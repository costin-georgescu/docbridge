# ADR-16: NestJS for all Node services

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

Five long-running Node services share cross-cutting concerns: the token verification guard (ADR-05), Postgres access, config loading, S3/SQS clients and structured logging. The dispatcher and workers are not HTTP servers.

## Decision required

Which Node framework do the services share?

## Alternatives evaluated

### 1. NestJS

Modules with dependency injection. The same module system runs HTTP applications and standalone application contexts for the dispatcher and workers.

- \+ One framework covers HTTP apps and non-HTTP services alike.
- \+ Guards and pipes map directly onto token verification and request validation.
- \+ Testing module supports DI-based unit tests.
- \- Learning curve and framework conventions to adopt alongside Postgres and SQS.
- \- Heavier than needed for the two non-HTTP services.

### 2. Express

Minimal HTTP framework the team already knows.

- \+ No learning curve.
- \- No module or DI story: every cross-cutting concern becomes a hand-rolled convention repeated across five services.
- \- No shape for the non-HTTP services.

### 3. Fastify

Performance-focused HTTP framework with schema-based validation.

- \+ Fastest of the three.
- \+ Built-in schema validation.
- \- Same lack of structure as Express.
- \- Smaller ecosystem for the shared concerns.

## Decision

**Option 1.**

One module system, one DI container and one testing approach for all five services outweigh the conventions we have to adopt. The default Express adapter stays underneath; the Fastify adapter is a one-line swap if API latency ever needs it. We accept the learning curve in exchange for not hand-rolling structure five times.

**Ratified by:** Awaiting review
