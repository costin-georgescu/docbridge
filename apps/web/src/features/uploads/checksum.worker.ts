import { computeChecksums } from "./checksum";

interface HashRequest {
  id: number;
  file: File;
}

const PROGRESS_STEP_BYTES = 4 * 1024 ** 2;

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = (event) => {
  const { id, file } = event.data;
  let lastReported = 0;
  computeChecksums(file.stream(), file.size, {
    onProgress: (bytes) => {
      if (bytes - lastReported >= PROGRESS_STEP_BYTES) {
        lastReported = bytes;
        ctx.postMessage({ id, type: "progress", bytes });
      }
    },
  }).then(
    (checksums) => ctx.postMessage({ id, type: "done", checksums }),
    (err: unknown) =>
      ctx.postMessage({
        id,
        type: "error",
        message: err instanceof Error ? err.message : "Checksum failed",
      }),
  );
};
