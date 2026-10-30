import { Checksums } from "./checksum";

export type Hasher = (
  file: File,
  onProgress: (bytes: number) => void,
) => Promise<Checksums>;

type WorkerResponse =
  | { id: number; type: "progress"; bytes: number }
  | { id: number; type: "done"; checksums: Checksums }
  | { id: number; type: "error"; message: string };

interface Pending {
  resolve: (checksums: Checksums) => void;
  reject: (err: Error) => void;
  onProgress: (bytes: number) => void;
}

export function createWorkerHasher(): Hasher {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, Pending>();

  const ensure = (): Worker => {
    if (!worker) {
      worker = new Worker(new URL("./checksum.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        const entry = pending.get(msg.id);
        if (!entry) {
          return;
        }
        if (msg.type === "progress") {
          entry.onProgress(msg.bytes);
        } else if (msg.type === "done") {
          pending.delete(msg.id);
          entry.resolve(msg.checksums);
        } else {
          pending.delete(msg.id);
          entry.reject(new Error(msg.message));
        }
      };
      worker.onerror = (event) => {
        const err = new Error(event.message || "Checksum worker failed");
        pending.forEach((entry) => entry.reject(err));
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    }
    return worker;
  };

  return (file, onProgress) =>
    new Promise<Checksums>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      ensure().postMessage({ id, file });
    });
}
