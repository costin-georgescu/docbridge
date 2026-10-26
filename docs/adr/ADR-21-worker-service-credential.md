# ADR-21: Workers deliver with an auth-issued service token

**Status:** Awaiting review | **Date:** 21.10.2026 | **Updated:** 23.10.2026 | **Author:** Costin Georgescu

## Context

Workers call the platform's delivery endpoint under a service identity and pass the submitter's user id (ADR-05). The platform already verifies user tokens with the auth service's public key. This resolves blueprint open question 4 and the question left open in ADR-05.

## Decision required

Which credential do workers present to the document platform?

## Alternatives evaluated

### 1. Auth issued service token

The worker exchanges a client id and secret from Secrets Manager for a short-lived JWT (`sub: service:worker`, `scope: documents:write`, 1 h TTL).

- \+ The platform verifies it with the same public key and the same guard as user tokens.
- \+ Rotating the client secret revokes the credential.
- \+ Short TTL limits the lifetime of a leaked token.
- \- Workers depend on the auth service to renew tokens; tokens are cached and renewed at 50 min, so an auth outage under 1 h is invisible.

### 2. Static shared secret / API key checked by the platform

A long lived credential verified against a configured value.

- \+ Nothing to renew, no runtime dependency on the auth service.
- \- A second verification path in the platform.
- \- Long lived credential; rotation means redeploying two services.

### 3. mTLS between workers and platform

Mutual TLS with per-service certificates.

- \+ Strongest identity.
- \- Certificate issuance and rotation infrastructure for one internal call in R1.

## Decision

**Option 1.**

One verification path serves every caller of the platform, and the signing infrastructure already exists. The renewal dependency on the auth service is bounded by the 1 h TTL and the 50 min renewal. We accept that dependency in exchange for a single trust model.

**Ratified by:** Awaiting review
