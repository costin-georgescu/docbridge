# DocBridge

DocBridge turns a repetitive clinical-trial workflow into one action: pick files once, map each file to many destination folders across teams and binders, submit the batch, track every delivery. The manual version is one upload per file per destination, meaning 10 documents into 15 binders means 150 uploads with no retries and no record of what landed. Files stage in S3, workers deliver them in the background, and each file-to-destination pair is a task with its own status and error trail.

## Documents

- [Design requirements](docs/design-requirements.md) — the spec this project is designed against.
- [Blueprint](docs/blueprint.md) — high-level design: components, file lifecycle, user flows, security, releases.
- [Technical design](docs/tdd.md) — stack, data model, API contracts, per-step implementation with estimates, failure modes, launch plan.
- [Decision records](docs/adr/)
- [Diagrams](docs/diagrams/) — architecture + per-flow sequence diagrams (Eraser DSL) + [interactive view on Eraser](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share).

## Tech stack

- Frontend: React + Vite + TypeScript.
- Backend: NestJS on Node.js (TypeScript), PostgreSQL, SQS, S3 (SSE-KMS).
- Infra: AWS, CDK, GitHub Actions; LocalStack for local development.
- Auth: custom service — RS256 JWTs with team claims; auth-issued service token for workers.

## Status

- Stage 1 — Blueprint: done
- Stage 2 — Technical design: drafted, awaiting review
- Stage 3 — Implementation & hosting: next

## Architecture overview

- Uploads go straight from the browser to staging over presigned URLs; a storage event marks each file staged, and Submit unlocks only when all are confirmed.
- Submission claims the staged files and commits the job with all its tasks in one transaction, acknowledged in under 500 ms; a dispatcher then scans undispatched tasks and publishes them to SQS.
- Workers consume tasks, re-verify the CRC32C checksum and stream into the platform under a service token — the task id doubles as the idempotency key; after 3 attempts the message parks in a DLQ.
- Job status is derived from its tasks and polled by the UI; downloads are presigned GETs, so file bytes never pass through the API.
- Three Postgres databases, one per owner: auth, DocBridge, platform. Every store encrypted at rest with KMS.
