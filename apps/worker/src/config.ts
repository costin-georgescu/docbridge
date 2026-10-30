import { z } from "zod";
import {
  baseEnvSchema,
  loadConfig,
  databaseUrlFromEnv,
} from "@docbridge/config";

export const envSchema = baseEnvSchema.extend({
  STAGING_BUCKET: z.string().min(1),
  TASKS_QUEUE_URL: z.string().url(),
  AUTH_INTERNAL_URL: z.string().url(),
  PLATFORM_INTERNAL_URL: z.string().url(),
  WORKER_CLIENT_ID: z.string().min(1).default("worker"),
  WORKER_CLIENT_SECRET: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}
