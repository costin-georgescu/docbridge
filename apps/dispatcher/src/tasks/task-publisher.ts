import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { TaskMessage } from "@docbridge/contracts";
import { Prisma } from "@docbridge/db-docbridge";
import { sleep } from "../common/sleep";
import { PrismaService } from "../prisma/prisma.service";
import { SqsService } from "../sqs/sqs.service";

export const CLAIM_BATCH_SIZE = 100;
const SEND_BATCH_SIZE = 10;
const IDLE_SLEEP_MS = 1_000;

interface ClaimedTask {
  id: string;
  job_id: string;
}

/**
 * Publishes undispatched tasks to the tasks queue. Rows are claimed with
 * FOR UPDATE SKIP LOCKED inside a transaction that stays open while the
 * batch is sent, so two dispatcher instances always work disjoint batches
 * (ADR-24). The second sweep in the same loop re-publishes non-final tasks
 * whose message is presumed dead (ADR-11).
 */
@Injectable()
export class TaskPublisher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TaskPublisher.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SqsService) private readonly sqsService: SqsService,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          await this.republishStuckOnce();
          const published = await this.publishOnce();
          if (published === CLAIM_BATCH_SIZE) continue;
        } catch (e) {
          if (this.abort.signal.aborted) break;
          this.logger.error("publish loop failed", e as Error);
        }
        await sleep(IDLE_SLEEP_MS, this.abort.signal);
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /**
   * One claim-publish-mark cycle. Returns the number of tasks published so
   * the caller can rerun immediately when a full batch was sent.
   */
  async publishOnce(): Promise<number> {
    return this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<ClaimedTask[]>`
        SELECT id, job_id FROM tasks
        WHERE dispatched_at IS NULL
        ORDER BY created_at
        LIMIT ${CLAIM_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (claimed.length === 0) return 0;

      const published = await this.sendBatches(claimed);
      if (published.length > 0) {
        const idList = Prisma.Prisma.join(
          published.map((id) => Prisma.Prisma.sql`${id}::uuid`),
        );
        await tx.$executeRaw`
          UPDATE tasks SET dispatched_at = now() WHERE id IN (${idList})`;
      }
      if (published.length !== claimed.length) {
        this.logger.warn(
          `published ${published.length}/${claimed.length} claimed tasks; the rest retry on the next scan`,
        );
      }
      return published.length;
    });
  }

  /**
   * Re-publishes non-final tasks whose message is presumed dead: older than
   * the maximum a live message can stay invisible (20 min visibility
   * timeout + 2 min backoff + slack). Republishing a task whose message is
   * still in flight is harmless: workers deduplicate by task status.
   */
  async republishStuckOnce(): Promise<number> {
    const stuck = await this.prisma.db.$queryRaw<ClaimedTask[]>`
      SELECT id, job_id FROM tasks
      WHERE status IN ('pending', 'in_progress')
        AND dispatched_at IS NOT NULL
        AND COALESCE(started_at, dispatched_at) < now() - interval '25 minutes'`;
    if (stuck.length === 0) return 0;

    const published = await this.sendBatches(stuck);
    this.logger.log(`re-published ${published.length}/${stuck.length} stuck tasks`);
    return published.length;
  }

  /** SendMessageBatch in groups of 10; returns the ids that were accepted. */
  private async sendBatches(tasks: ClaimedTask[]): Promise<string[]> {
    const published: string[] = [];
    for (let i = 0; i < tasks.length; i += SEND_BATCH_SIZE) {
      const chunk = tasks.slice(i, i + SEND_BATCH_SIZE);
      const res = await this.sqsService.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.sqsService.tasksQueueUrl,
          Entries: chunk.map((t) => ({
            Id: t.id,
            MessageBody: JSON.stringify({
              v: 1,
              taskId: t.id,
              jobId: t.job_id,
            } satisfies TaskMessage),
          })),
        }),
      );
      published.push(
        ...(res.Successful ?? [])
          .map((s) => s.Id)
          .filter((id): id is string => id !== undefined),
      );
      for (const failed of res.Failed ?? []) {
        this.logger.warn(
          `SendMessageBatch failed for task ${failed.Id ?? "unknown"}: ${failed.Code} ${failed.Message}`,
        );
      }
    }
    return published;
  }
}
