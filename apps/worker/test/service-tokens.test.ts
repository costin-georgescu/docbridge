import { describe, expect, it } from "@jest/globals";
import { ServiceTokens } from "../src/auth/service-tokens";

const tokenResponse = (token: string, expiresIn = 3600) =>
  new Response(JSON.stringify({ accessToken: token, expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function tokensWith(fetchImpl: typeof fetch): ServiceTokens {
  return new ServiceTokens({
    baseUrl: "http://auth:3001/",
    clientId: "worker",
    clientSecret: "secret",
    fetch: fetchImpl,
  });
}

describe("ServiceTokens", () => {
  it("exchanges client credentials for a token and caches it", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stub: typeof fetch = async (url, init) => {
      calls.push({ url: url as string, init: init as RequestInit });
      return tokenResponse("tok-1");
    };
    const tokens = tokensWith(stub);

    expect(await tokens.getToken()).toBe("tok-1");
    expect(await tokens.getToken()).toBe("tok-1");
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0];
    expect(url).toBe("http://auth:3001/auth/service-token");
    expect(JSON.parse(init.body as string)).toEqual({
      clientId: "worker",
      clientSecret: "secret",
    });
  });

  it("shares one in-flight request between concurrent callers", async () => {
    let calls = 0;
    const stub: typeof fetch = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return tokenResponse("tok-shared");
    };
    const tokens = tokensWith(stub);
    const [a, b] = await Promise.all([tokens.getToken(), tokens.getToken()]);
    expect(a).toBe("tok-shared");
    expect(b).toBe("tok-shared");
    expect(calls).toBe(1);
  });

  it("renews when the cached token is inside the renew window", async () => {
    let calls = 0;
    const stub: typeof fetch = async () => {
      calls += 1;
      return tokenResponse(`tok-${calls}`, 60); // inside the usage buffer too
    };
    const tokens = tokensWith(stub);
    expect(await tokens.getToken()).toBe("tok-1");
    expect(await tokens.getToken()).toBe("tok-2");
    expect(calls).toBe(2);
  });

  it("serves a still-valid token while a renewal fails in the background", async () => {
    let calls = 0;
    const stub: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return tokenResponse("tok-1", 599); // in the renew window
      throw new TypeError("connect ECONNREFUSED");
    };
    const tokens = tokensWith(stub);
    expect(await tokens.getToken()).toBe("tok-1");
    expect(await tokens.getToken()).toBe("tok-1");
    expect(await tokens.getToken()).toBe("tok-1");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("fails once the cached token is inside the usage buffer", async () => {
    let calls = 0;
    const stub: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return tokenResponse("tok-1", 30); // below the usage buffer
      throw new TypeError("connect ECONNREFUSED");
    };
    const tokens = tokensWith(stub);
    expect(await tokens.getToken()).toBe("tok-1");
    await expect(tokens.getToken()).rejects.toThrow(
      "service token request failed",
    );
  });

  it("throws on a non-2xx response", async () => {
    const stub: typeof fetch = async () =>
      new Response("down", { status: 503 });
    const tokens = tokensWith(stub);
    await expect(tokens.getToken()).rejects.toThrow("503");
  });

  it("throws on a transport error", async () => {
    const stub: typeof fetch = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const tokens = tokensWith(stub);
    await expect(tokens.getToken()).rejects.toThrow(
      "service token request failed",
    );
  });
});
