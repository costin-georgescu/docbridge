import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createClient, PrismaClient } from "@docbridge/db-platform";
import { getDatabaseUrl } from "../config";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly db: PrismaClient = createClient(getDatabaseUrl());

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}
