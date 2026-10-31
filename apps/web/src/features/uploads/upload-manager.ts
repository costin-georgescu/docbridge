import {
  ALLOWED_UPLOAD_TYPES,
  CreateUploadResponse,
  MAX_UPLOAD_BYTES,
  UploadStatusResponse,
} from "@docbridge/contracts";
import { Session } from "../../auth/session";
import { ApiError } from "../../lib/api";
import { Checksums } from "./checksum";
import { Hasher } from "./checksum-client";
import { uploadErrorMessage } from "./messages";
import { putWithProgress, TransferError, withRetry } from "./transfer";

export type UploadPhase =
  | "queued"
  | "hashing"
  | "uploading"
  | "completing"
  | "processing"
  | "staged"
  | "error";

export const STATUS_LABELS: Record<UploadPhase, string> = {
  queued: "Queued",
  hashing: "Computing checksum",
  uploading: "Uploading",
  completing: "Completing",
  processing: "Processing",
  staged: "Staged",
  error: "Failed",
};

export interface UploadItem {
  id: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  phase: UploadPhase;
  progress: number;
  fileId: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface UploadManagerDeps {
  authFetch: Session["authFetch"];
  hash: Hasher;
  put: typeof putWithProgress;
  sleep?: (ms: number) => Promise<void>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  now?: () => number;
  newId?: () => string;
}

export interface UploadManager {
  getState(): UploadItem[];
  subscribe(listener: () => void): () => void;
  addFiles(files: File[]): void;
  retry(id: string): void;
  remove(id: string): void;
  reset(): void;
}

const MAX_ACTIVE = 3;
const PART_CONCURRENCY = 4;
const POLL_INTERVAL_MS = 2000;
const POLL_CHUNK = 100;
const RESUME_EXPIRY_MARGIN_MS = 60_000;
const RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

const ACTIVE_PHASES: UploadPhase[] = ["hashing", "uploading", "completing"];

interface PrivateItem {
  file: File;
  generation: number;
  checksums: Checksums | null;
  plan: CreateUploadResponse | null;
  etags: Map<number, string>;
  inflight: Map<number, number>;
  controllers: Set<AbortController>;
  checksumMismatch: boolean;
}

function isAbort(err: unknown): boolean {
  return err instanceof TransferError && err.aborted;
}

function isRetryableTransfer(err: unknown): boolean {
  return err instanceof TransferError && err.retryable;
}

function toItemError(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (err instanceof ApiError) {
    const retryable = err.status !== 415 && err.status !== 413;
    return {
      code: err.code,
      message: uploadErrorMessage(err.code, err.message),
      retryable,
    };
  }
  if (err instanceof TransferError) {
    const code =
      err.s3Code === "BadDigest" || err.s3Code === "InvalidDigest"
        ? "checksum_mismatch"
        : "upload_failed";
    return {
      code,
      message: uploadErrorMessage(code, err.message),
      retryable: true,
    };
  }
  const code = "upload_failed";
  return {
    code,
    message: uploadErrorMessage(
      code,
      err instanceof Error ? err.message : "Upload failed",
    ),
    retryable: true,
  };
}

export function createUploadManager(deps: UploadManagerDeps): UploadManager {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setIntervalImpl = deps.setInterval ?? globalThis.setInterval;
  const clearIntervalImpl = deps.clearInterval ?? globalThis.clearInterval;
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  let items: UploadItem[] = [];
  const privateById = new Map<string, PrivateItem>();
  const listeners = new Set<() => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const notify = () => listeners.forEach((listener) => listener());

  const update = (id: string, patch: Partial<UploadItem>) => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) {
      return;
    }
    items = items.map((item, i) =>
      i === index ? { ...item, ...patch } : item,
    );
    notify();
  };

  const alive = (id: string, generation: number): boolean =>
    privateById.get(id)?.generation === generation;

  const updateIfAlive = (
    id: string,
    generation: number,
    patch: Partial<UploadItem>,
  ) => {
    if (alive(id, generation)) {
      update(id, patch);
    }
  };

  const activeCount = () =>
    items.filter((item) => ACTIVE_PHASES.includes(item.phase)).length;

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearIntervalImpl(pollTimer);
      pollTimer = null;
    }
  };

  const pollOnce = async () => {
    const ids = items
      .filter((item) => item.phase === "processing" && item.fileId)
      .map((item) => item.fileId!);
    if (ids.length === 0) {
      stopPolling();
      return;
    }
    for (let i = 0; i < ids.length; i += POLL_CHUNK) {
      const chunk = ids.slice(i, i + POLL_CHUNK);
      try {
        const res = await deps.authFetch<UploadStatusResponse>(
          `/api/uploads?ids=${chunk.join(",")}`,
        );
        const staged = new Map(res.map((r) => [r.fileId, r.status]));
        items.forEach((item) => {
          if (
            item.phase === "processing" &&
            item.fileId &&
            staged.get(item.fileId) === "staged"
          ) {
            update(item.id, { phase: "staged" });
          }
        });
      } catch {
        // next tick retries
      }
    }
  };

  const ensurePolling = () => {
    if (pollTimer === null) {
      pollTimer = setIntervalImpl(() => void pollOnce(), POLL_INTERVAL_MS);
    }
  };

  const emitUploadProgress = (id: string, priv: PrivateItem) => {
    const item = items.find((it) => it.id === id);
    if (!item) {
      return;
    }
    const plan = priv.plan;
    let done = 0;
    if (plan?.mode === "multipart") {
      for (const partNumber of priv.etags.keys()) {
        const start = (partNumber - 1) * plan.partSizeBytes;
        done += Math.min(
          plan.partSizeBytes,
          Math.max(0, item.sizeBytes - start),
        );
      }
      for (const loaded of priv.inflight.values()) {
        done += loaded;
      }
    } else {
      done = priv.inflight.get(0) ?? 0;
    }
    update(id, {
      progress: item.sizeBytes > 0 ? Math.min(1, done / item.sizeBytes) : 0,
    });
  };

  const newController = (priv: PrivateItem): AbortController => {
    const controller = new AbortController();
    priv.controllers.add(controller);
    return controller;
  };

  const putRetried = (
    priv: PrivateItem,
    partNumber: number,
    url: string,
    body: Blob,
    headers: Record<string, string>,
    id: string,
  ) => {
    const controller = newController(priv);
    return withRetry(
      () =>
        deps.put(
          url,
          body,
          headers,
          (loaded) => {
            priv.inflight.set(partNumber, loaded);
            emitUploadProgress(id, priv);
          },
          controller.signal,
        ),
      {
        retries: RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        sleep,
        isRetryable: isRetryableTransfer,
      },
    ).finally(() => priv.controllers.delete(controller));
  };

  const uploadMultipart = async (
    id: string,
    priv: PrivateItem,
    generation: number,
    plan: Extract<CreateUploadResponse, { mode: "multipart" }>,
  ) => {
    const pending = plan.parts
      .filter((part) => !priv.etags.has(part.partNumber))
      .sort((a, b) => a.partNumber - b.partNumber);
    const item = items.find((it) => it.id === id)!;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(PART_CONCURRENCY, pending.length) },
      async () => {
        while (next < pending.length) {
          const part = pending[next++];
          if (!alive(id, generation)) {
            return;
          }
          const start = (part.partNumber - 1) * plan.partSizeBytes;
          const end = Math.min(
            part.partNumber * plan.partSizeBytes,
            item.sizeBytes,
          );
          const result = await putRetried(
            priv,
            part.partNumber,
            part.url,
            priv.file.slice(start, end),
            part.headers,
            id,
          );
          if (!result.etag) {
            throw new TransferError(
              0,
              null,
              "Storage response did not include an ETag. Check the bucket CORS ExposeHeaders configuration.",
            );
          }
          priv.etags.set(part.partNumber, result.etag);
          priv.inflight.delete(part.partNumber);
          emitUploadProgress(id, priv);
        }
      },
    );
    await Promise.all(workers);
    if (!alive(id, generation)) {
      return;
    }
    update(id, { phase: "completing" });
    const parts = [...priv.etags.entries()]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    await deps.authFetch(`/api/uploads/${plan.fileId}/complete`, {
      method: "POST",
      body: JSON.stringify({ parts }),
    });
  };

  const run = async (id: string, generation: number) => {
    const priv = privateById.get(id);
    const item = items.find((it) => it.id === id);
    if (!priv || !item) {
      return;
    }
    try {
      if (!priv.checksums) {
        update(id, { phase: "hashing", progress: 0, error: null });
        priv.checksums = await deps.hash(priv.file, (bytes) => {
          updateIfAlive(id, generation, {
            progress:
              item.sizeBytes > 0 ? Math.min(1, bytes / item.sizeBytes) : 0,
          });
        });
      }
      if (!alive(id, generation)) {
        return;
      }
      if (!priv.plan) {
        const body: Record<string, unknown> = {
          fileName: item.name,
          contentType: item.contentType,
          sizeBytes: item.sizeBytes,
          checksumCrc32c: priv.checksums.checksumCrc32c,
        };
        if (priv.checksums.partChecksumsCrc32c) {
          body.partChecksumsCrc32c = priv.checksums.partChecksumsCrc32c;
        }
        priv.plan = await deps.authFetch<CreateUploadResponse>("/api/uploads", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      if (!alive(id, generation)) {
        return;
      }
      update(id, {
        phase: "uploading",
        fileId: priv.plan.fileId,
        progress: 0,
      });
      if (priv.plan.mode === "single") {
        await putRetried(
          priv,
          0,
          priv.plan.url,
          priv.file,
          priv.plan.headers,
          id,
        );
      } else {
        await uploadMultipart(id, priv, generation, priv.plan);
      }
      if (!alive(id, generation)) {
        return;
      }
      update(id, { phase: "processing", progress: 1 });
      ensurePolling();
      pump();
    } catch (err) {
      if (!alive(id, generation) || isAbort(err)) {
        return;
      }
      priv.controllers.forEach((controller) => controller.abort());
      priv.inflight.clear();
      const itemError = toItemError(err);
      priv.checksumMismatch = itemError.code === "checksum_mismatch";
      update(id, { phase: "error", error: itemError });
      pump();
    }
  };

  const pump = () => {
    for (const item of items) {
      if (activeCount() >= MAX_ACTIVE) {
        break;
      }
      if (item.phase === "queued") {
        const priv = privateById.get(item.id);
        if (priv) {
          priv.generation += 1;
          void run(item.id, priv.generation);
        }
      }
    }
  };

  const failValidation = (
    file: File,
    contentType: string,
    code: string,
    message: string,
  ) => {
    const id = newId();
    items = [
      ...items,
      {
        id,
        name: file.name,
        sizeBytes: file.size,
        contentType,
        phase: "error",
        progress: 0,
        fileId: null,
        error: {
          code,
          message: uploadErrorMessage(code, message),
          retryable: false,
        },
      },
    ];
    notify();
  };

  return {
    getState: () => items,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addFiles: (files) => {
      for (const file of files) {
        const dot = file.name.lastIndexOf(".");
        const ext =
          dot >= 0 && dot < file.name.length - 1
            ? file.name.slice(dot + 1).toLowerCase()
            : "";
        const contentType = (ALLOWED_UPLOAD_TYPES as Record<string, string>)[
          ext
        ];
        if (!contentType || (file.type !== "" && file.type !== contentType)) {
          failValidation(
            file,
            contentType ?? (file.type || "application/octet-stream"),
            "unsupported_file_type",
            "File type is not supported",
          );
          continue;
        }
        if (file.size === 0) {
          failValidation(
            file,
            contentType,
            "validation_error",
            "File is empty",
          );
          continue;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          failValidation(
            file,
            contentType,
            "file_too_large",
            "File exceeds the 1 GiB limit",
          );
          continue;
        }
        const id = newId();
        items = [
          ...items,
          {
            id,
            name: file.name,
            sizeBytes: file.size,
            contentType,
            phase: "queued",
            progress: 0,
            fileId: null,
            error: null,
          },
        ];
        privateById.set(id, {
          file,
          generation: 0,
          checksums: null,
          plan: null,
          etags: new Map(),
          inflight: new Map(),
          controllers: new Set(),
          checksumMismatch: false,
        });
      }
      notify();
      pump();
    },
    retry: (id) => {
      const item = items.find((it) => it.id === id);
      const priv = privateById.get(id);
      if (!item || !priv || item.phase !== "error") {
        return;
      }
      const planValid =
        priv.plan !== null &&
        Date.parse(priv.plan.expiresAt) > now() + RESUME_EXPIRY_MARGIN_MS;
      const canResume =
        priv.checksums !== null && planValid && !priv.checksumMismatch;
      if (!canResume) {
        priv.plan = null;
        priv.etags.clear();
        priv.inflight.clear();
        if (priv.checksumMismatch) {
          priv.checksums = null;
        }
      }
      priv.checksumMismatch = false;
      update(id, {
        phase: "queued",
        progress: 0,
        error: null,
        fileId: canResume ? item.fileId : null,
      });
      pump();
    },
    remove: (id) => {
      const priv = privateById.get(id);
      if (priv) {
        priv.generation += 1;
        priv.controllers.forEach((controller) => controller.abort());
        privateById.delete(id);
      }
      const next = items.filter((item) => item.id !== id);
      if (next.length !== items.length) {
        items = next;
        notify();
      }
      pump();
    },
    reset: () => {
      privateById.forEach((priv) => {
        priv.generation += 1;
        priv.controllers.forEach((controller) => controller.abort());
      });
      privateById.clear();
      items = [];
      stopPolling();
      notify();
    },
  };
}
