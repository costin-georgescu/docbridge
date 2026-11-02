import { describe, expect, it } from "@jest/globals";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  parseArgs,
  generateSigningKey,
  secretIsPopulated,
  planForPopulated,
} from "./gen-signing-key.impl";

describe("parseArgs", () => {
  it("defaults to print mode with no flags", () => {
    expect(parseArgs([])).toEqual({
      force: false,
      dryRun: false,
      skipIfPopulated: false,
    });
  });

  it("parses --aws-secret, --region, --force, --dry-run", () => {
    expect(
      parseArgs([
        "--aws-secret",
        "docbridge/staging/auth/jwt-signing-key",
        "--region",
        "eu-central-1",
        "--force",
        "--dry-run",
        "--skip-if-populated",
      ]),
    ).toEqual({
      awsSecret: "docbridge/staging/auth/jwt-signing-key",
      region: "eu-central-1",
      force: true,
      dryRun: true,
      skipIfPopulated: true,
    });
  });

  it("rejects unknown arguments and missing values", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--aws-secret"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--region"])).toThrow(/requires a value/);
  });
});

describe("generateSigningKey", () => {
  it("produces the JSON shape auth's SigningKeyService parses", () => {
    const key = generateSigningKey();
    // Same JSON.parse + field access as apps/auth signing-key.service.ts.
    const parsed = JSON.parse(JSON.stringify(key)) as {
      kid: string;
      privateKey: string;
    };
    expect(parsed.kid).toMatch(/^k-\d{8}-[0-9a-f]{6}$/);
    expect(parsed.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    // Valid pkcs8 PEM importable by node:crypto, and a matching RSA-2048
    // public key can be derived.
    const priv = createPrivateKey(parsed.privateKey);
    expect(priv.asymmetricKeyType).toBe("rsa");
    const pub = createPublicKey(priv).export({
      format: "jwk",
    }) as { n?: string };
    expect(Buffer.from(pub.n!, "base64url").length).toBe(256);
  });

  it("generates unique kids", () => {
    expect(generateSigningKey().kid).not.toBe(generateSigningKey().kid);
  });
});

describe("planForPopulated", () => {
  it("skips with --skip-if-populated, refuses by default, writes with --force", () => {
    expect(planForPopulated({ force: false, skipIfPopulated: true })).toBe(
      "skip",
    );
    expect(planForPopulated({ force: false, skipIfPopulated: false })).toBe(
      "refuse",
    );
    expect(planForPopulated({ force: true, skipIfPopulated: true })).toBe(
      "write",
    );
  });
});

describe("secretIsPopulated", () => {
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
  const fail = (stderr: string) => ({ ok: false, stdout: "", stderr });

  it("is populated when SecretString is non-empty", () => {
    expect(
      secretIsPopulated(ok(JSON.stringify({ SecretString: '{"kid":"x"}' }))),
    ).toBe(true);
  });

  it("is empty when the secret has no SecretString or is missing", () => {
    expect(secretIsPopulated(ok(JSON.stringify({})))).toBe(false);
    expect(
      secretIsPopulated(fail("An error occurred (ResourceNotFoundException)")),
    ).toBe(false);
  });

  it("propagates other AWS errors", () => {
    expect(() =>
      secretIsPopulated(fail("An error occurred (AccessDeniedException)")),
    ).toThrow(/get-secret-value failed/);
  });
});
