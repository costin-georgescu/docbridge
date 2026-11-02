import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import { dbUrl } from "./db-url";

const KEYS = [
  "T_DATABASE_URL",
  "T_DB_HOST",
  "T_DB_NAME",
  "T_DB_USERNAME",
  "T_DB_PASSWORD",
  "DB_SSL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("dbUrl", () => {
  it("returns the <P>_DATABASE_URL verbatim", () => {
    process.env.T_DATABASE_URL = "postgresql://u:p@h:5432/d";
    expect(dbUrl("T")).toBe("postgresql://u:p@h:5432/d");
  });

  it("builds the URL from the <P>_DB_* parts", () => {
    process.env.T_DB_HOST = "db.local";
    process.env.T_DB_NAME = "auth";
    process.env.T_DB_USERNAME = "auth_app";
    process.env.T_DB_PASSWORD = "p/w:d";
    expect(dbUrl("T")).toBe(
      "postgresql://auth_app:p%2Fw%3Ad@db.local:5432/auth",
    );
  });

  it("appends ?sslmode=<DB_SSL> to the parts URL", () => {
    process.env.T_DB_HOST = "db.local";
    process.env.T_DB_NAME = "auth";
    process.env.T_DB_USERNAME = "auth_app";
    process.env.T_DB_PASSWORD = "pw";
    process.env.DB_SSL = "no-verify";
    expect(dbUrl("T")).toBe(
      "postgresql://auth_app:pw@db.local:5432/auth?sslmode=no-verify",
    );
  });

  it("appends &sslmode=<DB_SSL> to a direct URL that has a query", () => {
    process.env.T_DATABASE_URL = "postgresql://u:p@h:5432/d?connection_limit=4";
    process.env.DB_SSL = "no-verify";
    expect(dbUrl("T")).toBe(
      "postgresql://u:p@h:5432/d?connection_limit=4&sslmode=no-verify",
    );
  });

  it("throws naming the missing parts", () => {
    expect(() => dbUrl("T")).toThrow(/T_DB_HOST/);
  });
});
