import { ResolveFoldersResponse } from "@docbridge/contracts";
import { AppError } from "../common/app-error";

export interface PlatformClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PlatformClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async resolveFolders(
    bearerToken: string,
    folderIds: string[],
  ): Promise<ResolveFoldersResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/folders/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ folderIds }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError(
        503,
        "platform_unavailable",
        "Document platform is unavailable",
      );
    }
    if (!res.ok) {
      throw new AppError(
        503,
        "platform_unavailable",
        "Document platform is unavailable",
        { status: res.status },
      );
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new AppError(
        503,
        "platform_unavailable",
        "Document platform returned an invalid response",
      );
    }
    const parsed = ResolveFoldersResponse.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        503,
        "platform_unavailable",
        "Document platform returned an invalid response",
      );
    }
    return parsed.data;
  }
}
