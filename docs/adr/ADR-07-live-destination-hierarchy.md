# ADR-07: Destination hierarchy queried on live platform

**Status:** Awaiting review | **Date:** 05.10.2026 | **Author:** Costin Georgescu

## Context

Users need to browse the destination hierarchy that they are authorized to access before mapping files to destination folders. The document platform owns this hierarchy.

## Decision required

How should the system retrieve destination hierarchy while reflecting the user's current permissions?

## Alternatives evaluated

### 1. Query the document platform live

API requests the destination hierarchy from the platform on behalf of the user when they browse.

- \+ Reads the hierarchy from source rather than maintaining a separate copy.
- \+ The platform filters the hierarchy by the team claims in the user's token (ADR-05).
- \+ No synchronization process to build and maintain.
- \- Browsing depends on platform availability and response time.
- \- Repeated browsing creates additional requests to the platform.

### 2. Keep a synchronized local copy

System stores a local copy of the hierarchy and updates it when the platform changes.

- \+ Browsing can use local data without requesting the hierarchy on each request.
- \+ Reduces browsing traffic to the platform.
- \- Requires synchronization and recovery when updates are missed.
- \- Copied hierarchy or permissions can become outdated.
- \- Current authorization still needs to be verified and a local copy alone cannot guarantee authorized access.

### 3. Cache hierarchy responses with short TTL

API queries the platform live but caches the response for a short period (30-60 seconds).

- \+ Minimizes repeated requests to the platform during active browsing sessions.
- \+ Still reflects recent changes.
- \+ No explicit sync management because cache expiry handles refresh.
- \- Stale within the TTL window as a user could see destinations they lost access to.
- \- Cache invalidation on permission changes requires either platform push or accepting the TTL delay.

## Decision

**Option 1.**

The document platform owns the hierarchy, so querying it directly avoids maintaining a second copy and a synchronization process. We accept that browsing depends on platform availability.

**Ratified by:** Awaiting review
