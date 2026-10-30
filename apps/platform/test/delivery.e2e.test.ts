import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createClient, PrismaClient } from "@docbridge/db-platform";
import {
  bootApp,
  makeKeypair,
  servicePayload,
  signToken,
  TestKeypair,
  userPayload,
} from "./helpers";

const DATABASE_URL = process.env.PLATFORM_TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn(
    "delivery.e2e skipped: set PLATFORM_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "eu-central-1";
const BUCKET = process.env.PLATFORM_BUCKET ?? "docbridge-platform";

const TEAM_D = "00000000-0000-7000-8000-00000000e2d1";
const BINDER_D = "00000000-0000-7000-8000-00000000e2d2";
const FOLDER_D1 = "00000000-0000-7000-8000-00000000e2d3";
const FOLDER_D2 = "00000000-0000-7000-8000-00000000e2d4";
const SUBMITTER = "00000000-0000-7000-8000-00000000e2d5";

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

run("delivery e2e", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let kp: TestKeypair;
  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
  });
  const storageKeys: string[] = [];

  const serviceToken = (scope = ["documents:write"]) =>
    signToken(kp.privateKey, kp.kid, servicePayload(scope));
  const userToken = () => signToken(kp.privateKey, kp.kid, userPayload());

  interface Delivery {
    taskId?: string;
    submitter?: string;
    fileName?: string;
    checksum?: string;
    contentType?: string;
    token?: string;
    body?: Buffer;
  }

  const deliver = async (folderId: string, opts: Delivery = {}) => {
    const taskId = opts.taskId ?? randomUUID();
    const body = opts.body ?? Buffer.from("%PDF-1.7 delivery e2e\n");
    storageKeys.push(`versions/${taskId}`);
    const res = await request(app.getHttpServer())
      .put(`/folders/${folderId}/documents`)
      .set(
        "authorization",
        `Bearer ${opts.token ?? (await serviceToken())}`,
      )
      .set("x-delivery-task-id", taskId)
      .set("x-submitter-user-id", opts.submitter ?? SUBMITTER)
      .set("x-file-name", encodeURIComponent(opts.fileName ?? "report.pdf"))
      .set(
        "x-checksum-crc32c",
        opts.checksum ?? (await crc32cBase64(body)),
      )
      .set("content-type", opts.contentType ?? "application/pdf")
      .send(body);
    return { res, taskId, body };
  };

  const headObject = async (key: string) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch (e) {
      if (isMissingObject(e)) return false;
      throw e;
    }
  };

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch (e) {
      if ((e as Error).name !== "BucketAlreadyOwnedByYou") throw e;
    }
    await db.documentVersion.deleteMany({
      where: { document: { folder: { binderId: BINDER_D } } },
    });
    await db.document.deleteMany({
      where: { folder: { binderId: BINDER_D } },
    });
    await db.folder.deleteMany({ where: { binderId: BINDER_D } });
    await db.binder.deleteMany({ where: { id: BINDER_D } });
    await db.team.deleteMany({ where: { id: TEAM_D } });
    await db.team.create({ data: { id: TEAM_D, name: "E2E D" } });
    await db.binder.create({
      data: { id: BINDER_D, teamId: TEAM_D, name: "Binder" },
    });
    await db.folder.createMany({
      data: [
        { id: FOLDER_D1, binderId: BINDER_D, name: "Inbox" },
        { id: FOLDER_D2, binderId: BINDER_D, name: "Archive" },
      ],
    });
    kp = await makeKeypair("k1");
    app = await bootApp(kp);
  });

  afterAll(async () => {
    await app?.close();
    await db?.documentVersion.deleteMany({
      where: { document: { folder: { binderId: BINDER_D } } },
    });
    await db?.document.deleteMany({
      where: { folder: { binderId: BINDER_D } },
    });
    await db?.folder.deleteMany({ where: { binderId: BINDER_D } });
    await db?.binder.deleteMany({ where: { id: BINDER_D } });
    await db?.team.deleteMany({ where: { id: TEAM_D } });
    await db?.$disconnect();
    await Promise.all(
      storageKeys.map((Key) =>
        s3
          .send(new DeleteObjectCommand({ Bucket: BUCKET, Key }))
          .catch(() => undefined),
      ),
    );
  });

  it("rejects a delivery without a token", async () => {
    const res = await request(app.getHttpServer())
      .put(`/folders/${FOLDER_D1}/documents`)
      .send(Buffer.from("x"));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a delivery with a user token", async () => {
    const { res } = await deliver(FOLDER_D1, { token: await userToken() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("rejects a service token without documents:write", async () => {
    const { res } = await deliver(FOLDER_D1, {
      token: await serviceToken(["folders:read"]),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("stores a delivery and answers 201 with the ids", async () => {
    const fileName = "résumé é.pdf";
    const { res, taskId, body } = await deliver(FOLDER_D1, { fileName });
    expect(res.status).toBe(201);
    expect(res.body.versionNo).toBe(1);

    const object = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `versions/${taskId}`,
      }),
    );
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(
      body,
    );

    const version = await db.documentVersion.findUniqueOrThrow({
      where: { deliveryTaskId: taskId },
      include: { document: true },
    });
    expect(version.documentId).toBe(res.body.documentId);
    expect(version.document.folderId).toBe(FOLDER_D1);
    expect(version.document.name).toBe(fileName);
    expect(version.storageKey).toBe(`versions/${taskId}`);
    expect(version.sizeBytes).toBe(BigInt(body.length));
    expect(version.checksumCrc32c).toBe(await crc32cBase64(body));
    expect(version.contentType).toBe("application/pdf");
    expect(version.submittedByUserId).toBe(SUBMITTER);
  });

  it("answers 200 alreadyDelivered for a repeated task id", async () => {
    const first = await deliver(FOLDER_D1);
    expect(first.res.status).toBe(201);

    const second = await deliver(FOLDER_D1, {
      taskId: first.taskId,
      body: Buffer.from("a different body, never stored"),
    });
    expect(second.res.status).toBe(200);
    expect(second.res.body).toEqual({
      documentId: first.res.body.documentId,
      versionNo: 1,
      alreadyDelivered: true,
    });
    expect(
      await db.documentVersion.count({
        where: { documentId: first.res.body.documentId },
      }),
    ).toBe(1);
  });

  it("bumps the version for a same-name delivery to one folder", async () => {
    const first = await deliver(FOLDER_D1, { fileName: "dup.pdf" });
    const second = await deliver(FOLDER_D1, { fileName: "dup.pdf" });
    expect(second.res.status).toBe(201);
    expect(second.res.body.documentId).toBe(first.res.body.documentId);
    expect(second.res.body.versionNo).toBe(2);
  });

  it("creates a separate document for the same name in another folder", async () => {
    const first = await deliver(FOLDER_D1, { fileName: "shared.pdf" });
    const second = await deliver(FOLDER_D2, { fileName: "shared.pdf" });
    expect(second.res.body.documentId).not.toBe(first.res.body.documentId);
    expect(second.res.body.versionNo).toBe(1);
  });

  it("deletes the object and answers 400 on a checksum mismatch", async () => {
    const { res, taskId } = await deliver(FOLDER_D1, {
      fileName: "corrupt.pdf",
      checksum: await crc32cBase64(Buffer.from("other bytes")),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("checksum_mismatch");
    expect(await headObject(`versions/${taskId}`)).toBe(false);
    expect(
      await db.documentVersion.count({ where: { deliveryTaskId: taskId } }),
    ).toBe(0);
    expect(
      await db.document.count({
        where: { folderId: FOLDER_D1, name: "corrupt.pdf" },
      }),
    ).toBe(0);
  });

  it("answers 404 folder_not_found without storing the object", async () => {
    const { res, taskId } = await deliver(randomUUID());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("folder_not_found");
    expect(await headObject(`versions/${taskId}`)).toBe(false);
  });

  it("answers 415 for a type outside the allowlist", async () => {
    const { res, taskId } = await deliver(FOLDER_D1, {
      fileName: "evil.exe",
      body: Buffer.from("MZ"),
      contentType: "application/pdf",
    });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("unsupported_file_type");
    expect(await headObject(`versions/${taskId}`)).toBe(false);
  });

  it("answers 422 for missing delivery headers", async () => {
    const res = await request(app.getHttpServer())
      .put(`/folders/${FOLDER_D1}/documents`)
      .set("authorization", `Bearer ${await serviceToken()}`)
      .set("content-type", "application/pdf")
      .send(Buffer.from("%PDF-1.7\n"));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("answers 413 without reading an oversized body", async () => {
    const server = app.getHttpServer() as http.Server;
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const { port } = server.address() as AddressInfo;
    const token = await serviceToken();
    // The server stays listening for the remaining tests; app.close() in
    // afterAll shuts it down.
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/folders/${FOLDER_D1}/documents`,
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "x-delivery-task-id": randomUUID(),
            "x-submitter-user-id": SUBMITTER,
            "x-file-name": encodeURIComponent("big.pdf"),
            "x-checksum-crc32c": "AAAAAA==",
            "content-type": "application/pdf",
            "content-length": String(2 * 1024 ** 3),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", () => resolve(-1)); // socket cut after the 413
      req.end("x"); // declared length never arrives; the 413 must anyway
    });
    expect(status).toBe(413);
  });

  it("lets one of two concurrent same-task deliveries win", async () => {
    const taskId = randomUUID();
    const [a, b] = await Promise.all([
      deliver(FOLDER_D1, { taskId }),
      deliver(FOLDER_D1, { taskId }),
    ]);
    const statuses = [a.res.status, b.res.status].sort();
    expect(statuses).toEqual([200, 201]);
    const winner = a.res.status === 201 ? a.res : b.res;
    for (const res of [a.res, b.res]) {
      expect(res.body.documentId).toBe(winner.body.documentId);
      expect(res.body.versionNo).toBe(winner.body.versionNo);
    }
    // The loser must not delete the winner's object: it sits at the same
    // key, so the stored bytes stay reachable.
    expect(await headObject(`versions/${taskId}`)).toBe(true);
    expect(
      await db.documentVersion.count({ where: { deliveryTaskId: taskId } }),
    ).toBe(1);
  });

  it("serializes versions under concurrent same-name deliveries", async () => {
    const [a, b] = await Promise.all([
      deliver(FOLDER_D1, { fileName: "race.pdf" }),
      deliver(FOLDER_D1, { fileName: "race.pdf" }),
    ]);
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    expect(a.res.body.documentId).toBe(b.res.body.documentId);
    const versionNos = [a.res.body.versionNo, b.res.body.versionNo].sort();
    expect(versionNos).toEqual([1, 2]);
  });
});
