import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export function createClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

export type { PrismaClient } from "./generated/client";
export * as Prisma from "./generated/client";
export * from "./generated/models";
export * from "./generated/enums";
