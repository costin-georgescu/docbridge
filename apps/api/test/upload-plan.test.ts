import { describe, expect, it } from "@jest/globals";
import {
  MAX_UPLOAD_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  PART_SIZE_BYTES,
} from "@docbridge/contracts";
import { planUpload } from "../src/uploads/upload-plan";

describe("planUpload", () => {
  it("returns single at exactly 64 MiB", () => {
    expect(planUpload(MULTIPART_THRESHOLD_BYTES)).toEqual({ mode: "single" });
  });

  it("returns multipart at 64 MiB + 1", () => {
    expect(planUpload(MULTIPART_THRESHOLD_BYTES + 1)).toEqual({
      mode: "multipart",
      partSizeBytes: PART_SIZE_BYTES,
      partCount: 5,
    });
  });

  it("returns 64 parts at 1 GiB", () => {
    expect(planUpload(MAX_UPLOAD_BYTES)).toEqual({
      mode: "multipart",
      partSizeBytes: PART_SIZE_BYTES,
      partCount: 64,
    });
  });
});
