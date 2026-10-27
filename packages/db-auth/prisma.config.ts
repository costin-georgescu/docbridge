import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Only needed by migrate commands; `generate` works without it.
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder",
  },
});
