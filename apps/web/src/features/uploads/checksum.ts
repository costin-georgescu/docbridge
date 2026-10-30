import { AwsCrc32c } from "@aws-crypto/crc32c";
import {
  MULTIPART_THRESHOLD_BYTES,
  PART_SIZE_BYTES,
} from "@docbridge/contracts";

export interface Checksums {
  checksumCrc32c: string;
  partChecksumsCrc32c?: string[];
}

export interface ChecksumOptions {
  onProgress?: (bytesHashed: number) => void;
  thresholdBytes?: number;
  partSizeBytes?: number;
}

async function digestBase64(crc: AwsCrc32c): Promise<string> {
  const bytes = await crc.digest();
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

export async function computeChecksums(
  stream: ReadableStream<Uint8Array>,
  sizeBytes: number,
  opts: ChecksumOptions = {},
): Promise<Checksums> {
  const thresholdBytes = opts.thresholdBytes ?? MULTIPART_THRESHOLD_BYTES;
  const partSizeBytes = opts.partSizeBytes ?? PART_SIZE_BYTES;
  const multipart = sizeBytes > thresholdBytes;

  const whole = new AwsCrc32c();
  let part = multipart ? new AwsCrc32c() : null;
  const partChecksums: string[] = [];
  let partOffset = 0;
  let hashed = 0;

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      whole.update(value);
      if (part) {
        let offset = 0;
        while (offset < value.length) {
          const take = Math.min(
            partSizeBytes - partOffset,
            value.length - offset,
          );
          part.update(value.subarray(offset, offset + take));
          partOffset += take;
          offset += take;
          if (partOffset === partSizeBytes) {
            partChecksums.push(await digestBase64(part));
            part = new AwsCrc32c();
            partOffset = 0;
          }
        }
      }
      hashed += value.length;
      opts.onProgress?.(hashed);
    }
    if (part && partOffset > 0) {
      partChecksums.push(await digestBase64(part));
    }
  } finally {
    reader.releaseLock();
  }

  const checksums: Checksums = {
    checksumCrc32c: await digestBase64(whole),
  };
  if (multipart) {
    checksums.partChecksumsCrc32c = partChecksums;
  }
  return checksums;
}
