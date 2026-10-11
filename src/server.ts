import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type onRequestHookHandler,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import type { Env } from "./config/env.js";
import type { ApiKeyStore } from "./auth/apiKey.js";
import { extractBearerToken } from "./auth/apiKey.js";
import {
  createAuthHook,
  createChatGptTokenHook,
  createHttpsHook,
  createOAuthSetupTokenHook,
  tokenFromChatGptPath,
} from "./auth/plugin.js";
import { ApiError } from "./lib/errors.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";
import type { AnalyticsService } from "./services/analyticsService.js";
import type { ConnectionService } from "./services/connectionService.js";
import { openApiSchemas } from "./openapi/schemas.js";
import { chatGptRoutes } from "./routes/chatgpt.js";
import { oauthRoutes } from "./routes/oauth.js";
import { actionRoutes, parseActionAccounts } from "./routes/actions.js";
import { mcpRoutes } from "./mcp/routes.js";
import type { XOAuthService } from "./services/xOAuthService.js";

export interface BuildServerOptions {
  env: Env;
  apiKeyStore: ApiKeyStore;
  service: AnalyticsService;
  connectionService?: ConnectionService;
  oauthService?: XOAuthService;
  oauthSetupTokenStore?: ApiKeyStore;
  chatGptTokenStore?: ApiKeyStore;
  chatGptActionKeyStore?: ApiKeyStore;
}

function rateLimitKey(store: ApiKeyStore, authorization: string | undefined, ip: string): string {
  const presented = extractBearerToken(authorization);
  if (!presented) return `ip:${ip}`;

  // Only a recognised key earns its own bucket — and `keyId` is a digest
  // prefix, so the key itself never enters the limiter's store. An unknown
  // token falls back to the caller's IP: bucketing by the presented value
  // would let a client rotate random tokens to mint a fresh allowance per
  // request and brute-force keys unchecked.
  const keyId = store.verify(presented);
  return keyId ? `key:${keyId}` : `ip:${ip}`;
}

function chatGptRateLimitKey(store: ApiKeyStore, url: string, ip: string): string {
  const token = tokenFromChatGptPath(url);
  const tokenId = token ? store.verify(token) : null;
  return tokenId ? `chatgpt:${tokenId}` : `ip:${ip}`;
}

