import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TaskMessage } from "@docbridge/contracts";
import {
  createClient as createDocbridgeClient,
  PrismaClient as DocbridgeDb,
} from "@docbridge/db-docbridge";
import {
  createClient as createPlatformClient,
  PrismaClient as PlatformDb,
} from "@docbridge/db-platform";
import { AppModule } from "../src/app.module";
import { ServiceTokens } from "../src/auth/service-tokens";
import { PlatformDeliveryClient } from "../src/platform/platform-client";
import { TaskProcessor } from "../src/tasks/task-processor";
import {
  bootApp,
  makeKeypair,
  servicePayload,
  signToken,
  TestKeypair,
} from "../../platform/test/helpers";

const DOCBRIDGE_DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
const PLATFORM_DATABASE_URL = process.env.PLATFORM_TEST_DATABASE_URL;
const run =
  DOCBRIDGE_DATABASE_URL && PLATFORM_DATABASE_URL ? describe : describe.skip;
if (!DOCBRIDGE_DATABASE_URL || !PLATFORM_DATABASE_URL) {
  console.warn(
    "delivery-platform.e2e skipped: set WORKER_TEST_DATABASE_URL and PLATFORM_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const QUEUE_URL =
  process.env.TASKS_QUEUE_URL ??
  "http://localhost:4566/000000000000/docbridge-worker-tasks-test";
const QUEUE_NAME = QUEUE_URL.split("/").pop()!;
const DLQ_NAME = `${QUEUE_NAME}-dlq`;
const DLQ_URL = QUEUE_URL.replace(/[^/]+$/, DLQ_NAME);
const DLQ_ARN = `arn:aws:sqs:eu-central-1:000000000000:${DLQ_NAME}`;
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "eu-central-1";
const STAGING_BUCKET = process.env.STAGING_BUCKET ?? "docbridge-staging";
const PLATFORM_BUCKET = process.env.PLATFORM_BUCKET ?? "docbridge-platform";

const TEAM_P = "00000000-0000-7000-8000-00000000e5d1";
const BINDER_P = "00000000-0000-7000-8000-00000000e5d2";
const FOLDER_P = "00000000-0000-7000-8000-00000000e5d3";

const crc32cBase64 = async (bytes: Uint8Array): Promise<string> => {
  const crc = new AwsCrc32c();
  crc.update(bytes);
  return Buffer.from(await crc.digest()).toString("base64");
};

const isMissingObject = (e: unknown): boolean =>
  e instanceof S3ServiceException &&
  (e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata.httpStatusCode === 404);

// TDD 5.1: the worker drives the real platform application in-process —
// SQS, staging S3, the platform HTTP endpoint, platform storage and both
// Postgres databases are real; only the auth service is bypassed (the
// service token is signed by a test keypair the platform trusts via JWKS).
run("task-processor e2e against the real platform", () => {
  let moduleRef: TestingModule;
  let processor: TaskProcessor;
  let platformApp: INestApplication;
  let platformClosed = false;
  let db: DocbridgeDb;
  let platformDb: PlatformDb;
  let kp: TestKeypair;
  const sqs = new SQSClient({ region: REGION, endpoint: ENDPOINT });
  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
  });

  const jobIds: string[] = [];
  const fileIds: string[] = [];
  const taskIds: string[] = [];
  const stagingKeys: string[] = [];
  const versionKeys: string[] = [];

  async function deleteMessage(msg: Message) {
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: msg.ReceiptHandle,
      }),
    );
  }

  async function drainQueue(queueUrl: string) {
    for (;;) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      if (!Messages?.length) break;
      for (const m of Messages) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: m.ReceiptHandle,
          }),
        );
      }
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

  async function objectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (e) {
      if (isMissingObject(e)) return false;
      throw e;
    }
  }

  interface SeedOptions {
    content?: Buffer;
    fileName?: string;
    folderId?: string;
    recordedChecksum?: string;
    attemptCount?: number;
  }

  async function seed(opts: SeedOptions = {}) {
    const ownerId = randomUUID();
    const jobId = randomUUID();
    const fileId = randomUUID();
    const taskId = randomUUID();
    const content = opts.content ?? Buffer.from("%PDF-1.7 real platform\n");
    const storageKey = `staged/${ownerId}/${fileId}`;

    jobIds.push(jobId);
    fileIds.push(fileId);
    taskIds.push(taskId);
    stagingKeys.push(storageKey);
    versionKeys.push(`versions/${taskId}`);

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
        fileName: opts.fileName ?? "report.pdf",
        contentType: "application/pdf",
        sizeBytes: BigInt(content.length),
        checksumCrc32c:
          opts.recordedChecksum ?? (await crc32cBase64(content)),
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
        destinationFolderId: opts.folderId ?? FOLDER_P,
        destinationTeamId: TEAM_P,
        destinationPath: "/team/binder/folder",
        status: "pending",
        dispatchedAt: new Date(),
        attemptCount: opts.attemptCount ?? 0,
      },
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: STAGING_BUCKET,
        Key: storageKey,
        Body: content,
      }),
    );
    return { ownerId, jobId, fileId, taskId, content };
  }

  beforeAll(async () => {
    db = createDocbridgeClient(DOCBRIDGE_DATABASE_URL!);
    platformDb = createPlatformClient(PLATFORM_DATABASE_URL!);

    for (const name of [QUEUE_NAME, DLQ_NAME]) {
      try {
        await sqs.send(new CreateQueueCommand({ QueueName: name }));
      } catch {
        // the queue already exists
      }
    }
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: QUEUE_URL,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: DLQ_ARN,
            maxReceiveCount: "3",
          }),
        },
      }),
    );
    await drainQueue(QUEUE_URL);
    await drainQueue(DLQ_URL);

    try {
      await s3.send(new CreateBucketCommand({ Bucket: PLATFORM_BUCKET }));
    } catch (e) {
      if ((e as Error).name !== "BucketAlreadyOwnedByYou") throw e;
    }

    await platformDb.documentVersion.deleteMany({
      where: { document: { folder: { binderId: BINDER_P } } },
    });
    await platformDb.document.deleteMany({
      where: { folder: { binderId: BINDER_P } },
    });
    await platformDb.folder.deleteMany({ where: { binderId: BINDER_P } });
    await platformDb.binder.deleteMany({ where: { id: BINDER_P } });
    await platformDb.team.deleteMany({ where: { id: TEAM_P } });
    await platformDb.team.create({ data: { id: TEAM_P, name: "E2E P" } });
    await platformDb.binder.create({
      data: { id: BINDER_P, teamId: TEAM_P, name: "Binder" },
    });
    await platformDb.folder.create({
      data: { id: FOLDER_P, binderId: BINDER_P, name: "Inbox" },
    });

    kp = await makeKeypair("k1");
    platformApp = await bootApp(kp, { db: platformDb });
    const server = platformApp.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ServiceTokens)
      .useValue({
        getToken: () =>
          signToken(kp.privateKey, kp.kid, servicePayload()),
      })
      .overrideProvider(PlatformDeliveryClient)
      .useValue(
        new PlatformDeliveryClient({
          baseUrl: `http://127.0.0.1:${port}`,
        }),
      )
      .compile();
    processor = moduleRef.get(TaskProcessor);
  }, 60_000);

  afterEach(async () => {
    await drainQueue(QUEUE_URL);
    await drainQueue(DLQ_URL);
  });

  afterAll(async () => {
    await db.taskAttempt.deleteMany({ where: { taskId: { in: taskIds } } });
    await db.task.deleteMany({ where: { id: { in: taskIds } } });
    await db.stagedFile.deleteMany({ where: { id: { in: fileIds } } });
    await db.job.deleteMany({ where: { id: { in: jobIds } } });
    await platformDb.documentVersion.deleteMany({
      where: { document: { folder: { binderId: BINDER_P } } },
    });
    await platformDb.document.deleteMany({
      where: { folder: { binderId: BINDER_P } },
    });
    await platformDb.folder.deleteMany({ where: { binderId: BINDER_P } });
    await platformDb.binder.deleteMany({ where: { id: BINDER_P } });
    await platformDb.team.deleteMany({ where: { id: TEAM_P } });
    for (const Key of stagingKeys) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: STAGING_BUCKET, Key }))
        .catch(() => {});
    }
    for (const Key of versionKeys) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: PLATFORM_BUCKET, Key }))
        .catch(() => {});
    }
    if (!platformClosed) await platformApp?.close();
    await moduleRef?.close();
    await db.$disconnect();
    await platformDb.$disconnect();
    await drainQueue(QUEUE_URL);
    await drainQueue(DLQ_URL);
    s3.destroy();
    sqs.destroy();
  });

  it("delivers a staged file through the real platform", async () => {
    const { taskId, jobId, ownerId, content } = await seed();
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("completed");
    expect(task.finishedAt).not.toBeNull();

    const version = await platformDb.documentVersion.findUniqueOrThrow({
      where: { deliveryTaskId: taskId },
      include: { document: true },
    });
    expect(version.versionNo).toBe(1);
    expect(version.document.folderId).toBe(FOLDER_P);
    expect(version.document.name).toBe("report.pdf");
    expect(version.submittedByUserId).toBe(ownerId);
    expect(version.storageKey).toBe(`versions/${taskId}`);
    expect(version.checksumCrc32c).toBe(await crc32cBase64(content));
    expect(task.platformDocumentId).toBe(version.documentId);
    expect(task.platformVersionNo).toBe(1);

    const object = await s3.send(
      new GetObjectCommand({
        Bucket: PLATFORM_BUCKET,
        Key: `versions/${taskId}`,
      }),
    );
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(
      content,
    );

    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  }, 60_000);

  it("fails permanently when the platform answers 404 folder_not_found", async () => {
    const { taskId, jobId } = await seed({ folderId: randomUUID() });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.lastErrorCode).toBe("folder_not_found");
    expect(
      await platformDb.documentVersion.count({
        where: { deliveryTaskId: taskId },
      }),
    ).toBe(0);
    expect(await objectExists(PLATFORM_BUCKET, `versions/${taskId}`)).toBe(
      false,
    );
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  }, 60_000);

  it("fails permanently when the platform answers 400 checksum_mismatch", async () => {
    const { taskId, jobId } = await seed({
      recordedChecksum: await crc32cBase64(Buffer.from("other bytes")),
    });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.lastErrorCode).toBe("checksum_mismatch");
    // the platform deletes its copy on a checksum failure
    expect(await objectExists(PLATFORM_BUCKET, `versions/${taskId}`)).toBe(
      false,
    );
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  }, 60_000);

  it("fails permanently when the platform answers 415 unsupported_file_type", async () => {
    const { taskId, jobId } = await seed({ fileName: "evil.exe" });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.lastErrorCode).toBe("platform_rejected");
    expect(await queueCounts()).toEqual({ visible: 0, invisible: 0 });
  }, 60_000);

  it("redrives the message to the DLQ after the third attempt", async () => {
    // A genuine retryable: the platform is down, the delivery cannot start.
    await platformApp.close();
    platformClosed = true;

    const { taskId, jobId } = await seed({ attemptCount: 2 });
    const msg = await sendAndReceive(taskId, jobId);

    await processor.processMessage(msg);

    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.status).toBe("failed");
    expect(task.attemptCount).toBe(3);
    expect(task.lastErrorCode).toBe("platform_unavailable");

    // The worker re-exposed the message (visibility 0). Re-receive it until
    // the receive count passes maxReceiveCount and SQS moves it to the DLQ.
    const deadline = Date.now() + 45_000;
    for (;;) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      for (const m of Messages ?? []) {
        const body = JSON.parse(m.Body ?? "{}") as Partial<TaskMessage>;
        if (body.taskId === taskId) {
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: QUEUE_URL,
              ReceiptHandle: m.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        } else {
          await deleteMessage(m);
        }
      }
      const dlq = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: DLQ_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      );
      const hit = (dlq.Messages ?? []).find((m) => {
        const body = JSON.parse(m.Body ?? "{}") as Partial<TaskMessage>;
        return body.taskId === taskId;
      });
      if (hit) {
        const body = JSON.parse(hit.Body!) as TaskMessage;
        expect(body.jobId).toBe(jobId);
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: DLQ_URL,
            ReceiptHandle: hit.ReceiptHandle,
          }),
        );
        return;
      }
      if (Date.now() > deadline) {
        throw new Error("message never reached the DLQ");
      }
    }
  }, 60_000);
});
