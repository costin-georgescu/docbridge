export class TransferError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly status: number,
    public readonly s3Code: string | null,
    message: string,
    public readonly aborted = false,
  ) {
    super(message);
    this.name = "TransferError";
    this.retryable =
      !aborted && (status === 0 || status >= 500 || status === 429);
  }
}

function s3ErrorCode(responseText: string): string | null {
  const match = /<Code>([^<]+)<\/Code>/.exec(responseText);
  return match ? match[1] : null;
}

export function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<{ etag: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ etag: xhr.getResponseHeader("ETag") });
      } else {
        const code = s3ErrorCode(xhr.responseText);
        reject(
          new TransferError(
            xhr.status,
            code,
            code
              ? `Upload failed: ${code}`
              : `Upload failed with status ${xhr.status}`,
          ),
        );
      }
    };
    xhr.onerror = () =>
      reject(new TransferError(0, null, "Network error during upload"));
    xhr.onabort = () =>
      reject(new TransferError(0, null, "Upload aborted", true));
    if (signal.aborted) {
      xhr.abort();
      return;
    }
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries: number;
    baseDelayMs: number;
    sleep: (ms: number) => Promise<void>;
    isRetryable: (e: unknown) => boolean;
  },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !opts.isRetryable(err)) {
        throw err;
      }
      attempt += 1;
      await opts.sleep(opts.baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
