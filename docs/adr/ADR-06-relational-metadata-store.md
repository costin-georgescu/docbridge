# ADR-06: Relational database for the auth and DocBridge stores

**Status:** Awaiting review | **Date:** 05.10.2026 | **Updated:** 21.10.2026 | **Author:** Costin Georgescu

## Context

The auth service persists users and team memberships; the DocBridge API persists jobs, per-task delivery records and staged file metadata (ADR-15). Both datasets are relational by nature: tasks belong to jobs, users own memberships. Submission must commit a job plus all its task records in one atomic transaction (ADR-10).

## Decision required

Which database model backs the auth and DocBridge databases?

## Alternatives evaluated

### 1. Relational (Postgres)

Tables with foreign keys; transactions span multiple rows.

- \+ The data is inherently relational. Job - tasks is a foreign key relationship, and status/history queries are joins and aggregates.
- \+ A single transaction can commit a job and all 2,000 task rows atomically.
- \+ High workload headroom.
- \- Requires schema management and migrations.
- \- Scaling is vertical; adequate here, but not limitless.

### 2. Managed key-value store (DynamoDB)

Fully managed NoSQL with predictable single record latency.

- \+ Practically infinite scale, fully managed operations.
- \+ Strong for key-based lookups.
- \- Multi item transactions are capped far below 2,000 and cannot commit all task records atomically. This breaks ADR-10's design.
- \- Aggregate queries (job history, task counts, status rollups) fight the model and need indexing workarounds.

### 3. Document store (Mongo-style)

Flexible JSON documents.

- \+ Flexible schema evolution.
- \- Adds a service to operate without an advantage over the relational option.
- \- Same atomicity and query shape problems as Option 2 for job - task data.

## Decision

**Option 1.**

The data structure is relational by nature: jobs own tasks, users own memberships. ADR-10 depends on writing a job plus all its task records in one atomic transaction, which the NoSQL option can't do at 2,000 records. Postgres covers the workload comfortably and its scaling limits aren't a concern for v1. The platform database (ADR-03) follows the same choice.

**Ratified by:** Awaiting review
