import { describe, expect, it } from "@jest/globals";
import { scrubForLog } from "../src/common/scrub";

describe("scrubForLog", () => {
  it("redacts emails", () => {
    expect(scrubForLog("query failed for user jane.doe@clinic.org")).toBe(
      "query failed for user [email]",
    );
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMe";
    expect(scrubForLog(`token ${jwt} rejected`)).toBe("token [token] rejected");
  });

  it("redacts Bearer headers, opaque or JWT", () => {
    expect(scrubForLog("Authorization: Bearer abc123-def456 failed")).toBe(
      "Authorization: Bearer [token] failed",
    );
    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMe";
    expect(scrubForLog(`Authorization: Bearer ${jwt} failed`)).toBe(
      "Authorization: Bearer [token] failed",
    );
  });

  it("leaves ids and ordinary text alone", () => {
    const text =
      "task 019a4f2c-8f1b-7c9d-b3e2-4f5a6b7c8d9e failed: staged_object_missing";
    expect(scrubForLog(text)).toBe(text);
  });
});
