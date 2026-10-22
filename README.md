# DocBridge

DocBridge is a standalone web app that lets clinical-trial coordinators bulk-upload the same documents to many destination folders in a document management platform in a single action. Files are staged in S3, delivered asynchronously by workers, and every file-to-destination task is tracked independently.

This is a practice / portfolio project, built end to end: blueprint, technical design, implementation, and cloud hosting.

## Status

- Stage 1 — Blueprint: done
- Stage 2 — Technical design: drafted, awaiting review
- Stage 3 — Implementation & hosting: next

## Documents

- [Design requirements](docs/design-requirements.md) — the spec this project is designed against (verbatim)
- [Blueprint](docs/blueprint.md) — high-level design: components, file lifecycle, user flows, security, releases
- [Technical design](docs/tdd.md) — stack, data model, API contracts, per-step implementation with estimates, failure modes, launch plan
- [Decision records](docs/adr/) — ADR-01 to ADR-24
- [Diagrams](docs/diagrams/) — architecture + per-flow sequence diagrams (Eraser DSL); [interactive view on Eraser](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share)

## Stack

- Backend: NestJS on Node.js (TypeScript), PostgreSQL, SQS, S3 (SSE-KMS)
- Frontend: React + Vite + TypeScript
- Infra: AWS, CDK, GitHub Actions; LocalStack for local development
- Auth: custom service — RS256 JWTs with team claims; auth-issued service token for workers

## Architecture at a glance

Browser → presigned upload to S3 → submit job (API) → one transaction commits job + tasks → dispatcher fans out to SQS → workers deliver each file to the platform, with end-to-end CRC32C integrity checks, retries (3 attempts → DLQ), and independent per-task status.
