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

import { databaseUrlFromEnv } from "../src";

describe("databaseUrlFromEnv", () => {
  it("returns DATABASE_URL when set", () => {
    expect(
      databaseUrlFromEnv({ DATABASE_URL: "postgresql://u:p@h:5432/d" }),
    ).toBe("postgresql://u:p@h:5432/d");
  });

  it("builds the URL from the DB_* parts", () => {
    expect(
      databaseUrlFromEnv({
        DB_HOST: "rds.example.com",
        DB_NAME: "auth",
        DB_USERNAME: "auth_app",
        DB_PASSWORD: "s3cret/with:chars",
      }),
    ).toBe(
      "postgresql://auth_app:s3cret%2Fwith%3Achars@rds.example.com:5432/auth",
    );
  });

  it("throws naming the missing parts", () => {
    expect(() => databaseUrlFromEnv({})).toThrow(/DB_HOST/);
  });
});
