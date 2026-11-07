import { describe, expect, it } from "@jest/globals";
import {
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { SigningKeyService } from "../src/keys/signing-key.service";
import { config } from "../src/config";
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

  it("loads a JWT_SIGNING_KEY document (production path)", async () => {
    // Regression: importPKCS8 keys must be extractable or exportJWK throws.
    // Same {"kid","privateKey"} document scripts/gen-signing-key.impl.ts writes.
    const privateKeyPem = await exportPKCS8(
      (
        await generateKeyPair("RS256", {
          modulusLength: 2048,
          extractable: true,
        })
      ).privateKey,
    );
    const doc = { kid: "k-test-abcdef", privateKey: privateKeyPem };
    const original = config.JWT_SIGNING_KEY;
    (config as { JWT_SIGNING_KEY?: string }).JWT_SIGNING_KEY =
      JSON.stringify(doc);
    try {
      const svc = new SigningKeyService();
      await svc.onModuleInit();
      const jwk = svc.jwks().keys[0] as Record<string, unknown>;
      expect(jwk.kid).toBe(doc.kid);
      expect(jwk.alg).toBe("RS256");
      expect(jwk.use).toBe("sig");
      expect(jwk.kty).toBe("RSA");
      expect(typeof jwk.n).toBe("string");
      expect(typeof jwk.e).toBe("string");
      for (const priv of ["d", "p", "q", "dp", "dq", "qi"]) {
        expect(jwk[priv]).toBeUndefined();
      }
      const token = await svc.sign({ sub: "abc" }, 60);
      const payload = await svc.verify(token);
      expect(payload.sub).toBe("abc");
    } finally {
      (config as { JWT_SIGNING_KEY?: string }).JWT_SIGNING_KEY = original;
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
