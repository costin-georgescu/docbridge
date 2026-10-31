import { execFileSync } from "node:child_process";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

const HINT =
  "bring the stack up with `docker compose up -d` (plus `pnpm db:migrate && pnpm db:seed` on a fresh database)";

async function probe(name: string, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      throw new Error(`${name} answered ${res.status} at ${url} — ${HINT}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("answered")) {
      throw err;
    }
    throw new Error(`${name} is unreachable at ${url} — ${HINT}`, {
      cause: err,
    });
  }
}

// Dispatcher and worker expose no HTTP port; the only way to know they are
// up (and therefore that submitted jobs will be delivered) is docker itself.
function probeBackgroundServices() {
  let running: string;
  try {
    running = execFileSync(
      "docker",
      [
        "compose",
        "-p",
        process.env.E2E_COMPOSE_PROJECT ?? "docbridge",
        "ps",
        "--status",
        "running",
        "--format",
        "{{.Service}}",
      ],
      { encoding: "utf8" },
    );
  } catch (err) {
    throw new Error(`could not list docker compose services — ${HINT}`, {
      cause: err,
    });
  }
  const services = new Set(running.split("\n").filter(Boolean));
  for (const required of ["dispatcher", "worker"]) {
    if (!services.has(required)) {
      throw new Error(
        `docker compose service "${required}" is not running — ${HINT}`,
      );
    }
  }
}

export default async function globalSetup() {
  await probe("web", baseURL);
  await probe(
    "api",
    `${process.env.E2E_API_URL ?? "http://localhost:3000"}/health`,
  );
  await probe(
    "auth",
    `${process.env.E2E_AUTH_URL ?? "http://localhost:3001"}/auth/.well-known/jwks.json`,
  );
  await probe(
    "platform",
    `${process.env.E2E_PLATFORM_URL ?? "http://localhost:3002"}/health`,
  );
  await probe(
    "localstack",
    `${process.env.E2E_LOCALSTACK_URL ?? "http://localhost:4566"}/_localstack/health`,
  );
  probeBackgroundServices();
}
