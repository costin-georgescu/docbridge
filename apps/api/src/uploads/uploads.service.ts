import { Inject, Injectable } from "@nestjs/common";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  CompleteUploadRequest,
  CompleteUploadResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  ErrorCode,
  isAllowedUpload,
  MAX_UPLOAD_BYTES,
  UploadStatusResponse,
} from "@docbridge/contracts";
import { presignPutObject, presignUploadPart } from "@docbridge/storage";
import { AppError } from "../common/app-error";
import { PrismaService } from "../prisma/prisma.service";
import { StagingStorage } from "../storage/staging-storage.service";
import { planUpload } from "./upload-plan";

const PUT_URL_TTL_SECONDS = 900;
const PART_URL_TTL_SECONDS = 3600;

@Injectable()
export class UploadsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StagingStorage) private readonly storage: StagingStorage,
  ) {}

  async createUpload(
    ownerUserId: string,
    req: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    if (!isAllowedUpload(req.fileName, req.contentType)) {
      throw new AppError(
        415,
        "unsupported_file_type",
        "File type is not supported",
      );
    }
    if (req.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new AppError(413, "file_too_large", "File exceeds the 1 GiB limit");
    }
    const fileId = uuidv7();
    const storageKey = `staged/${ownerUserId}/${fileId}`;
    const plan = planUpload(req.sizeBytes);

    if (plan.mode === "single") {
      if (req.partChecksumsCrc32c !== undefined) {
        throw new AppError(
          422,
          "validation_error",
          "partChecksumsCrc32c is only valid for multipart uploads",
        );
      }
      await this.prisma.db.stagedFile.create({
        data: {
          id: fileId,
          ownerUserId,
          fileName: req.fileName,
          contentType: req.contentType,
          sizeBytes: req.sizeBytes,
          checksumCrc32c: req.checksumCrc32c,
          storageKey,
          status: "pending_upload",
        },
      });
      const { url, headers } = await presignPutObject(this.storage.presign, {
        bucket: this.storage.bucket,
        key: storageKey,
        contentType: req.contentType,
        checksumCrc32c: req.checksumCrc32c,
        expiresIn: PUT_URL_TTL_SECONDS,
      });
      return {
        fileId,
        mode: "single",
        url,
        headers,
        expiresAt: expiresAtIso(PUT_URL_TTL_SECONDS),
      };
    }

    if (
      req.partChecksumsCrc32c === undefined ||
      req.partChecksumsCrc32c.length !== plan.partCount
    ) {
      throw new AppError(
        422,
        "validation_error",
        `Expected ${plan.partCount} part checksums`,
        { expectedParts: plan.partCount },
      );
    }

    const mpu = await this.storage.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: storageKey,
        ContentType: req.contentType,
        ChecksumAlgorithm: "CRC32C",
        ChecksumType: "FULL_OBJECT",
      }),
    );
    const uploadId = mpu.UploadId!;
    await this.prisma.db.stagedFile.create({
      data: {
        id: fileId,
        ownerUserId,
        fileName: req.fileName,
        contentType: req.contentType,
        sizeBytes: req.sizeBytes,
        checksumCrc32c: req.checksumCrc32c,
        storageKey,
        multipartUploadId: uploadId,
        status: "pending_upload",
      },
    });
    const parts = await Promise.all(
      Array.from({ length: plan.partCount }, async (_, i) => {
        const { url, headers } = await presignUploadPart(this.storage.presign, {
          bucket: this.storage.bucket,
          key: storageKey,
          uploadId,
          partNumber: i + 1,
          checksumCrc32c: req.partChecksumsCrc32c![i],
          expiresIn: PART_URL_TTL_SECONDS,
        });
        return { partNumber: i + 1, url, headers };
      }),
    );
    return {
      fileId,
      mode: "multipart",
      uploadId,
      partSizeBytes: plan.partSizeBytes,
      parts,
      expiresAt: expiresAtIso(PART_URL_TTL_SECONDS),
    };
  }

  async completeUpload(
    fileId: string,
    ownerUserId: string,
    req: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse> {
    const row = z.uuid().safeParse(fileId).success
      ? await this.prisma.db.stagedFile.findFirst({
          where: { id: fileId, ownerUserId },
        })
      : null;
    if (!row) {
      throw new AppError(404, "upload_not_found", "Upload not found");
    }
    if (!row.multipartUploadId) {
      throw new AppError(409, "not_multipart", "Upload is not multipart");
    }
    const parts = [...req.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ ETag: p.etag, PartNumber: p.partNumber }));
    try {
      await this.storage.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.storage.bucket,
          Key: row.storageKey,
          UploadId: row.multipartUploadId,
          ChecksumCRC32C: row.checksumCrc32c,
          ChecksumType: "FULL_OBJECT",
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err) {
      throw mapS3Error(err);
    }
    await this.prisma.db.stagedFile.updateMany({
      where: { id: row.id, multipartUploadId: row.multipartUploadId },
      data: { multipartUploadId: null },
    });
    return {};
  }

  async uploadStatus(
    ownerUserId: string,
    ids: string[],
  ): Promise<UploadStatusResponse> {
    const rows = await this.prisma.db.stagedFile.findMany({
      where: { id: { in: ids }, ownerUserId },
      select: { id: true, status: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    return ids.flatMap((fileId) => {
      const status = byId.get(fileId);
      return status ? [{ fileId, status }] : [];
    });
  }
}

function expiresAtIso(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function mapS3Error(err: unknown): AppError {
  const name = (err as { name?: string })?.name ?? "";
  let status: number;
  let code: ErrorCode;
  let message: string;
  switch (name) {
    case "BadDigest":
      status = 400;
      code = "checksum_mismatch";
      message = "Object checksum does not match the declared checksum";
      break;
    case "InvalidPart":
    case "InvalidPartOrder":
    case "EntityTooSmall":
      status = 422;
      code = "validation_error";
      message = "S3 rejected the multipart parts list";
      break;
    case "NoSuchUpload":
      status = 404;
      code = "upload_not_found";
      message = "Upload not found";
      break;
    default:
      throw err;
  }
  return new AppError(status, code, message, { s3Code: name });
}
