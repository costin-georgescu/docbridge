import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TaskMessage } from "@docbridge/contracts";
import { createClient, PrismaClient, TaskStatus } from "@docbridge/db-docbridge";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { SqsService } from "../src/sqs/sqs.service";
import { TaskPublisher } from "../src/tasks/task-publisher";

const DATABASE_URL = process.env.DISPATCHER_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "task-publisher.e2e skipped: set DISPATCHER_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const QUEUE_URL =
  process.env.TASKS_QUEUE_URL ??
  "http://localhost:4566/000000000000/docbridge-tasks-test";
const QUEUE_NAME = QUEUE_URL.split("/").pop()!;
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "eu-central-1";

run("task-publisher e2e", () => {
  let moduleRef: TestingModule;
  let publisher: TaskPublisher;
  let db: PrismaClient;
  const sqs = new SQSClient({ region: REGION, endpoint: ENDPOINT });
  const insertedJobIds: string[] = [];
  const insertedFileIds: string[] = [];

  async function drainQueue() {
    for (;;) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      if (!Messages?.length) break;
      for (const m of Messages) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: m.ReceiptHandle,
          }),
        );
      }
    }
  }

  async function receiveBodies(expected: number): Promise<unknown[]> {
    const bodies: unknown[] = [];
    for (let i = 0; i < 30 && bodies.length < expected; i++) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const m of Messages ?? []) {
        bodies.push(JSON.parse(m.Body ?? ""));
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: m.ReceiptHandle,
          }),
        );
      }
    }
    return bodies;
  }

  async function insertJobWithTasks(
    count: number,
    opts: { dispatchedAt?: Date | null; status?: TaskStatus } = {},
  ) {
    const jobId = randomUUID();
    const fileId = randomUUID();
    const owner = randomUUID();
    await db.job.create({
      data: {
        id: jobId,
        submitterUserId: owner,
        submitterDisplayName: "test",
        submittedAt: new Date(),
        filesCount: 1,
        tasksCount: count,
      },
    });
    await db.stagedFile.create({
      data: {
        id: fileId,
        ownerUserId: owner,
        jobId,
        fileName: `${fileId}.pdf`,
        contentType: "application/pdf",
        sizeBytes: 4n,
        checksumCrc32c: "AAAAAA==",
        storageKey: `staged/${owner}/${fileId}`,
        status: "staged",
        stagedAt: new Date(),
      },
    });
    const taskIds = [] as string[];
    for (let i = 0; i < count; i++) {
      const task = await db.task.create({
        data: {
          jobId,
          stagedFileId: fileId,
          destinationFolderId: randomUUID(),
          destinationTeamId: randomUUID(),
          destinationPath: "/a/b",
          status: opts.status ?? "pending",
          ...(opts.dispatchedAt !== undefined
            ? { dispatchedAt: opts.dispatchedAt }
            : {}),
        },
      });
      taskIds.push(task.id);
    }
    insertedJobIds.push(jobId);
    insertedFileIds.push(fileId);
    return { jobId, fileId, taskIds };
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    await sqs.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
    await drainQueue();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    publisher = moduleRef.get(TaskPublisher);
  }, 60_000);

  afterAll(async () => {
    await db.task.deleteMany({ where: { jobId: { in: insertedJobIds } } });
    await db.stagedFile.deleteMany({
      where: { id: { in: insertedFileIds } },
    });
    await db.jobTeam.deleteMany({ where: { jobId: { in: insertedJobIds } } });
    await db.job.deleteMany({ where: { id: { in: insertedJobIds } } });
    await moduleRef.close();
    await db.$disconnect();
    sqs.destroy();
  });

  it("publishes claimed tasks and marks dispatched_at", async () => {
    const { jobId, taskIds } = await insertJobWithTasks(3);
    await drainQueue();

    expect(await publisher.publishOnce()).toBe(3);

    const bodies = await receiveBodies(3);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      const parsed = TaskMessage.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.v).toBe(1);
        expect(parsed.data.jobId).toBe(jobId);
        expect(taskIds).toContain(parsed.data.taskId);
      }
    }
    const tasks = await db.task.findMany({ where: { id: { in: taskIds } } });
    for (const t of tasks) {
      expect(t.dispatchedAt).not.toBeNull();
    }
  }, 60_000);

  it("does not republish already-dispatched tasks", async () => {
    await insertJobWithTasks(2);
    await drainQueue();

    expect(await publisher.publishOnce()).toBe(2);
    expect(await publisher.publishOnce()).toBe(0);
    expect(await receiveBodies(2)).toHaveLength(2);
  }, 60_000);

  it("stuck sweep republishes only stale non-final tasks", async () => {
    const stale = new Date(Date.now() - 30 * 60_000);
    const fresh = new Date(Date.now() - 60_000);
    const a = await insertJobWithTasks(1, {
      dispatchedAt: stale,
      status: "pending",
    });
    await insertJobWithTasks(1, { dispatchedAt: fresh, status: "pending" });
    await insertJobWithTasks(1, { dispatchedAt: stale, status: "completed" });
    const d = await insertJobWithTasks(1, {
      dispatchedAt: stale,
      status: "in_progress",
    });
    await drainQueue();

    expect(await publisher.republishStuckOnce()).toBe(2);

    const bodies = await receiveBodies(2);
    const taskIds = bodies
      .map((body) => TaskMessage.safeParse(body).data?.taskId)
      .filter(Boolean);
    expect(taskIds.sort()).toEqual([a.taskIds[0], d.taskIds[0]].sort());
  }, 60_000);

  it("two concurrent publishers dispatch each task once", async () => {
    const { taskIds } = await insertJobWithTasks(20);
    await drainQueue();

    const secondDb = new PrismaService();
    const second = new TaskPublisher(secondDb, new SqsService());
    const [publishedA, publishedB] = await Promise.all([
      publisher.publishOnce(),
      second.publishOnce(),
    ]);
    await secondDb.db.$disconnect();

    expect(publishedA + publishedB).toBe(20);
    const bodies = await receiveBodies(20);
    const seen = bodies
      .map((b) => TaskMessage.safeParse(b).data?.taskId)
      .filter(Boolean)
      .sort();
    expect(seen).toEqual([...taskIds].sort());
  }, 60_000);
});