function redactChatGptUrl(url: string | undefined): string | undefined {
  return url
    ?.replace(/(\/api\/chatgpt\/)[^/?#]+/, "$1[redacted]")
    .replace(/(\/auth\/x\/)(?!callback(?:[/?#]|$))[^/?#]+/, "$1[redacted]");
}

export async function buildServer({
  env,
  apiKeyStore,
  service,
  connectionService,
  oauthService,
  oauthSetupTokenStore,
  chatGptTokenStore,
  chatGptActionKeyStore,
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.access_token",
          "req.body.refresh_token",
          "req.body.client_secret",
        ],
        censor: "[redacted]",
      },
      serializers: {
        req(request: FastifyRequest) {
          const host = request.headers.host;
          return {
            method: request.method,
            url: redactChatGptUrl(request.url),
            host: Array.isArray(host) ? host[0] : host,
            remoteAddress: request.ip,
          };
        },
      },
    },
  });

  await app.register(helmet, {
    // The docs page is the only HTML this service serves; Swagger UI needs
    // inline script and style to boot.
    contentSecurityPolicy: env.ENABLE_DOCS
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            workerSrc: ["'self'", "blob:"],
          },
        }
      : { directives: { defaultSrc: ["'self'"] } },
    hsts: env.REQUIRE_HTTPS ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  await app.register(cors, {
    // Default: no browser origin is allowed. This is a server-to-server API.
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id"],
    maxAge: 600,
  });

  // global:false so the limiter is not attached per route, where it would run
  // *after* the /v1 scope's authentication hook and therefore never see a
  // rejected request. The hook is placed explicitly ahead of auth instead.
  await app.register(rateLimit, { global: false });

  const rateLimitHook: onRequestHookHandler = app.rateLimit({
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    keyGenerator: (request) => rateLimitKey(apiKeyStore, request.headers.authorization, request.ip),
    // The plugin throws this value verbatim, so it must be a real ApiError for
    // the error handler below to recognise it and keep the response envelope
    // consistent with every other error.
    errorResponseBuilder: (_request, context) =>
      new ApiError(
        429,
        "rate_limited",
        `Rate limit exceeded: at most ${context.max} requests per ${env.RATE_LIMIT_WINDOW_SECONDS}s.`,
        { retry_after_seconds: Math.ceil(context.ttl / 1000) },
      ),
  }) as onRequestHookHandler;

  const chatGptRateLimitHook: onRequestHookHandler | undefined = chatGptTokenStore
    ? (app.rateLimit({
        max: env.CHATGPT_RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
        keyGenerator: (request) => chatGptRateLimitKey(chatGptTokenStore, request.url, request.ip),
        errorResponseBuilder: (_request, context) =>
          new ApiError(
            429,
            "rate_limited",
            `ChatGPT rate limit exceeded: at most ${context.max} requests per ${env.RATE_LIMIT_WINDOW_SECONDS}s.`,
            { retry_after_seconds: Math.ceil(context.ttl / 1000) },
          ),
      }) as onRequestHookHandler)
    : undefined;

  const chatGptActionRateLimitHook: onRequestHookHandler | undefined = chatGptActionKeyStore
    ? (app.rateLimit({
        max: env.CHATGPT_ACTION_RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
        keyGenerator: (request) =>
          rateLimitKey(chatGptActionKeyStore, request.headers.authorization, request.ip),
        errorResponseBuilder: (_request, context) =>
          new ApiError(
            429,
            "rate_limited",
            `Custom GPT Action rate limit exceeded: at most ${context.max} requests per ${env.RATE_LIMIT_WINDOW_SECONDS}s.`,
            { retry_after_seconds: Math.ceil(context.ttl / 1000) },
          ),
      }) as onRequestHookHandler)
    : undefined;

  await app.register(swagger, {
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, index) {
        return typeof json.$id === "string" ? json.$id : `def-${index}`;
      },
    },
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "X Analytics API",
        version: "1.0.0",
        description:
          "Persistent read-only analytics for independently authorized X accounts, intended " +
          "for AI agents and humans. Per-account OAuth credentials are accepted only by the " +
          "authenticated admin connection routes, encrypted at rest, redacted from logs, and " +
          "never returned.",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "An API key issued for this service. Send over HTTPS only.",
          },
          actionBearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "The dedicated, read-only Custom GPT Action API key.",
          },
        },
      },
      tags: [
        { name: "meta", description: "Service metadata and health." },
        { name: "accounts", description: "Which X accounts are exposed." },
        { name: "analytics", description: "Per-account analytics." },
        { name: "connections", description: "Administrative X OAuth connection lifecycle." },
        { name: "history", description: "Persistent account and post performance history." },
        { name: "chatgpt", description: "GET-only, sanitized analytics access via URL token." },
        {
          name: "custom-gpt-action",
          description: "GET-only, sanitized analytics for the dedicated Custom GPT Action key.",
        },
      ],
    },
  });

  // Register after Swagger so shared schemas are included in /openapi.json,
  // and before routes so response references resolve for serialization.
  for (const schema of openApiSchemas) app.addSchema(schema);

  if (env.ENABLE_DOCS) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });
  }

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send(error.toJSON());
      return;
    }

    if (error.validation) {
      reply.status(400).send({
        error: { code: "bad_request", message: error.message },
      });
      return;
    }

    // The rate limiter and other plugins set statusCode with a safe message.
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: "bad_request", message: error.message },
      });
      return;
    }

    request.log.error({ err: error }, "Unhandled error while serving request");
    reply.status(500).send({
      error: { code: "internal_error", message: "An unexpected error occurred." },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "not_found",
        message: `No route for ${request.method} ${redactChatGptUrl(request.url)}. See GET / for the endpoint list.`,
      },
    });
  });

  const authHook = createAuthHook({
    store: apiKeyStore,
    requireHttps: env.REQUIRE_HTTPS,
  });

  await app.register(healthRoutes, { service });
  await app.register(v1Routes, {
    service,
    connectionService,
    oauthService,
    authHook,
    rateLimitHook,
    prefix: "/v1",
  });
  if (oauthService) {
    await app.register(oauthRoutes, {
      oauthService,
      httpsHook: createHttpsHook(env.REQUIRE_HTTPS),
      rateLimitHook,
      setupAuthHook: oauthSetupTokenStore
        ? createOAuthSetupTokenHook({
            store: oauthSetupTokenStore,
            requireHttps: env.REQUIRE_HTTPS,
          })
        : undefined,
    });
  }
  if (connectionService && chatGptTokenStore && chatGptRateLimitHook) {
    await app.register(chatGptRoutes, {
      connectionService,
      authHook: createChatGptTokenHook({
        store: chatGptTokenStore,
        requireHttps: env.REQUIRE_HTTPS,
      }),
      rateLimitHook: chatGptRateLimitHook,
      prefix: "/api/chatgpt",
    });
  }
  if (
    connectionService &&
    chatGptActionKeyStore &&
    chatGptActionRateLimitHook &&
    env.PUBLIC_API_BASE_URL
  ) {
    await app.register(mcpRoutes, {
      connectionService,
      baseUrl: env.PUBLIC_API_BASE_URL,
      origins: [new URL(env.PUBLIC_API_BASE_URL).origin, ...corsOrigins],
      authHook: createAuthHook({ store: chatGptActionKeyStore, requireHttps: env.REQUIRE_HTTPS }),
      rateLimitHook: app.rateLimit({
        max: env.CHATGPT_ACTION_RATE_LIMIT_MAX,
        timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
        keyGenerator: (request) =>
          `mcp:${rateLimitKey(chatGptActionKeyStore, request.headers.authorization, request.ip)}`,
        errorResponseBuilder: () =>
          new ApiError(429, "rate_limited", "MCP request rate limit exceeded. Retry shortly."),
      }) as onRequestHookHandler,
    });
    await app.register(actionRoutes, {
      baseUrl: env.PUBLIC_API_BASE_URL.replace(/\/$/, ""),
      accountAliases: parseActionAccounts(env.CHATGPT_ACTION_ACCOUNTS),
      connectionService,
      authHook: createAuthHook({
        store: chatGptActionKeyStore,
        requireHttps: env.REQUIRE_HTTPS,
      }),
      rateLimitHook: chatGptActionRateLimitHook,
      prefix: "/actions",
    });
  }

  return app;
}
