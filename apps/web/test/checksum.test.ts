import { AwsCrc32c } from "@aws-crypto/crc32c";
import { describe, expect, it, jest } from "@jest/globals";
import { computeChecksums } from "../src/features/uploads/checksum";

async function crc32cBase64(data: Uint8Array): Promise<string> {
  const crc = new AwsCrc32c();
  crc.update(data);
  const bytes = await crc.digest();
  return btoa(String.fromCharCode(...bytes));
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function chunkSizes(total: number, sizes: number[]): Uint8Array[] {
  const data = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    data[i] = i % 251;
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < total) {
    chunks.push(data.subarray(offset));
  }
  return chunks;
}

describe("computeChecksums", () => {
  it("matches the known CRC32C vector for '123456789'", async () => {
    const data = new TextEncoder().encode("123456789");
    const result = await computeChecksums(streamOf([data]), data.length);
    expect(result.checksumCrc32c).toBe("4waSgw==");
    expect(result.partChecksumsCrc32c).toBeUndefined();
  });

  it("produces the same digest as hashing the whole buffer with irregular chunks", async () => {
    const chunks = chunkSizes(1027, [1, 500, 13, 400, 113]);
    const data = new Uint8Array(1027);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    const result = await computeChecksums(streamOf(chunks), 1027);
    expect(result.checksumCrc32c).toBe(await crc32cBase64(data));
  });

  it("computes per-part digests across chunk boundaries with a short last part", async () => {
    const partSize = 4;
    const threshold = 10;
    const total = 23;
    const chunks = chunkSizes(total, [7, 5, 11]);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }

    const onProgress = jest.fn();
    const result = await computeChecksums(streamOf(chunks), total, {
      thresholdBytes: threshold,
      partSizeBytes: partSize,
      onProgress,
    });

    expect(result.checksumCrc32c).toBe(await crc32cBase64(data));
    const expectedParts = Math.ceil(total / partSize);
    expect(result.partChecksumsCrc32c).toHaveLength(expectedParts);
    for (let i = 0; i < expectedParts; i++) {
      const slice = data.subarray(i * partSize, (i + 1) * partSize);
      expect(result.partChecksumsCrc32c![i]).toBe(await crc32cBase64(slice));
    }
    expect(onProgress).toHaveBeenLastCalledWith(total);
  });

  it("does not compute part checksums when size is at or below the threshold", async () => {
    const chunks = chunkSizes(10, [4, 6]);
    const result = await computeChecksums(streamOf(chunks), 10, {
      thresholdBytes: 10,
      partSizeBytes: 4,
    });
    expect(result.partChecksumsCrc32c).toBeUndefined();
  });
});
