import { z } from "zod";
import {
  baseEnvSchema,
  loadConfig,
  databaseUrlFromEnv,
} from "@docbridge/config";

export const envSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().default(3000),
  AUTH_INTERNAL_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().optional(),
  STAGING_BUCKET: z.string().min(1),
  S3_PRESIGN_ENDPOINT_URL: z.string().url().optional(),
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}

export function jwksUrl(): string {
  return `${config.AUTH_INTERNAL_URL.replace(/\/$/, "")}/auth/.well-known/jwks.json`;
}
