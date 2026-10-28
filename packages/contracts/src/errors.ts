import { z } from "zod";

export const ErrorCode = z.enum([
  "invalid_credentials",
  "account_disabled",
  "too_many_attempts",
  "invalid_refresh",
  "unsupported_file_type",
  "file_too_large",
  "validation_error",
  "checksum_mismatch",
  "not_multipart",
  "folder_not_authorized",
  "folder_not_found",
  "file_not_staged",
  "file_expired",
  "file_already_submitted",
  "file_not_owned",
  "limits_exceeded",
  "platform_unavailable",
  "job_not_visible",
  "file_not_in_job",
  "file_signature_mismatch",
  "platform_rejected",
  "delivery_timeout",
  "staged_object_missing",
  "storage_unavailable",
  "user_not_found",
  "email_already_exists",
  "team_not_found",
  "binder_not_found",
  "name_already_exists",
  "unauthorized",
  "forbidden",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).default({}),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;
