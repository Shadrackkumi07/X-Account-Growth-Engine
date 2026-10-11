# Project G Wing MCP deployment and plugin connection

The expected production endpoint after you deploy this commit is **https://apx.serionflow.com/mcp**. Deployment and plugin linking have not been performed by this change.

The existing application is Fastify 5, not Express. MCP runs inside that same Node server, with the official SDK v2 Node Streamable HTTP transport. It uses stateless, JSON responses with no persistent MCP sessions. Authenticated POST requests support initialization, discovery, and invocation. Authenticated GET and DELETE return 405, as permitted for a stateless server without an SSE subscription stream.

## Deploy on the existing Render service

1. Commit/push the changed backend files and deploy that commit using the existing Render service. Keep the existing `npm ci && npm run build` build and `npm start` start commands.
2. Confirm the existing `PUBLIC_API_BASE_URL` is exactly `https://apx.serionflow.com`, and the existing `CHATGPT_ACTION_API_KEY` is configured. No new server environment variables or X OAuth setup are needed. `/mcp` is registered only when the existing connection service, Action key, and public base URL are available; otherwise it is unavailable, rather than anonymous.
3. Keep the existing database, credential encryption key, X credentials, scopes, and account connections. The MCP code does not modify X authorization or token refresh logic.
4. Preserve `REQUIRE_HTTPS=true` and the existing Render proxy setting. MCP validates the actual Host against `PUBLIC_API_BASE_URL`, and rejects a browser Origin unless it matches that URL's origin or the existing `CORS_ORIGINS` allowlist. Server-to-server clients without Origin are supported. For local use, set `PUBLIC_API_BASE_URL` to the exact localhost URL including its port.
5. Confirm `/healthz` and the original REST Actions still work. A normal browser visit to `/mcp` without credentials should return 401; it is not a webpage.

## Authentication and tool contract

Use the **existing read-only `CHATGPT_ACTION_API_KEY`**, sent as `Authorization: Bearer <key>`. Admin keys and the legacy URL token are not accepted. This key grants access to exactly the two fixed private accounts. The same key continues to protect the original REST Actions. MCP has a separate rate-limit bucket using `CHATGPT_ACTION_RATE_LIMIT_MAX` (30 requests per configured window by default), and a 60-second HTTP response deadline. Existing X client timeouts continue to apply.

| Tool                       | Fixed X account ID    | Input                              |
| -------------------------- | --------------------- | ---------------------------------- |
| `get_bloomquest_analytics` | `2077627663540535296` | `days`: integer 1–3650, default 30 |
| `get_serionflow_analytics` | `2041559051490783232` | `days`: integer 1–3650, default 30 |

Other input fields are rejected. Both tools advertise `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false`. All returned service identities, histories, post identities, and metric identities must match the fixed account. There are no publishing or credential-management tools. Reading analytics may refresh the existing local cache/history, as REST Actions already do.

MCP reuses the exact Action analytics assembly and formulas. The REST response contract stays intact. MCP returns account identity, 7/30-day summaries, and separate original/quote, reply, and repost lists. It retains full text and existing metrics, including nulls for unavailable data. It deduplicates posts by ID using the latest snapshot. Summaries refer to best/worst post IDs to avoid repeating full posts. Defaults cap originals/quotes at 120, replies at 60, reposts at 20, and account snapshots at 90; a 96 KiB JSON ceiling can reduce these further. `coverage` explicitly reports available, returned, and omitted counts and truncation. Summaries continue to use the existing service's full available data. Summary IDs may refer to omitted posts. No pagination or complete-archive claim is implied. If summaries alone exceed the ceiling, the tool returns a safe error.

## Verify after deployment

Run from a trusted local checkout with dependencies installed. Keep the key in your private `.env` or injected environment; do not put it in shell arguments or the plugin package.

```sh
npm run mcp:verify
```

