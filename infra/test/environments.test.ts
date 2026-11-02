import { describe, expect, it } from "@jest/globals";
import { resolveEnvironments } from "../lib/environments";
import type { EnvironmentConfig } from "../lib/docbridge-stack";

const STAGING: EnvironmentConfig = {
  domainName: "staging.docbridge.example.com",
  hostedZoneId: "ZPLACEHOLDER1",
  account: "111111111111",
  region: "eu-central-1",
};
const PRODUCTION: EnvironmentConfig = {
  domainName: "docbridge.example.com",
  hostedZoneId: "ZPLACEHOLDER2",
  account: "111111111111",
  region: "eu-central-1",
};
const BASE = { staging: STAGING, production: PRODUCTION };

const resolve = (
  env: Record<string, string | undefined> = {},
  selected?: string,
) => resolveEnvironments({ context: BASE, env, selected });

describe("resolveEnvironments", () => {
  it("returns the cdk.json context environments by default", () => {
    expect(resolve({})).toEqual(BASE);
    expect(resolve({ DOCBRIDGE_ENVIRONMENTS: "" })).toEqual(BASE);
    expect(resolve({ DOCBRIDGE_ENVIRONMENTS: "  " })).toEqual(BASE);
  });

  it("replaces the whole base when DOCBRIDGE_ENVIRONMENTS is set", () => {
    const onlyStaging = {
      staging: {
        domainName: "staging.example.org",
        hostedZoneId: "ZREAL12345",
        account: "123456789012",
        region: "us-east-1",
      },
    };
    const out = resolve({
      DOCBRIDGE_ENVIRONMENTS: JSON.stringify(onlyStaging),
    });
    expect(out).toEqual(onlyStaging);
    expect(out.production).toBeUndefined();
  });

  it("throws a clear error on invalid JSON", () => {
    expect(() => resolve({ DOCBRIDGE_ENVIRONMENTS: "{nope" })).toThrow(
      /DOCBRIDGE_ENVIRONMENTS is not valid JSON/,
    );
  });

  it("filters to the selected environment", () => {
    expect(resolve({}, "staging")).toEqual({ staging: STAGING });
  });

  it("rejects an unknown selected name listing the available ones", () => {
    expect(() => resolve({}, "qa")).toThrow(
      /unknown environment "qa"; available: staging, production/,
    );
  });

  it.each([
    ["domainName", { domainName: "https://x.com" }],
    ["domainName", { domainName: "example.com." }],
    ["hostedZoneId", { hostedZoneId: "placeholder" }],
    ["account", { account: "12345" }],
    ["account", { account: "abc123456789" }],
    ["region", { region: "europe1" }],
    ["alarmEmail", { alarmEmail: "a@b@c" }],
    ["alarmEmail", { alarmEmail: "not-an-email" }],
    ["monthlyBudgetUsd", { monthlyBudgetUsd: 0 }],
    ["monthlyBudgetUsd", { monthlyBudgetUsd: -10 }],
    ["monthlyBudgetUsd", { monthlyBudgetUsd: Number.POSITIVE_INFINITY }],
    ["monthlyBudgetUsd", { monthlyBudgetUsd: Number.NaN }],
  ])("rejects invalid %s", (field, bad) => {
    const envs = { staging: { ...STAGING, ...bad } };
    expect(() => resolveEnvironments({ context: envs, env: {} })).toThrow(
      new RegExp(`staging\\.${field}`),
    );
  });

  it("accepts the placeholder values used for offline synth", () => {
    expect(() => resolve({})).not.toThrow();
  });

  it("accepts a valid monthlyBudgetUsd", () => {
    const envs = {
      staging: { ...STAGING, monthlyBudgetUsd: 75 },
    };
    expect(resolveEnvironments({ context: envs, env: {} })).toEqual(envs);
  });

  it("accepts a valid alarmEmail", () => {
    const envs = {
      staging: { ...STAGING, alarmEmail: "oncall@example.com" },
    };
    expect(resolveEnvironments({ context: envs, env: {} })).toEqual(envs);
  });
});
