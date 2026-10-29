import { Injectable } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Client } from "@docbridge/storage";
import { config } from "../config";

/**
 * Two S3 clients on purpose: `s3` talks to AWS_ENDPOINT_URL (LocalStack's
 * `localstack:4566` inside docker) for API calls, while `presign` uses
 * S3_PRESIGN_ENDPOINT_URL so URLs handed to the browser carry a host it
 * can actually reach (`localhost:4566` locally). In AWS neither is set
 * and both clients are identical.
 */
@Injectable()
export class StagingStorage {
  readonly bucket = config.STAGING_BUCKET;
  readonly s3: S3Client = createS3Client({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
  });
  readonly presign: S3Client = createS3Client({
    region: config.AWS_REGION,
    endpoint: config.S3_PRESIGN_ENDPOINT_URL ?? config.AWS_ENDPOINT_URL,
  });
}
