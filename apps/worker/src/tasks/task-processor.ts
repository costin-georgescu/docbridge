import { Inject, Injectable, Logger } from "@nestjs/common";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import { GetObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
} from "@aws-sdk/client-sqs";
import { ErrorCode, TaskMessage } from "@docbridge/contracts";
import { Prisma } from "@docbridge/db-docbridge";
import { ServiceTokens } from "../auth/service-tokens";
import { matchesSignature, SIGNATURE_HEAD_BYTES } from "../delivery/signature";
import {
  DeliveryOutcome,
  PlatformDeliveryClient,
} from "../platform/platform-client";
import { PrismaService } from "../prisma/prisma.service";
import { SqsService } from "../sqs/sqs.service";
import { StagingStorage } from "../storage/staging-storage.service";

export const MAX_ATTEMPTS = 3;
/** An in_progress task younger than this belongs to a live message. */
export const FRESH_IN_PROGRESS = "15 minutes";
/** ChangeMessageVisibility backoff after retryable attempts 1 and 2. */
export const RETRY_BACKOFF_S = [30, 120] as const;

type TaskWithRefs = Prisma.Prisma.TaskGetPayload<{
  include: { stagedFile: true; job: true };
}>;

const permanent = (code: ErrorCode, message: string): DeliveryOutcome => ({
  kind: "permanent",
  code,
  message,
});
const retryable = (code: ErrorCode, message: string): DeliveryOutcome => ({
  kind: "retryable",
  code,
  message,
});

async function readHead(
  it: AsyncIterableIterator<Uint8Array>,
  n: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let len = 0;
  while (len < n) {
    const { done, value } = await it.next();
    if (done) break;
    chunks.push(value as Buffer);
    len += value.length;
  }
  return Buffer.concat(chunks);
}

const isMissingObject = (e: unknown): boolean =>
  e instanceof S3ServiceException &&
  (e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata.httpStatusCode === 404);

/**
 * Processes one task-queue message end to end (TDD 2.7): deduplicates by
 * task status, claims an attempt, streams the staged object to the platform
 * and records the outcome. Every result is idempotent — a repeated message
 * either exits on the status checks or loses the platform's delivery_task_id
 * race, which answers alreadyDelivered.
 */
