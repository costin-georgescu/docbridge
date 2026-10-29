import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignPutObjectOptions {
  bucket: string;
  key: string;
  contentType: string;
  checksumCrc32c: string;
  expiresIn: number;
}

export async function presignPutObject(
  client: S3Client,
  options: PresignPutObjectOptions,
): Promise<{ url: string; headers: Record<string, string> }> {
  const command = new PutObjectCommand({
    Bucket: options.bucket,
    Key: options.key,
    ContentType: options.contentType,
    ChecksumCRC32C: options.checksumCrc32c,
  });
  const url = await getSignedUrl(client, command, {
    expiresIn: options.expiresIn,
    signableHeaders: new Set(["content-type"]),
    unhoistableHeaders: new Set(["x-amz-checksum-crc32c"]),
  });
  return {
    url,
    headers: {
      "Content-Type": options.contentType,
      "x-amz-checksum-crc32c": options.checksumCrc32c,
    },
  };
}
