import { Injectable } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Client } from "@docbridge/storage";
import { config } from "../config";

@Injectable()
export class PlatformStorage {
  readonly bucket = config.PLATFORM_BUCKET;
  readonly s3: S3Client = createS3Client({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
  });
}
