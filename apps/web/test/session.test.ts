import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { ApiError } from "../src/lib/api";
import { createSession } from "../src/auth/session";

const SUB = "11111111-2222-3333-a444-555555555555";

function fakeJwt(overrides: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "docbridge-auth",
    aud: "docbridge",
    sub: SUB,
    name: "Test User",
    teams: ["66666666-7777-4888-8999-000000000000"],
    admin: false,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  return `${b64({ alg: "RS256", kid: "k1" })}.${b64(payload)}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code = "unauthorized"): Response {
  return json({ error: { code, message: "nope", details: {} } }, status);
}

type FetchMock = jest.Mock<typeof fetch>;

const paths = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.map((c) => String(c[0]));

describe("session", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("login stores token and claims and schedules a silent refresh", async () => {
    const fetchMock: FetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(
      json({ accessToken: fakeJwt({ name: "Ada" }), expiresIn: 120 }),
    );
    const s = createSession({ fetch: fetchMock });
    await s.login("ada@example.com", "password123");
    const state = s.getState();
    expect(state.status).toBe("authenticated");
    expect(state.claims?.name).toBe("Ada");
    expect(state.claims?.sub).toBe(SUB);
    const token = state.token!;

    fetchMock.mockResolvedValueOnce(
      json({
        accessToken: fakeJwt({ name: "Ada", exp: 9999999999 }),
        expiresIn: 120,
      }),
    );
    await jest.advanceTimersByTimeAsync(59_000);
    expect(paths(fetchMock)).toEqual(["/auth/login"]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(paths(fetchMock)).toEqual(["/auth/login", "/auth/refresh"]);
    expect(s.getState().token).not.toBe(token);
  });

  it("authFetch attaches the bearer token", async () => {
    const fetchMock: FetchMock = jest.fn();
    const token = fakeJwt();
    fetchMock.mockResolvedValueOnce(
      json({ accessToken: token, expiresIn: 120 }),
    );
    const s = createSession({ fetch: fetchMock });
    await s.login("ada@example.com", "password123");
    fetchMock.mockResolvedValueOnce(json({ teams: [] }));
    const res = await s.authFetch<{ teams: unknown[] }>("/tree");
    expect(res.teams).toEqual([]);
    const [, init] = fetchMock.mock.calls[1];
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${token}`,
    );
  });

  it("on 401 authFetch refreshes once and retries with the new token", async () => {
    const fetchMock: FetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(
      json({ accessToken: fakeJwt(), expiresIn: 120 }),
    );
    const s = createSession({ fetch: fetchMock });
    await s.login("ada@example.com", "password123");

    const fresh = fakeJwt({ name: "Fresh" });
    fetchMock
      .mockResolvedValueOnce(error(401))
      .mockResolvedValueOnce(json({ accessToken: fresh, expiresIn: 120 }))
      .mockResolvedValueOnce(json({ teams: [{ id: "t" }] }));
    const res = await s.authFetch<{ teams: { id: string }[] }>("/tree");
    expect(res.teams).toHaveLength(1);
    expect(paths(fetchMock)).toEqual([
      "/auth/login",
      "/tree",
      "/auth/refresh",
      "/tree",
    ]);
    const retryInit = fetchMock.mock.calls[3][1];
    expect((retryInit?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${fresh}`,
    );
  });

  it("rethrows the original 401 when refresh also fails", async () => {
    const fetchMock: FetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(
      json({ accessToken: fakeJwt(), expiresIn: 120 }),
    );
    const s = createSession({ fetch: fetchMock });
    await s.login("ada@example.com", "password123");

    fetchMock
      .mockResolvedValueOnce(error(401))
      .mockResolvedValueOnce(error(401, "invalid_refresh"));
    const err = await s.authFetch("/tree").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(s.getState().status).toBe("anonymous");
    expect(s.getState().token).toBeNull();
  });

  it("dedupes concurrent refresh calls into a single request", async () => {
    const fetchMock: FetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(
      json({ accessToken: fakeJwt(), expiresIn: 120 }),
    );
    const s = createSession({ fetch: fetchMock });
    await s.login("ada@example.com", "password123");

    let resolveRefresh!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (resolveRefresh = r)),
    );
    const first = s.refresh();
    const second = s.refresh();
    resolveRefresh(json({ accessToken: fakeJwt(), expiresIn: 120 }));
    await Promise.all([first, second]);
    expect(paths(fetchMock).filter((p) => p === "/auth/refresh")).toHaveLength(
      1,
    );
  });

  it("restore marks the session anonymous when refresh fails", async () => {
    const fetchMock: FetchMock = jest.fn();
    fetchMock.mockResolvedValueOnce(error(401, "invalid_refresh"));
    const s = createSession({ fetch: fetchMock });
    await s.restore();
    await expect(s.ready()).resolves.toBeUndefined();
    expect(s.getState().status).toBe("anonymous");
  });
});
