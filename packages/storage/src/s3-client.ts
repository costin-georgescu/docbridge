import { S3Client } from "@aws-sdk/client-s3";

export interface S3ClientOptions {
  region: string;
  endpoint?: string;
}

export function createS3Client(options: S3ClientOptions): S3Client {
  return new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.endpoint !== undefined,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
