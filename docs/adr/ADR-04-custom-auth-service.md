# ADR-04: Custom auth service instead of managed identity

**Status:** Awaiting review | **Date:** 05.10.2026 | **Author:** Costin Georgescu

## Context

Users need to be authenticated before performing any kind of operation so it can be tracked back to them. Accounts are provided by an admin and team memberships are stored in the auth database (ADR-15). Managed AWS services are permitted as per ADR-01 and services we run use the compute platform settled in ADR-02.

## Decision required

Managed identity service or in house auth service?

## Alternatives evaluated

### 1. Custom auth service

Build our own service for managing users, credentials and memberships that issues and verifies tokens.

- \+ Required data lives locally in our system, no external user pool to sync.
- \+ Admin-provisioned accounts; no self signup or federation needed.
- \+ Runs on the chosen compute platform.
- \- We bear security responsibility for hashing, token signing and verification.
- \- No managed MFA or advanced features out of the box, which are not required in v1.

### 2. Cognito

AWS managed identity service.

- \+ Managed credential storage with inherited AWS compliance.
- \+ MFA, password policies and hosted flows available when needed.
- \- Strengths don't map to system requirements.
- \- Deeper vendor lock in for capabilities we won't use.
- \- User data lives in our database either way, Cognito adds a second user store to sync.

## Decision

**Option 1.**

The identity model is trivial and tightly coupled to team memberships, which live in the auth database (ADR-15). Cognito would add a user store to sync while its benefits sit unused. We accept owning credential code, backed by mature libraries. Auth service is the single source of users and team memberships; how other services consume them is decided in ADR-05.

**Ratified by:** Awaiting review
