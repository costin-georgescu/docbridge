import { describe, expect, it } from "@jest/globals";
import {
  CompleteUploadRequest,
  CreateUploadRequest,
  isAllowedUpload,
  UploadStatusQuery,
} from "../src";

describe("isAllowedUpload", () => {
  it("accepts each allowlisted type", () => {
    expect(isAllowedUpload("a.pdf", "application/pdf")).toBe(true);
    expect(
      isAllowedUpload(
        "a.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(
      isAllowedUpload(
        "a.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
    expect(isAllowedUpload("a.png", "image/png")).toBe(true);
    expect(isAllowedUpload("a.jpg", "image/jpeg")).toBe(true);
    expect(isAllowedUpload("a.jpeg", "image/jpeg")).toBe(true);
  });

  it("accepts uppercase extensions", () => {
    expect(isAllowedUpload("report.PDF", "application/pdf")).toBe(true);
  });

  it("rejects an extension/content-type mismatch", () => {
    expect(isAllowedUpload("report.pdf", "image/png")).toBe(false);
  });

  it("rejects a file with no extension", () => {
    expect(isAllowedUpload("report", "application/pdf")).toBe(false);
  });

  it("rejects a file with a trailing dot", () => {
    expect(isAllowedUpload("report.", "application/pdf")).toBe(false);
  });

  it("uses the last extension for double extensions", () => {
    expect(isAllowedUpload("a.png.pdf", "application/pdf")).toBe(true);
    expect(isAllowedUpload("a.png.pdf", "image/png")).toBe(false);
  });
});

describe("CreateUploadRequest", () => {
  const valid = {
    fileName: "report.pdf",
    contentType: "application/pdf",
    sizeBytes: 1024,
    checksumCrc32c: "AAAAAA==",
  };

  it("parses a valid request", () => {
    expect(CreateUploadRequest.parse(valid)).toEqual(valid);
  });

  it("has no size cap in the schema (service returns 413)", () => {
    expect(
      CreateUploadRequest.safeParse({ ...valid, sizeBytes: 1024 ** 3 + 1 })
        .success,
    ).toBe(true);
  });

  it("rejects a non-positive size", () => {
    expect(
      CreateUploadRequest.safeParse({ ...valid, sizeBytes: 0 }).success,
    ).toBe(false);
  });

  it("rejects a malformed checksum", () => {
    for (const checksumCrc32c of ["AAAAAA=", "AAAAA==", "AAAAAA A==", "abc"]) {
      expect(
        CreateUploadRequest.safeParse({ ...valid, checksumCrc32c }).success,
      ).toBe(false);
    }
  });

  it("accepts optional partChecksumsCrc32c", () => {
    expect(
      CreateUploadRequest.parse({
        ...valid,
        partChecksumsCrc32c: ["AAAAAA==", "BBBBBB=="],
      }).partChecksumsCrc32c,
    ).toEqual(["AAAAAA==", "BBBBBB=="]);
  });

  it("rejects a malformed part checksum", () => {
    expect(
      CreateUploadRequest.safeParse({
        ...valid,
        partChecksumsCrc32c: ["AAAAAA==", "not-a-crc"],
      }).success,
    ).toBe(false);
  });

  it("rejects more than 64 part checksums", () => {
    expect(
      CreateUploadRequest.safeParse({
        ...valid,
        partChecksumsCrc32c: Array(65).fill("AAAAAA=="),
      }).success,
    ).toBe(false);
  });
});

describe("CompleteUploadRequest", () => {
  it("parses a valid request", () => {
    const res = CompleteUploadRequest.parse({
      parts: [
        { partNumber: 2, etag: "b" },
        { partNumber: 1, etag: "a" },
      ],
    });
    expect(res.parts).toHaveLength(2);
  });

  it("rejects an empty parts array", () => {
    expect(CompleteUploadRequest.safeParse({ parts: [] }).success).toBe(false);
  });

  it("rejects duplicate partNumbers", () => {
    expect(
      CompleteUploadRequest.safeParse({
        parts: [
          { partNumber: 1, etag: "a" },
          { partNumber: 1, etag: "b" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects more than 64 parts", () => {
    const parts = Array.from({ length: 65 }, (_, i) => ({
      partNumber: i + 1,
      etag: "e",
    }));
    expect(CompleteUploadRequest.safeParse({ parts }).success).toBe(false);
  });

  it("rejects an empty etag", () => {
    expect(
      CompleteUploadRequest.safeParse({
        parts: [{ partNumber: 1, etag: "" }],
      }).success,
    ).toBe(false);
  });
});

describe("UploadStatusQuery", () => {
  const id1 = "00000000-0000-7000-8000-000000000001";
  const id2 = "00000000-0000-7000-8000-000000000002";

  it("splits, trims and drops empty entries", () => {
    expect(UploadStatusQuery.parse({ ids: ` ${id1} ,,${id2} ` }).ids).toEqual([
      id1,
      id2,
    ]);
  });

  it("dedupes ids", () => {
    expect(UploadStatusQuery.parse({ ids: `${id1},${id1}` }).ids).toEqual([
      id1,
    ]);
  });

  it("rejects a non-uuid id", () => {
    expect(UploadStatusQuery.safeParse({ ids: `${id1},nope` }).success).toBe(
      false,
    );
  });

  it("rejects an empty list", () => {
    expect(UploadStatusQuery.safeParse({ ids: " , " }).success).toBe(false);
  });

  it("rejects more than 100 ids", () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) =>
        `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    ).join(",");
    expect(UploadStatusQuery.safeParse({ ids }).success).toBe(false);
  });
});
