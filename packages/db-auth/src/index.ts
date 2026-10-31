import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

// Per-service pool size is tuned via `connection_limit` in the service's
// DATABASE_URL (TDD 5.3). The pg driver doesn't understand the parameter,
// so it is mapped to the pool's `max` and stripped from the URL.
export function createClient(databaseUrl: string): PrismaClient {
  let connectionString = databaseUrl;
  let max: number | undefined;
  try {
    const url = new URL(databaseUrl);
    const limit = Number(url.searchParams.get("connection_limit"));
    if (Number.isInteger(limit) && limit > 0) {
      max = limit;
      url.searchParams.delete("connection_limit");
      connectionString = url.toString();
    }
  } catch {
    // Not a URL (e.g. keyword/value format): pass through unchanged.
  }
  const adapter = new PrismaPg({ connectionString, max });
  return new PrismaClient({ adapter });
}

export type { PrismaClient } from "./generated/client";
export * as Prisma from "./generated/client";
export * from "./generated/models";
export * from "./generated/enums";
