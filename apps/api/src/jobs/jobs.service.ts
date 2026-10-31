import { Inject, Injectable } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  checkJobLimits,
  CreateJobRequest,
  CreateJobResponse,
  deriveJobStatus,
  encodeJobCursor,
  ErrorCode,
  JobDetailResponse,
  JobFileDownloadResponse,
  JobListQuery,
  JobListResponse,
  JobSummary,
  TaskCounts,
  type UserClaims,
} from "@docbridge/contracts";
import { Prisma, type TaskStatus } from "@docbridge/db-docbridge";
import { presignGetObject } from "@docbridge/storage";
import { AppError } from "../common/app-error";
import { PlatformClient } from "../platform/platform-client";
import { PrismaService } from "../prisma/prisma.service";
import { StagingStorage } from "../storage/staging-storage.service";

class ClaimMismatch extends Error {}

const GET_URL_TTL_SECONDS = 300;
const STAGED_FILE_TTL_MS = 32 * 24 * 60 * 60 * 1000;

@Injectable()
export class JobsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlatformClient) private readonly platform: PlatformClient,
    @Inject(StagingStorage) private readonly storage: StagingStorage,
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

    const resolved = await this.platform.resolveFolders(bearerToken, [
      ...new Set(mappings.flatMap((m) => m.folderIds)),
    ]);
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
    const byFolder = new Map(resolved.resolved.map((r) => [r.folderId, r]));

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
        // One INSERT over unnested column arrays: at the 2,000-task limit a
        // per-row createMany costs far more client CPU than a single
        // statement the server expands itself.
        const taskIds: string[] = [];
        const taskFileIds: string[] = [];
        const taskFolderIds: string[] = [];
        const taskTeamIds: string[] = [];
        const taskPaths: string[] = [];
        for (const m of mappings) {
          for (const folderId of m.folderIds) {
            const dest = byFolder.get(folderId)!;
            taskIds.push(uuidv7());
            taskFileIds.push(m.fileId);
            taskFolderIds.push(folderId);
            taskTeamIds.push(dest.teamId);
            taskPaths.push(dest.path);
          }
        }
        await tx.$executeRaw`
          INSERT INTO tasks (
            id, job_id, staged_file_id, destination_folder_id,
            destination_team_id, destination_path, status, created_at
          )
          SELECT
            t.id, ${jobId}::uuid, t.staged_file_id, t.folder_id,
            t.team_id, t.path, 'pending'::task_status, now()
          FROM unnest(
            ${taskIds}::uuid[],
            ${taskFileIds}::uuid[],
            ${taskFolderIds}::uuid[],
            ${taskTeamIds}::uuid[],
            ${taskPaths}::text[]
          ) AS t(id, staged_file_id, folder_id, team_id, path)`;
      });
    } catch (err) {
      if (err instanceof ClaimMismatch) {
        throw await this.classifyClaimFailure(claims.sub, fileIds);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { jobId };
  }

  async listJobs(
    claims: UserClaims,
    query: JobListQuery,
  ): Promise<JobListResponse> {
    const rows = await this.prisma.db.job.findMany({
      where: {
        teams: { some: { teamId: { in: claims.teams } } },
        ...(query.cursor && {
          OR: [
            { submittedAt: { lt: query.cursor.submittedAt } },
            {
              submittedAt: query.cursor.submittedAt,
              id: { lt: query.cursor.id },
            },
          ],
        }),
      },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const counts = await this.countTasksByStatus(page.map((j) => j.id));
    const last = page[page.length - 1];
    return {
      items: page.map((job) => this.toSummary(job, counts.get(job.id))),
      nextCursor:
        rows.length > query.limit && last
          ? encodeJobCursor({ submittedAt: last.submittedAt, id: last.id })
          : null,
    };
  }

  async getJob(claims: UserClaims, id: string): Promise<JobDetailResponse> {
    const job = z.uuid().safeParse(id).success
      ? await this.prisma.db.job.findFirst({
          where: { id, teams: { some: { teamId: { in: claims.teams } } } },
          include: {
            stagedFiles: {
              select: { id: true, fileName: true, sizeBytes: true },
              orderBy: { id: "asc" },
            },
            tasks: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
          },
        })
      : null;
    if (!job) {
      throw new AppError(
        403,
        "job_not_visible",
        "Job not found or not visible",
      );
    }
    const counts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
    let pendingAttempts = 0;
    for (const task of job.tasks) {
      counts[countKey(task.status)] += 1;
      if (task.status === "pending") {
        pendingAttempts += task.attemptCount;
      }
    }
    return {
      ...this.toSummary(job, { ...counts, pendingAttempts }),
      files: job.stagedFiles.map((file) => ({
        id: file.id,
        name: file.fileName,
        sizeBytes: Number(file.sizeBytes),
      })),
      tasks: job.tasks.map((task) => ({
        id: task.id,
        fileId: task.stagedFileId,
        destination: {
          folderId: task.destinationFolderId,
          path: task.destinationPath,
        },
        status: task.status,
        attemptCount: task.attemptCount,
        lastError: task.lastErrorCode
          ? { code: task.lastErrorCode, message: task.lastErrorMessage }
          : null,
        startedAt: task.startedAt?.toISOString() ?? null,
        finishedAt: task.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  async downloadFile(
    claims: UserClaims,
    jobId: string,
    fileId: string,
  ): Promise<JobFileDownloadResponse> {
    const visible = z.uuid().safeParse(jobId).success
      ? await this.prisma.db.job.findFirst({
          where: {
            id: jobId,
            teams: { some: { teamId: { in: claims.teams } } },
          },
          select: { id: true },
        })
      : null;
    if (!visible) {
      throw new AppError(
        403,
        "job_not_visible",
        "Job not found or not visible",
      );
    }
    const file = z.uuid().safeParse(fileId).success
      ? await this.prisma.db.stagedFile.findFirst({
          where: { id: fileId, tasks: { some: { jobId } } },
        })
      : null;
    if (!file) {
      throw new AppError(
        404,
        "file_not_in_job",
        "File is not part of this job",
      );
    }
    const cutoff = new Date(Date.now() - STAGED_FILE_TTL_MS);
    if (file.stagedAt === null || file.stagedAt <= cutoff) {
      throw new AppError(410, "file_expired", "File is no longer available");
    }
    const { url } = await presignGetObject(this.storage.presign, {
      bucket: this.storage.bucket,
      key: file.storageKey,
      downloadName: file.fileName,
      expiresIn: GET_URL_TTL_SECONDS,
    });
    return { url, expiresAt: expiresAtIso(GET_URL_TTL_SECONDS) };
  }

  private async countTasksByStatus(
    jobIds: string[],
  ): Promise<Map<string, TaskCounts & { pendingAttempts: number }>> {
    const grouped =
      jobIds.length === 0
        ? []
        : await this.prisma.db.task.groupBy({
            by: ["jobId", "status"],
            where: { jobId: { in: jobIds } },
            _count: { _all: true },
            _sum: { attemptCount: true },
          });
    const counts = new Map<string, TaskCounts & { pendingAttempts: number }>();
    for (const row of grouped) {
      const acc = counts.get(row.jobId) ?? {
        pending: 0,
        inProgress: 0,
        completed: 0,
        failed: 0,
        pendingAttempts: 0,
      };
      acc[countKey(row.status)] += row._count._all;
      if (row.status === "pending") {
        acc.pendingAttempts += row._sum.attemptCount ?? 0;
      }
      counts.set(row.jobId, acc);
    }
    return counts;
  }

  private toSummary(
    job: {
      id: string;
      submittedAt: Date;
      submitterDisplayName: string;
      filesCount: number;
      tasksCount: number;
      completedAt: Date | null;
    },
    counts: (TaskCounts & { pendingAttempts: number }) | undefined,
  ): JobSummary {
    const c = counts ?? {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      pendingAttempts: 0,
    };
    return {
      id: job.id,
      submittedAt: job.submittedAt.toISOString(),
      submitterDisplayName: job.submitterDisplayName,
      filesCount: job.filesCount,
      tasksCount: job.tasksCount,
      counts: {
        pending: c.pending,
        inProgress: c.inProgress,
        completed: c.completed,
        failed: c.failed,
      },
      status: deriveJobStatus(c),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
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
      files.push(
        ...fileIds.map((fileId) => ({
          fileId,
          reason: "file_not_staged" as ErrorCode,
        })),
      );
    }
    return new AppError(
      409,
      files[0].reason,
      "Some files cannot be submitted",
      { files },
    );
  }
}

function expiresAtIso(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function countKey(status: TaskStatus): keyof TaskCounts {
  return status === "in_progress" ? "inProgress" : status;
}
