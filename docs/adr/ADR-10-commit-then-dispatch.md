# ADR-10: Submission acknowledged before dispatch

**Status:** Awaiting review | **Date:** 05.10.2026 | **Updated:** 21.10.2026 | **Author:** Costin Georgescu

## Context

A job submission can have up to 100 files distributed to 20 destinations, expanding to 2,000 tasks. Each task needs a metadata record and queue message before a worker can process it.

As the spec requires submission acknowledgement <500ms at p99 regardless of batch size, this decision separates what must complete inside the request from what can happen after ack.

## Decision required

Determine what must complete inside the submission request to meet the acknowledgement latency at maximum batch size.

## Alternatives evaluated

### 1. Synchronous dispatch

API does records and queue messages before responding.

- \+ Simplest design with submission and work dispatch in one atomic action.
- \+ Submission guarantee at ack time, tasks are already queued.
- \- Publishing latency scales linearly with batch size.
- \- If the request fails mid-publish we'll have partial state with no clean recovery method.
- \- Submission availability is coupled to the queue health.

### 2. Commit then dispatch

API commits job + task records in a single transaction and acks, then a dispatcher publishes queue messages after submission.

- \+ Request cost is one batched folder-to-team call to the platform plus a single DB transaction regardless of batch size, which meets <500ms at p99 at 2000 tasks.
- \+ Committed records are the source of truth and a dispatcher crash delays tasks, doesn't lose them.
- \+ Submission stays available even if the queue is briefly down.
- \- Adds a dispatcher step that must retry until task messages are published.
- \- Tasks are pending after ack, not atomically with it, with a brief gap where records exist but messages don't yet.

### 3. Job fan-out

API writes the job and submission mapping, publishes one 'job submitted' message which a worker expands into task records and publishes to queue after ack.

- \+ Cheapest request of the three with a constant write size regardless of batch size.
- \+ The stored mapping fully determines the task set, so re-running it is safe.
- \- The task records don't exist at ack and the job shows no tasks until expansion.
- \- Expander failure during runtime leaves partial task records, needs rerun/redup.

## Decision

**Option 2.**

It removes the queue publishing from the request while creating task records at ack. The job is fully created and queryable at submission. Option 3 removes latency that was never the bottleneck at the cost of tasks that are not created yet with a more complex recovery path. The request budget is that one platform call plus the transaction; nothing else runs inside it.

**Ratified by:** Awaiting review
