import { defineConfig } from "prisma/config";

// Local dev sets DATABASE_URL; the ECS migrate task injects the four DB_*
// parts (Secrets Manager can't template a full URL).
function datasourceUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { DB_HOST, DB_NAME, DB_USERNAME, DB_PASSWORD } = process.env;
  if (DB_HOST && DB_NAME && DB_USERNAME && DB_PASSWORD) {
    return `postgresql://${encodeURIComponent(DB_USERNAME)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:5432/${DB_NAME}`;
  }
  // Only needed by migrate commands; `generate` works without it.
  return "postgresql://localhost:5432/placeholder";
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: datasourceUrl(),
  },
});
