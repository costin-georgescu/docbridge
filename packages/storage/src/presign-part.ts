import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignUploadPartOptions {
  bucket: string;
  key: string;
  uploadId: string;
  partNumber: number;
  checksumCrc32c: string;
  expiresIn: number;
}

export async function presignUploadPart(
  client: S3Client,
  options: PresignUploadPartOptions,
): Promise<{ url: string; headers: Record<string, string> }> {
  const command = new UploadPartCommand({
    Bucket: options.bucket,
    Key: options.key,
    UploadId: options.uploadId,
    PartNumber: options.partNumber,
    ChecksumCRC32C: options.checksumCrc32c,
  });
  const url = await getSignedUrl(client, command, {
    expiresIn: options.expiresIn,
    unhoistableHeaders: new Set(["x-amz-checksum-crc32c"]),
  });
  return {
    url,
    headers: { "x-amz-checksum-crc32c": options.checksumCrc32c },
  };
}
