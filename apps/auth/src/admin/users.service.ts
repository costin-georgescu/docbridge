import { Inject, Injectable } from "@nestjs/common";
import argon2 from "argon2";
import { Prisma, UserModel } from "@docbridge/db-auth";
import { CreateUserRequest, UserResponse } from "@docbridge/contracts";
import { AppError } from "../common/app-error";
import { PrismaService } from "../prisma/prisma.service";
import { RefreshTokenService } from "../tokens/refresh-token.service";

type UserWithMemberships = UserModel & { memberships: { teamId: string }[] };

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(RefreshTokenService)
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  private toResponse(user: UserWithMemberships): UserResponse {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      teamIds: user.memberships.map((m) => m.teamId),
      disabledAt: user.disabledAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async create(body: CreateUserRequest): Promise<UserResponse> {
    const passwordHash = await argon2.hash(body.password);
    try {
      const user = await this.prisma.db.user.create({
        data: {
          email: body.email,
          displayName: body.displayName,
          passwordHash,
          memberships: {
            createMany: {
              data: body.teamIds.map((teamId) => ({ teamId })),
            },
          },
        },
        include: { memberships: true },
      });
      return this.toResponse(user);
    } catch (err) {
      if (
        err instanceof Prisma.Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new AppError(409, "email_already_exists", "Email already exists");
      }
      throw err;
    }
  }

  async list(cursor: string | undefined, limit: number) {
    const rows = await this.prisma.db.user.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      take: limit + 1,
      include: { memberships: true },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((u) => this.toResponse(u)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async replaceTeams(id: string, teamIds: string[]): Promise<UserResponse> {
    const user = await this.prisma.db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError(404, "user_not_found", "User not found");
      }
      await tx.teamMembership.deleteMany({ where: { userId: id } });
      await tx.teamMembership.createMany({
        data: teamIds.map((teamId) => ({ userId: id, teamId })),
      });
      return tx.user.findUniqueOrThrow({
        where: { id },
        include: { memberships: true },
      });
    });
    return this.toResponse(user);
  }

  async disable(id: string): Promise<void> {
    try {
      await this.prisma.db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id },
          data: { disabledAt: new Date() },
        });
        await this.refreshTokens.revokeAllForUser(id, tx);
      });
    } catch (err) {
      if (
        err instanceof Prisma.Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        throw new AppError(404, "user_not_found", "User not found");
      }
      throw err;
    }
  }
}
