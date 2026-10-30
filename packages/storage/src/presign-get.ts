import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignGetObjectOptions {
  bucket: string;
  key: string;
  downloadName: string;
  expiresIn: number;
}

export async function presignGetObject(
  client: S3Client,
  options: PresignGetObjectOptions,
): Promise<{ url: string }> {
  const command = new GetObjectCommand({
    Bucket: options.bucket,
    Key: options.key,
    ResponseContentDisposition: contentDisposition(options.downloadName),
  });
  const url = await getSignedUrl(client, command, {
    expiresIn: options.expiresIn,
  });
  return { url };
}

// RFC 6266: a quoted ASCII fallback plus filename* keeps user-supplied
// names (quotes, non-ASCII) from breaking the header.
function contentDisposition(fileName: string): string {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
