import { describe, expect, it } from "@jest/globals";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { SigningKeyService } from "../src/keys/signing-key.service";
import { AUDIENCE, ISSUER } from "../src/constants";

describe("SigningKeyService", () => {
  async function makeService(): Promise<SigningKeyService> {
    const svc = new SigningKeyService();
    await svc.onModuleInit();
    return svc;
  }

  it("round-trips signed claims with a kid header", async () => {
    const svc = await makeService();
    const token = await svc.sign({ sub: "abc", admin: true }, 60);
    const header = decodeProtectedHeader(token);
    expect(header.kid).toBe(svc.jwks().keys[0].kid);
    const payload = await svc.verify(token);
    expect(payload.sub).toBe("abc");
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it("exposes only public JWK fields", async () => {
    const svc = await makeService();
    const jwk = svc.jwks().keys[0] as Record<string, unknown>;
    expect(Object.keys(jwk).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
    for (const priv of ["d", "p", "q", "dp", "dq", "qi", "oth"]) {
      expect(jwk[priv]).toBeUndefined();
    }
  });

  it("rejects a token signed by a different key", async () => {
    const a = await makeService();
    const b = await makeService();
    const token = await b.sign({ sub: "abc" }, 60);
    await expect(a.verify(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const svc = await makeService();
    const token = await svc.sign({ sub: "abc" }, 60);
    await expect(
      jwtVerify(token, svc.jwks().keys[0], {
        issuer: ISSUER,
        audience: "other-audience",
      }),
    ).rejects.toThrow();
  });
});
