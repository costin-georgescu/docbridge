import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { fileIdFromStagedKey, UploadEventMessage } from "@docbridge/contracts";
import { config } from "../config";
import { SqsService } from "./sqs.service";
import { StagingConfirmer } from "./staging-confirmer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class UploadEventsConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(UploadEventsConsumer.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(StagingConfirmer) private readonly confirmer: StagingConfirmer,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          await this.pollOnce(this.abort.signal);
        } catch (e) {
          if (this.abort.signal.aborted) break;
          this.logger.error("pollOnce failed", e as Error);
          await sleep(1000);
        }
      }
    })();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    const { Messages } = await this.sqsService.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.sqsService.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      }),
      { abortSignal: signal },
    );
    await Promise.all(
      (Messages ?? []).map(async (msg: Message) => {
        if (await this.handleMessage(msg)) {
          await this.sqsService.sqs.send(
            new DeleteMessageCommand({
              QueueUrl: this.sqsService.queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }),
          );
        }
      }),
    );
  }

  /** true = safe to delete the SQS message. */
  async handleMessage(msg: Message): Promise<boolean> {
    let parsed;
    try {
      parsed = UploadEventMessage.safeParse(JSON.parse(msg.Body ?? ""));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      this.logger.error(
        `unparseable SQS message ${msg.MessageId}: ${msg.Body}`,
      );
      return false;
    }
    const body = parsed.data;
    if ("Event" in body) return true; // s3:TestEvent

    for (const record of body.Records) {
      const eventName = record.eventName.replace(/^s3:/, "");
      if (!eventName.startsWith("ObjectCreated:")) {
        this.logger.warn(`ignoring event ${record.eventName}`);
        continue;
      }
      if (record.s3.bucket.name !== config.STAGING_BUCKET) {
        this.logger.warn(`ignoring event for bucket ${record.s3.bucket.name}`);
        continue;
      }
      const ids = fileIdFromStagedKey(record.s3.object.key);
      if (!ids) {
        this.logger.warn(`unparseable object key ${record.s3.object.key}`);
        continue;
      }
      try {
        const outcome = await this.confirmer.confirm(
          ids.fileId,
          `staged/${ids.ownerUserId}/${ids.fileId}`,
        );
        this.logger.log(`file ${ids.fileId}: ${outcome}`);
      } catch (e) {
        this.logger.error(`confirm failed for file ${ids.fileId}`, e as Error);
        return false;
      }
    }
    return true;
  }
}
