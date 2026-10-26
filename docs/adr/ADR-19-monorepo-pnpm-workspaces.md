# ADR-19: One repository, pnpm workspaces

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

Six deployables (five services plus the web app) share contracts (request/response schemas, the queue message shape), the auth guard and storage helpers. The spec requires the whole system to run locally with a single `docker compose up`.

## Decision required

How is the code organised across repositories?

## Alternatives evaluated

### 1. Monorepo with pnpm workspaces

`apps/*`, `packages/*`, `infra/` in one repository.

- \+ One compose file, one CI, one checkout.
- \+ Shared packages imported by path, no publish step.
- \+ Cross service changes land atomically in one commit.
- \- One repo grows large.
- \- CI must scope builds to changed packages.

### 2. One repo per service with published shared packages

Independent repositories with versioned shared libraries.

- \+ Independent release cadence per service.
- \- Version skew between contracts and their consumers.
- \- Six repos and six pipelines; compose must pull images from six places.

### 3. Single Nest monorepo (`nest-cli` projects)

Nest's own multi-project mode.

- \+ First-party tooling for the services.
- \- The web app and CDK don't fit Nest's project model.

## Decision

**Option 1.**

The shared contracts are the point of coupling: they must move in lockstep with all consumers, which a monorepo makes free and published packages make manual. Turborepo/Nx is deferred; pnpm filters are enough for six packages. We accept CI scoping in exchange for atomic cross service changes.

**Ratified by:** Awaiting review
