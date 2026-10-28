import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import argon2 from "argon2";
import { AppError } from "../common/app-error";
import { PrismaService } from "../prisma/prisma.service";
import { RefreshTokenService } from "../tokens/refresh-token.service";
import { TokenService } from "../tokens/token.service";
import { UserModel } from "@docbridge/db-auth";

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = "";

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(TokenService)
    private readonly tokens: TokenService,
    @Inject(RefreshTokenService)
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argon2.hash("dummy-password");
  }

  async verifyPassword(
    passwordHash: string | null,
    password: string,
  ): Promise<boolean> {
    return argon2.verify(passwordHash ?? this.dummyHash, password);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.db.user.findUnique({ where: { email } });
    const ok = await this.verifyPassword(user?.passwordHash ?? null, password);
    if (!user || !ok) {
      throw new AppError(401, "invalid_credentials", "Invalid credentials");
    }
    if (user.disabledAt) {
      throw new AppError(423, "account_disabled", "Account is disabled");
    }
    return this.issueForUser(user);
  }

  async issueForUser(user: UserModel) {
    const memberships = await this.prisma.db.teamMembership.findMany({
      where: { userId: user.id },
      select: { teamId: true },
    });
    const accessToken = await this.tokens.issueUserToken(
      user,
      memberships.map((m) => m.teamId),
    );
    const refresh = await this.refreshTokens.mint(user.id);
    return { accessToken, refresh };
  }

  async refresh(raw: string) {
    const tokenHash = this.refreshTokens.hash(raw);
    const existing = await this.prisma.db.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!existing || existing.expiresAt.getTime() <= Date.now()) {
      throw new AppError(401, "invalid_refresh", "Invalid refresh token");
    }
    if (existing.replacedBy) {
      await this.refreshTokens.revokeAllForUser(existing.userId);
      throw new AppError(401, "invalid_refresh", "Invalid refresh token");
    }
    if (existing.revokedAt) {
      throw new AppError(401, "invalid_refresh", "Invalid refresh token");
    }
    if (existing.user.disabledAt) {
      await this.refreshTokens.revokeAllForUser(existing.userId);
      throw new AppError(401, "invalid_refresh", "Invalid refresh token");
    }
    const rotated = await this.prisma.db.$transaction(async (tx) => {
      const next = await this.refreshTokens.mint(existing.userId, tx);
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedBy: next.id },
      });
      return next;
    });
    const memberships = await this.prisma.db.teamMembership.findMany({
      where: { userId: existing.userId },
      select: { teamId: true },
    });
    const accessToken = await this.tokens.issueUserToken(
      existing.user,
      memberships.map((m) => m.teamId),
    );
    return { accessToken, refresh: rotated };
  }

  async logout(raw: string): Promise<void> {
    await this.refreshTokens.revokeChain(raw);
  }

  async serviceToken(clientId: string, clientSecret: string) {
    const client = await this.prisma.db.serviceClient.findUnique({
      where: { id: clientId },
    });
    const ok = await this.verifyPassword(
      client?.secretHash ?? null,
      clientSecret,
    );
    if (!client || !ok) {
      throw new AppError(401, "invalid_credentials", "Invalid credentials");
    }
    return this.tokens.issueServiceToken(client.id, client.scopes);
  }
}
