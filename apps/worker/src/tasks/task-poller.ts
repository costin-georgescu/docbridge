import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sleep } from "../common/sleep";
import { config } from "../config";
import { SqsService } from "../sqs/sqs.service";
import { TaskProcessor } from "./task-processor";

const POLL_SLEEP_MS = 1_000;

/**
 * Long-polls the tasks queue and keeps up to WORKER_CONCURRENCY messages
 * in flight (TDD 2.7). On SIGTERM polling stops and in-flight attempts
 * finish; the ECS stopTimeout (120 s) bounds the wait, anything longer is
 * cut and retried by visibility expiry.
 */
@Injectable()
export class TaskPoller
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TaskPoller.name);
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(TaskProcessor) private readonly processor: TaskProcessor,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          await this.pollOnce(this.abort.signal);
        } catch (e) {
          if (this.abort.signal.aborted) break;
          this.logger.error("pollOnce failed", e as Error);
          await sleep(POLL_SLEEP_MS, this.abort.signal);
        }
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
  }

  /** One receive-and-dispatch round. */
  async pollOnce(signal?: AbortSignal): Promise<void> {
    const free = config.WORKER_CONCURRENCY - this.inFlight.size;
    if (free <= 0) {
      await Promise.race(this.inFlight);
      return;
    }
    const { Messages } = await this.sqsService.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.sqsService.tasksQueueUrl,
        MaxNumberOfMessages: Math.min(10, free),
        WaitTimeSeconds: 20,
      }),
      { abortSignal: signal },
    );
    for (const msg of Messages ?? []) {
      const p = this.processor
        .processMessage(msg)
        .catch((e: Error) =>
          this.logger.error(`task message ${msg.MessageId} failed`, e),
        )
        .finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }
}
