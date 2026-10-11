import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import { analyticsResponse } from "../services/actionAnalytics.js";
import { ConfigError } from "../lib/errors.js";
import type { ConnectionService } from "../services/connectionService.js";

interface DaysQuery {
  days?: number;
}

const defaultAccountAliases = {
  bloomquest: "bloomquestapp",
  serionflow: "SerionFlow",
};

const actionAliasPattern = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Turns a friendly environment value into the small, allow-listed Action
 * surface. It deliberately supports aliases only; arbitrary account ids never
 * become callable merely because a Custom GPT knows one.
 */
export function parseActionAccounts(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return defaultAccountAliases;
  const accounts: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const [alias, ...targetParts] = entry.split("=");
    const normalizedAlias = alias?.trim().toLowerCase() ?? "";
    const target = targetParts.join("=").trim();
    if (!actionAliasPattern.test(normalizedAlias) || !target || target.includes(",")) {
      throw new ConfigError(
        "CHATGPT_ACTION_ACCOUNTS must be comma-separated alias=account values, " +
          'for example: "brand=brand_handle,personal=my_handle".',
      );
    }
    if (accounts[normalizedAlias]) {
      throw new ConfigError(
        `CHATGPT_ACTION_ACCOUNTS contains duplicate alias "${normalizedAlias}".`,
      );
    }
    accounts[normalizedAlias] = target;
  }
  if (Object.keys(accounts).length === 0) {
    throw new ConfigError("CHATGPT_ACTION_ACCOUNTS must include at least one alias=account value.");
  }
  return accounts;
}

const daysQuery = {
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 3650,
      default: 30,
      description: "Number of calendar days of posts to analyse.",
    },
  },
} as const;

function actionOpenApi(baseUrl: string, accountAliases: Record<string, string>) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Project G Wing X Analytics Action",
      version: "1.0.0",
      description:
        "Read-only X performance analytics for BloomQuest and SerionFlow. " +
        "Responses never include X credentials, OAuth tokens, connection health, or admin data.",
    },
    servers: [{ url: baseUrl }],
    components: {
      schemas: {
        ActionAccount: {
          type: "object",
          additionalProperties: true,
          required: ["id", "handle", "display_name", "followers", "following", "total_posts"],
          properties: {
            id: { type: "string", description: "Immutable X account ID." },
            handle: { type: "string", description: "Current X handle without @." },
            display_name: { type: "string", description: "Current X display name." },
            followers: { anyOf: [{ type: "number" }, { type: "null" }] },
            following: { anyOf: [{ type: "number" }, { type: "null" }] },
            total_posts: { anyOf: [{ type: "number" }, { type: "null" }] },
            current_timestamp: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
        AnalyticsResponse: {
          type: "object",
          additionalProperties: true,
          required: [
            "account",
            "analytics_history",
            "posts",
            "summary_7d",
            "summary_30d",
            "generated_at",
          ],
          properties: {
            account: { $ref: "#/components/schemas/ActionAccount" },
            analytics_history: {
              type: "array",
              description: "Historical account follower and post-count snapshots.",
              items: { type: "object", additionalProperties: true, properties: {} },
            },
            posts: {
              type: "array",
              description: "Posts with current metrics, rates, and relative performance.",
              items: { type: "object", additionalProperties: true, properties: {} },
            },
            summary_7d: {
              type: "object",
              description: "Seven-day comparisons, content performance, and follower growth.",
              additionalProperties: true,
              properties: {},
            },
            summary_30d: {
              type: "object",
              description: "Thirty-day comparisons, content performance, and follower growth.",
              additionalProperties: true,
              properties: {},
            },
            generated_at: { type: "string", format: "date-time" },
          },
        },
      },
      securitySchemes: {
        actionBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key",
          description: "The dedicated Custom GPT Action key.",
        },
      },
    },
    paths: Object.fromEntries(
      Object.keys(accountAliases).map((account) => [
        `/actions/x/${account}`,
        {
          get: {
            operationId: `get${account[0]!.toUpperCase()}${account.slice(1)}Analytics`,
            summary: `Get ${account} X analytics`,
            description:
              "Returns sanitized account history, posts, derived rates, and 7/30-day performance summaries.",
            security: [{ actionBearerAuth: [] }],
            parameters: [
              {
                name: "days",
                in: "query",
                required: false,
                schema: { type: "integer", minimum: 1, maximum: 3650, default: 30 },
                description: "Number of calendar days of posts to return.",
              },
            ],
            responses: {
              "200": {
                description: "Sanitized account analytics.",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/AnalyticsResponse" },
                  },
                },
              },
              "401": { description: "Missing or invalid Action API key." },
              "429": { description: "Rate limit exceeded." },
            },
          },
        },
      ]),
    ),
  };
}

export interface ActionRouteOptions {
  baseUrl: string;
  accountAliases: Record<string, string>;
  connectionService: ConnectionService;
  authHook: onRequestHookHandler;
  rateLimitHook: onRequestHookHandler;
}

/**
 * A deliberately small Custom GPT Action surface. The two fixed account names
 * prevent the Action key from discovering connection IDs or admin routes.
 */
export const actionRoutes: FastifyPluginAsync<ActionRouteOptions> = async (
  app,
  { baseUrl, accountAliases, connectionService, authHook, rateLimitHook },
) => {
  app.get(
    "/openapi.json",
    {
      schema: {
        hide: true,
        summary: "Custom GPT Action OpenAPI specification",
      },
    },
    async (_request, reply) =>
      reply.header("Cache-Control", "no-store").send(actionOpenApi(baseUrl, accountAliases)),
  );

  app.register(
    async (secured) => {
      secured.addHook("onRequest", rateLimitHook);
      secured.addHook("onRequest", authHook);

      secured.get<{ Params: { account: string }; Querystring: DaysQuery }>(
        "/x/:account",
        {
          schema: {
            tags: ["custom-gpt-action"],
            summary: "Sanitized read-only X analytics for a Custom GPT Action",
            description:
              "Returns only account analytics, posts, and summaries. It never returns X credentials, " +
              "OAuth tokens, connection health, internal secret references, or admin routes.",
            params: {
              type: "object",
              required: ["account"],
              properties: { account: { enum: Object.keys(accountAliases) } },
            },
            querystring: daysQuery,
            security: [{ actionBearerAuth: [] }],
          },
        },
        async (request, reply) => {
          const days = request.query.days ?? 30;
          return reply
            .header("Cache-Control", "no-store")
            .send(
              await analyticsResponse(
                connectionService,
                accountAliases[request.params.account]!,
                days,
              ),
            );
        },
      );
    },
    { prefix: "/" },
  );
};
