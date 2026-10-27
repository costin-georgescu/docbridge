import { describe, expect, it } from "@jest/globals";
import { HealthResponse } from "../src";

describe("HealthResponse", () => {
  it("parses a valid health response", () => {
    expect(HealthResponse.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects an invalid status", () => {
    expect(() => HealthResponse.parse({ status: "down" })).toThrow();
  });
});