@Injectable()
export class TaskProcessor {
  private readonly logger = new Logger(TaskProcessor.name);
  private readonly workerId = process.env.HOSTNAME ?? hostname();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(StagingStorage) private readonly storage: StagingStorage,
    @Inject(ServiceTokens) private readonly tokens: ServiceTokens,
    @Inject(PlatformDeliveryClient)
    private readonly platform: PlatformDeliveryClient,
  ) {}

  async processMessage(msg: Message): Promise<void> {
    const body = this.parse(msg);
    if (!body) return; // poison messages redrive to the DLQ on their own

    const task = await this.prisma.db.task.findUnique({
      where: { id: body.taskId },
      include: { stagedFile: true, job: true },
    });
    if (!task) {
      await this.deleteMessage(msg);
      return;
    }
    const attemptNo = await this.claim(task);
    if (attemptNo === null) {
      // Missing row, final status, or a fresh in_progress claimed by a
      // concurrent message — in every case this message is a duplicate.
      await this.deleteMessage(msg);
      return;
    }
    if (attemptNo > MAX_ATTEMPTS) {
      await this.finishPermanent(task.id, attemptNo, {
        code: "internal_error",
        message: `attempt ${attemptNo} exceeds the maximum of ${MAX_ATTEMPTS}`,
      });
      await this.deleteMessage(msg);
      return;
    }

    const outcome = await this.attemptDelivery(task);
    switch (outcome.kind) {
      case "delivered":
        await this.finishDelivered(task.id, attemptNo, outcome);
        await this.deleteMessage(msg);
        this.logger.log(
          `task ${task.id} delivered as document ${outcome.documentId} v${outcome.versionNo}`,
        );
        return;
      case "permanent":
        await this.finishPermanent(task.id, attemptNo, outcome);
        await this.deleteMessage(msg);
        this.logger.warn(
          `task ${task.id} failed permanently: ${outcome.code} ${outcome.message}`,
        );
        return;
      case "retryable": {
        const failed = attemptNo >= MAX_ATTEMPTS;
        await this.finishRetryable(task.id, attemptNo, outcome, failed);
        try {
          await this.sqsService.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.sqsService.tasksQueueUrl,
              ReceiptHandle: msg.ReceiptHandle,
              // At the attempt limit the message becomes visible at once so
              // SQS redrives it to the DLQ on the next receive; otherwise the
              // task returns to pending behind a backoff (ADR-11).
              VisibilityTimeout: failed
                ? 0
                : RETRY_BACKOFF_S[
                    Math.min(attemptNo, RETRY_BACKOFF_S.length) - 1
                  ],
            }),
          );
        } catch (e) {
          // The task row is already updated; visibility expiry re-exposes
          // the message and it is reprocessed from the stored state.
          this.logger.warn(
            `task ${task.id}: could not change visibility of message ${msg.MessageId}: ${(e as Error).message}`,
          );
        }
        this.logger.warn(
          `task ${task.id} attempt ${attemptNo} retryable: ${outcome.code} ${outcome.message}`,
        );
        return;
      }
    }
  }

  private parse(msg: Message): TaskMessage | null {
    try {
      const parsed = TaskMessage.safeParse(JSON.parse(msg.Body ?? ""));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through */
    }
    this.logger.error(`unparseable task message ${msg.MessageId}`);
    return null;
  }

  /**
   * Atomically flips the task to in_progress and bumps attempt_count, then
   * records the task_attempt row. The WHERE clause is the real dedup guard:
   * pending tasks and stale in_progress tasks (owning worker presumed dead)
   * can be claimed; final tasks and freshly started ones cannot.
   */
  private async claim(task: TaskWithRefs): Promise<number | null> {
    return this.prisma.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ attempt_count: number }[]>`
        UPDATE tasks
        SET status = 'in_progress',
            attempt_count = attempt_count + 1,
            started_at = now()
        WHERE id = ${task.id}::uuid
          AND (status = 'pending'
            OR (status = 'in_progress'
              AND (started_at IS NULL
                OR started_at < now() - ${FRESH_IN_PROGRESS}::interval)))
        RETURNING attempt_count`;
      const attemptNo = rows[0]?.attempt_count;
      if (attemptNo === undefined) return null;
      await tx.taskAttempt.create({
        data: {
          taskId: task.id,
          attemptNo,
          startedAt: new Date(),
          workerId: this.workerId,
        },
      });
      return attemptNo;
    });
  }

  /**
   * Staging read → signature check → streamed PUT through a CRC32C
   * transform. The signature is verified on the first bytes before the
   * platform request starts, so a bad file never reaches the wire.
   */
  private async attemptDelivery(task: TaskWithRefs): Promise<DeliveryOutcome> {
    const file = task.stagedFile;
    if (!file || file.status !== "staged") {
      return permanent(
        "staged_object_missing",
        `staged file ${task.stagedFileId} is not staged`,
      );
    }

    let source: Readable;
    try {
      const obj = await this.storage.s3.send(
        new GetObjectCommand({
          Bucket: this.storage.bucket,
          Key: file.storageKey,
        }),
      );
      if (!obj.Body) {
        return retryable(
          "storage_unavailable",
          `GetObject ${file.storageKey} returned no body`,
        );
      }
      source = obj.Body as Readable;
    } catch (e) {
      return isMissingObject(e)
        ? permanent(
            "staged_object_missing",
            `staged object ${file.storageKey} not found`,
          )
        : retryable(
            "storage_unavailable",
            `staging GetObject failed: ${(e as Error).message}`,
          );
    }

    const iterator = source[Symbol.asyncIterator]();
    let head: Buffer;
    try {
      head = await readHead(iterator, SIGNATURE_HEAD_BYTES);
    } catch (e) {
      source.destroy();
      return retryable(
        "storage_unavailable",
        `staging read failed: ${(e as Error).message}`,
      );
    }
    if (!matchesSignature(file.contentType, head)) {
      source.destroy();
      return permanent(
        "file_signature_mismatch",
        `object does not match the ${file.contentType} signature`,
      );
    }

    let token: string;
    try {
      token = await this.tokens.getToken();
    } catch (e) {
      source.destroy();
      return retryable(
        "platform_unavailable",
        `could not obtain a service token: ${(e as Error).message}`,
      );
    }

    const crc = new AwsCrc32c();
    let streamError: Error | undefined;
    const body = Readable.from(
      (async function* () {
        try {
          crc.update(head);
          yield head;
          for await (const chunk of iterator) {
            crc.update(chunk);
            yield chunk;
          }
        } catch (e) {
          streamError = e as Error;
          throw e;
        }
      })(),
    );

    const outcome = await this.platform.deliver({
      token,
      taskId: task.id,
      submitterUserId: task.job.submitterUserId,
      folderId: task.destinationFolderId,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      checksumCrc32c: file.checksumCrc32c,
      body,
    });
    if (streamError) {
      return retryable(
        "storage_unavailable",
        `staging stream failed: ${streamError.message}`,
      );
    }
    if (outcome.kind !== "delivered") return outcome;

    const computed = Buffer.from(await crc.digest()).toString("base64");
    if (computed !== file.checksumCrc32c) {
      return permanent(
        "checksum_mismatch",
        `streamed crc32c ${computed} does not match the recorded ${file.checksumCrc32c}`,
      );
    }
    return outcome;
  }

  private async finishDelivered(
    taskId: string,
    attemptNo: number,
    outcome: { documentId: string; versionNo: number },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.db.$transaction([
      this.prisma.db.taskAttempt.update({
        where: { taskId_attemptNo: { taskId, attemptNo } },
        data: { finishedAt: now, outcome: "succeeded" },
      }),
      this.prisma.db.task.update({
        where: { id: taskId },
        data: {
          status: "completed",
          finishedAt: now,
          platformDocumentId: outcome.documentId,
          platformVersionNo: outcome.versionNo,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      }),
    ]);
  }

  private async finishPermanent(
    taskId: string,
    attemptNo: number,
    error: { code: ErrorCode; message: string },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.db.$transaction([
      this.prisma.db.taskAttempt.update({
        where: { taskId_attemptNo: { taskId, attemptNo } },
        data: {
          finishedAt: now,
          outcome: "failed_permanent",
          errorCode: error.code,
          errorMessage: error.message,
        },
      }),
      this.prisma.db.task.update({
        where: { id: taskId },
        data: {
          status: "failed",
          finishedAt: now,
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
        },
      }),
    ]);
  }

  private async finishRetryable(
    taskId: string,
    attemptNo: number,
    error: { code: ErrorCode; message: string },
    failed: boolean,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.db.$transaction([
      this.prisma.db.taskAttempt.update({
        where: { taskId_attemptNo: { taskId, attemptNo } },
        data: {
          finishedAt: now,
          outcome: "failed_retryable",
          errorCode: error.code,
          errorMessage: error.message,
        },
      }),
      this.prisma.db.task.update({
        where: { id: taskId },
        data: {
          status: failed ? "failed" : "pending",
          finishedAt: failed ? now : null,
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
        },
      }),
    ]);
  }

  private async deleteMessage(msg: Message): Promise<void> {
    try {
      await this.sqsService.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.sqsService.tasksQueueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
    } catch (e) {
      // The task row is already final; the next redelivery deletes it.
      this.logger.warn(
        `could not delete message ${msg.MessageId}: ${(e as Error).message}`,
      );
    }
  }
}
