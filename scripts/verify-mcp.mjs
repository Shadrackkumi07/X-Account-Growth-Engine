import { existsSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.MCP_API_KEY || process.env.CHATGPT_ACTION_API_KEY;
const url =
  process.env.MCP_URL ||
  `${(process.env.PUBLIC_API_BASE_URL || "https://apx.serionflow.com").replace(/\/$/, "")}/mcp`;
const expected = {
  get_bloomquest_analytics: "2077627663540535296",
  get_serionflow_analytics: "2041559051490783232",
};
const client = new Client({ name: "gwing-mcp-verifier", version: "1.0.0" });
try {
  if (!key)
    throw new Error(
      "Configure the read-only key privately in CHATGPT_ACTION_API_KEY or MCP_API_KEY.",
    );
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname))
    throw new Error("Remote MCP verification requires HTTPS.");
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  const { tools } = await client.listTools();
  if (tools.length !== 2 || tools.some((t) => !expected[t.name] || !t.annotations?.readOnlyHint))
    throw new Error("Unexpected tool discovery or annotations.");
  console.log("Initialization and discovery passed: exactly two read-only analytics tools.");
  for (const [name, id] of Object.entries(expected)) {
    for (const days of [7, 30]) {
      const result = await client.callTool({ name, arguments: { days } });
      if (result.isError)
        throw new Error(`${name} failed. Check account authorization and backend health.`);
      const block = result.content.find((item) => item.type === "text");
      const data = JSON.parse(block.text);
      if (data.account?.id !== id)
        throw new Error(`${name} returned an unexpected account identity.`);
      if (Buffer.byteLength(block.text) > 96 * 1024)
        throw new Error(`${name} exceeded the response limit.`);
      console.log(
        `${name}: ${days} days, account ${id}, ${data.coverage.returned_posts} posts, truncated=${data.coverage.truncated}.`,
      );
    }
  }
  console.log("Authenticated MCP verification passed.");
} catch {
  // Transport errors may include response bodies. Never print them or the key.
  console.error(
    "MCP verification failed. Confirm deployment, URL, private read-only key, and both X connections. No credentials were printed.",
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
