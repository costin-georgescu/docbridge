import { describe, expect, it } from "@jest/globals";
import { baseEnvSchema, loadConfig } from "../src";

describe("loadConfig", () => {
  it("parses valid env and applies defaults", () => {
    const config = loadConfig(baseEnvSchema, { AWS_REGION: "eu-central-1" });
    expect(config).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      AWS_REGION: "eu-central-1",
    });
  });

  it("names the missing key without printing values", () => {
    expect(() => loadConfig(baseEnvSchema, {})).toThrow(/AWS_REGION/);
  });

  it("rejects an invalid enum value", () => {
    expect(() =>
      loadConfig(baseEnvSchema, {
        AWS_REGION: "eu-central-1",
        NODE_ENV: "staging",
      }),
    ).toThrow(/NODE_ENV/);
  });
});
