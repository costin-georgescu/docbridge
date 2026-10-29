export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(
  path: string,
  init: RequestInit & { token?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<T> {
  const { token, fetch: fetchImpl, headers, ...rest } = init;
  const res = await (fetchImpl ?? globalThis.fetch)(`${__API_BASE__}${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (
      body as {
        error?: { code?: unknown; message?: unknown; details?: unknown };
      } | null
    )?.error;
    throw new ApiError(
      res.status,
      typeof err?.code === "string" ? err.code : "http_error",
      typeof err?.message === "string" ? err.message : res.statusText,
      (err?.details as Record<string, unknown>) ?? {},
    );
  }
  return body as T;
}
