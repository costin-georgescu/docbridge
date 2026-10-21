# ADR-05: Signed tokens carry team claims; services verify locally

**Status:** Awaiting review | **Date:** 05.10.2026 | **Author:** Costin Georgescu

## Context

Auth service owns users and memberships (ADR-04). The API and document platform need the caller's identity and teams on every request; workers act under a service credential. Services run as separate containers (ADR-02).

## Decision required

How do downstream services verify identity and learn team membership?

## Alternatives evaluated

### 1. Signed token with team claims (JWT)

Auth service issues a short lived token containing the user id and team ids. API and platform verify the signature locally with the auth service's public key.

- \+ The token carries everything, no calls to the auth service per request.
- \+ Auth service downtime doesn't block users that are logged in already.
- \+ One source of truth for memberships, no copy to sync.
- \- Membership changes take effect only when token expires.
- \- Token grows with the number of teams, acceptable at 50 teams.

### 2. Opaque token with introspection

Services send the token to the auth service on each request to resolve the user and teams.

- \+ Revoking access takes effect immediately.
- \+ Nothing sensitive inside the token.
- \- Auth service becomes a dependency on every request, including the <1s destination tree path.
- \- Doubles request traffic for information that rarely changes.

### 3. Platform owns a copy of memberships

Copy syncs from auth service.

- \+ Platform is self sufficient.
- \- Adds a second source of truth.
- \- Sync process to build and maintain, same problem rejected in ADR-07.

## Decision

**Option 1.**

The platform filters the destination tree by the team claims in the token (ADR-07) and the API uses the same claims for job and download visibility. Workers deliver with a service credential and record the submitting user id, so delivery doesn't depend on the user's token lifetime. We accept that a revoked membership stays valid until the token expires, bounded by a short TTL set in the TDD.

**Ratified by:** Awaiting review
