import { describe, expect, it } from "@jest/globals";
import { JwksClient } from "../src/jwks-client";
import { TokenVerifier } from "../src/token-verifier";
import {
  fakeFetch,
  makeKeypair,
  servicePayload,
  signToken,
  userPayload,
} from "./helpers";

const JWKS_URL = "http://auth.test/.well-known/jwks.json";

describe("TokenVerifier", () => {
  it("verifies a user token and caches the JWKS across verifies", async () => {
    const kp = await makeKeypair("k1");
    const { fetch, calls } = fakeFetch(() => [kp.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(kp.privateKey, "k1", userPayload());
    const claims = await verifier.verify(token);
    expect("teams" in claims && claims.sub).toBe(
      "11111111-2222-3333-a444-555555555555",
    );

    await verifier.verify(await signToken(kp.privateKey, "k1", userPayload()));
    expect(calls).toHaveLength(1);
  });

  it("verifies a service token", async () => {
    const kp = await makeKeypair("k1");
    const { fetch } = fakeFetch(() => [kp.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(
      kp.privateKey,
      "k1",
      servicePayload(["documents:write"]),
    );
    const claims = await verifier.verify(token);
    expect("scope" in claims && claims.scope).toEqual(["documents:write"]);
  });

  it("refetches once when the kid is unknown", async () => {
    const k1 = await makeKeypair("k1");
    const k2 = await makeKeypair("k2");
    let keys = [k1.publicJwk];
    const { fetch, calls } = fakeFetch(() => keys);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    keys = [k1.publicJwk, k2.publicJwk];
    const token = await signToken(k2.privateKey, "k2", userPayload());
    const claims = await verifier.verify(token);
    expect(claims.sub).toBe("11111111-2222-3333-a444-555555555555");
    expect(calls).toHaveLength(2);
  });

  it("rejects when the kid is still unknown after refetch", async () => {
    const k1 = await makeKeypair("k1");
    const k2 = await makeKeypair("k2");
    const { fetch, calls } = fakeFetch(() => [k1.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(k2.privateKey, "k2", userPayload());
    await expect(verifier.verify(token)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("rejects a token signed by a different key with the same kid", async () => {
    const k1 = await makeKeypair("k1");
    const other = await makeKeypair("k1");
    const { fetch } = fakeFetch(() => [k1.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(other.privateKey, "k1", userPayload());
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong issuer", async () => {
    const kp = await makeKeypair("k1");
    const { fetch } = fakeFetch(() => [kp.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(kp.privateKey, "k1", userPayload(), {
      issuer: "not-docbridge",
    });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const kp = await makeKeypair("k1");
    const { fetch } = fakeFetch(() => [kp.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(kp.privateKey, "k1", userPayload(), {
      audience: "other-audience",
    });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const kp = await makeKeypair("k1");
    const { fetch } = fakeFetch(() => [kp.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(kp.privateKey, "k1", userPayload(), {
      iat: now - 120,
      exp: now - 60,
    });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it("rejects a structurally invalid payload", async () => {
    const kp = await makeKeypair("k1");
    const { fetch } = fakeFetch(() => [kp.publicJwk]);
    const client = new JwksClient({ jwksUrl: JWKS_URL, fetch, cooldownMs: 0 });
    const verifier = new TokenVerifier(client);
    await client.warmUp();

    const token = await signToken(
      kp.privateKey,
      "k1",
      userPayload({ sub: "not-a-uuid" }),
    );
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
