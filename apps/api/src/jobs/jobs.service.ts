import { Inject, Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import {
  checkJobLimits,
  CreateJobRequest,
  CreateJobResponse,
  ErrorCode,
  type UserClaims,
} from "@docbridge/contracts";
import { Prisma } from "@docbridge/db-docbridge";
import { AppError } from "../common/app-error";
import { PlatformClient } from "../platform/platform-client";
import { PrismaService } from "../prisma/prisma.service";

class ClaimMismatch extends Error {}

@Injectable()
export class JobsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlatformClient) private readonly platform: PlatformClient,
  ) {}

  async createJob(
    claims: UserClaims,
    bearerToken: string,
    req: CreateJobRequest,
  ): Promise<CreateJobResponse> {
    const byFile = new Map<string, Set<string>>();
    for (const mapping of req.mappings) {
      const folders = byFile.get(mapping.fileId) ?? new Set<string>();
      for (const folderId of mapping.folderIds) {
        folders.add(folderId);
      }
      byFile.set(mapping.fileId, folders);
    }
    const mappings = [...byFile.entries()].map(([fileId, folderIds]) => ({
      fileId,
      folderIds: [...folderIds],
    }));
    const limits = checkJobLimits(mappings);
    if (limits.violations.length > 0) {
      throw new AppError(422, "limits_exceeded", "Job limits exceeded", {
        violations: limits.violations,
      });
    }

    const resolved = await this.platform.resolveFolders(
      bearerToken,
      [...new Set(mappings.flatMap((m) => m.folderIds))],
    );
    if (resolved.missing.length > 0) {
      throw new AppError(404, "folder_not_found", "Folder not found", {
        folderIds: resolved.missing,
      });
    }
    const teams = new Set(claims.teams);
    const denied = resolved.resolved
      .filter((r) => !teams.has(r.teamId))
      .map((r) => r.folderId);
    if (denied.length > 0) {
      throw new AppError(
        403,
        "folder_not_authorized",
        "Folder belongs to a team you are not a member of",
        { folderIds: denied },
      );
    }
    const byFolder = new Map(
      resolved.resolved.map((r) => [r.folderId, r]),
    );

    const fileIds = mappings.map((m) => m.fileId);
    const jobId = uuidv7();
    try {
      await this.prisma.db.$transaction(async (tx) => {
        await tx.job.create({
          data: {
            id: jobId,
            submitterUserId: claims.sub,
            submitterDisplayName: claims.name,
            submittedAt: new Date(),
            filesCount: fileIds.length,
            tasksCount: limits.tasks,
          },
        });
        await tx.jobTeam.createMany({
          data: [...teams].map((teamId) => ({ jobId, teamId })),
        });
        const idList = Prisma.Prisma.join(
          fileIds.map((id) => Prisma.Prisma.sql`${id}::uuid`),
        );
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          UPDATE staged_files
          SET job_id = ${jobId}::uuid
          WHERE id IN (${idList})
            AND owner_user_id = ${claims.sub}::uuid
            AND status = 'staged'
            AND job_id IS NULL
            AND staged_at > now() - interval '24 hours'
          RETURNING id`;
        if (claimed.length !== fileIds.length) {
          throw new ClaimMismatch();
        }
        await tx.task.createMany({
          data: mappings.flatMap((m) =>
            m.folderIds.map((folderId) => {
              const dest = byFolder.get(folderId)!;
              return {
                jobId,
                stagedFileId: m.fileId,
                destinationFolderId: folderId,
                destinationTeamId: dest.teamId,
                destinationPath: dest.path,
                status: "pending" as const,
              };
            }),
          ),
        });
      });
    } catch (err) {
      if (err instanceof ClaimMismatch) {
        throw await this.classifyClaimFailure(claims.sub, fileIds);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { jobId };
  }

  private async classifyClaimFailure(
    caller: string,
    fileIds: string[],
  ): Promise<AppError> {
    const rows = await this.prisma.db.stagedFile.findMany({
      where: { id: { in: fileIds } },
      select: {
        id: true,
        ownerUserId: true,
        status: true,
        jobId: true,
        stagedAt: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const files: { fileId: string; reason: ErrorCode }[] = [];
    for (const fileId of fileIds) {
      const row = byId.get(fileId);
      let reason: ErrorCode | null;
      if (!row || row.ownerUserId !== caller) {
        reason = "file_not_owned";
      } else if (row.jobId !== null) {
        reason = "file_already_submitted";
      } else if (row.status !== "staged") {
        reason = "file_not_staged";
      } else if (row.stagedAt === null || row.stagedAt <= cutoff) {
        reason = "file_expired";
      } else {
        reason = null;
      }
      if (reason !== null) {
        files.push({ fileId, reason });
      }
    }
    if (files.length === 0) {
      files.push(...fileIds.map((fileId) => ({
        fileId,
        reason: "file_not_staged" as ErrorCode,
      })));
    }
    return new AppError(
      409,
      files[0].reason,
      "Some files cannot be submitted",
      { files },
    );
  }
}
