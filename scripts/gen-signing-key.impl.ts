import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// Generates the RS256 signing keypair in the JSON shape auth's
// SigningKeyService reads from JWT_SIGNING_KEY:
//   {"kid": "...", "privateKey": "<pkcs8 PEM>"}
// Plain run prints the .env line; --aws-secret writes the bare JSON to
// Secrets Manager via the aws CLI (no SDK dependency, value piped on stdin).

export interface KeygenArgs {
  awsSecret?: string;
  region?: string;
  force: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): KeygenArgs {
  const args: KeygenArgs = { force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--aws-secret") {
      args.awsSecret = argv[++i];
      if (!args.awsSecret) throw new Error("--aws-secret requires a value");
    } else if (arg === "--region") {
      args.region = argv[++i];
      if (!args.region) throw new Error("--region requires a value");
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

export function generateSigningKey(): { kid: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return {
    kid: `k-${stamp}-${randomBytes(3).toString("hex")}`,
    privateKey: pem,
  };
}

interface AwsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function aws(awsArgs: string[], input?: string): AwsResult {
  const r = spawnSync("aws", awsArgs, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: `${r.stderr ?? ""}${r.error ? ` ${r.error.message}` : ""}`,
  };
}

// An existing SecretString means the secret is populated; the CDK-created
// secret has no AWSCURRENT version yet, so get-secret-value fails.
export function secretIsPopulated(result: AwsResult): boolean {
  if (!result.ok) {
    if (result.stderr.includes("ResourceNotFoundException")) return false;
    throw new Error(
      `aws secretsmanager get-secret-value failed:${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { SecretString?: string };
  return (
    typeof parsed.SecretString === "string" && parsed.SecretString.length > 0
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.awsSecret) {
    const key = generateSigningKey();
    console.log(`JWT_SIGNING_KEY='${JSON.stringify(key)}'`);
    return;
  }

  const regionArgs = args.region ? ["--region", args.region] : [];
  const secret = args.awsSecret;

  if (args.dryRun) {
    console.log(
      `dry-run: would generate an RS256 keypair and put-secret-value to ${secret}` +
        `${args.force ? " (--force: overwrite allowed)" : " (refuses if populated)"}` +
        `${args.region ? ` in ${args.region}` : ""}; private key is never printed`,
    );
    return;
  }

  if (!args.force) {
    const current = aws([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secret,
      ...regionArgs,
    ]);
    if (secretIsPopulated(current)) {
      console.error(
        `${secret} already has a value; refusing to overwrite (use --force)`,
      );
      process.exit(1);
    }
  }

  const key = generateSigningKey();
  // --secret-string file:///dev/stdin keeps the private key out of argv/logs.
  const put = aws(
    [
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      secret,
      "--secret-string",
      "file:///dev/stdin",
      ...regionArgs,
    ],
    JSON.stringify(key),
  );
  if (!put.ok) {
    console.error(`aws secretsmanager put-secret-value failed:${put.stderr}`);
    process.exit(1);
  }
  console.log(`wrote new signing key (kid ${key.kid}) to ${secret}`);
}

if (require.main === module) {
  main();
}
