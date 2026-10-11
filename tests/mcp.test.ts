import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyStore } from "../src/auth/apiKey.js";
import { loadEnv } from "../src/config/env.js";
import { CredentialVault } from "../src/security/credentialVault.js";
import { buildServer } from "../src/server.js";
import { AnalyticsService } from "../src/services/analyticsService.js";
import { ConnectionService } from "../src/services/connectionService.js";
import { Repository } from "../src/storage/repository.js";
import { XClient } from "../src/x/client.js";
import { ApiError } from "../src/lib/errors.js";
import { MCP_ACCOUNTS, MAX_RESPONSE_BYTES, mcpAnalytics } from "../src/mcp/analytics.js";
import { sampleTweets, sampleUser } from "./fixtures/xApi.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const KEY = "mcp-read-only-test-secret-with-32-characters";
const ADMIN = "admin-test-secret-with-32-characters";
const headers = {
  host: "api.example.test",
  authorization: `Bearer ${KEY}`,
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture(rateLimit = 100, baseUrl = "https://api.example.test") {
  const directory = mkdtempSync(join(tmpdir(), "gwing-mcp-"));
  cleanup.push(async () => rmSync(directory, { force: true, recursive: true }));
  const env = loadEnv({
    NODE_ENV: "test",
    PUBLIC_API_BASE_URL: baseUrl,
    CHATGPT_ACTION_RATE_LIMIT_MAX: String(rateLimit),
    CACHE_TTL_SECONDS: "300",
  });
  const repository = new Repository(join(directory, "store.json"));
  await repository.initialize();
  const client = new XClient({
    baseUrl: env.X_API_BASE_URL,
    timeoutMs: env.X_TIMEOUT_MS,
    fetchImpl: async (url, init) => {
      const id = new Headers(init?.headers).get("authorization")?.includes("bloomquest")
        ? MCP_ACCOUNTS.get_bloomquest_analytics.id
        : MCP_ACCOUNTS.get_serionflow_analytics.id;
      if (url.includes("/users/me"))
        return Response.json({
          data: {
            ...sampleUser,
            id,
            username:
              id === MCP_ACCOUNTS.get_bloomquest_analytics.id ? "bloomquestapp" : "SerionFlow",
          },
        });
      return Response.json({
        data: sampleTweets.map((t, i) => ({
          ...t,
          id: `${id}-${i}`,
          created_at: new Date().toISOString(),
          text: `${id}: post ${i}`,
        })),
        meta: { result_count: sampleTweets.length },
      });
    },
  });
  const vault = new CredentialVault(repository, "test-encryption-secret-with-32-characters");
  const service = new ConnectionService(repository, vault, client, env);
  await service.create({
    access_token: "x-bloomquest-secret",
    refresh_token: "x-bloomquest-refresh",
  });
  await service.create({
    access_token: "x-serionflow-secret",
    refresh_token: "x-serionflow-refresh",
  });
  const app = await buildServer({
    env,
    apiKeyStore: ApiKeyStore.fromEnv({ plaintextKeys: ADMIN }),
    chatGptActionKeyStore: ApiKeyStore.fromSingleSecret(KEY, "CHATGPT_ACTION_API_KEY"),
    service: new AnalyticsService({ accounts: [], client, env }),
    connectionService: service,
  });
  await app.ready();
  cleanup.push(() => app.close());
  const rpc = (method: string, params?: unknown, customHeaders = headers) =>
    app.inject({
      method: "POST",
      url: "/mcp",
      headers: customHeaders,
      payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
    });
  return { app, service, rpc };
}

describe("authenticated stateless MCP", () => {
  it("connects with the official SDK over a real HTTP socket", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const address = `http://127.0.0.1:${port}`;
    const { app } = await fixture(100, address);
    await app.listen({ host: "127.0.0.1", port });
    const client = new Client({ name: "gwing-test", version: "1.0.0" });
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${KEY}` } },
      }),
    );
    expect((await client.listTools()).tools).toHaveLength(2);
    for (const [name, account] of Object.entries(MCP_ACCOUNTS)) {
      const result = await client.callTool({ name, arguments: { days: 7 } });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]!.text).account.id).toBe(account.id);
    }
  });
  it("initializes and discovers exactly two strict read-only tools", async () => {
    const { rpc } = await fixture();
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe("project-g-wing-x-analytics");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    const result = await rpc("tools/list");
    expect(result.statusCode).toBe(200);
    expect(
      result
        .json()
        .result.tools.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(Object.keys(MCP_ACCOUNTS).sort());
    for (const tool of result.json().result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties.days).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 3650,
        default: 30,
      });
    }
  });
  for (const [name, account] of Object.entries(MCP_ACCOUNTS)) {
    for (const days of [7, 30])
      it(`${name} returns only its bound account for ${days} days`, async () => {
        const { rpc } = await fixture();
        const response = await rpc("tools/call", { name, arguments: { days } });
        expect(response.statusCode).toBe(200);
        const text = response.json().result.content[0].text;
        const data = JSON.parse(text);
        expect(data.account.id).toBe(account.id);
        expect(data.original_posts.length).toBeGreaterThan(0);
        expect(data.summary_7d).toBeDefined();
        expect(data.summary_30d).toBeDefined();
        expect(data.original_posts[0].metrics.likes).toBeTypeOf("number");
        expect(data.original_posts[0].metrics.impressions).toBeNull();
        expect(text).not.toContain(
          Object.values(MCP_ACCOUNTS).find((a) => a.id !== account.id)!.id,
        );
        expect(text).not.toMatch(
          /x-bloomquest-secret|x-serionflow-secret|refresh_token|credential_secret_reference|connection_status/,
        );
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      });
  }
  it("defaults days and rejects invalid days or arbitrary account selectors", async () => {
    const { rpc } = await fixture();
    const response = await rpc("tools/call", { name: "get_bloomquest_analytics", arguments: {} });
    expect(JSON.parse(response.json().result.content[0].text).days).toBe(30);
    for (const args of [
      { days: 0 },
      { days: 3651 },
      { days: 1.5 },
      { days: "7" },
      { account_id: "other" },
    ]) {
      const result = (
        await rpc("tools/call", { name: "get_bloomquest_analytics", arguments: args })
      ).json();
      expect(result.error || result.result?.isError).toBeTruthy();
    }
    const unknown = (await rpc("tools/call", { name: "publish_tweet", arguments: {} })).json();
    expect(unknown.error || unknown.result?.isError).toBeTruthy();
  });
  it("rejects missing/invalid/admin credentials before accessing analytics", async () => {
    const { app, service } = await fixture();
    const spy = vi.spyOn(service, "accountAnalytics");
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${ADMIN}`]) {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { host: "api.example.test", ...(authorization ? { authorization } : {}) },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects unsafe Host/Origin and supports stateless method rejection", async () => {
    const { app, rpc } = await fixture();
    expect((await rpc("tools/list", undefined, { ...headers, host: "evil.test" })).statusCode).toBe(
      403,
    );
    expect(
      (
        await rpc("tools/list", undefined, {
          ...headers,
          origin: "https://evil.test",
        } as typeof headers)
      ).statusCode,
    ).toBe(403);
    for (const method of ["GET", "DELETE"] as const)
      expect((await app.inject({ method, url: "/mcp", headers })).statusCode).toBe(405);
    expect(
      (await app.inject({ method: "POST", url: "/mcp", headers, payload: "{" })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers,
          payload: { jsonrpc: "2.0", method: "notifications/initialized" },
        })
      ).statusCode,
    ).toBe(202);
  });
  it("rate limits MCP requests", async () => {
    const { rpc } = await fixture(1);
    expect((await rpc("tools/list")).statusCode).toBe(200);
    expect((await rpc("tools/list")).statusCode).toBe(429);
  });
  it("returns safe actionable errors without provider secret details", async () => {
    const { service, rpc } = await fixture();
    vi.spyOn(service, "accountAnalytics").mockRejectedValue(
      new ApiError(502, "token_refresh_failed", "secret=x-token database=private"),
    );
    const result = (
      await rpc("tools/call", { name: "get_serionflow_analytics", arguments: {} })
    ).json().result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Reconnect");
    expect(result.content[0].text).not.toMatch(/x-token|database|private/);
  });
  it("validates all account identities even when a summary is mismatched", async () => {
    const { service, rpc } = await fixture();
    const summary = await service.summary(MCP_ACCOUNTS.get_serionflow_analytics.id, 7);
    vi.spyOn(service, "summary").mockResolvedValue(summary);
    const result = (
      await rpc("tools/call", { name: "get_bloomquest_analytics", arguments: {} })
    ).json().result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("account_mismatch");
    expect(result.content[0].text).not.toContain(MCP_ACCOUNTS.get_serionflow_analytics.id);
  });
  it("deduplicates latest snapshots, bounds bytes, and reports omissions", async () => {
    const { service } = await fixture();
    const id = MCP_ACCOUNTS.get_bloomquest_analytics.id;
    const data = await service.posts(id, 30);
    const original = data.posts[0]!;
    const posts = Array.from({ length: 400 }, (_, i) => ({
      ...original,
      kind: "original" as const,
      post_id: String(i),
      text: "a".repeat(2000),
    }));
    posts.push({
      ...posts[0]!,
      text: "latest",
      metrics: posts[0]!.metrics
        ? {
            ...posts[0]!.metrics,
            captured_at: "2099-01-01T00:00:00Z",
          }
        : null,
    });
    vi.spyOn(service, "posts").mockResolvedValue({ ...data, posts });
    const result = await mcpAnalytics(service, id, 30);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.available_posts).toBe(400);
    expect(result.coverage.omitted_posts).toBeGreaterThan(0);
    expect(result.original_posts.find((p) => p.post_id === "0")?.text).toBe("latest");
    expect(new Set(result.original_posts.map((p) => p.post_id)).size).toBe(
      result.original_posts.length,
    );
  });
  it("keeps existing REST Action analytics working", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/actions/x/bloomquest?days=7",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().account.id).toBe(MCP_ACCOUNTS.get_bloomquest_analytics.id);
    expect(response.json().posts).toBeDefined();
  });
});
