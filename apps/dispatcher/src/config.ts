import { z } from "zod";
import {
  baseEnvSchema,
  loadConfig,
  databaseUrlFromEnv,
} from "@docbridge/config";

export const envSchema = baseEnvSchema.extend({
  STAGING_BUCKET: z.string().min(1),
  UPLOAD_EVENTS_QUEUE_URL: z.string().url(),
  TASKS_QUEUE_URL: z.string().url(),
});

export const config = loadConfig(envSchema);

export function getDatabaseUrl(): string {
  return databaseUrlFromEnv();
}
