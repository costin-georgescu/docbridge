import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { createS3Client } from "@docbridge/storage";
import { createClient, PrismaClient } from "@docbridge/db-docbridge";
import { AppModule } from "../src/app.module";
import { UploadEventsConsumer } from "../src/upload-events/upload-events.consumer";
import { ReconciliationSweep } from "../src/upload-events/reconciliation.sweep";

const DATABASE_URL = process.env.DISPATCHER_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "upload-events.e2e skipped: set DISPATCHER_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const BUCKET = process.env.STAGING_BUCKET ?? "docbridge-staging";
const QUEUE_URL =
  process.env.UPLOAD_EVENTS_QUEUE_URL ??
  "http://localhost:4566/000000000000/docbridge-upload-events-test";
const QUEUE_NAME = QUEUE_URL.split("/").pop()!;
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "eu-central-1";

async function crc32cBase64(data: Buffer | Uint8Array): Promise<string> {
  const crc = new AwsCrc32c();
  crc.update(data);
  return Buffer.from(await crc.digest()).toString("base64");
}

run("upload-events e2e", () => {
  let moduleRef: TestingModule;
  let consumer: UploadEventsConsumer;
  let sweep: ReconciliationSweep;
  let db: PrismaClient;
  const s3 = createS3Client({ region: REGION, endpoint: ENDPOINT });
  const sqs = new SQSClient({ region: REGION, endpoint: ENDPOINT });
  const insertedIds: string[] = [];
  const insertedKeys: string[] = [];

  const stagedKey = (owner: string, file: string) => `staged/${owner}/${file}`;

  function s3Event(...keys: string[]) {
    return JSON.stringify({
      Records: keys.map((key) => ({
        eventName: "s3:ObjectCreated:Put",
        s3: {
          bucket: { name: BUCKET },
          object: { key },
        },
      })),
    });
  }

  const msg = (body: string): Message => ({
    MessageId: randomUUID(),
    Body: body,
  });

  async function insertFile(opts: {
    id?: string;
    owner?: string;
    sizeBytes: bigint | number;
    checksumCrc32c: string;
    key?: string;
    createdAt?: Date;
  }) {
    const id = opts.id ?? randomUUID();
    const owner = opts.owner ?? randomUUID();
    const key = opts.key ?? stagedKey(owner, id);
    await db.stagedFile.create({
      data: {
        id,
        ownerUserId: owner,
        fileName: `${id}.pdf`,
        contentType: "application/pdf",
        sizeBytes: BigInt(opts.sizeBytes),
        checksumCrc32c: opts.checksumCrc32c,
        storageKey: key,
        status: "pending_upload",
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    insertedIds.push(id);
    return { id, owner, key };
  }

  async function putObject(key: string, body: Buffer, checksum?: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ChecksumCRC32C: checksum ?? (await crc32cBase64(body)),
      }),
    );
    insertedKeys.push(key);
  }

  async function statusOf(id: string) {
    return db.stagedFile.findUniqueOrThrow({ where: { id } });
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    await sqs.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));
    // drain leftovers
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
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    consumer = moduleRef.get(UploadEventsConsumer);
    sweep = moduleRef.get(ReconciliationSweep);
  }, 60_000);

  afterAll(async () => {
    await db.stagedFile.deleteMany({ where: { id: { in: insertedIds } } });
    for (const key of insertedKeys) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
        .catch(() => {});
    }
    await moduleRef.close();
    await db.$disconnect();
    s3.destroy();
    sqs.destroy();
  });

  it("stages a file on a single-PUT event", async () => {
    const body = Buffer.from("hello dispatcher");
    const checksum = await crc32cBase64(body);
    const { id, key } = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
    });
    await putObject(key, body, checksum);

    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
    const row = await statusOf(id);
    expect(row.status).toBe("staged");
    expect(row.stagedAt).not.toBeNull();
  });

  it("handles a duplicate event without touching staged_at", async () => {
    const body = Buffer.from("dup");
    const checksum = await crc32cBase64(body);
    const { id, key } = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
    });
    await putObject(key, body, checksum);

    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
    const first = await statusOf(id);
    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
    const second = await statusOf(id);
    expect(second.status).toBe("staged");
    expect(second.stagedAt?.getTime()).toBe(first.stagedAt?.getTime());
  });

  it("leaves pending_upload when the checksum differs", async () => {
    const body = Buffer.from("checksum mismatch");
    const { id, key } = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: await crc32cBase64(Buffer.from("other data")),
    });
    await putObject(key, body);

    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
    expect((await statusOf(id)).status).toBe("pending_upload");
  });

  it("leaves pending_upload when the size differs", async () => {
    const body = Buffer.from("size mismatch");
    const { id, key } = await insertFile({
      sizeBytes: body.length + 10,
      checksumCrc32c: await crc32cBase64(body),
    });
    await putObject(key, body);

    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
    expect((await statusOf(id)).status).toBe("pending_upload");
  });

  it("handles an event for an unknown file id", async () => {
    const key = stagedKey(randomUUID(), randomUUID());
    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
  });

  it("handles the S3 test event", async () => {
    expect(
      await consumer.handleMessage(
        msg(JSON.stringify({ Event: "s3:TestEvent", Bucket: BUCKET })),
      ),
    ).toBe(true);
  });

  it("returns false for a malformed body", async () => {
    expect(await consumer.handleMessage(msg("not json {{{"))).toBe(false);
    expect(await consumer.handleMessage(msg(JSON.stringify({ nope: 1 })))).toBe(
      false,
    );
  });

  it("stages a FULL_OBJECT multipart upload", async () => {
    const part1 = Buffer.alloc(5 * 1024 * 1024, 1);
    const part2 = Buffer.from("tail");
    const body = Buffer.concat([part1, part2]);
    const checksum = await crc32cBase64(body);
    const { id, key } = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
    });

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        ChecksumAlgorithm: "CRC32C",
        ChecksumType: "FULL_OBJECT",
      }),
    );
    const parts = [part1, part2];
    const uploaded = [] as { PartNumber: number; ETag?: string }[];
    for (let i = 0; i < parts.length; i++) {
      const { ETag } = await s3.send(
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId,
          PartNumber: i + 1,
          Body: parts[i],
          ChecksumCRC32C: await crc32cBase64(parts[i]),
        }),
      );
      uploaded.push({ PartNumber: i + 1, ETag });
    }
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId,
        ChecksumCRC32C: checksum,
        ChecksumType: "FULL_OBJECT",
        MultipartUpload: { Parts: uploaded },
      }),
    );
    insertedKeys.push(key);

    expect(await consumer.handleMessage(msg(s3Event(key)))).toBe(true);
    expect((await statusOf(id)).status).toBe("staged");
  }, 60_000);

  it("pollOnce receives, confirms and deletes the message", async () => {
    const body = Buffer.from("via queue");
    const checksum = await crc32cBase64(body);
    const { id, key } = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
    });
    await putObject(key, body, checksum);

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: s3Event(key),
      }),
    );
    await consumer.pollOnce();

    expect((await statusOf(id)).status).toBe("staged");
    // attributes are eventually consistent on LocalStack too
    for (let i = 0; i < 10; i++) {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: QUEUE_URL,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
          ],
        }),
      );
      if (
        Attributes?.ApproximateNumberOfMessages === "0" &&
        Attributes?.ApproximateNumberOfMessagesNotVisible === "0"
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("queue still shows messages after pollOnce");
  }, 60_000);

  it("sweep confirms aged pending rows only", async () => {
    const body = Buffer.from("sweep me");
    const checksum = await crc32cBase64(body);
    const twoMin = new Date(Date.now() - 2 * 60_000);
    const tenSec = new Date(Date.now() - 10_000);
    const dayOld = new Date(Date.now() - 25 * 60 * 60_000);

    const aged = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
      createdAt: twoMin,
    });
    await putObject(aged.key, body, checksum);

    const fresh = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
      createdAt: tenSec,
    });
    await putObject(fresh.key, body, checksum);

    const ancient = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
      createdAt: dayOld,
    });
    await putObject(ancient.key, body, checksum);

    const missing = await insertFile({
      sizeBytes: body.length,
      checksumCrc32c: checksum,
      createdAt: twoMin,
    }); // no object uploaded

    const summary = await sweep.sweepOnce();
    expect(summary.checked).toBeGreaterThanOrEqual(2);
    expect(summary.staged).toBeGreaterThanOrEqual(1);
    expect(summary.object_missing).toBeGreaterThanOrEqual(1);

    expect((await statusOf(aged.id)).status).toBe("staged");
    expect((await statusOf(fresh.id)).status).toBe("pending_upload");
    expect((await statusOf(ancient.id)).status).toBe("pending_upload");
    expect((await statusOf(missing.id)).status).toBe("pending_upload");
  }, 60_000);
});
