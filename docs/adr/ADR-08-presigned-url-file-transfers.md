# ADR-08: Direct transfer via presigned URLs

**Status:** Awaiting review | **Date:** 05.10.2026 | **Updated:** 21.10.2026 | **Author:** Costin Georgescu

## Context

Files travel between the user's browser and staging storage with up to 100 files per job, 1 GB maximum file size each. The spec requires that downloads must not flow through application servers, and the API must stay responsive under concurrent load.

## Decision required

How do file bytes travel between the client and staging storage?

## Alternatives evaluated

### 1. Direct transfer via presigned URLs

The API verifies authorization, mints a short-lived URL for a specific file and the browser transfers bytes directly with storage.

- \+ File bytes never traverse app servers.
- \+ Storage natively supports large files (multipart) and parallel transfers.
- \+ Access control enforced at issuance with a short lived URL as the credential.
- \+ The presigned PUT binds content type and checksum; storage rejects a mismatched upload.
- \- A leaked URL grants access until expiry, bounded by short TTL.
- \- Staged files from abandoned sessions need lifecycle cleanup.

### 2. Proxy through the API

File bytes stream through the DocBridge API, which forwards them to storage.

- \+ Bytes can be inspected or validated as they flow, ensuring full control during transit.
- \+ Simplest mental model, one channel for all traffic.
- \- Violates the spec requirement that file bytes must not flow through the API server.
- \- Byte traffic peaks the API server, causing high scale costs.

### 3. Dedicated transfer service

A separate service owns uploads and downloads, keeping byte traffic off the API.

- \+ Isolates byte load from the API's request capacity.
- \+ Keeps server side control over the byte stream.
- \- Still routes bytes through our own infrastructure and misses the point of the requirement.
- \- Another service to build, deploy and operate with added complexity without satisfying the initial constraint.

## Decision

**Option 1.**

Direct transfers fulfill specification constraints and keep the API free of bulk byte traffic. Multipart uploads cover large-file reliability. We give up inspecting bytes in transit, which the spec doesn't require.

**Ratified by:** Awaiting review
