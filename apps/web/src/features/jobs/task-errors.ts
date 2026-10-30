export interface TaskErrorText {
  title: string;
  detail: string | null;
}

const DESCRIPTIONS: Record<string, string> = {
  checksum_mismatch:
    "The delivered file did not match the uploaded checksum",
  folder_not_found: "The destination folder was not found on the platform",
  platform_rejected: "The document platform rejected the file",
  file_signature_mismatch:
    "The file contents do not match the declared file type",
  staged_object_missing: "The staged upload is no longer available",
  platform_unavailable: "The document platform is temporarily unavailable",
  delivery_timeout: "The delivery timed out",
  storage_unavailable: "Staging storage is temporarily unavailable",
  internal_error: "An internal error occurred during delivery",
};

export function describeTaskError(error: {
  code: string;
  message: string | null;
}): TaskErrorText {
  const title = DESCRIPTIONS[error.code];
  if (title !== undefined) {
    return { title, detail: error.message };
  }
  return { title: error.message ?? "Delivery failed", detail: error.code };
}
