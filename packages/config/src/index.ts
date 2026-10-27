import { z } from "zod";

export const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.string().url().optional(),
});

export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "<env>"}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/**
 * Builds a Postgres URL from either DATABASE_URL (local dev) or the four
 * DB_* parts injected in AWS (Secrets Manager can't template a full URL).
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DB_HOST, DB_NAME, DB_USERNAME, DB_PASSWORD } = env;
  const missing = ["DB_HOST", "DB_NAME", "DB_USERNAME", "DB_PASSWORD"].filter(
    (k) => !env[k],
  );
  if (missing.length) {
    throw new Error(
      `Invalid environment configuration:\n${missing.map((k) => `${k}: required`).join("\n")}`,
    );
  }
  return `postgresql://${encodeURIComponent(DB_USERNAME!)}:${encodeURIComponent(DB_PASSWORD!)}@${DB_HOST}:5432/${DB_NAME}`;
}
