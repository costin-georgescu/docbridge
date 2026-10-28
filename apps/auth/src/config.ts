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
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}
