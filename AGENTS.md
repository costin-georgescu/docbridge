# DocBridge — agent notes

## Documents are frozen

Never edit `docs/tdd.md`, `docs/blueprint.md` or `docs/adr/*.md` unless the user explicitly instructs it. The TDD is the official plan; local shortcuts taken to move faster before AWS deployment (LocalStack-only, deferred CDK deploy, direct-DB seeding, etc.) are implementation-side deviations and are never written back into the documents. Flag a deviation in conversation when it happens; do not "fix" the docs to match.

## Branching

- `master` — receives `dev` once the lead approves the TDD.
- `dev` — all development.
- `feat/flow-N-<name>` — one branch per TDD milestone (Flow 0–4, cross-cutting), branched from `dev`, merged back when done.

## Commits

Never commit or push. Leave every change uncommitted in the working tree; the user reviews and commits manually. Report what changed and suggest a commit message.

## Current constraints

- No AWS credentials yet: everything runs against LocalStack via docker compose. CDK can be written and `cdk synth`'d but not deployed.
- Local Postgres runs with `full_page_writes=off` + `max_wal_size=4GB` (docker-compose `command`) to cut disk-write churn during perf/e2e runs; a perf cycle churns ~4M task rows and previously drove ~60 GB/hr of VM disk writes. Commit semantics are untouched so TDD 5.3 latency numbers stay honest — `fsync=off`/`synchronous_commit=off` were deliberately not used. DEPLOYMENT: do not carry these flags to RDS/staging/prod — full-page images are required for crash recovery and PITR; use stock durability settings there.

## Verification

- `pnpm install`
- `pnpm db:generate`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` — runs all Jest projects
- Auth e2e needs a real Postgres (`docker compose up -d postgres`, then `pnpm db:migrate`) and runs only when `AUTH_TEST_DATABASE_URL` is set, e.g. `AUTH_TEST_DATABASE_URL=postgresql://auth_app:auth_app@localhost:5432/auth pnpm test --selectProjects auth`.
- Platform e2e needs Postgres + LocalStack (`docker compose up -d postgres localstack`, then `pnpm db:migrate`) and runs only when `PLATFORM_TEST_DATABASE_URL` is set, e.g. `PLATFORM_TEST_DATABASE_URL=postgresql://platform_app:platform_app@localhost:5432/platform pnpm test --selectProjects platform`.
- `pnpm auth:keygen` prints a `JWT_SIGNING_KEY='...'` line to append to `.env`.
- Browser e2e (Playwright, `tests/e2e`) needs the full stack: `docker compose up -d` (all services, not just postgres/localstack), then `pnpm db:migrate && pnpm db:seed` on a fresh database. One-time browser install: `pnpm e2e:install`. Run with `pnpm e2e`. Do not run two Playwright invocations concurrently — they share `test-results/` and the dev stack.
- Do not run `pnpm format` / `prettier --write .` — parts of the tree are not prettier-clean, so a repo-wide format produces unrelated churn. Format only the files you touched.
- Api e2e needs Postgres + LocalStack (`docker compose up -d postgres localstack`, then `pnpm db:migrate`) and runs only when `API_TEST_DATABASE_URL` is set, e.g. `API_TEST_DATABASE_URL=postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge pnpm test --selectProjects api`.
- Dispatcher e2e needs Postgres + LocalStack (same setup as api) and runs only when `DISPATCHER_TEST_DATABASE_URL` is set, e.g. `DISPATCHER_TEST_DATABASE_URL=postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge pnpm test --selectProjects dispatcher`. Run it with `docker compose stop dispatcher` first: the live dispatcher's task publisher and reconciliation sweep race the test fixtures on the shared database.
- Worker e2e needs Postgres + LocalStack (same setup) and runs only when `WORKER_TEST_DATABASE_URL` is set, e.g. `WORKER_TEST_DATABASE_URL=postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge pnpm test --selectProjects worker`. `task-processor.e2e` stubs the platform; `delivery-platform.e2e` runs the real platform app in-process and additionally needs `PLATFORM_TEST_DATABASE_URL` (e.g. `postgresql://platform_app:platform_app@localhost:5432/platform`). The suites use their own SQS queue (`docbridge-worker-tasks-test` + a `-dlq` redrive pair), so no need to stop the live worker.
- Perf (TDD 5.3, k6): `pnpm perf:seed` seeds 50 teams/folders, a perf user and a staged-file pool, and writes `tests/perf/manifest.json` + `chunks.txt` (gitignored); `pnpm perf:clean` removes all of it. `pnpm perf:jobs` and `pnpm perf:tree` run the k6 scripts via the `grafana/k6` image on the compose network. Stop `dispatcher`/`worker` before the jobs run so they don't race the fixtures. `ITERATIONS`, `VUS` and `RATE` (constant-arrival-rate instead of saturation) env vars tune the jobs run; scale the api with `docker compose -f docker-compose.yml -f docker/compose.perf.yml up -d` (needs Docker Compose >= v2.24).
