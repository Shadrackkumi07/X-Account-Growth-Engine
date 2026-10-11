import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod/v4";
import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { ConnectionService } from "../services/connectionService.js";
import { ApiError } from "../lib/errors.js";
import { MCP_ACCOUNTS, mcpAnalytics } from "./analytics.js";

interface Options {
  connectionService: ConnectionService;
  baseUrl: string;
  origins: string[];
  authHook: onRequestHookHandler;
  rateLimitHook: onRequestHookHandler;
}

const safeErrors: Record<string, string> = {
  not_found: "This X account is not connected. Complete its protected X OAuth setup first.",
  upstream_unauthorized:
    "X authorization expired or was rejected. Reconnect the affected X account.",
  token_refresh_failed:
    "X rejected the token refresh. Reconnect the affected X account using the protected setup URL.",
  refresh_unavailable: "X authorization cannot be refreshed. Reconnect the affected X account.",
  upstream_rate_limited: "X API rate limit reached. Retry after the provider's rate-limit window.",
  account_mismatch: "Account identity validation failed. No analytics were returned.",
  upstream_error:
    "X analytics could not be returned. Check X API availability, credits, and the MCP response limit.",
};

export const mcpRoutes: FastifyPluginAsync<Options> = async (
  app,
  { connectionService, baseUrl, origins, authHook, rateLimitHook },
) => {
  const canonical = new URL(baseUrl);
  app.route({
    method: ["POST", "GET", "DELETE"],
    url: "/mcp",
    schema: { hide: true },
    onRequest: [
      rateLimitHook,
      authHook,
      async (request, reply) => {
        // Validate the actual Host, not caller-supplied forwarded headers.
        if (
          request.headers.host !== canonical.host ||
          (request.headers.origin && !origins.includes(request.headers.origin))
        ) {
          throw new ApiError(403, "forbidden", "MCP Host or Origin is not allowed.");
        }
        reply.header("Cache-Control", "no-store");
        if (request.method !== "POST") {
          return reply
            .header("Allow", "POST")
            .status(405)
            .send({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "This stateless MCP endpoint supports POST only." },
            });
        }
      },
    ],
    handler: async (request, reply) => {
      const server = new McpServer({ name: "project-g-wing-x-analytics", version: "1.0.0" });
      for (const [name, account] of Object.entries(MCP_ACCOUNTS)) {
        server.registerTool(
          name,
          {
            description: `Retrieve live and historical X analytics for ${account.name}, account ID ${account.id}. Reads only this company's private account; never publishes.`,
            inputSchema: z.object({ days: z.number().int().min(1).max(3650).default(30) }).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          },
          async ({ days }) => {
            try {
              const result = await mcpAnalytics(connectionService, account.id, days);
              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              const code = error instanceof ApiError ? error.code : "internal_error";
              request.log.warn(
                { tool: name, account_id: account.id, code },
                "MCP analytics failed",
              );
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: {
                        code,
                        message:
                          safeErrors[code] ??
                          "Analytics are temporarily unavailable. Retry or check backend service health.",
                      },
                    }),
                  },
                ],
              };
            }
          },
        );
      }
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      // Fastify already parsed JSON. Hand the raw response to the official SDK.
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(key, value);
      }
      reply.hijack();
      const timeout = setTimeout(() => {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(504, { "Content-Type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "Analytics request timed out. Retry shortly." },
            }),
          );
        } else reply.raw.destroy();
        void server.close().catch(() => undefined);
      }, 60_000);
      timeout.unref();
      reply.raw.once("close", () => {
        clearTimeout(timeout);
        void server.close().catch(() => undefined);
      });
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        request.log.warn({ code: "mcp_transport_error" }, "MCP transport failed");
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "MCP transport failed." },
            }),
          );
        } else reply.raw.destroy();
        clearTimeout(timeout);
        await server.close();
      }
      return reply;
    },
  });
};
