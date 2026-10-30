import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createS3Client } from "@docbridge/storage";
import { createClient, PrismaClient, TaskStatus } from "@docbridge/db-docbridge";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { StagingStorage } from "../src/storage/staging-storage.service";
import { JobFinalizer } from "../src/finalizer/job-finalizer";
import { HousekeepingSweep } from "../src/finalizer/housekeeping.sweep";

const DATABASE_URL = process.env.DISPATCHER_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "finalizer.e2e skipped: set DISPATCHER_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const BUCKET = process.env.STAGING_BUCKET ?? "docbridge-staging";
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "eu-central-1";

run("finalizer + housekeeping e2e", () => {
  let moduleRef: TestingModule;
  let finalizer: JobFinalizer;
  let housekeeping: HousekeepingSweep;
  let storage: StagingStorage;
  let db: PrismaClient;
  const s3 = createS3Client({ region: REGION, endpoint: ENDPOINT });
  const insertedJobIds: string[] = [];
  const insertedFileIds: string[] = [];
  const insertedKeys: string[] = [];

  async function putObject(key: string) {
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "x" }),
    );
    insertedKeys.push(key);
  }

  async function tagsOf(key: string) {
    const res = await s3.send(
      new GetObjectTaggingCommand({ Bucket: BUCKET, Key: key }),
    );
    return res.TagSet ?? [];
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch (e) {
      if (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404) {
        return false;
      }
      throw e;
    }
  }

  async function insertFile(opts: {
    jobId?: string | null;
    createdAt?: Date;
    withObject?: boolean;
  }) {
    const id = randomUUID();
    const owner = randomUUID();
    const key = `staged/${owner}/${id}`;
    await db.stagedFile.create({
      data: {
        id,
        ownerUserId: owner,
        jobId: opts.jobId ?? null,
        fileName: `${id}.pdf`,
        contentType: "application/pdf",
        sizeBytes: 1n,
        checksumCrc32c: "AAAAAA==",
        storageKey: key,
        status: "staged",
        stagedAt: new Date(),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    insertedFileIds.push(id);
    if (opts.withObject) await putObject(key);
    return { id, key };
  }

  async function insertJob(
    taskStatuses: TaskStatus[],
    opts: { fileCount?: number; withObjects?: boolean } = {},
  ) {
    const jobId = randomUUID();
    const owner = randomUUID();
    const fileCount = opts.fileCount ?? 1;
    await db.job.create({
      data: {
        id: jobId,
        submitterUserId: owner,
        submitterDisplayName: "test",
        submittedAt: new Date(),
        filesCount: fileCount,
        tasksCount: taskStatuses.length,
      },
    });
    const files = [];
    for (let i = 0; i < fileCount; i++) {
      files.push(
        await insertFile({ jobId, withObject: opts.withObjects ?? true }),
      );
    }
    for (const [i, status] of taskStatuses.entries()) {
      await db.task.create({
        data: {
          jobId,
          stagedFileId: files[i % files.length].id,
          destinationFolderId: randomUUID(),
          destinationTeamId: randomUUID(),
          destinationPath: "/a/b",
          status,
        },
      });
    }
    insertedJobIds.push(jobId);
    return { jobId, files };
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    finalizer = moduleRef.get(JobFinalizer);
    housekeeping = moduleRef.get(HousekeepingSweep);
    storage = moduleRef.get(StagingStorage);
  }, 60_000);

  afterAll(async () => {
    await db.task.deleteMany({ where: { jobId: { in: insertedJobIds } } });
    await db.stagedFile.deleteMany({
      where: { id: { in: insertedFileIds } },
    });
    await db.jobTeam.deleteMany({ where: { jobId: { in: insertedJobIds } } });
    await db.job.deleteMany({ where: { id: { in: insertedJobIds } } });
    for (const key of insertedKeys) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
        .catch(() => {});
    }
    await moduleRef.close();
    await db.$disconnect();
    s3.destroy();
  });

  it("completes a finished job and tags its staged objects", async () => {
    const { jobId, files } = await insertJob(
      ["completed", "completed", "failed"],
      { fileCount: 2 },
    );

    expect(await finalizer.finalizeOnce()).toBeGreaterThanOrEqual(1);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.completedAt).not.toBeNull();
    expect(job.retentionTaggedAt).not.toBeNull();
    for (const { key } of files) {
      expect(await tagsOf(key)).toEqual([
        { Key: "retention", Value: "completed" },
      ]);
    }
  }, 60_000);

  it("leaves a job with non-final tasks untouched", async () => {
    const { jobId, files } = await insertJob(["completed", "in_progress"]);
    const pending = await insertJob(["pending"]);

    await finalizer.finalizeOnce();

    for (const id of [jobId, pending.jobId]) {
      const job = await db.job.findUniqueOrThrow({ where: { id } });
      expect(job.completedAt).toBeNull();
      expect(job.retentionTaggedAt).toBeNull();
    }
    for (const { key } of [...files, ...pending.files]) {
      expect(await tagsOf(key)).toEqual([]);
    }
  }, 60_000);

  it("sets completed_at exactly once under two concurrent finalizers", async () => {
    const { jobId } = await insertJob(["completed"]);

    const secondDb = new PrismaService();
    const second = new JobFinalizer(secondDb, storage);
    const [a, b] = await Promise.all([
      finalizer.finalizeOnce(),
      second.finalizeOnce(),
    ]);
    await secondDb.db.$disconnect();

    expect(a + b).toBeGreaterThanOrEqual(1);
    const first = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(first.completedAt).not.toBeNull();

    expect(await finalizer.finalizeOnce()).toBe(0);
    const again = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(again.completedAt?.getTime()).toBe(first.completedAt?.getTime());
  }, 60_000);

  it("keeps completed_at when tagging fails and retries the job", async () => {
    const { jobId, files } = await insertJob(["completed"]);

    const spy = jest
      .spyOn(storage.s3, "send")
      .mockImplementationOnce(() => Promise.reject(new Error("s3 down")));
    try {
      await finalizer.finalizeOnce();
    } finally {
      spy.mockRestore();
    }

    const untagged = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(untagged.completedAt).not.toBeNull();
    expect(untagged.retentionTaggedAt).toBeNull();

    expect(await finalizer.finalizeOnce()).toBeGreaterThanOrEqual(1);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.retentionTaggedAt).not.toBeNull();
    expect(job.completedAt?.getTime()).toBe(
      untagged.completedAt?.getTime(),
    );
    for (const { key } of files) {
      expect(await tagsOf(key)).toEqual([
        { Key: "retention", Value: "completed" },
      ]);
    }
  }, 60_000);

  it("housekeeping deletes old orphans with their objects only", async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const orphan = await insertFile({ createdAt: old, withObject: true });
    const noObject = await insertFile({ createdAt: old });
    const fresh = await insertFile({ withObject: true });
    const { jobId, files } = await insertJob(["pending"]);

    const deleted = await housekeeping.sweepOnce();
    expect(deleted).toBeGreaterThanOrEqual(2);

    expect(await db.stagedFile.findUnique({ where: { id: orphan.id } })).toBeNull();
    expect(await db.stagedFile.findUnique({ where: { id: noObject.id } })).toBeNull();
    expect(await objectExists(orphan.key)).toBe(false);

    expect(
      await db.stagedFile.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();
    expect(await objectExists(fresh.key)).toBe(true);
    expect(await db.job.findUnique({ where: { id: jobId } })).not.toBeNull();
    expect(
      await db.stagedFile.findUnique({ where: { id: files[0].id } }),
    ).not.toBeNull();
    expect(await objectExists(files[0].key)).toBe(true);
  }, 60_000);
});
