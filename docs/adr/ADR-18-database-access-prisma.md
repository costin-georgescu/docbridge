# ADR-18: Prisma as schema, migration and query layer

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

Three Postgres databases (ADR-06, ADR-15, ADR-03), each owned by one service. Submission inserts up to 2,000 task rows in one transaction (ADR-10). The dispatcher claims rows with `FOR UPDATE SKIP LOCKED` (ADR-24). Types must flow to TypeScript.

## Decision required

Which library owns schema, migrations and queries?

## Alternatives evaluated

### 1. Prisma

Schema file as the single source of truth per database, generated typed client, built-in migrations.

- \+ One schema file per database is the source of truth.
- \+ Generated typed client keeps TypeScript types in sync.
- \+ `createMany` covers the 2,000-row bulk insert; interactive transactions cover the submission transaction.
- \- The two locking queries need `$queryRaw`.
- \- The query engine adds a layer between code and SQL.

### 2. Drizzle

SQL-shaped ORM with native `skip locked` support.

- \+ Closer to SQL; locking queries without raw escape hatch.
- \+ Lighter runtime.
- \- Migrations tooling is younger.
- \- Less common in the target hiring market, which matters for who can maintain this.

### 3. TypeORM

Nest's historical default.

- \+ First party examples with Nest.
- \- Decorator-entity model with weaker type inference.
- \- Uneven maintenance history.

### 4. Raw SQL with pg and hand-written migrations

No ORM.

- \+ Full control over every query.
- \- Hand-maintained types for three schemas.
- \- Migration tooling to build.

## Decision

**Option 1.**

The generated client removes a class of type drift across three databases, and the two queries Prisma cannot express are confined to two named raw queries: the dispatcher claim and the platform version lock. We accept the extra query layer in exchange for one typed schema per database.

**Ratified by:** Awaiting review
