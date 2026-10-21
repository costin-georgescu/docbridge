# ADR-11: At least once delivery, idempotent workers, DLQ

**Status:** Awaiting review | **Date:** 05.10.2026 | **Author:** Costin Georgescu

## Context

Tasks are published to a managed queue (ADR-01) by the dispatcher (ADR-10) and consumed by workers. Managed queues deliver messages at least once: a worker can finish a delivery, crash before recording the result, and the same message comes back to another worker. The spec requires at least 3 delivery attempts before a task is marked failed, and no task outcome may go unrecorded.

## Decision required

How do we retry failed deliveries and what happens when the same task message is processed twice?

## Alternatives evaluated

### 1. At least once queue with idempotent delivery

Standard queue. A failed task returns to the queue and is retried with backoff. After the retry limit the message is moved to a dead-letter queue. Workers send the task id as an idempotency key, so the platform ignores a repeat delivery of the same task.

- \+ Retries and dead-lettering are queue features, nothing to build.
- \+ A duplicate message produces no duplicate document version.
- \+ Failed tasks are parked, not lost, and keep their error details.
- \- Platform must store the idempotency key per delivery.
- \- Tasks can briefly show in-progress twice while a duplicate is being rejected.

### 2. FIFO queue with deduplication

Queue deduplicates messages by id within a time window and processes them in order.

- \+ Deduplication happens before the worker.
- \- Deduplication only covers the publish side while a worker crash still redelivers.
- \- Ordering is not needed as tasks are independent and FIFO throughput limits don't fit 2,000 tasks per job.

### 3. Accept duplicates

A redelivered task creates another version on the platform, no idempotency.

- \+ Nothing extra to build.
- \- Silent duplicate versions in a regulated system; the user cannot tell which delivery is the real one.
- \- Breaks the "no silent failures" goal of the project.

## Decision

**Option 1.**

Retries and the dead-letter queue come with the managed queue, and the task id as idempotency key makes duplicate processing harmless. Workers record every attempt and error on the task: the worker marks it failed on the last allowed attempt, then SQS moves the message to the dead-letter queue on its own redrive. We accept storing the idempotency key on the platform side.

**Ratified by:** Awaiting review
