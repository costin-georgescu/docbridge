# DocBridge

Batch distribution of clinical trial documents into a permission-controlled document platform. A coordinator selects files once, maps each file to many destination folders across teams and binders, submits the whole batch in one action and tracks every individual delivery. Today the same work is one upload per file per destination: 10 documents into 15 binders means 150 manual uploads with no retry and no audit trail.

**Stage:** design. Blueprint and 15 ADRs written and awaiting review. No implementation yet; the next step after review is the technical design document.

## Documents

- [Design requirements](docs/design-requirements.md) — the spec this project is designed against
- [Blueprint PAS-001](docs/blueprint.md) — problem, components, file lifecycle, user flows, security, releases
- [Architecture decision records](docs/adr/) — ADR-01 to ADR-15
- [Diagram sources](docs/diagrams/) — architecture and four user-flow sequence diagrams in Eraser DSL
- [Interactive diagram on Eraser](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share)

## Architecture at a glance

Everything runs on AWS as ECS Fargate services, with LocalStack for local development (ADR-01, ADR-02). A single load balancer fronts the API and auth service; the document platform stays private (ADR-14).

- **Web UI** served from a CDN, talks to one backend: the **DocBridge API**. The **auth service** issues short-lived JWTs carrying the user's team ids, which the API and the document platform verify locally (ADR-04, ADR-05, ADR-14).
- **Uploads** go from the browser straight to **staging storage** through presigned URLs. An object-created event tells the dispatcher a file is staged; submit unlocks only when every file is confirmed in storage (ADR-08, ADR-09, ADR-13).
- **Submission** is one platform call plus one database transaction that writes the job and all its tasks, acknowledged in under 500 ms regardless of batch size. A **dispatcher** publishes tasks to an SQS **task queue** after the ack (ADR-10).
- **Workers** consume tasks at least once, re-verify the checksum and deliver to the **document platform** under a service credential with the task id as idempotency key. At least 3 delivery attempts; on the last failure the worker marks the task failed and the message lands in a dead-letter queue (ADR-11).
- **Status** reaches the UI by polling; the job state is derived from its tasks (ADR-12).
- **Data** lives in three Postgres databases, one per owner: auth, DocBridge, platform (ADR-03, ADR-06, ADR-15). The platform also has its own storage. Every store is encrypted at rest with KMS. The document platform is never publicly reachable.

## Scale and targets

2,000 users, 200 concurrent. Up to 100 files x 20 destinations = 2,000 tasks per job, 90,000 deliveries a day, files up to 1 GB. 99.9% availability, submit ack < 500 ms p99, destination tree < 1 s at 50 teams, delivery failure rate < 0.1%, no unrecorded task outcome.
