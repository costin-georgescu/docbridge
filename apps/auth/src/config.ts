import { z } from "zod";
import {
  baseEnvSchema,
  loadConfig,
  databaseUrlFromEnv,
} from "@docbridge/config";

export const envSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().default(3001),
  JWT_SIGNING_KEY: z.string().optional(),
  WEB_ORIGIN: z.string().url().optional(),
  // TDD 5.5 rate limits, per client IP; 0 disables.
  RATE_LIMIT_SESSION_PER_MIN: z.coerce.number().int().min(0).default(60),
  RATE_LIMIT_SERVICE_TOKEN_PER_MIN: z.coerce.number().int().min(0).default(20),
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}
