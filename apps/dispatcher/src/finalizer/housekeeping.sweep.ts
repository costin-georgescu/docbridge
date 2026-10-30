import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { Prisma } from "@docbridge/db-docbridge";
import { PrismaService } from "../prisma/prisma.service";
import { StagingStorage } from "../storage/staging-storage.service";
import { sleep } from "../common/sleep";

export const HOUSEKEEPING_BATCH = 1_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface OrphanFile {
  id: string;
  storage_key: string;
}

/**
 * Daily: deletes staged_files that were never submitted to a job
 * (job_id IS NULL) and are older than two days, together with their
 * staged objects — a lifecycle rule can't express "objects without a
 * completion tag", so the dispatcher removes the orphans itself. Rows are
 * claimed with FOR UPDATE SKIP LOCKED so two instances work disjoint
 * batches (ADR-24). Objects go first via DeleteObjects (idempotent on
 * missing keys), then the rows are deleted in the same transaction, so a
 * crash only leaves rows the next run retries.
 */
@Injectable()
export class HousekeepingSweep
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(HousekeepingSweep.name);
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
          const deleted = await this.sweepOnce();
          if (deleted > 0) {
            this.logger.log(`housekeeping deleted ${deleted} orphan files`);
          }
        } catch (e) {
          if (this.abort.signal.aborted) break;
          this.logger.error("housekeeping failed", e as Error);
        }
        await sleep(SWEEP_INTERVAL_MS, this.abort.signal);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** Deletes orphan files in batches; returns the total rows removed. */
  async sweepOnce(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const removed = await this.deleteBatchOnce();
      deleted += removed;
      if (removed < HOUSEKEEPING_BATCH) break;
    }
    return deleted;
  }

  private async deleteBatchOnce(): Promise<number> {
    return this.prisma.db.$transaction(async (tx) => {
      const orphans = await tx.$queryRaw<OrphanFile[]>`
        SELECT id, storage_key FROM staged_files
        WHERE job_id IS NULL
          AND created_at < now() - interval '2 days'
        ORDER BY created_at
        LIMIT ${HOUSEKEEPING_BATCH}
        FOR UPDATE SKIP LOCKED`;
      if (orphans.length === 0) return 0;

      const res = await this.storage.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.storage.bucket,
          Delete: {
            Objects: orphans.map((o) => ({ Key: o.storage_key })),
            Quiet: true,
          },
        }),
      );
      const failedKeys = new Set((res.Errors ?? []).map((e) => e.Key));
      for (const err of res.Errors ?? []) {
        this.logger.warn(
          `DeleteObjects failed for ${err.Key}: ${err.Code} ${err.Message}`,
        );
      }

      const deletable = orphans.filter((o) => !failedKeys.has(o.storage_key));
      if (deletable.length === 0) return 0;
      const idList = Prisma.Prisma.join(
        deletable.map((o) => Prisma.Prisma.sql`${o.id}::uuid`),
      );
      await tx.$executeRaw`DELETE FROM staged_files WHERE id IN (${idList})`;
      return deletable.length;
    });
  }
}
