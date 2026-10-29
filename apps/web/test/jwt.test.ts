import { describe, expect, it } from "@jest/globals";
import { decodeClaims } from "../src/lib/jwt";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "k1" })}.${b64(payload)}.sig`;
}

describe("decodeClaims", () => {
  it("decodes a valid payload", () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = decodeClaims(
      fakeJwt({
        iss: "docbridge-auth",
        aud: "docbridge",
        sub: "11111111-2222-3333-a444-555555555555",
        name: "Ada",
        teams: ["66666666-7777-4888-8999-000000000000"],
        admin: true,
        iat: now,
        exp: now + 60,
      }),
    );
    expect(claims.name).toBe("Ada");
    expect(claims.admin).toBe(true);
  });

  it("throws on garbage", () => {
    expect(() => decodeClaims("not-a-jwt")).toThrow();
    expect(() => decodeClaims("a.b.c")).toThrow();
  });
});
