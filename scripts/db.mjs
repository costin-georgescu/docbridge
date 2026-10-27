import { spawnSync } from "node:child_process";

const cmd = process.argv[2];
if (!cmd) {
  console.error("usage: node scripts/db.mjs <command>");
  process.exit(1);
}

const packages = [
  ["db-auth", "AUTH_DATABASE_URL"],
  ["db-docbridge", "DOCBRIDGE_DATABASE_URL"],
  ["db-platform", "PLATFORM_DATABASE_URL"],
];

for (const [pkg, envVar] of packages) {
  const databaseUrl = process.env[envVar];
  if (!databaseUrl) {
    console.error(`${envVar} is not set`);
    process.exit(1);
  }
  console.log(`== ${pkg}: ${cmd}`);
  const result = spawnSync(
    "pnpm",
    ["--filter", `@docbridge/${pkg}`, "run", cmd],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
