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

## Verification

- `pnpm install`
- `pnpm db:generate`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` — runs all Jest projects
- Auth e2e needs a real Postgres (`docker compose up -d postgres`, then `pnpm db:migrate`) and runs only when `AUTH_TEST_DATABASE_URL` is set, e.g. `AUTH_TEST_DATABASE_URL=postgresql://auth_app:auth_app@localhost:5432/auth pnpm test --selectProjects auth`.
- `pnpm auth:keygen` prints a `JWT_SIGNING_KEY='...'` line to append to `.env`.
- Api e2e needs Postgres + LocalStack (`docker compose up -d postgres localstack`, then `pnpm db:migrate`) and runs only when `API_TEST_DATABASE_URL` is set, e.g. `API_TEST_DATABASE_URL=postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge pnpm test --selectProjects api`.
- Dispatcher e2e needs Postgres + LocalStack (same setup as api) and runs only when `DISPATCHER_TEST_DATABASE_URL` is set, e.g. `DISPATCHER_TEST_DATABASE_URL=postgresql://docbridge_app:docbridge_app@localhost:5432/docbridge pnpm test --selectProjects dispatcher`.
