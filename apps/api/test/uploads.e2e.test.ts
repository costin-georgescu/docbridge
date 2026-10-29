import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "@docbridge/storage";
import {
  MAX_UPLOAD_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  PART_SIZE_BYTES,
} from "@docbridge/contracts";
import { createClient, PrismaClient } from "@docbridge/db-docbridge";
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
    "uploads.e2e skipped: set API_TEST_DATABASE_URL to run against Postgres and LocalStack",
  );
}

const OWNER_A = "00000000-0000-7000-8000-0000000000aa";
const OWNER_B = "00000000-0000-7000-8000-0000000000bb";
const BUCKET = process.env.STAGING_BUCKET ?? "docbridge-staging";

async function crc32cBase64(data: Buffer | Uint8Array): Promise<string> {
  const crc = new AwsCrc32c();
  crc.update(data);
  return Buffer.from(await crc.digest()).toString("base64");
}

// Splits data into 16 MiB parts and returns whole-file + per-part CRC32Cs.
async function crc32cParts(data: Buffer): Promise<{
  checksumCrc32c: string;
  partChecksumsCrc32c: string[];
  parts: Buffer[];
}> {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += PART_SIZE_BYTES) {
    parts.push(data.subarray(off, off + PART_SIZE_BYTES));
  }
  return {
    checksumCrc32c: await crc32cBase64(data),
    partChecksumsCrc32c: await Promise.all(parts.map(crc32cBase64)),
    parts,
  };
}

