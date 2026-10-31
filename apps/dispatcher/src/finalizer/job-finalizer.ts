import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import {
  PutObjectTaggingCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { PrismaService } from "../prisma/prisma.service";
import { StagingStorage } from "../storage/staging-storage.service";
import { sleep } from "../common/sleep";

export const JOB_BATCH_SIZE = 10;
const SWEEP_INTERVAL_MS = 10_000;
const TAG_CONCURRENCY = 10;
const RETENTION_TAG = { Key: "retention", Value: "completed" };

interface ClaimedJob {
  id: string;
}

interface StagedKey {
  id: string;
  storage_key: string;
}

/**
 * Marks jobs complete once no task is pending or in_progress (ADR-23) and
 * applies the retention=completed tag to their staged objects so the
 * bucket lifecycle rule deletes them after the retention period. Jobs are
 * claimed with FOR UPDATE SKIP LOCKED inside a transaction that stays
 * open while tags are applied, so two instances work disjoint sets
 * (ADR-24). completed_at is set on the first pass and never overwritten;
 * a job whose tagging failed stays untagged and is retried on the next
 * sweep.
 */
@Injectable()
export class JobFinalizer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(JobFinalizer.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StagingStorage) private readonly storage: StagingStorage,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          const finalized = await this.finalizeOnce();
          if (finalized === JOB_BATCH_SIZE) continue;
        } catch (e) {
          if (this.abort.signal.aborted) break;
          this.logger.error("finalizer loop failed", e as Error);
        }
        await sleep(SWEEP_INTERVAL_MS, this.abort.signal);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /**
   * One claim-tag-mark cycle. Returns the number of jobs finalized so the
   * caller can rerun immediately when a full batch was claimed.
   */
  async finalizeOnce(): Promise<number> {
    return this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<ClaimedJob[]>`
        SELECT id FROM jobs
        WHERE retention_tagged_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.job_id = jobs.id
              AND t.status IN ('pending', 'in_progress')
          )
        ORDER BY submitted_at
        LIMIT ${JOB_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;

      for (const job of claimed) {
        const tagged = await this.tagJob(job.id);
        if (tagged) {
          await tx.$executeRaw`
            UPDATE jobs SET
              completed_at = COALESCE(completed_at, now()),
              retention_tagged_at = now()
            WHERE id = ${job.id}::uuid`;
        } else {
          this.logger.warn(
            `job ${job.id}: completed but tagging incomplete; retried on the next sweep`,
          );
          await tx.$executeRaw`
            UPDATE jobs SET completed_at = COALESCE(completed_at, now())
            WHERE id = ${job.id}::uuid`;
        }
      }
      return claimed.length;
    });
  }

  /** Tags every staged object of the job; false when any call failed. */
  private async tagJob(jobId: string): Promise<boolean> {
    const files = await this.prisma.db.$queryRaw<StagedKey[]>`
      SELECT id, storage_key FROM staged_files WHERE job_id = ${jobId}::uuid`;

    let allTagged = true;
    for (let i = 0; i < files.length; i += TAG_CONCURRENCY) {
      await Promise.all(
        // TDD 5.5: logs carry ids, not storage keys.
        files.slice(i, i + TAG_CONCURRENCY).map(async ({ id, storage_key }) => {
          try {
            await this.storage.s3.send(
              new PutObjectTaggingCommand({
                Bucket: this.storage.bucket,
                Key: storage_key,
                Tagging: { TagSet: [RETENTION_TAG] },
              }),
            );
          } catch (e) {
            if (
              e instanceof S3ServiceException &&
              (e.name === "NoSuchKey" || e.$metadata.httpStatusCode === 404)
            ) {
              this.logger.warn(
                `job ${jobId}: staged object for file ${id} is gone, nothing to tag`,
              );
            } else {
              this.logger.warn(
                `job ${jobId}: tagging file ${id} failed`,
                e as Error,
              );
              allTagged = false;
            }
          }
        }),
      );
    }
    return allTagged;
  }
}
