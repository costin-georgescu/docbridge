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
