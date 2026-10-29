import { describe, expect, it } from "@jest/globals";
import { createS3Client, presignPutObject, presignUploadPart } from "../src";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

function client() {
  return createS3Client({
    region: "eu-central-1",
    endpoint: "http://localhost:4566",
  });
}

describe("presignPutObject", () => {
  it("binds content type and crc32c as signed headers", async () => {
    const { url, headers } = await presignPutObject(client(), {
      bucket: "docbridge-staging",
      key: "staged/user/file",
      contentType: "application/pdf",
      checksumCrc32c: "AAAAAA==",
      expiresIn: 900,
    });
    const u = new URL(url);
    const signed = u.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed).toContain("content-type");
    expect(signed).toContain("x-amz-checksum-crc32c");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    // the checksum must be a header, not a query param
    expect(u.searchParams.get("x-amz-checksum-crc32c")).toBeNull();
    expect(u.searchParams.get("x-amz-sdk-checksum-algorithm")).toBeNull();
    for (const key of u.searchParams.keys()) {
      expect(key).not.toContain("x-amz-checksum-crc32");
    }
    expect(headers).toEqual({
      "Content-Type": "application/pdf",
      "x-amz-checksum-crc32c": "AAAAAA==",
    });
  });
});

describe("presignUploadPart", () => {
  it("binds the part crc32c as a signed header", async () => {
    const { url, headers } = await presignUploadPart(client(), {
      bucket: "docbridge-staging",
      key: "staged/user/file",
      uploadId: "upload-123",
      partNumber: 3,
      checksumCrc32c: "BBBBBB==",
      expiresIn: 3600,
    });
    const u = new URL(url);
    expect(u.searchParams.get("partNumber")).toBe("3");
    expect(u.searchParams.get("uploadId")).toBe("upload-123");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    const signed = u.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed).toContain("x-amz-checksum-crc32c");
    for (const key of u.searchParams.keys()) {
      expect(key).not.toContain("x-amz-checksum-crc32");
    }
    expect(u.searchParams.get("x-amz-sdk-checksum-algorithm")).toBeNull();
    expect(headers).toEqual({ "x-amz-checksum-crc32c": "BBBBBB==" });
  });
});
