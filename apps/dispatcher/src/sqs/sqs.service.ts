import { Injectable } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { config } from "../config";

@Injectable()
export class SqsService {
  readonly sqs = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
  });
  readonly uploadEventsQueueUrl = config.UPLOAD_EVENTS_QUEUE_URL;
  readonly tasksQueueUrl = config.TASKS_QUEUE_URL;
}
