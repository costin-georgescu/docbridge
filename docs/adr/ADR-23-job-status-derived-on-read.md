# ADR-23: Job status is computed from task counts at read time

**Status:** Awaiting review | **Date:** 21.10.2026 | **Updated:** 23.10.2026 | **Author:** Costin Georgescu

## Context

The blueprint states job status is derived from its tasks. A job holds up to 2,000 tasks; up to 200 users poll status (ADR-12); many workers finish tasks of the same job concurrently.

## Decision required

Where does the job's aggregate status live?

## Alternatives evaluated

### 1. Aggregate on read

`SELECT status, count(*) ... GROUP BY status` over a `(job_id, status)` index, computed per request.

- \+ Index only scan over at most 2,000 rows per job.
- \+ No write contention in the worker path.
- \+ One grouped query serves a whole page of jobs.
- \- Every poll pays an aggregate, trivial at this scale.

### 2. Counters on the job row updated by workers

Workers increment status counters as tasks finish.

- \+ Cheap reads.
- \- Every task completion updates the same job row: 2,000 contending updates on one hot row per job, lock waits in the worker path.
- \- Counters drift on a crash between task update and counter update unless both are in one transaction, which still contends.

### 3. Materialized job status set by the last finishing worker

The worker that finishes the final task writes the job's final state.

- \+ Cheap reads.
- \- The "am I last" check races between two workers finishing simultaneously unless the job row is locked; same contention as option 2.

## Decision

**Option 1.**

The aggregate is an index only scan at trivial scale and keeps the hot worker path free of writes to the job row. `completed_at` is set by the dispatcher's finalizer sweep rather than by any worker, for the same reason (see the TDD). We accept an aggregate query per poll in exchange for zero write contention.

**Ratified by:** Awaiting review
