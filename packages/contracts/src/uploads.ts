import { z } from "zod";

export const MAX_UPLOAD_BYTES = 1024 ** 3;
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 ** 2;
export const PART_SIZE_BYTES = 16 * 1024 ** 2;
export const MAX_MULTIPART_PARTS = 64;

export const ALLOWED_UPLOAD_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
} as const;

export type AllowedUploadExtension = keyof typeof ALLOWED_UPLOAD_TYPES;

export function isAllowedUpload(fileName: string, contentType: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return false;
  const ext = fileName.slice(dot + 1).toLowerCase();
  const allowed = (ALLOWED_UPLOAD_TYPES as Record<string, string>)[ext];
  return allowed === contentType;
}

const checksumCrc32c = z.string().regex(/^[A-Za-z0-9+/]{6}==$/);

export const CreateUploadRequest = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  checksumCrc32c,
  partChecksumsCrc32c: z.array(checksumCrc32c).max(MAX_MULTIPART_PARTS).optional(),
});

export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

const UploadResponseBase = z.object({
  fileId: z.uuid(),
  expiresAt: z.iso.datetime(),
});

export const SingleUploadResponse = UploadResponseBase.extend({
  mode: z.literal("single"),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});

export const MultipartUploadResponse = UploadResponseBase.extend({
  mode: z.literal("multipart"),
  uploadId: z.string(),
  partSizeBytes: z.number().int().positive(),
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1).max(MAX_MULTIPART_PARTS),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
    }),
  ),
});

export const CreateUploadResponse = z.discriminatedUnion("mode", [
  SingleUploadResponse,
  MultipartUploadResponse,
]);

export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const CompleteUploadRequest = z
  .object({
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(MAX_MULTIPART_PARTS),
          etag: z.string().min(1),
        }),
      )
      .min(1)
      .max(MAX_MULTIPART_PARTS),
  })
  .refine(
    (req) =>
      new Set(req.parts.map((p) => p.partNumber)).size === req.parts.length,
    { message: "partNumbers must be unique", path: ["parts"] },
  );

export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequest>;

export const CompleteUploadResponse = z.object({});

export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponse>;

export const UploadStatusQuery = z.object({
  ids: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(z.uuid()).min(1).max(100))
    .transform((ids) => [...new Set(ids)]),
});

export type UploadStatusQuery = z.infer<typeof UploadStatusQuery>;

export const UploadStatusResponse = z.array(
  z.object({
    fileId: z.uuid(),
    status: z.enum(["pending_upload", "staged"]),
  }),
);

export type UploadStatusResponse = z.infer<typeof UploadStatusResponse>;
