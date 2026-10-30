const MESSAGES: Record<string, string> = {
  unsupported_file_type:
    "This file type is not supported. Use PDF, DOCX, XLSX, PNG, or JPG.",
  file_too_large: "This file exceeds the 1 GiB limit.",
  checksum_mismatch:
    "The uploaded data did not match its checksum. Try uploading again.",
  upload_failed: "The upload failed. Check your connection and try again.",
};

export function uploadErrorMessage(code: string, fallback: string): string {
  return MESSAGES[code] ?? fallback;
}
