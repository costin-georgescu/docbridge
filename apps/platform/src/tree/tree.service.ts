import { Inject, Injectable } from "@nestjs/common";
import { TreeResponse } from "@docbridge/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { buildTree } from "./build-tree";

@Injectable()
export class TreeService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async getTree(
    scope: { teamIds: string[] } | { all: true },
  ): Promise<TreeResponse> {
    const all = "all" in scope;
    if (!all && scope.teamIds.length === 0) {
      return { teams: [] };
    }
    const teams = await this.prisma.db.team.findMany({
      where: all ? {} : { id: { in: scope.teamIds } },
      select: { id: true, name: true },
    });
    const binders = await this.prisma.db.binder.findMany({
      where: { teamId: { in: teams.map((t) => t.id) } },
      select: { id: true, teamId: true, name: true },
    });
    const folders = await this.prisma.db.folder.findMany({
      where: { binderId: { in: binders.map((b) => b.id) } },
      select: { id: true, binderId: true, parentFolderId: true, name: true },
    });
    return buildTree(teams, binders, folders);
  }
}
