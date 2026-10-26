# ADR-15: Auth service and DocBridge API own separate databases

**Status:** Awaiting review | **Date:** 21.10.2026 | **Updated:** 23.10.2026 | **Author:** Costin Georgescu

## Context

The auth service owns users, credentials and team memberships (ADR-04). The DocBridge API owns jobs, tasks and staged file metadata. ADR-03 gave the document platform its own database but left auth and DocBridge sharing the metadata database. The API never reads the user or membership tables: job visibility is a check between token claims and the team ids stored on the job (ADR-05).

## Decision required

Do the auth service and the DocBridge API share one database or own one each?

## Alternatives evaluated

### 1. One database per service

Auth owns a users and memberships database, DocBridge owns a jobs and tasks database, each with its own credential.

- \+ Credential data lives in a database the API cannot read.
- \+ Each service owns its schema and migrations; neither can break the other.
- \+ Same boundary already drawn for the platform in ADR-03.
- \+ No cross-service queries exist today, so nothing is lost.
- \- One more database, credential and migration path to run.

### 2. One database, separate schemas

Both services use one database with an auth schema and a docbridge schema, isolated by grants.

- \+ One database to operate.
- \+ Adequate isolation when grants are configured correctly.
- \- Isolation rests on grant discipline rather than a hard boundary.
- \- Shared failure and restore blast radius.

### 3. One database, shared tables

Both services read and write the same tables.

- \+ Simplest local setup.
- \- The API's connection can read credential data it never needs.
- \- A schema change for auth is a schema change for DocBridge.

## Decision

**Option 1.**

The two services share no queries, so separating the data is free at the application level and removes credential data from the API's reach. In R1 both databases run on one Multi-AZ Postgres instance with separate credentials. Moving to separate instances is an operational change, not a design one. We accept one more database to run. This supersedes the shared metadata database statement in ADR-03.

**Ratified by:** Awaiting review
