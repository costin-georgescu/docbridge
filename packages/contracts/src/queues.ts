import { z } from "zod";

// S3 sends a one-shot TestEvent when a bucket notification is first wired up.
const S3TestEvent = z
  .object({
    Event: z.literal("s3:TestEvent"),
  })
  .loose();

const S3EventRecord = z
  .object({
    eventName: z.string(),
    s3: z
      .object({
        bucket: z.object({ name: z.string() }).loose(),
        // S3 URL-encodes the key ("+" for spaces); decode before use.
        object: z.object({ key: z.string() }).loose(),
      })
      .loose(),
  })
  .loose();

const S3EventNotification = z
  .object({
    Records: z.array(S3EventRecord).min(1),
  })
  .loose();

export const UploadEventMessage = z.union([S3TestEvent, S3EventNotification]);
export type UploadEventMessage = z.infer<typeof UploadEventMessage>;

const STAGED_KEY =
  /^staged\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function fileIdFromStagedKey(
  rawKey: string,
): { ownerUserId: string; fileId: string } | null {
  const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
  const m = STAGED_KEY.exec(key);
  if (!m) return null;
  return { ownerUserId: m[1], fileId: m[2] };
}
