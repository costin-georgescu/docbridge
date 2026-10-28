import { Inject, Injectable } from "@nestjs/common";
import { ResolveFoldersResponse } from "@docbridge/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { folderPath } from "./build-paths";
import { FolderRow } from "../tree/build-tree";

@Injectable()
export class FoldersService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async resolve(folderIds: string[]): Promise<ResolveFoldersResponse> {
    const uniqueIds = [...new Set(folderIds)];
    const found = await this.prisma.db.folder.findMany({
      where: { id: { in: uniqueIds } },
      include: { binder: { include: { team: true } } },
    });
    const binderIds = [...new Set(found.map((f) => f.binderId))];
    const siblings = await this.prisma.db.folder.findMany({
      where: { binderId: { in: binderIds } },
      select: { id: true, binderId: true, parentFolderId: true, name: true },
    });
    const foldersById = new Map<string, FolderRow>(
      siblings.map((f) => [f.id, f]),
    );
    const foundById = new Map(found.map((f) => [f.id, f]));
    const resolved = uniqueIds
      .filter((id) => foundById.has(id))
      .map((id) => {
        const folder = foundById.get(id)!;
        return {
          folderId: id,
          teamId: folder.binder.teamId,
          path: folderPath(id, foldersById, folder.binder, folder.binder.team),
        };
      });
    const missing = uniqueIds.filter((id) => !foundById.has(id));
    return { resolved, missing };
  }
}
