# ADR-24: Dispatcher instances claim work with SKIP LOCKED

**Status:** Awaiting review | **Date:** 21.10.2026 | **Author:** Costin Georgescu

## Context

The dispatcher scans committed tasks that have no queue message yet (ADR-10). Two instances run for availability. Both must not publish the same task twice in the normal case, and a double publish must be harmless when it happens anyway (ADR-11).

## Decision required

How do two dispatcher instances share the scan without double-publishing?

## Alternatives evaluated

### 1. `SELECT ... FOR UPDATE SKIP LOCKED` batch claim

Both instances stay active; each claims a disjoint batch of rows inside a transaction, publishes, marks them dispatched, commits.

- \+ No coordinator, no single point.
- \+ A crash between publish and mark leaves rows unmarked; they are re-published on the next scan and deduplicated by the worker (ADR-11).
- \+ Full capacity from both instances.
- \- Row locks held across the SQS call, bounded by a batch size of 100 and one `SendMessageBatch` round.

### 2. Leader election via Postgres advisory lock

One instance publishes, the standby waits for the lock.

- \+ Only one publisher ever.
- \- Half the capacity idle.
- \- Failover latency equals the lock session timeout.

### 3. Single instance

One dispatcher task.

- \+ Nothing to coordinate.
- \- Violates the two-task availability rule.

## Decision

**Option 1.**

Both instances work at full capacity and the failure mode (a re-published task) is already made harmless by worker-side deduplication. The same pattern is reused for the finalizer and housekeeping sweeps. We accept short held row locks in exchange for active-active dispatch with no coordinator.

**Ratified by:** Awaiting review
