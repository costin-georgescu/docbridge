# ADR-03: Document platform runs as a separate service with its own stores

**Status:** Awaiting review | **Date:** 05.10.2026 | **Updated:** 21.10.2026 | **Author:** Costin Georgescu

## Context

The brief requires us to build the document platform ourselves and the system to deliver files into it through its API. We need to decide whether the platform is a separate service with its own data, or part of the system codebase sharing the metadata database.

## Decision required

Is the document platform a separate system or a module of DocBridge?

## Alternatives evaluated

### 1. Separate service with its own database and storage

Platform runs as its own container (ADR-02), owns the team, binder, folder hierarchy and delivered documents in its own database and bucket. The system talks to it only through its API.

- \+ Mirrors the real situation where DocBridge integrates with a product it doesn't own.
- \+ The API between them is the contract, which is what the spec describes.
- \+ Platform can be deployed and tested separately.
- \- Two databases and two buckets to run and encrypt.
- \- Hierarchy and membership live in different systems, which needs ADR-05.

### 2. Module of DocBridge sharing the metadata database

Hierarchy and documents stored in the metadata database next to jobs and tasks.

- \+ One database, simpler local setup.
- \+ Permission checks are a join away.
- \- DocBridge and the platform become one system. A schema change in one breaks the other.
- \- Doesn't reflect the integration the brief describes.

## Decision

**Option 1.**

The platform stands in for an external product, so it gets its own service, database and storage, and DocBridge only uses its API. Database ownership for the auth service and DocBridge API is decided in ADR-15. We accept running separate databases and a second bucket.

**Ratified by:** Awaiting review
