import { Readable } from "node:stream";
import {
  DeliverDocumentResponse,
  ErrorCode,
  ErrorResponse,
} from "@docbridge/contracts";

/** TDD 2.7: one delivery attempt must finish within 15 minutes. */
export const DELIVERY_DEADLINE_MS = 15 * 60 * 1000;

export type DeliveryOutcome =
  | { kind: "delivered"; documentId: string; versionNo: number }
  | { kind: "permanent"; code: ErrorCode; message: string }
  | { kind: "retryable"; code: ErrorCode; message: string };

export interface DeliverRequest {
  token: string;
  taskId: string;
  submitterUserId: string;
  folderId: string;
  fileName: string;
  contentType: string;
  sizeBytes: bigint;
  checksumCrc32c: string;
  body: Readable;
}

export interface PlatformDeliveryClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  deadlineMs?: number;
}

const permanent = (code: ErrorCode, message: string): DeliveryOutcome => ({
  kind: "permanent",
  code,
  message,
});
const retryable = (code: ErrorCode, message: string): DeliveryOutcome => ({
  kind: "retryable",
  code,
  message,
});

/**
 * Streams a staged object into `PUT /folders/:folderId/documents` (TDD 4.4)
 * and classifies the result the way 2.7 prescribes: 200/201 completes the
 * task, 4xx fails it permanently, 429/5xx and transport errors retry.
 */
export class PlatformDeliveryClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;

  constructor(options: PlatformDeliveryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.deadlineMs = options.deadlineMs ?? DELIVERY_DEADLINE_MS;
  }

  async deliver(req: DeliverRequest): Promise<DeliveryOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/folders/${req.folderId}/documents`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${req.token}`,
            "x-delivery-task-id": req.taskId,
            "x-submitter-user-id": req.submitterUserId,
            // Percent-encoded so any file name survives the latin-1-only
            // header channel; the platform decodes with decodeURIComponent.
            "x-file-name": encodeURIComponent(req.fileName),
            "x-checksum-crc32c": req.checksumCrc32c,
            "content-type": req.contentType,
            "content-length": req.sizeBytes.toString(),
          },
          body: req.body,
          duplex: "half",
          signal: AbortSignal.timeout(this.deadlineMs),
        },
      );
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") {
        return retryable(
          "delivery_timeout",
          `delivery deadline of ${this.deadlineMs} ms exceeded`,
        );
      }
      return retryable(
        "platform_unavailable",
        `delivery request failed: ${err.message}`,
      );
    }

    if (res.status === 200 || res.status === 201) {
      const parsed = DeliverDocumentResponse.safeParse(
        await res.json().catch(() => null),
      );
      if (!parsed.success) {
        return retryable(
          "platform_unavailable",
          `platform answered ${res.status} with an invalid body`,
        );
      }
      return {
        kind: "delivered",
        documentId: parsed.data.documentId,
        versionNo: parsed.data.versionNo,
      };
    }

    const message = await this.errorMessage(res);
    if (res.status === 400 && message.code === "checksum_mismatch") {
      return permanent("checksum_mismatch", message.text);
    }
    if (res.status === 404) {
      return permanent("folder_not_found", message.text);
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      return permanent("platform_rejected", message.text);
    }
    return retryable("platform_unavailable", message.text);
  }

  private async errorMessage(
    res: Response,
  ): Promise<{ code: ErrorCode | null; text: string }> {
    const fallback = `platform answered ${res.status}`;
    const body = await res.text().catch(() => "");
    if (!body) return { code: null, text: fallback };
    try {
      const parsed = ErrorResponse.safeParse(JSON.parse(body));
      if (!parsed.success) return { code: null, text: fallback };
      return { code: parsed.data.error.code, text: parsed.data.error.message };
    } catch {
      return { code: null, text: fallback };
    }
  }
}
