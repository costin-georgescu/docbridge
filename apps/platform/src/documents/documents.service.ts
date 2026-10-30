import { Inject, Injectable, Logger } from "@nestjs/common";
import { Transform, TransformCallback } from "node:stream";
import { Request } from "express";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  DeliverDocumentResponse,
  isAllowedUpload,
  MAX_UPLOAD_BYTES,
} from "@docbridge/contracts";
import { Prisma } from "@docbridge/db-platform";
import { AppError } from "../common/app-error";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformStorage } from "../storage/platform-storage.service";

const checksumCrc32c = z.string().regex(/^[A-Za-z0-9+/]{6}==$/);

const DeliveryHeaders = z.object({
  taskId: z.uuid(),
  submitterUserId: z.uuid(),
  // Postgres text rejects \0 — a bad name must be a 422, not a 500.
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !name.includes("\0")),
  checksumCrc32c,
  contentType: z.string().min(1).max(255),
});

type DeliveryHeaders = z.infer<typeof DeliveryHeaders>;

class PayloadTooLargeError extends Error {}

/** Counts bytes and accumulates the CRC32C of everything it forwards. */
class ChecksumStream extends Transform {
  readonly crc = new AwsCrc32c();
  received = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.received += chunk.length;
    if (this.received > this.maxBytes) {
      callback(new PayloadTooLargeError());
      return;
    }
    this.crc.update(chunk);
    callback(null, chunk);
  }

  async digest(): Promise<string> {
    return Buffer.from(await this.crc.digest()).toString("base64");
  }
}

/**
 * TDD 2.8 / ADR-11. `delivery_task_id` is the idempotency key: the first
 * thing the handler does (before touching the body) is look for a version
 * carrying it, and the unique index decides the race when two deliveries
 * interleave anyway. Early answers never consume the request stream —
 * Node drains the unread body for keep-alive reuse once the response ends.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlatformStorage) private readonly storage: PlatformStorage,
  ) {}

  async deliver(
    folderId: string,
    req: Request,
  ): Promise<DeliverDocumentResponse> {
    const headers = this.parseHeaders(req);

    const existing = await this.prisma.db.documentVersion.findUnique({
      where: { deliveryTaskId: headers.taskId },
    });
    if (existing) {
      return {
        documentId: existing.documentId,
        versionNo: existing.versionNo,
        alreadyDelivered: true,
      };
    }

    const folder = z.uuid().safeParse(folderId).success
      ? await this.prisma.db.folder.findUnique({ where: { id: folderId } })
      : null;
    if (!folder) {
      throw new AppError(404, "folder_not_found", "Folder not found", {
        folderId,
      });
    }

    if (!isAllowedUpload(headers.fileName, headers.contentType)) {
      throw new AppError(
        415,
        "unsupported_file_type",
        "File type is not supported",
      );
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new AppError(413, "file_too_large", "File exceeds the 1 GiB limit");
    }

    const storageKey = `versions/${headers.taskId}`;
    const meter = new ChecksumStream(MAX_UPLOAD_BYTES);
    const upload = new Upload({
      client: this.storage.s3,
      params: {
        Bucket: this.storage.bucket,
        Key: storageKey,
        Body: req.pipe(meter),
        ContentType: headers.contentType,
      },
    });
    try {
      await upload.done();
    } catch (err) {
      // Detach the transform so the request stops feeding a dead sink; Node
      // drains whatever body remains once the response ends.
      req.unpipe(meter);
      if (err instanceof PayloadTooLargeError) {
        throw new AppError(
          413,
          "file_too_large",
          "File exceeds the 1 GiB limit",
        );
      }
      this.logger.warn(
        `delivery ${headers.taskId}: storage write failed: ${(err as Error).message}`,
      );
      throw new AppError(
        503,
        "platform_unavailable",
        "Platform storage is unavailable",
      );
    }

    const computed = await meter.digest();
    if (computed !== headers.checksumCrc32c) {
      await this.deleteObject(storageKey);
      throw new AppError(
        400,
        "checksum_mismatch",
        "Body does not match X-Checksum-CRC32C",
      );
    }

    try {
      const version = await this.insertVersion(
        folderId,
        headers,
        storageKey,
        meter.received,
        computed,
      );
      return { documentId: version.documentId, versionNo: version.versionNo };
    } catch (err) {
      const winner =
        err instanceof Prisma.Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
          ? await this.prisma.db.documentVersion.findUnique({
              where: { deliveryTaskId: headers.taskId },
            })
          : null;
      if (!winner) throw err;
      // A concurrent delivery of the same task won the delivery_task_id
      // race (ADR-11). Both racers store identical, checksum-verified bytes
      // at versions/{taskId}, so our copy is only safe to remove when the
      // winner recorded a different key — deleting the shared key would
      // drop the winner's live object.
      if (winner.storageKey !== storageKey) {
        await this.deleteObject(storageKey);
      }
      return {
        documentId: winner.documentId,
        versionNo: winner.versionNo,
        alreadyDelivered: true,
      };
    }
  }

  /**
   * One transaction turns the upload into a document version (TDD 2.8):
   * the upsert takes a row lock on the (folder_id, name) document, so two
   * same-name deliveries serialize and version numbers never collide.
   */
  private async insertVersion(
    folderId: string,
    headers: DeliveryHeaders,
    storageKey: string,
    sizeBytes: number,
    computedChecksum: string,
  ) {
    return this.prisma.db.$transaction(async (tx) => {
      const docs = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO documents (id, folder_id, name)
        VALUES (${uuidv7()}::uuid, ${folderId}::uuid, ${headers.fileName})
        ON CONFLICT (folder_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id`;
      const documentId = docs[0].id;
      await tx.$queryRaw`
        SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`;
      const next = await tx.$queryRaw<{ next: number }[]>`
        SELECT coalesce(max(version_no), 0) + 1 AS next
        FROM document_versions
        WHERE document_id = ${documentId}::uuid`;
      return tx.documentVersion.create({
        data: {
          documentId,
          versionNo: next[0].next,
          storageKey,
          sizeBytes: BigInt(sizeBytes),
          checksumCrc32c: computedChecksum,
          contentType: headers.contentType,
          submittedByUserId: headers.submitterUserId,
          deliveryTaskId: headers.taskId,
        },
      });
    });
  }

  private parseHeaders(req: Request): DeliveryHeaders {
    const single = (name: string): string | undefined => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    let fileName: string | undefined;
    const encodedName = single("x-file-name");
    if (encodedName !== undefined) {
      try {
        fileName = decodeURIComponent(encodedName);
      } catch {
        throw new AppError(
          422,
          "validation_error",
          "X-File-Name is not valid percent-encoding",
        );
      }
    }
    const result = DeliveryHeaders.safeParse({
      taskId: single("x-delivery-task-id"),
      submitterUserId: single("x-submitter-user-id"),
      fileName,
      checksumCrc32c: single("x-checksum-crc32c"),
      contentType: single("content-type")?.split(";")[0].trim(),
    });
    if (!result.success) {
      throw new AppError(422, "validation_error", "Invalid delivery headers", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }

  private async deleteObject(key: string): Promise<void> {
    try {
      await this.storage.s3.send(
        new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(
        `could not delete object ${key}: ${(err as Error).message}`,
      );
    }
  }
}
