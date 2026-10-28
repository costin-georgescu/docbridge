import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@docbridge/db-auth";
import { REFRESH_TOKEN_TTL_S } from "../constants";
import { PrismaService } from "../prisma/prisma.service";

type Tx = Prisma.Prisma.TransactionClient;

@Injectable()
export class RefreshTokenService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  private client(tx?: Tx): PrismaClient | Tx {
    return tx ?? this.prisma.db;
  }

  hash(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  async mint(userId: string, tx?: Tx): Promise<{ raw: string; id: string }> {
    const raw = randomBytes(32).toString("base64url");
    const row = await this.client(tx).refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(raw),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000),
      },
    });
    return { raw, id: row.id };
  }

  async revokeChain(raw: string): Promise<void> {
    const tokenHash = this.hash(raw);
    await this.prisma.db.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string, tx?: Tx): Promise<void> {
    await this.client(tx).refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
