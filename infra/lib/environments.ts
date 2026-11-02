import type { EnvironmentConfig } from "./docbridge-stack";

interface ResolveInput {
  context: Record<string, EnvironmentConfig> | undefined;
  env: NodeJS.ProcessEnv;
  selected?: string;
}

const HOSTNAME =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
const ZONE_ID = /^Z[A-Z0-9]+$/;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

function fail(envName: string, field: string, reason: string): never {
  throw new Error(`${envName}.${field}: ${reason}`);
}

function validate(name: string, raw: unknown): EnvironmentConfig {
  if (typeof raw !== "object" || raw === null) {
    fail(name, "<env>", "must be an object");
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.domainName !== "string" || !HOSTNAME.test(c.domainName)) {
    fail(name, "domainName", "must be a hostname (no scheme or trailing dot)");
  }
  if (typeof c.hostedZoneId !== "string" || !ZONE_ID.test(c.hostedZoneId)) {
    fail(name, "hostedZoneId", "must look like Z<alnum>+");
  }
  if (typeof c.account !== "string" || !ACCOUNT.test(c.account)) {
    fail(name, "account", "must be a 12-digit AWS account id");
  }
  if (typeof c.region !== "string" || !REGION.test(c.region)) {
    fail(name, "region", "must look like eu-central-1");
  }
  const alarmEmail = c.alarmEmail;
  if (
    alarmEmail !== undefined &&
    (typeof alarmEmail !== "string" ||
      (alarmEmail.match(/@/g) ?? []).length !== 1)
  ) {
    fail(name, "alarmEmail", "must be an email address (single @)");
  }
  const monthlyBudgetUsd = c.monthlyBudgetUsd;
  if (
    monthlyBudgetUsd !== undefined &&
    (typeof monthlyBudgetUsd !== "number" ||
      !Number.isFinite(monthlyBudgetUsd) ||
      monthlyBudgetUsd <= 0)
  ) {
    fail(name, "monthlyBudgetUsd", "must be a positive finite number");
  }
  return {
    domainName: c.domainName as string,
    hostedZoneId: c.hostedZoneId as string,
    account: c.account as string,
    region: c.region as string,
    alarmEmail: alarmEmail as string | undefined,
    monthlyBudgetUsd: monthlyBudgetUsd as number | undefined,
  };
}

// Environment configs come from cdk.json `context.environments` by default;
// DOCBRIDGE_ENVIRONMENTS (JSON, same shape) replaces them entirely so the
// real values never need editing into the repo. `-c environment=<name>`
// selects a single environment.
export function resolveEnvironments({
  context,
  env,
  selected,
}: ResolveInput): Record<string, EnvironmentConfig> {
  let raw = context ?? {};
  const override = env.DOCBRIDGE_ENVIRONMENTS;
  if (typeof override === "string" && override.trim() !== "") {
    try {
      raw = JSON.parse(override) as typeof raw;
    } catch {
      throw new Error(
        "DOCBRIDGE_ENVIRONMENTS is not valid JSON (expected an " +
          "{ <name>: {domainName, hostedZoneId, account, region} } object)",
      );
    }
  }
  const resolved: Record<string, EnvironmentConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    resolved[name] = validate(name, cfg);
  }
  if (selected !== undefined) {
    const env = resolved[selected];
    if (!env) {
      throw new Error(
        `unknown environment "${selected}"; available: ` +
          `${Object.keys(resolved).join(", ") || "(none)"}`,
      );
    }
    return { [selected]: env };
  }
  return resolved;
}
