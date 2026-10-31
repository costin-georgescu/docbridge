import { z } from "zod";
import {
  baseEnvSchema,
  loadConfig,
  databaseUrlFromEnv,
} from "@docbridge/config";

export const envSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().default(3002),
  AUTH_INTERNAL_URL: z.string().url(),
  PLATFORM_BUCKET: z.string().min(1),
  WEB_ORIGIN: z.string().url().optional(),
  // TDD 5.5 rate limit on GET /tree (the only public route), per client IP;
  // 0 disables.
  RATE_LIMIT_TREE_PER_MIN: z.coerce.number().int().min(0).default(60),
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}

export function jwksUrl(): string {
  return `${config.AUTH_INTERNAL_URL.replace(/\/$/, "")}/auth/.well-known/jwks.json`;
}
