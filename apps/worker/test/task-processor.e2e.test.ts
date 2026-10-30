import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TaskMessage } from "@docbridge/contracts";
import { createClient, PrismaClient } from "@docbridge/db-docbridge";
import { ServiceTokens } from "../src/auth/service-tokens";
import { AppModule } from "../src/app.module";
import { PlatformDeliveryClient } from "../src/platform/platform-client";
import { TaskProcessor } from "../src/tasks/task-processor";

const DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "task-processor.e2e skipped: set WORKER_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const QUEUE_URL =
  process.env.TASKS_QUEUE_URL ??
  "http://localhost:4566/000000000000/docbridge-worker-tasks-test";
const QUEUE_NAME = QUEUE_URL.split("/").pop()!;
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "eu-central-1";
const BUCKET = process.env.STAGING_BUCKET ?? "docbridge-staging";

const crc32cBase64 = async (bytes: Uint8Array): Promise<string> => {
  const crc = new AwsCrc32c();
  crc.update(bytes);
  return Buffer.from(await crc.digest()).toString("base64");
};

run("task-processor e2e", () => {
  let moduleRef: TestingModule;
  let processor: TaskProcessor;
  let db: PrismaClient;
  const sqs = new SQSClient({ region: REGION, endpoint: ENDPOINT });
  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
  });

  const jobIds: string[] = [];
  const fileIds: string[] = [];
  const taskIds: string[] = [];

  // The platform is not deployed next to the tests; a controllable stub
  // plays its part while SQS, S3 and Postgres stay real.
  let platformStatus = 201;
  let platformCalls: { url: string; headers: Headers; body: Buffer }[] = [];
  const stubFetch: typeof fetch = async (url, init) => {
    const received: Buffer[] = [];
    for await (const chunk of init?.body as Readable) {
      received.push(chunk as Buffer);
    }
    platformCalls.push({
      url: url as string,
      headers: new Headers(init?.headers),
      body: Buffer.concat(received),
    });
    if (platformStatus === 201) {
      return Response.json({ documentId: randomUUID(), versionNo: 1 });
    }
    if (platformStatus === 200) {
      return Response.json({
        documentId: randomUUID(),
        versionNo: 2,
        alreadyDelivered: true,
      });
    }
    return Response.json(
      {
        error: {
          code: "internal_error",
          message: `stub ${platformStatus}`,
          details: {},
        },
      },
      { status: platformStatus },
    );
  };

  beforeAll(async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ServiceTokens)
      .useValue({ getToken: async () => "svc-token" })
      .overrideProvider(PlatformDeliveryClient)
      .useValue(
        new PlatformDeliveryClient({
          baseUrl: "http://platform.invalid",
          fetch: stubFetch,
        }),
      )
      .compile();
    processor = moduleRef.get(TaskProcessor);
    db = createClient(DATABASE_URL!);
    await drainQueue();
  });

  afterEach(async () => {
    platformStatus = 201;
    platformCalls = [];
    await drainQueue();
  });

  afterAll(async () => {
    await db.taskAttempt.deleteMany({ where: { taskId: { in: taskIds } } });
    await db.task.deleteMany({ where: { id: { in: taskIds } } });
    await db.stagedFile.deleteMany({ where: { id: { in: fileIds } } });
    await db.job.deleteMany({ where: { id: { in: jobIds } } });
    await db.$disconnect();
    await drainQueue();
    await moduleRef.close();
  });

  async function deleteMessage(msg: Message) {
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: msg.ReceiptHandle,
      }),
    );
  }

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
      for (const m of Messages) await deleteMessage(m);
    }
  }

  async function queueCounts(): Promise<{
    visible: number;
    invisible: number;
  }> {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: QUEUE_URL,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    return {
      visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
      invisible: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }

  async function sendAndReceive(
    taskId: string,
    jobId: string,
  ): Promise<Message> {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({
          v: 1,
          taskId,
          jobId,
        } satisfies TaskMessage),
      }),
    );
    for (let i = 0; i < 20; i++) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const m of Messages ?? []) {
        const body = JSON.parse(m.Body ?? "{}") as Partial<TaskMessage>;
        if (body.taskId === taskId) return m;
        await deleteMessage(m); // stray from another test
      }
    }
    throw new Error("message never became visible");
  }

  interface SeedOptions {
    content?: Buffer;
    contentType?: string;
    taskStatus?: "pending" | "in_progress" | "completed" | "failed";
    attemptCount?: number;
    startedAt?: Date;
    putObject?: boolean;
  }

  async function seed(opts: SeedOptions = {}) {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    const fileId = randomUUID();
    const taskId = randomUUID();
    const content = opts.content ?? Buffer.from("%PDF-1.7 fake body\n");
    const contentType = opts.contentType ?? "application/pdf";
    const storageKey = `staged/${ownerId}/${fileId}`;

    jobIds.push(jobId);
    fileIds.push(fileId);
    taskIds.push(taskId);

    await db.job.create({
      data: {
        id: jobId,
        submitterUserId: ownerId,
        submitterDisplayName: "E2E User",
        submittedAt: new Date(),
        filesCount: 1,
        tasksCount: 1,
      },
    });
    await db.stagedFile.create({
      data: {
        id: fileId,
        ownerUserId: ownerId,
        jobId,
        fileName: "report.pdf",
        contentType,
        sizeBytes: BigInt(content.length),
        checksumCrc32c: await crc32cBase64(content),
        storageKey,
        status: "staged",
        stagedAt: new Date(),
      },
    });
    await db.task.create({
      data: {
        id: taskId,
        jobId,
        stagedFileId: fileId,
        destinationFolderId: randomUUID(),
        destinationTeamId: randomUUID(),
        destinationPath: "/team/binder/folder",
        status: opts.taskStatus ?? "pending",
        dispatchedAt: new Date(),
        attemptCount: opts.attemptCount ?? 0,
        startedAt: opts.startedAt,
      },
    });
    if (opts.putObject !== false) {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: storageKey,
          Body: content,
        }),
      );
    }
    return { ownerId, jobId, fileId, taskId, content, storageKey };
  }

  it("delivers a staged file and completes the task", async () => {
    const { taskId, jobId, ownerId, content } = await seed();
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const call = platformCalls[0];
    expect(call.url).toContain("/folders/");
    expect(call.headers.get("authorization")).toBe("Bearer svc-token");
    expect(call.headers.get("x-delivery-task-id")).toBe(taskId);
    expect(call.headers.get("x-submitter-user-id")).toBe(ownerId);
    expect(call.headers.get("x-file-name")).toBe("report.pdf");
    expect(call.headers.get("content-length")).toBe(String(content.length));
    expect(call.body.equals(content)).toBe(true);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("completed");
    expect(task.attemptCount).toBe(1);
    expect(task.platformDocumentId).not.toBeNull();
    expect(task.platformVersionNo).toBe(1);
    expect(task.finishedAt).not.toBeNull();

    const attempt = await db.taskAttempt.findFirstOrThrow({
      where: { taskId, attemptNo: 1 },
    });
    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.finishedAt).not.toBeNull();

    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  });

  it("fails permanently when the staged object is missing", async () => {
    const { taskId, jobId } = await seed({ putObject: false });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    expect(platformCalls).toHaveLength(0);
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.lastErrorCode).toBe("staged_object_missing");
    const attempt = await db.taskAttempt.findFirstOrThrow({
      where: { taskId, attemptNo: 1 },
    });
    expect(attempt.outcome).toBe("failed_permanent");
    expect(attempt.errorCode).toBe("staged_object_missing");
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  });

  it("fails permanently on a file signature mismatch", async () => {
    const { taskId, jobId } = await seed({
      content: Buffer.from("this is not a pdf at all"),
    });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    expect(platformCalls).toHaveLength(0);
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.lastErrorCode).toBe("file_signature_mismatch");
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  });

  it("backs off a retryable error and keeps the message invisible", async () => {
    platformStatus = 503;
    const { taskId, jobId } = await seed();
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("pending");
    expect(task.attemptCount).toBe(1);
    expect(task.lastErrorCode).toBe("platform_unavailable");
    const attempt = await db.taskAttempt.findFirstOrThrow({
      where: { taskId, attemptNo: 1 },
    });
    expect(attempt.outcome).toBe("failed_retryable");
    // ChangeMessageVisibility 30 s: still on the queue, not receivable.
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 1 });

    await deleteMessage(msg);
  });

  it("fails the task on the third attempt and re-exposes the message", async () => {
    platformStatus = 503;
    const { taskId, jobId } = await seed({ attemptCount: 2 });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.attemptCount).toBe(3);
    expect(task.finishedAt).not.toBeNull();
    const attempt = await db.taskAttempt.findFirstOrThrow({
      where: { taskId, attemptNo: 3 },
    });
    expect(attempt.outcome).toBe("failed_retryable");
    // ChangeMessageVisibility 0: back in the queue, SQS redrives to the DLQ.
    expect(await queueCounts()).toEqual({ visible: 1, invisible: 0 });
  });

  it("deletes the message for an already-completed task", async () => {
    const { taskId, jobId } = await seed({ taskStatus: "completed" });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    expect(platformCalls).toHaveLength(0);
    expect(await db.taskAttempt.count({ where: { taskId } })).toBe(0);
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  });

  it("deletes the message for a fresh in_progress task", async () => {
    const { taskId, jobId } = await seed({
      taskStatus: "in_progress",
      attemptCount: 1,
      startedAt: new Date(),
    });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    expect(platformCalls).toHaveLength(0);
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.attemptCount).toBe(1);
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  });
});
