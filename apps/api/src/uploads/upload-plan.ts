import {
  MULTIPART_THRESHOLD_BYTES,
  PART_SIZE_BYTES,
} from "@docbridge/contracts";

export type UploadPlan =
  | { mode: "single" }
  | { mode: "multipart"; partSizeBytes: number; partCount: number };

export function planUpload(sizeBytes: number): UploadPlan {
  if (sizeBytes <= MULTIPART_THRESHOLD_BYTES) {
    return { mode: "single" };
  }
  return {
    mode: "multipart",
    partSizeBytes: PART_SIZE_BYTES,
    partCount: Math.ceil(sizeBytes / PART_SIZE_BYTES),
  };
}