This uses the official SDK client to initialize, discover exactly two tools, invoke each for 7 and 30 days, validate IDs, and check response sizes. It prints only verification results, never keys or full analytics. Optional verifier-only `MCP_URL` and `MCP_API_KEY` override the URL/key; they are not new server configuration.

For the requested manual MCP Inspector check:

```sh
npx @modelcontextprotocol/inspector
```

Choose **Streamable HTTP**, URL `https://apx.serionflow.com/mcp`, and configure the Authorization header with the read-only key privately. Confirm discovery, annotations, and both calls with `{"days":7}` and `{"days":30}`. Inspector and live production checks remain required after deployment; automated local tests use deterministic X fixtures.

## Attach to the existing migrated plugin

OpenAI documents fixed bearer tokens as **API-key auth**, and provides a private packaged-server declaration with `auth.type: "api_key"` and `headerScheme: "bearer"`. This is separate from X OAuth. It does not implement a ChatGPT OAuth connector flow. See [OpenAI plugin packaging and authentication](https://developers.openai.com/plugins/build/plugins#fixed-bearer-tokens-and-api-keys).

1. Update the **existing** Project G Wing X Growth Analyst plugin package. Merge the server entry from [mcp.json](./mcp.json) into its root `mcp.json`; preserve existing entries, manifest identity, instructions, and knowledge/skills. The portable format discovers the fixed root `mcp.json` path; preserve the existing root `plugin.json` identity and metadata. If using the legacy compatibility format, use the corresponding `.mcp.json` surface rather than renaming the entire package.
2. Upload the updated release using the existing plugin's edit/update workflow. Do not create a replacement plugin. The provided JSON contains connection configuration only, with no secret.
3. Install or enable **Project G Wing X Growth Analyst** if its status is `not_installed`. Enable the bundled `project-g-wing-x-analytics` server and complete its API-key connection setup, privately entering the existing Action key as the credential. The manifest tells the runtime to send it using Bearer authentication.
4. If the connection surface only offers OAuth/None and has no API-key setup, **do not choose None**. That surface does not support this packaged API-key workflow. Use the private installed-plugin setup described above. OpenAI explicitly says its public submission portal connection form does not support API-key declarations; publishing through that portal would need a separate supported OAuth provider/flow. It is not included or silently substituted here.
5. After authenticated discovery, verify these two exact tool names are available to the plugin. Preserve its existing requirement to recommend exactly two posts per company without publishing.
6. Test: **“Check BloomQuest and SerionFlow X analytics for the last 30 days. Call both analytics tools, analyze each company separately, and recommend exactly two posts per company without publishing.”**

Actual UI labels and API-key setup availability depend on your plugin installation surface. If it cannot accept the declared key, plugin linking remains incomplete; the secure backend can still be verified using Inspector and the SDK script. [OpenAI connection/testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Implementation and validation record

- New runtime dependencies: `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1. Zod upgraded to 4 for the current SDK's Standard Schema support; existing environment validation continues using its compatible `zod/v3` export.
- New development dependency: `@modelcontextprotocol/client` 2.3.1, for real HTTP integration tests and the post-deploy verifier.
- MCP code: `src/mcp/routes.ts` and `src/mcp/analytics.ts`; shared Action response assembly: `src/services/actionAnalytics.ts`.
- Registration: `src/server.ts`; original REST Actions: `src/routes/actions.ts`. CORS allows MCP methods/headers for the existing explicit browser origin allowlist.
- Added tests: `tests/mcp.test.ts`, including official SDK socket transport, discovery, both accounts at 7/30 days, invalid inputs, auth rejection, Host/Origin checks, stateless methods, rate limiting, safe errors, identity mismatches, deduplication, byte limits, and REST regression. Existing connection/refresh tests remain intact.
- Compatible dependency lockfile updates fix audit findings in Fastify, fast-uri, brace-expansion, and source-map-js.
- Production deployment, live X verification, MCP Inspector verification, and connection of the migrated cloud plugin remain manual steps after deploying. No production success is claimed.
