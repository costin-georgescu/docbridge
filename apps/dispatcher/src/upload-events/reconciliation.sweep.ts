import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { sleep } from "../common/sleep";
import { PrismaService } from "../prisma/prisma.service";
import { ConfirmOutcome, StagingConfirmer } from "./staging-confirmer";

export const SWEEP_LIMIT = 200;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_MIN_AGE_MS = 60_000;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_CONCURRENCY = 10;

/** Covers S3 events that never arrived: pending_upload rows 60s–24h old. */
@Injectable()
export class ReconciliationSweep
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ReconciliationSweep.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StagingConfirmer) private readonly confirmer: StagingConfirmer,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          const summary = await this.sweepOnce();
          if (summary.checked > 0) {
            this.logger.log(`sweep: ${JSON.stringify(summary)}`);
          }
        } catch (e) {
          if (this.abort.signal.aborted) break;
          this.logger.error("sweepOnce failed", e as Error);
        }
        await sleep(SWEEP_INTERVAL_MS, this.abort.signal);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  async sweepOnce(): Promise<Record<ConfirmOutcome | "checked", number>> {
    const now = Date.now();
    const pending = await this.prisma.db.stagedFile.findMany({
      where: {
        status: "pending_upload",
        createdAt: {
          lt: new Date(now - SWEEP_MIN_AGE_MS),
          gt: new Date(now - SWEEP_MAX_AGE_MS),
        },
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_LIMIT,
      select: { id: true },
    });

    const summary: Record<ConfirmOutcome | "checked", number> = {
      checked: pending.length,
      staged: 0,
      already_staged: 0,
      not_found: 0,
      key_mismatch: 0,
      object_missing: 0,
      mismatch: 0,
    };
    for (let i = 0; i < pending.length; i += SWEEP_CONCURRENCY) {
      await Promise.all(
        pending.slice(i, i + SWEEP_CONCURRENCY).map(async ({ id }) => {
          try {
            const outcome = await this.confirmer.confirm(id);
            summary[outcome] += 1;
            if (outcome !== "object_missing") {
              this.logger.log(`sweep file ${id}: ${outcome}`);
            } else {
              this.logger.debug(`sweep file ${id}: object_missing`);
            }
          } catch (e) {
            this.logger.warn(`sweep confirm failed for ${id}`, e as Error);
          }
        }),
      );
    }
    return summary;
  }
}
