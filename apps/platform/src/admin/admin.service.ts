import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@docbridge/db-platform";
import {
  BinderResponse,
  CreateBinderRequest,
  CreateFolderRequest,
  CreateTeamRequest,
  FolderResponse,
  TeamResponse,
} from "@docbridge/contracts";
import { AppError } from "../common/app-error";
import { PrismaService } from "../prisma/prisma.service";

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async createTeam(body: CreateTeamRequest): Promise<TeamResponse> {
    const team = await this.prisma.db.team.create({
      data: { name: body.name },
    });
    return {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt.toISOString(),
    };
  }

  async createBinder(body: CreateBinderRequest): Promise<BinderResponse> {
    const team = await this.prisma.db.team.findUnique({
      where: { id: body.teamId },
    });
    if (!team) {
      throw new AppError(404, "team_not_found", "Team not found");
    }
    try {
      const binder = await this.prisma.db.binder.create({
        data: { teamId: body.teamId, name: body.name },
      });
      return { id: binder.id, teamId: binder.teamId, name: binder.name };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(
          409,
          "name_already_exists",
          "Binder name already exists in this team",
        );
      }
      throw err;
    }
  }

  async createFolder(body: CreateFolderRequest): Promise<FolderResponse> {
    const binder = await this.prisma.db.binder.findUnique({
      where: { id: body.binderId },
    });
    if (!binder) {
      throw new AppError(404, "binder_not_found", "Binder not found");
    }
    if (body.parentFolderId) {
      const parent = await this.prisma.db.folder.findUnique({
        where: { id: body.parentFolderId },
      });
      if (!parent || parent.binderId !== body.binderId) {
        throw new AppError(
          404,
          "folder_not_found",
          "Parent folder not found in this binder",
          { parentFolderId: body.parentFolderId },
        );
      }
    }
    const existing = await this.prisma.db.folder.findFirst({
      where: {
        binderId: body.binderId,
        parentFolderId: body.parentFolderId,
        name: body.name,
      },
    });
    if (existing) {
      throw new AppError(
        409,
        "name_already_exists",
        "Folder name already exists at this level",
      );
    }
    try {
      const folder = await this.prisma.db.folder.create({
        data: {
          binderId: body.binderId,
          parentFolderId: body.parentFolderId,
          name: body.name,
        },
      });
      return {
        id: folder.id,
        binderId: folder.binderId,
        parentFolderId: folder.parentFolderId,
        name: folder.name,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(
          409,
          "name_already_exists",
          "Folder name already exists at this level",
        );
      }
      throw err;
    }
  }
}