run("uploads e2e", () => {
  let app: INestApplication;
  let db: PrismaClient;
  let kp: TestKeypair;
  const s3 = createS3Client({
    region: process.env.AWS_REGION ?? "eu-central-1",
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const userToken = (sub: string) =>
    signToken(kp.privateKey, kp.kid, userPayload({ sub }));

  const api = () => request(app.getHttpServer());

  async function createUpload(
    token: string,
    body: Record<string, unknown>,
    expectStatus = 201,
  ) {
    return api()
      .post("/api/uploads")
      .set(bearer(token))
      .send(body)
      .expect(expectStatus);
  }

  async function put(url: string, init: RequestInit = {}) {
    return fetch(url, { method: "PUT", ...init });
  }

  beforeAll(async () => {
    db = createClient(DATABASE_URL!);
    await db.stagedFile.deleteMany({
      where: { ownerUserId: { in: [OWNER_A, OWNER_B] } },
    });
    kp = await makeKeypair("k1");
    app = await bootApp(kp);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.stagedFile.deleteMany({
        where: { ownerUserId: { in: [OWNER_A, OWNER_B] } },
      });
      await db.$disconnect();
    }
  });

  it("rejects requests without a token", async () => {
    const res = await api()
      .post("/api/uploads")
      .send({})
      .expect(401);
    expect(res.body.error.code).toBe("unauthorized");
    await api().get("/api/uploads?ids=x").expect(401);
    await api().post(`/api/uploads/${randomUUID()}/complete`).expect(401);
  });

  it("rejects an invalid body with 422", async () => {
    const token = await userToken(OWNER_A);
    const res = await createUpload(token, { fileName: "a.pdf" }, 422);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects an unsupported content type with 415", async () => {
    const token = await userToken(OWNER_A);
    const res = await createUpload(
      token,
      {
        fileName: "a.exe",
        contentType: "application/x-msdownload",
        sizeBytes: 10,
        checksumCrc32c: "AAAAAA==",
      },
      415,
    );
    expect(res.body.error.code).toBe("unsupported_file_type");
  });

  it("rejects an extension/content-type mismatch with 415", async () => {
    const token = await userToken(OWNER_A);
    const res = await createUpload(
      token,
      {
        fileName: "a.pdf",
        contentType: "image/png",
        sizeBytes: 10,
        checksumCrc32c: "AAAAAA==",
      },
      415,
    );
    expect(res.body.error.code).toBe("unsupported_file_type");
  });

  it("rejects multipart requests without matching partChecksumsCrc32c", async () => {
    const token = await userToken(OWNER_A);
    const base = {
      fileName: "big.pdf",
      contentType: "application/pdf",
      sizeBytes: MULTIPART_THRESHOLD_BYTES + 1,
      checksumCrc32c: "AAAAAA==",
    };
    const missing = await createUpload(token, base, 422);
    expect(missing.body.error.code).toBe("validation_error");
    expect(missing.body.error.details.expectedParts).toBe(5);

    const wrongCount = await createUpload(
      token,
      { ...base, partChecksumsCrc32c: ["AAAAAA==", "BBBBBB=="] },
      422,
    );
    expect(wrongCount.body.error.details.expectedParts).toBe(5);
  });

  it("rejects partChecksumsCrc32c on a single-mode upload", async () => {
    const token = await userToken(OWNER_A);
    const res = await createUpload(
      token,
      {
        fileName: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        checksumCrc32c: "AAAAAA==",
        partChecksumsCrc32c: ["AAAAAA=="],
      },
      422,
    );
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects files over 1 GiB with 413", async () => {
    const token = await userToken(OWNER_A);
    const res = await createUpload(
      token,
      {
        fileName: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: MAX_UPLOAD_BYTES + 1,
        checksumCrc32c: "AAAAAA==",
      },
      413,
    );
    expect(res.body.error.code).toBe("file_too_large");
  });

  it("single upload: presigned PUT enforces content type and checksum", async () => {
    const token = await userToken(OWNER_A);
    const body = Buffer.from("hello docbridge");
    const checksum = await crc32cBase64(body);
    const res = await createUpload(token, {
      fileName: "notes.pdf",
      contentType: "application/pdf",
      sizeBytes: body.length,
      checksumCrc32c: checksum,
    });
    expect(res.body.mode).toBe("single");
    expect(res.body.headers["Content-Type"]).toBe("application/pdf");
    expect(res.body.headers["x-amz-checksum-crc32c"]).toBe(checksum);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = await db.stagedFile.findUnique({
      where: { id: res.body.fileId },
    });
    expect(row).toMatchObject({
      ownerUserId: OWNER_A,
      status: "pending_upload",
      multipartUploadId: null,
      storageKey: `staged/${OWNER_A}/${res.body.fileId}`,
    });

    const ok = await put(res.body.url, { headers: res.body.headers, body });
    expect(ok.status).toBe(200);

    const badChecksum = await put(res.body.url, {
      headers: { ...res.body.headers, "x-amz-checksum-crc32c": "AAAAAA==" },
      body,
    });
    expect(badChecksum.status).toBeGreaterThanOrEqual(400);
  });

  // LocalStack does not enforce signed-header values on presigned PUTs; real
  // S3 must return 403 here — covered by the TDD Launch-step real-S3 check.
  (process.env.AWS_ENDPOINT_URL ? it.skip : it)(
    "single upload: presigned PUT rejects a different Content-Type",
    async () => {
      const token = await userToken(OWNER_A);
      const body = Buffer.from("hello docbridge");
      const checksum = await crc32cBase64(body);
      const res = await createUpload(token, {
        fileName: "ct.pdf",
        contentType: "application/pdf",
        sizeBytes: body.length,
        checksumCrc32c: checksum,
      });
      const badType = await put(res.body.url, {
        headers: { ...res.body.headers, "Content-Type": "image/png" },
        body,
      });
      expect(badType.status).toBe(403);
    },
  );

  it("multipart upload: parts, complete and full-object checksum", async () => {
    const token = await userToken(OWNER_A);
    const full = Buffer.alloc(MULTIPART_THRESHOLD_BYTES + 1, 0x61);
    const { checksumCrc32c, partChecksumsCrc32c, parts } =
      await crc32cParts(full);

    const res = await createUpload(token, {
      fileName: "big.pdf",
      contentType: "application/pdf",
      sizeBytes: full.length,
      checksumCrc32c,
      partChecksumsCrc32c,
    });
    expect(res.body.mode).toBe("multipart");
    expect(res.body.uploadId).toBeDefined();
    expect(res.body.partSizeBytes).toBe(PART_SIZE_BYTES);
    expect(res.body.parts).toHaveLength(5);

    const etags: { partNumber: number; etag: string }[] = [];
    for (const [i, part] of res.body.parts.entries()) {
      expect(part.headers["x-amz-checksum-crc32c"]).toBe(
        partChecksumsCrc32c[i],
      );
      const r = await put(part.url, { body: parts[i], headers: part.headers });
      expect(r.status).toBe(200);
      etags.push({
        partNumber: part.partNumber,
        etag: r.headers.get("etag")!,
      });
      expect(etags[etags.length - 1].etag).toBeTruthy();
    }

    // re-PUT a part with a corrupted crc32c header must be rejected
    const badPart = await put(res.body.parts[0].url, {
      body: parts[0],
      headers: { "x-amz-checksum-crc32c": "AAAAAA==" },
    });
    expect(badPart.status).toBeGreaterThanOrEqual(400);

    const complete = await api()
      .post(`/api/uploads/${res.body.fileId}/complete`)
      .set(bearer(token))
      .send({ parts: etags })
      .expect(200);
    expect(complete.body).toEqual({});

    const row = await db.stagedFile.findUnique({
      where: { id: res.body.fileId },
    });
    expect(row).toMatchObject({ status: "pending_upload", multipartUploadId: null });

    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: `staged/${OWNER_A}/${res.body.fileId}`,
        ChecksumMode: "ENABLED",
      }),
    );
    expect(head.ChecksumCRC32C).toBe(checksumCrc32c);

    const again = await api()
      .post(`/api/uploads/${res.body.fileId}/complete`)
      .set(bearer(token))
      .send({ parts: etags })
      .expect(409);
    expect(again.body.error.code).toBe("not_multipart");
  }, 120000);

  it("multipart complete with a wrong checksum returns 400 checksum_mismatch", async () => {
    const token = await userToken(OWNER_A);
    const full = Buffer.alloc(MULTIPART_THRESHOLD_BYTES + 1, 0x62);
    const { partChecksumsCrc32c, parts } = await crc32cParts(full);

    const res = await createUpload(token, {
      fileName: "bad.pdf",
      contentType: "application/pdf",
      sizeBytes: full.length,
      checksumCrc32c: "AAAAAA==",
      partChecksumsCrc32c,
    });
    expect(res.body.mode).toBe("multipart");
    expect(res.body.parts).toHaveLength(5);

    const etags: { partNumber: number; etag: string }[] = [];
    for (const [i, part] of res.body.parts.entries()) {
      const r = await put(part.url, { body: parts[i], headers: part.headers });
      expect(r.status).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: r.headers.get("etag")! });
    }

    const complete = await api()
      .post(`/api/uploads/${res.body.fileId}/complete`)
      .set(bearer(token))
      .send({ parts: etags })
      .expect(400);
    expect(complete.body.error.code).toBe("checksum_mismatch");

    const row = await db.stagedFile.findUnique({
      where: { id: res.body.fileId },
    });
    expect(row).toMatchObject({
      status: "pending_upload",
      multipartUploadId: res.body.uploadId,
    });
  }, 120000);

  it("complete rejects foreign files, single uploads and bad bodies", async () => {
    const tokenA = await userToken(OWNER_A);
    const tokenB = await userToken(OWNER_B);

    // a multipart upload owned by B
    const owned = await createUpload(tokenB, {
      fileName: "b.pdf",
      contentType: "application/pdf",
      sizeBytes: MULTIPART_THRESHOLD_BYTES + 1,
      checksumCrc32c: "AAAAAA==",
      partChecksumsCrc32c: Array(5).fill("AAAAAA=="),
    });
    const foreign = await api()
      .post(`/api/uploads/${owned.body.fileId}/complete`)
      .set(bearer(tokenA))
      .send({ parts: [{ partNumber: 1, etag: "e" }] })
      .expect(404);
    expect(foreign.body.error.code).toBe("upload_not_found");

    // a single-mode upload owned by A
    const single = await createUpload(tokenA, {
      fileName: "s.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      checksumCrc32c: "AAAAAA==",
    });
    const notMpu = await api()
      .post(`/api/uploads/${single.body.fileId}/complete`)
      .set(bearer(tokenA))
      .send({ parts: [{ partNumber: 1, etag: "e" }] })
      .expect(409);
    expect(notMpu.body.error.code).toBe("not_multipart");

    const missing = await api()
      .post(`/api/uploads/${randomUUID()}/complete`)
      .set(bearer(tokenA))
      .send({ parts: [{ partNumber: 1, etag: "e" }] })
      .expect(404);
    expect(missing.body.error.code).toBe("upload_not_found");

    const dup = await api()
      .post(`/api/uploads/${owned.body.fileId}/complete`)
      .set(bearer(tokenB))
      .send({
        parts: [
          { partNumber: 1, etag: "a" },
          { partNumber: 1, etag: "b" },
        ],
      })
      .expect(422);
    expect(dup.body.error.code).toBe("validation_error");
  });

  it("GET status returns only owned files in request order", async () => {
    const tokenA = await userToken(OWNER_A);
    const tokenB = await userToken(OWNER_B);

    const mine = await createUpload(tokenA, {
      fileName: "mine.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      checksumCrc32c: "AAAAAA==",
    });
    const other = await createUpload(tokenB, {
      fileName: "other.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      checksumCrc32c: "AAAAAA==",
    });
    const missing = randomUUID();

    const res = await api()
      .get(
        `/api/uploads?ids=${other.body.fileId},${mine.body.fileId},${missing}`,
      )
      .set(bearer(tokenA))
      .expect(200);
    expect(res.body).toEqual([
      { fileId: mine.body.fileId, status: "pending_upload" },
    ]);

    const badId = await api()
      .get(`/api/uploads?ids=${mine.body.fileId},not-a-uuid`)
      .set(bearer(tokenA))
      .expect(422);
    expect(badId.body.error.code).toBe("validation_error");

    const tooMany = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    ).join(",");
    await api()
      .get(`/api/uploads?ids=${tooMany}`)
      .set(bearer(tokenA))
      .expect(422);
  });
});
