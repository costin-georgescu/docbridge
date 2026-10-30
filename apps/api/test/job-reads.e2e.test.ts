import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import {
  createClient,
  PrismaClient,
  type TaskStatus,
} from "@docbridge/db-docbridge";
import {
  bootApp,
  makeKeypair,
  signToken,
  TestKeypair,
  userPayload,
} from "./helpers";

const DATABASE_URL = process.env.API_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "job-reads.e2e skipped: set API_TEST_DATABASE_URL to run against Postgres",
  );
}

const OWNER_C = "00000000-0000-7000-8000-0000000000cc";
const OWNER_D = "00000000-0000-7000-8000-0000000000dd";
const TEAM_1 = "66666666-7777-4888-8999-000000000001";
const TEAM_2 = "66666666-7777-4888-8999-000000000002";
const TEAM_3 = "66666666-7777-4888-8999-000000000003";
const TEAM_FOREIGN = "66666666-7777-4888-8999-999999999999";

interface SeedTask {
  status?: TaskStatus;
  attemptCount?: number;
  fileIndex?: number;
  folderId?: string;
  path?: string;
  // Seeded tasks are marked dispatched so a live dispatcher sharing the
  // database does not claim and publish them mid-test.
  dispatchedAt?: Date | null;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

run("job reads e2e", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let kp: TestKeypair;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const userToken = (sub: string, teams: string[] = [TEAM_1, TEAM_2]) =>
    signToken(kp.privateKey, kp.kid, userPayload({ sub, teams }));
  const api = () => request(app.getHttpServer());

  async function seedJob(opts: {
    teams: string[];
    submitter?: string;
    submittedAt?: Date;
    completedAt?: Date | null;
    files?: { name: string; sizeBytes?: number; stagedAt?: Date }[];
    tasks: SeedTask[];
  }): Promise<{ jobId: string; fileIds: string[] }> {
    const submitter = opts.submitter ?? OWNER_C;
    const jobId = uuidv7();
    const files: { name: string; sizeBytes?: number; stagedAt?: Date }[] =
      opts.files ?? opts.tasks.map((_, i) => ({ name: `file-${i}.pdf` }));
    const fileIds = files.map(() => uuidv7());
    await db.job.create({
      data: {
        id: jobId,
        submitterUserId: submitter,
        submitterDisplayName: "Test User",
        submittedAt: opts.submittedAt ?? new Date(),
        completedAt: opts.completedAt ?? null,
        filesCount: files.length,
        tasksCount: opts.tasks.length,
        teams: {
          createMany: { data: opts.teams.map((teamId) => ({ teamId })) },
        },
        stagedFiles: {
          createMany: {
            data: files.map((file, i) => ({
              id: fileIds[i],
              ownerUserId: submitter,
              fileName: file.name,
              contentType: "application/pdf",
              sizeBytes: file.sizeBytes ?? 10,
              checksumCrc32c: "AAAAAA==",
              storageKey: `staged/${submitter}/${fileIds[i]}`,
              status: "staged" as const,
              stagedAt: file.stagedAt ?? new Date(),
            })),
          },
        },
        tasks: {
          createMany: {
            data: opts.tasks.map((task, i) => ({
              id: uuidv7(),
              stagedFileId: fileIds[task.fileIndex ?? i] ?? fileIds[0],
              destinationFolderId: task.folderId ?? uuidv7(),
              destinationTeamId: opts.teams[0],
              destinationPath: task.path ?? "Team/Binder/Folder",
              status: task.status ?? "pending",
              attemptCount: task.attemptCount ?? 0,
              dispatchedAt: task.dispatchedAt ?? new Date(),
              startedAt: task.startedAt ?? null,
              finishedAt: task.finishedAt ?? null,
              lastErrorCode: task.lastErrorCode ?? null,
              lastErrorMessage: task.lastErrorMessage ?? null,
            })),
          },
        },
      },
    });
    return { jobId, fileIds };
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    kp = await makeKeypair("k1");
    app = await bootApp(kp);
    await db.task.deleteMany({
      where: { job: { submitterUserId: { in: [OWNER_C, OWNER_D] } } },
    });
    await db.stagedFile.deleteMany({
      where: { ownerUserId: { in: [OWNER_C, OWNER_D] } },
    });
    await db.job.deleteMany({
      where: { submitterUserId: { in: [OWNER_C, OWNER_D] } },
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.task.deleteMany({
        where: { job: { submitterUserId: { in: [OWNER_C, OWNER_D] } } },
      });
      await db.stagedFile.deleteMany({
        where: { ownerUserId: { in: [OWNER_C, OWNER_D] } },
      });
      await db.job.deleteMany({
        where: { submitterUserId: { in: [OWNER_C, OWNER_D] } },
      });
      await db.$disconnect();
    }
  });

  describe("GET /api/jobs", () => {
    it("rejects requests without a token", async () => {
      const res = await api().get("/api/jobs").expect(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("returns an empty page when nothing is visible", async () => {
      const token = await userToken(OWNER_D, [TEAM_FOREIGN]);
      const res = await api().get("/api/jobs").set(bearer(token)).expect(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it("rejects an invalid limit and a malformed cursor with 422", async () => {
      const token = await userToken(OWNER_C);
      const res = await api()
        .get("/api/jobs?limit=51")
        .set(bearer(token))
        .expect(422);
      expect(res.body.error.code).toBe("validation_error");

      const bad = await api()
        .get("/api/jobs?cursor=not-a-cursor")
        .set(bearer(token))
        .expect(422);
      expect(bad.body.error.code).toBe("validation_error");
    });

    it("lists only jobs whose job_teams intersect the token teams", async () => {
      const visible = await seedJob({
        teams: [TEAM_1],
        tasks: [{ status: "pending" }],
      });
      await seedJob({ teams: [TEAM_FOREIGN], tasks: [{}] });

      const token = await userToken(OWNER_D, [TEAM_2]);
      const other = await api().get("/api/jobs").set(bearer(token)).expect(200);
      expect(
        other.body.items.some((j: { id: string }) => j.id === visible.jobId),
      ).toBe(false);

      const token1 = await userToken(OWNER_D, [TEAM_1]);
      const res = await api().get("/api/jobs").set(bearer(token1)).expect(200);
      const ids = res.body.items.map((j: { id: string }) => j.id);
      expect(ids).toContain(visible.jobId);
    });

    it("makes a job visible to any team member, not only the submitter", async () => {
      const job = await seedJob({
        teams: [TEAM_1, TEAM_2],
        submitter: OWNER_C,
        tasks: [{}],
      });
      const token = await userToken(OWNER_D, [TEAM_2]);
      const res = await api().get("/api/jobs").set(bearer(token)).expect(200);
      const item = res.body.items.find(
        (j: { id: string }) => j.id === job.jobId,
      );
      expect(item).toBeDefined();
      expect(item.submitterDisplayName).toBe("Test User");
    });

    it("derives status and counts per job", async () => {
      const inProgress = await seedJob({
        teams: [TEAM_1],
        submittedAt: new Date("2026-10-01T00:00:00Z"),
        tasks: [{ status: "completed" }, { status: "pending" }],
      });
      const failed = await seedJob({
        teams: [TEAM_1],
        submittedAt: new Date("2026-10-02T00:00:00Z"),
        completedAt: new Date("2026-10-02T00:05:00Z"),
        tasks: [{ status: "failed" }],
      });
      const partial = await seedJob({
        teams: [TEAM_1],
        submittedAt: new Date("2026-10-03T00:00:00Z"),
        completedAt: new Date("2026-10-03T00:05:00Z"),
        tasks: [{ status: "completed" }, { status: "failed" }],
      });

      const token = await userToken(OWNER_C, [TEAM_1]);
      const res = await api().get("/api/jobs").set(bearer(token)).expect(200);
      const items = res.body.items as {
        id: string;
        status: string;
        completedAt: string | null;
        counts: {
          pending: number;
          inProgress: number;
          completed: number;
          failed: number;
        };
      }[];
      const byId = new Map(items.map((j) => [j.id, j]));

      const ip = byId.get(inProgress.jobId)!;
      expect(ip.status).toBe("in_progress");
      expect(ip.counts).toEqual({
        pending: 1,
        inProgress: 0,
        completed: 1,
        failed: 0,
      });
      expect(ip.completedAt).toBeNull();

      expect(byId.get(failed.jobId)!.status).toBe("failed");
      expect(byId.get(failed.jobId)!.completedAt).toBe(
        "2026-10-02T00:05:00.000Z",
      );
      expect(byId.get(partial.jobId)!.status).toBe("completed_with_failures");
    });

    it("paginates with a keyset cursor in submitted_at desc order", async () => {
      // TEAM_3 is dedicated to this test so no other seeded job can
      // land inside the paginated result set.
      const older = await seedJob({
        teams: [TEAM_3],
        submittedAt: new Date("2026-09-01T00:00:00Z"),
        tasks: [{}],
      });
      const middle = await seedJob({
        teams: [TEAM_3],
        submittedAt: new Date("2026-09-02T00:00:00Z"),
        tasks: [{}],
      });
      const newer = await seedJob({
        teams: [TEAM_3],
        submittedAt: new Date("2026-09-03T00:00:00Z"),
        tasks: [{}],
      });

      const token = await userToken(OWNER_D, [TEAM_3]);
      const page1 = await api()
        .get("/api/jobs?limit=2")
        .set(bearer(token))
        .expect(200);
      expect(page1.body.items.length).toBe(2);
      expect(page1.body.nextCursor).not.toBeNull();
      const firstIds = page1.body.items.map((j: { id: string }) => j.id);
      expect(firstIds).toEqual([newer.jobId, middle.jobId]);

      const page2 = await api()
        .get(`/api/jobs?limit=2&cursor=${page1.body.nextCursor}`)
        .set(bearer(token))
        .expect(200);
      const secondIds = page2.body.items.map((j: { id: string }) => j.id);
      expect(secondIds).toEqual([older.jobId]);
      expect(page2.body.nextCursor).toBeNull();
    });
  });

  describe("GET /api/jobs/:id", () => {
    it("rejects requests without a token", async () => {
      const res = await api().get(`/api/jobs/${uuidv7()}`).expect(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("answers 403 job_not_visible for missing and malformed ids alike", async () => {
      const token = await userToken(OWNER_C, [TEAM_1]);
      const missing = await api()
        .get(`/api/jobs/${uuidv7()}`)
        .set(bearer(token))
        .expect(403);
      expect(missing.body.error.code).toBe("job_not_visible");

      const malformed = await api()
        .get("/api/jobs/not-a-uuid")
        .set(bearer(token))
        .expect(403);
      expect(malformed.body.error.code).toBe("job_not_visible");
    });

    it("answers 403 job_not_visible when teams do not intersect", async () => {
      const job = await seedJob({ teams: [TEAM_FOREIGN], tasks: [{}] });
      const token = await userToken(OWNER_C, [TEAM_1, TEAM_2]);
      const res = await api()
        .get(`/api/jobs/${job.jobId}`)
        .set(bearer(token))
        .expect(403);
      expect(res.body.error.code).toBe("job_not_visible");
    });

    it("returns the job with files and tasks joined to staged files", async () => {
      const folderId = uuidv7();
      const job = await seedJob({
        teams: [TEAM_1],
        files: [
          { name: "alpha.pdf", sizeBytes: 100 },
          { name: "beta.pdf", sizeBytes: 200 },
        ],
        tasks: [
          {
            fileIndex: 0,
            folderId,
            path: "Team One / Binder / Inbox",
            status: "failed",
            attemptCount: 1,
            lastErrorCode: "folder_not_found",
            lastErrorMessage: "Folder was deleted",
            startedAt: new Date("2026-10-10T10:00:00Z"),
            finishedAt: new Date("2026-10-10T10:00:05Z"),
          },
          { fileIndex: 1, status: "completed", attemptCount: 1 },
          { fileIndex: 1, status: "pending", attemptCount: 2 },
        ],
      });

      const token = await userToken(OWNER_D, [TEAM_1]);
      const res = await api()
        .get(`/api/jobs/${job.jobId}`)
        .set(bearer(token))
        .expect(200);

      expect(res.body.id).toBe(job.jobId);
      expect(res.body.filesCount).toBe(2);
      expect(res.body.tasksCount).toBe(3);
      expect(res.body.status).toBe("in_progress");
      expect(res.body.counts).toEqual({
        pending: 1,
        inProgress: 0,
        completed: 1,
        failed: 1,
      });

      const filesById = new Map(
        res.body.files.map((f: { id: string }) => [f.id, f]),
      );
      expect(filesById.get(job.fileIds[0])).toMatchObject({
        name: "alpha.pdf",
        sizeBytes: 100,
      });
      expect(filesById.get(job.fileIds[1])).toMatchObject({
        name: "beta.pdf",
        sizeBytes: 200,
      });

      expect(res.body.tasks).toHaveLength(3);
      const failedTask = res.body.tasks.find(
        (t: { status: string }) => t.status === "failed",
      );
      expect(failedTask).toMatchObject({
        fileId: job.fileIds[0],
        destination: { folderId, path: "Team One / Binder / Inbox" },
        attemptCount: 1,
        lastError: { code: "folder_not_found", message: "Folder was deleted" },
        startedAt: "2026-10-10T10:00:00.000Z",
        finishedAt: "2026-10-10T10:00:05.000Z",
      });
      const pendingTask = res.body.tasks.find(
        (t: { status: string }) => t.status === "pending",
      );
      expect(pendingTask.fileId).toBe(job.fileIds[1]);
      expect(pendingTask.attemptCount).toBe(2);
      expect(pendingTask.lastError).toBeNull();
    });
  });

  describe("GET /api/jobs/:id/files/:fileId/download", () => {
    it("rejects requests without a token", async () => {
      const res = await api()
        .get(`/api/jobs/${uuidv7()}/files/${uuidv7()}/download`)
        .expect(401);
      expect(res.body.error.code).toBe("unauthorized");
    });

    it("answers 403 job_not_visible for missing, malformed and foreign-team jobs", async () => {
      const foreign = await seedJob({ teams: [TEAM_FOREIGN], tasks: [{}] });
      const token = await userToken(OWNER_C, [TEAM_1]);
      for (const jobId of [uuidv7(), "not-a-uuid", foreign.jobId]) {
        const res = await api()
          .get(`/api/jobs/${jobId}/files/${uuidv7()}/download`)
          .set(bearer(token))
          .expect(403);
        expect(res.body.error.code).toBe("job_not_visible");
      }
    });

    it("answers 404 file_not_in_job for a file attached to a different job", async () => {
      const a = await seedJob({ teams: [TEAM_1], tasks: [{}] });
      const b = await seedJob({ teams: [TEAM_1], tasks: [{}] });
      const token = await userToken(OWNER_D, [TEAM_1]);
      const res = await api()
        .get(`/api/jobs/${a.jobId}/files/${b.fileIds[0]}/download`)
        .set(bearer(token))
        .expect(404);
      expect(res.body.error.code).toBe("file_not_in_job");
    });

    it("answers 404 file_not_in_job when the file sits on the job but has no task", async () => {
      const job = await seedJob({
        teams: [TEAM_1],
        files: [{ name: "a.pdf" }, { name: "b.pdf" }],
        tasks: [{ fileIndex: 0 }],
      });
      const token = await userToken(OWNER_C, [TEAM_1]);
      const res = await api()
        .get(`/api/jobs/${job.jobId}/files/${job.fileIds[1]}/download`)
        .set(bearer(token))
        .expect(404);
      expect(res.body.error.code).toBe("file_not_in_job");
    });

    it("answers 410 file_expired once staged_at + 32 days has passed", async () => {
      const job = await seedJob({
        teams: [TEAM_1],
        files: [
          {
            name: "old.pdf",
            stagedAt: new Date(Date.now() - 33 * 24 * 60 * 60 * 1000),
          },
        ],
        tasks: [{}],
      });
      const token = await userToken(OWNER_C, [TEAM_1]);
      const res = await api()
        .get(`/api/jobs/${job.jobId}/files/${job.fileIds[0]}/download`)
        .set(bearer(token))
        .expect(410);
      expect(res.body.error.code).toBe("file_expired");
    });

    it("returns a 5-minute presigned GET with attachment disposition", async () => {
      const job = await seedJob({
        teams: [TEAM_1],
        files: [{ name: "report.pdf" }],
        tasks: [{}],
      });
      const token = await userToken(OWNER_D, [TEAM_1]);
      const res = await api()
        .get(`/api/jobs/${job.jobId}/files/${job.fileIds[0]}/download`)
        .set(bearer(token))
        .expect(200);
      const u = new URL(res.body.url);
      expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
      expect(u.pathname).toContain(`staged/${OWNER_C}/${job.fileIds[0]}`);
      const disposition =
        u.searchParams.get("response-content-disposition") ?? "";
      expect(disposition).toContain('attachment; filename="report.pdf"');
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
      expect(Date.parse(res.body.expiresAt)).toBeLessThanOrEqual(
        Date.now() + 300_000,
      );
    });
  });
});
