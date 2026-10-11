import { z } from "zod/v3";
import { ConfigError } from "../lib/errors.js";

const booleanish = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected a boolean, got "${value}"` });
  return z.NEVER;
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  API_KEYS: z.string().optional(),
  API_KEY_HASHES: z.string().optional(),
  CHATGPT_ACCESS_TOKEN: z.string().min(32).optional(),
  CHATGPT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  // Dedicated key for the small Custom GPT Action surface, separate from
  // administrator API keys and the legacy URL token.
  CHATGPT_ACTION_API_KEY: z.string().min(32).optional(),
  CHATGPT_ACTION_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  // Comma-separated public Action aliases, e.g. "brand=brand_handle,personal=my_handle".
  CHATGPT_ACTION_ACCOUNTS: z.string().optional(),
  PUBLIC_API_BASE_URL: z.string().url().optional(),

  REQUIRE_HTTPS: booleanish.optional(),
  TRUST_PROXY: booleanish.default(true),
  CORS_ORIGINS: z.string().optional(),
  ENABLE_DOCS: booleanish.default(true),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  X_API_BASE_URL: z.string().url().default("https://api.x.com/2"),
  X_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  ANALYTICS_TWEET_LIMIT: z.coerce.number().int().min(5).max(100).default(100),
  SYNC_POST_LIMIT: z.coerce.number().int().min(5).max(3200).default(500),
  TOP_TWEETS_COUNT: z.coerce.number().int().min(1).max(50).default(5),
  // When configured, durable PostgreSQL JSONB storage replaces DATA_FILE.
  DATABASE_URL: z.string().url().optional(),
  DATA_FILE: z.string().min(1).default("./data/x-analytics.json"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  // Dedicated browser-only secret for starting an X OAuth connection.
  OAUTH_SETUP_TOKEN: z.string().min(32).optional(),
  // This must exactly match the callback registered in the X Developer Portal.
  X_OAUTH_REDIRECT_URI: z.string().url().optional(),
  X_OAUTH_SCOPES: z.string().min(1).default("tweet.read users.read offline.access"),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
});

export type Env = z.infer<typeof envSchema> & { REQUIRE_HTTPS: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }

  const env = parsed.data;
  return {
    ...env,
    // HTTPS is mandatory in production but would block local http:// development.
    REQUIRE_HTTPS: env.REQUIRE_HTTPS ?? env.NODE_ENV === "production",
  };
}
