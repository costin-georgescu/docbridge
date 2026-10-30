import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { ResolveFoldersResponse } from "@docbridge/contracts";
import { createClient, PrismaClient } from "@docbridge/db-docbridge";
import { AppError } from "../src/common/app-error";
import { PlatformClient } from "../src/platform/platform-client";
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
    "jobs.e2e skipped: set API_TEST_DATABASE_URL to run against Postgres",
  );
}

const OWNER_A = "00000000-0000-7000-8000-0000000000aa";
const OWNER_B = "00000000-0000-7000-8000-0000000000bb";
const TEAM_1 = "66666666-7777-4888-8999-000000000001";
const TEAM_2 = "66666666-7777-4888-8999-000000000002";
const TEAM_FOREIGN = "66666666-7777-4888-8999-999999999999";

class StubPlatform {
  constructor(
    private readonly impl: (
      token: string,
      folderIds: string[],
    ) => Promise<ResolveFoldersResponse>,
  ) {}
  resolveFolders(
    token: string,
    folderIds: string[],
  ): Promise<ResolveFoldersResponse> {
    return this.impl(token, folderIds);
  }
}

function resolvingAll(
  byFolder: Record<string, { teamId: string; path: string }>,
): (token: string, folderIds: string[]) => Promise<ResolveFoldersResponse> {
  return async (_token, folderIds) => ({
    resolved: folderIds
      .filter((id) => byFolder[id])
      .map((id) => ({
        folderId: id,
        teamId: byFolder[id].teamId,
        path: byFolder[id].path,
      })),
    missing: folderIds.filter((id) => !byFolder[id]),
  });
}

