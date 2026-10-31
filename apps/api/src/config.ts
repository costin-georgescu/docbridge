import { z } from "zod";
import {
  baseEnvSchema,
  loadConfig,
  databaseUrlFromEnv,
} from "@docbridge/config";

export const envSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().default(3000),
  AUTH_INTERNAL_URL: z.string().url(),
  PLATFORM_INTERNAL_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().optional(),
  STAGING_BUCKET: z.string().min(1),
  S3_PRESIGN_ENDPOINT_URL: z.string().url().optional(),
  // TDD 5.5 rate limits, per user; 0 disables. Kept high enough that a
  // 100-file job's upload burst stays well under the uploads cap.
  RATE_LIMIT_JOBS_PER_MIN: z.coerce.number().int().min(0).default(30),
  RATE_LIMIT_UPLOADS_PER_MIN: z.coerce.number().int().min(0).default(120),
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}

export function jwksUrl(): string {
  return `${config.AUTH_INTERNAL_URL.replace(/\/$/, "")}/auth/.well-known/jwks.json`;
}

export function platformUrl(): string {
  return config.PLATFORM_INTERNAL_URL.replace(/\/$/, "");
}
