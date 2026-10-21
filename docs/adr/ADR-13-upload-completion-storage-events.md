# ADR-13: Upload completion detected through storage events

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

Files reach staging directly from the browser through presigned URLs (ADR-08) and a job can only be submitted once all its files are staged (ADR-09). The browser learns when a PUT finishes, but the API has no record of its own. The submission request is budgeted as one platform call plus one database transaction to hold <500 ms at p99 (ADR-10).

## Decision required

How does the system know, independently of the browser, that a file has landed in staging?

## Alternatives evaluated

### 1. Storage event notification

The staging bucket emits an object-created event to an upload events queue. The dispatcher consumes it and marks the staged file record as staged with the size and checksum reported by storage.

- \+ The record comes from storage, not from the client.
- \+ Survives a browser that closes after the upload finished.
- \+ Submission validates "all files staged" inside the existing transaction, no extra calls.
- \+ Queue and event delivery are managed features, nothing to build.
- \- A second queue and a consumer to run.
- \- A second or two between the PUT completing and the record turning staged.

### 2. Verify at submission

The API checks every referenced object in storage before committing the job.

- \+ No new infrastructure.
- \- Up to 100 storage calls inside the submission request, which breaks the request budget of ADR-10.
- \- Submission latency becomes a function of storage latency.

### 3. Client confirmation per file

After each upload the browser calls the API, which checks that one object and marks it staged.

- \+ No new infrastructure, check happens during staging rather than at submit.
- \- Still depends on the browser; an upload finished just before the tab closes is in storage but never marked.
- \- One extra API call per file for the client to manage.

## Decision

**Option 1.**

Only the storage event gives a record of staging that the client cannot get wrong. The dispatcher already reconciles committed state with the task queue, so consuming upload events keeps one background reconciler. The UI learns staged state by polling the API and submission rejects unstaged files. We accept a second queue and a short delay before a freshly uploaded file becomes submittable.

**Ratified by:** Awaiting review
