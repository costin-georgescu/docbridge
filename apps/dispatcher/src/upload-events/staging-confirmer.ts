import { Inject, Injectable, Logger } from "@nestjs/common";
import { HeadObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { PrismaService } from "../prisma/prisma.service";
import { StagingStorage } from "../storage/staging-storage.service";

export type ConfirmOutcome =
  | "staged"
  | "already_staged"
  | "not_found"
  | "key_mismatch"
  | "object_missing"
  | "mismatch";

@Injectable()
export class StagingConfirmer {
  private readonly logger = new Logger(StagingConfirmer.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StagingStorage) private readonly storage: StagingStorage,
  ) {}

  async confirm(fileId: string, key?: string): Promise<ConfirmOutcome> {
    const record = await this.prisma.db.stagedFile.findUnique({
      where: { id: fileId },
    });
    if (!record) return "not_found";
    if (key !== undefined && key !== record.storageKey) {
      // TDD 5.5: no object keys in logs — the file id identifies the row.
      this.logger.warn(`file ${fileId}: staged key mismatch`);
      return "key_mismatch";
    }
    if (record.status !== "pending_upload") return "already_staged";

    let head;
    try {
      head = await this.storage.s3.send(
        new HeadObjectCommand({
          Bucket: this.storage.bucket,
          Key: record.storageKey,
          ChecksumMode: "ENABLED",
        }),
      );
    } catch (e) {
      if (
        e instanceof S3ServiceException &&
        (e.name === "NotFound" ||
          e.name === "NoSuchKey" ||
          e.$metadata.httpStatusCode === 404)
      ) {
        return "object_missing";
      }
      throw e;
    }

    const sizeMatches =
      head.ContentLength !== undefined &&
      BigInt(head.ContentLength) === record.sizeBytes;
    if (head.ChecksumCRC32C !== record.checksumCrc32c || !sizeMatches) {
      this.logger.warn(
        `file ${fileId}: object does not match record ` +
          `(checksum expected ${record.checksumCrc32c} got ${head.ChecksumCRC32C}, ` +
          `size expected ${record.sizeBytes} got ${head.ContentLength}) — leaving pending_upload`,
      );
      return "mismatch";
    }

    const updated = await this.prisma.db.$executeRaw`
      UPDATE staged_files
      SET status = 'staged', staged_at = now()
      WHERE id = ${fileId}::uuid AND status = 'pending_upload'`;
    return updated === 1 ? "staged" : "already_staged";
  }
}