run("jobs e2e", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let kp: TestKeypair;
  let platformResolve: (
    token: string,
    folderIds: string[],
  ) => Promise<ResolveFoldersResponse>;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const userToken = (sub: string, teams: string[] = [TEAM_1, TEAM_2]) =>
    signToken(kp.privateKey, kp.kid, userPayload({ sub, teams }));
  const api = () => request(app.getHttpServer());

  async function seedStagedFile(
    owner: string,
    overrides: Partial<{
      status: "pending_upload" | "staged";
      stagedAt: Date | null;
      jobId: string;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.stagedFile.create({
      data: {
        id,
        ownerUserId: owner,
        fileName: "file.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        checksumCrc32c: "AAAAAA==",
        storageKey: `staged/${owner}/${id}`,
        status: overrides.status ?? "staged",
        stagedAt: overrides.stagedAt === undefined ? new Date() : overrides.stagedAt,
        jobId: overrides.jobId ?? null,
      },
    });
    return id;
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    kp = await makeKeypair("k1");
    platformResolve = async () => ({ resolved: [], missing: [] });
    app = await bootApp(kp, {
      platformClient: new StubPlatform((token, ids) =>
        platformResolve(token, ids),
      ) as unknown as PlatformClient,
    });
    await db.stagedFile.deleteMany({
      where: { ownerUserId: { in: [OWNER_A, OWNER_B] } },
    });
    await db.job.deleteMany({
      where: { submitterUserId: { in: [OWNER_A, OWNER_B] } },
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.task.deleteMany({
        where: { job: { submitterUserId: { in: [OWNER_A, OWNER_B] } } },
      });
      await db.stagedFile.deleteMany({
        where: { ownerUserId: { in: [OWNER_A, OWNER_B] } },
      });
      await db.job.deleteMany({
        where: { submitterUserId: { in: [OWNER_A, OWNER_B] } },
      });
      await db.$disconnect();
    }
  });

  it("rejects requests without a token", async () => {
    const res = await api().post("/api/jobs").send({}).expect(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects an invalid body with 422", async () => {
    const token = await userToken(OWNER_A);
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId: "nope", folderIds: [] }] })
      .expect(422);
    expect(res.body.error.code).toBe("validation_error");

    const empty = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [] })
      .expect(422);
    expect(empty.body.error.code).toBe("validation_error");
  });

  it("rejects limit violations with 422 limits_exceeded", async () => {
    const token = await userToken(OWNER_A);
    const folderIds = Array.from({ length: 21 }, () => randomUUID());
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({
        mappings: [{ fileId: randomUUID(), folderIds }],
      })
      .expect(422);
    expect(res.body.error.code).toBe("limits_exceeded");
    expect(res.body.error.details.violations).toContain("too_many_folders");

    const noFolder = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId: randomUUID(), folderIds: [] }] })
      .expect(422);
    expect(noFolder.body.error.details.violations).toContain(
      "file_without_folder",
    );

    const sharedFolder = randomUUID();
    const tooManyFiles = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({
        mappings: Array.from({ length: 101 }, () => ({
          fileId: randomUUID(),
          folderIds: [sharedFolder],
        })),
      })
      .expect(422);
    expect(tooManyFiles.body.error.code).toBe("limits_exceeded");
    expect(tooManyFiles.body.error.details.violations).toEqual([
      "too_many_files",
    ]);
  });

  async function expectNothingCommitted(...fileIds: string[]) {
    expect(
      await db.job.count({
        where: { stagedFiles: { some: { id: { in: fileIds } } } },
      }),
    ).toBe(0);
    expect(await db.task.count({ where: { stagedFileId: { in: fileIds } } })).toBe(
      0,
    );
    const rows = await db.stagedFile.findMany({
      where: { id: { in: fileIds } },
      select: { jobId: true },
    });
    expect(rows.every((r) => r.jobId === null)).toBe(true);
  }

  it("returns 404 folder_not_found and commits nothing", async () => {
    const token = await userToken(OWNER_A);
    const fileId = await seedStagedFile(OWNER_A);
    const folderId = randomUUID();
    platformResolve = async (_t, ids) => ({
      resolved: [],
      missing: ids,
    });
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId, folderIds: [folderId] }] })
      .expect(404);
    expect(res.body.error.code).toBe("folder_not_found");
    expect(res.body.error.details.folderIds).toEqual([folderId]);
    await expectNothingCommitted(fileId);
  });

  it("returns 403 folder_not_authorized for a foreign team folder", async () => {
    const token = await userToken(OWNER_A); // teams: TEAM_1, TEAM_2
    const fileId = await seedStagedFile(OWNER_A);
    const folderId = randomUUID();
    platformResolve = resolvingAll({
      [folderId]: { teamId: TEAM_FOREIGN, path: "Foreign/Binder/F" },
    });
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId, folderIds: [folderId] }] })
      .expect(403);
    expect(res.body.error.code).toBe("folder_not_authorized");
    expect(res.body.error.details.folderIds).toEqual([folderId]);
    await expectNothingCommitted(fileId);
  });

  it("returns 503 platform_unavailable when the platform is down", async () => {
    const token = await userToken(OWNER_A);
    const fileId = await seedStagedFile(OWNER_A);
    platformResolve = async () => {
      throw new AppError(
        503,
        "platform_unavailable",
        "Document platform is unavailable",
      );
    };
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId, folderIds: [randomUUID()] }] })
      .expect(503);
    expect(res.body.error.code).toBe("platform_unavailable");
  });

  it("creates a job atomically: job, job_teams, claimed files and tasks", async () => {
    const token = await userToken(OWNER_A);
    const fileA = await seedStagedFile(OWNER_A);
    const fileB = await seedStagedFile(OWNER_A);
    const folder1 = randomUUID();
    const folder2 = randomUUID();
    platformResolve = resolvingAll({
      [folder1]: { teamId: TEAM_1, path: "Team1/Binder/In" },
      [folder2]: { teamId: TEAM_2, path: "Team2/Binder/Out" },
    });

    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({
        mappings: [
          { fileId: fileA, folderIds: [folder1, folder2] },
          { fileId: fileB, folderIds: [folder1] },
        ],
      })
      .expect(202);
    const jobId = res.body.jobId;
    expect(jobId).toBeDefined();

    const job = await db.job.findUnique({
      where: { id: jobId },
      include: { teams: true, tasks: true },
    });
    expect(job).toMatchObject({
      submitterUserId: OWNER_A,
      submitterDisplayName: "Test User",
      filesCount: 2,
      tasksCount: 3,
    });
    expect(job!.teams.map((t) => t.teamId).sort()).toEqual(
      [TEAM_1, TEAM_2].sort(),
    );
    expect(job!.tasks).toHaveLength(3);
    expect(
      job!.tasks.every((t) => t.status === "pending" && t.dispatchedAt === null),
    ).toBe(true);
    const t1 = job!.tasks.find((t) => t.destinationFolderId === folder2)!;
    expect(t1).toMatchObject({
      stagedFileId: fileA,
      destinationTeamId: TEAM_2,
      destinationPath: "Team2/Binder/Out",
    });
    const claimed = await db.stagedFile.findMany({
      where: { id: { in: [fileA, fileB] } },
      select: { id: true, jobId: true },
    });
    expect(claimed.every((f) => f.jobId === jobId)).toBe(true);
  });

  it("returns 409 file_already_submitted on a same-user double submit", async () => {
    const token = await userToken(OWNER_A);
    const fileId = await seedStagedFile(OWNER_A);
    const folderId = randomUUID();
    platformResolve = resolvingAll({
      [folderId]: { teamId: TEAM_1, path: "Team1/B/F" },
    });
    const body = { mappings: [{ fileId, folderIds: [folderId] }] };
    await api().post("/api/jobs").set(bearer(token)).send(body).expect(202);
    const second = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send(body)
      .expect(409);
    expect(second.body.error.code).toBe("file_already_submitted");
    expect(second.body.error.details.files).toEqual([
      { fileId, reason: "file_already_submitted" },
    ]);
    expect(
      await db.job.count({
        where: { stagedFiles: { some: { id: fileId } } },
      }),
    ).toBe(1);
  });

  it("returns 409 file_not_owned for another user's file", async () => {
    const token = await userToken(OWNER_A);
    const fileId = await seedStagedFile(OWNER_B);
    const folderId = randomUUID();
    platformResolve = resolvingAll({
      [folderId]: { teamId: TEAM_1, path: "Team1/B/F" },
    });
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId, folderIds: [folderId] }] })
      .expect(409);
    expect(res.body.error.code).toBe("file_not_owned");
  });

  it("returns 409 file_not_staged and rolls back when a file is pending", async () => {
    const token = await userToken(OWNER_A);
    const staged = await seedStagedFile(OWNER_A);
    const pending = await seedStagedFile(OWNER_A, {
      status: "pending_upload",
      stagedAt: null,
    });
    const folderId = randomUUID();
    platformResolve = resolvingAll({
      [folderId]: { teamId: TEAM_1, path: "Team1/B/F" },
    });
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({
        mappings: [
          { fileId: staged, folderIds: [folderId] },
          { fileId: pending, folderIds: [folderId] },
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe("file_not_staged");

    // nothing committed: no job, no tasks, the staged file stays unclaimed
    await expectNothingCommitted(staged, pending);
    const stagedRow = await db.stagedFile.findUnique({
      where: { id: staged },
      select: { jobId: true, status: true },
    });
    expect(stagedRow).toMatchObject({ jobId: null, status: "staged" });
  });

  it("returns 409 file_expired for a file staged more than 24h ago", async () => {
    const token = await userToken(OWNER_A);
    const fileId = await seedStagedFile(OWNER_A, {
      stagedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const folderId = randomUUID();
    platformResolve = resolvingAll({
      [folderId]: { teamId: TEAM_1, path: "Team1/B/F" },
    });
    const res = await api()
      .post("/api/jobs")
      .set(bearer(token))
      .send({ mappings: [{ fileId, folderIds: [folderId] }] })
      .expect(409);
    expect(res.body.error.code).toBe("file_expired");
  });
});
