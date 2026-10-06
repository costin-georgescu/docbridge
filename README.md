# DocBridge — PAS-001 Blueprint

**Status:** Ready for review | **Owner:** Costin Georgescu | **Updated:** 05.10.2026

> Design-stage project — blueprint and 12 ADRs solo-authored, pending review. Implementation has not started; this repo captures the architecture and the reasoning behind it.

## What problem we're solving and why

Clinical trial documentation must be securely distributed to multiple destinations simultaneously.

Distributing one file at a time is slow, unreliable and hard to keep track of, leading to silent failures in a highly regulated industry.

**Current State:** A typical batch that would require 10 regulatory documents in 15 binders across 5 hospitals actually means 150 separate uploads, each requiring the coordinator to manually navigate, select receivers and confirm transfer.

**Impact:** Coordinator hours are wasted on repetitive document transfer operations instead of trial work, no retry mechanism unless someone notices the failed transfer and errors are silent and only discovered in audits.

## Context

Designed against a spec simulating a real clinical document distribution system. DocBridge is a standalone web application that delivers files into a document management platform through its API.

### Key Terminologies

| Term | Definition |
|---|---|
| Team | Highest organizational level, owns binders, declares permissions. |
| Binder | Document collection within a team. |
| Folder | Optional binder subdivision for organizing documents. |
| Destination | A folder where a file is delivered. |
| Job | Process for a submission batch, the actual unit tracked by the user. |
| Task | A single file to destination delivery process. |

### Related Documentation

- [ADRs](docs/adr/)
- [System design diagram](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share)

### Assumptions

- Files delivered to a folder are visible to all users with access to that team's folders.
- Delivery destinations are folders only while teams and binders are browsing levels (addressed in open questions).
- In case of users losing access mid-job, file distribution will continue until completion.
- When a file with the same name already exists, the system creates a new version of that document while retaining the previous.
- Authorization grants users full access to that team's resources, no role specific authorization for v1 (ex. read-only auditor).
- Team memberships managed in the auth service are the single source of truth for permissions. The platform relies on the team claims in the user's token and keeps no copy of its own ([ADR-05](docs/adr/ADR-05-signed-tokens-team-claims.md)).

## Job Stories

- When I need to send documentation to my sites, I want to see only the binders and folders I have access to, so that the right destinations are quickly available and can't be delivered somewhere by mistake.
- When a document batch needs to reach multiple destinations, I want to assign each file to all its destinations in one go, so that everything gets uploaded once instead of repeating the same upload per binder.
- When I submit a batch, I want it confirmed instantly, so that I can move on to other work instead of supervising progress bars.
- When checking if a previous job was successful, I want to be able to see the history at a glance, so that I don't miss deliveries or resend files.
- When I need to verify if a specific document was actually delivered, I want to see the status inside the batch, so that I know which destinations received it and which failed.
- When a file delivery fails, I want the errors to be detailed enough so that I know what to do next (wait for retry, fix the destination or escalate).
- When a new coordinator joins, I want to create their account and assign their teams so that every operation performed in the system gets tracked to the specific user.
- When a colleague sends documents, I want to be able to download them as well, so that our team has full transparency of outbound files.

## High-Level Architecture

![Architecture diagram](docs/architecture.png)

[Interactive version on Eraser](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share)

| Component | Responsibility |
|---|---|
| Web UI | Destination browsing, file selection and mapping, job submission, live status views, downloads initiation (presigned URLs). |
| CDN | Serves the web UI assets to the browser. |
| Load balancer (ALB) | Single public entry point. Routes requests to DocBridge API and auth service, terminates TLS. |
| Auth service | Manages users, credentials and team memberships. Issues signed tokens that other services verify locally. |
| DocBridge API | Acknowledges job submissions and commits job + task records in one transaction. Serves authorized destination hierarchy and job status, issues presigned URLs after auth check. |
| Staging storage | Holds file bytes between upload and delivery so that they don't pass through the API. Provides downloads directly, deletes files after job completion as per the 30 day retention policy. |
| Dispatcher | Scans committed jobs for tasks that have no queue message yet and publishes them. Retries until every task is dispatched. |
| Task queue | Holds pending delivery messages durably and decouples submission from processing. Retries failed messages and parks exhausted ones in a dead letter queue. |
| Workers | Consume task messages, fetch files from staging, verify integrity and deliver to the document platform via its API using a service credential. Record every attempt and error on the task. Repeat delivery of the same task is ignored. |
| Document platform | The destination document management platform. Owns the team, binder, folder hierarchy, filters it by the team claims in the caller's token, stores delivered documents and handles duplicates via versioning. |
| Platform database | Stores teams, binders, folders and document records with versions. Owned by the document platform. |
| Platform storage | Holds delivered file bytes for the document platform. |
| Metadata database | Stores users, team memberships, jobs, staged files metadata and tasks delivery records. |
| KMS | Holds and manages encryption keys for data at rest, no in app crypto. |

### File lifecycle

1. The browser computes a checksum for each file and uploads the file directly to staging storage through a presigned URL.
2. Storage validates the checksum on upload ([ADR-08](docs/adr/ADR-08-presigned-url-file-transfers.md)).
3. Uploads run in the background while the user maps destinations, and submit becomes available once all files are staged ([ADR-09](docs/adr/ADR-09-stage-before-submission.md)).
4. A worker picks up each task, fetches the file from staging, re-verifies the checksum and delivers the file together with its checksum through the document platform's API.
5. The platform verifies the checksum on receipt before storing the document version.
6. The staged copy stays available for download through a presigned GET for 30 days after job completion, then the lifecycle policy deletes it.
7. At submission, the job records the submitter's team ids from their token. A user can view a job and download its files if they share at least one team with the submitter. This is a check between the requester's token claims and the team ids stored on the job, so the API never needs to read the membership table, only the auth service does.

### Asynchronous processing and failure handling

- Submission commits the job and all task records in one transaction and acknowledges immediately. Queue publishing happens after the ack, done by the dispatcher ([ADR-10](docs/adr/ADR-10-commit-then-dispatch.md)).
- A failed delivery is retried automatically at least 3 times. After the retry limit the message moves to the dead-letter queue and the task is marked failed with the last error ([ADR-11](docs/adr/ADR-11-at-least-once-idempotent-delivery.md)).
- A worker crash can cause the same task message to be processed twice. Workers send the task id as an idempotency key so the platform ignores the repeat delivery ([ADR-11](docs/adr/ADR-11-at-least-once-idempotent-delivery.md)).
- One failed task never affects the other tasks in the same job. Job status is derived from the status of its tasks.
- The UI refreshes status on a polling interval, no persistent connection needed ([ADR-12](docs/adr/ADR-12-ui-status-polling.md)).
- Availability target of 99.9% is met by running every service (API, auth, dispatcher, workers) as an ECS service with at least two tasks spread across availability zones. Storage, queue and KMS are managed services with their own SLAs, so there is no single instance whose loss takes the system down.

## User Flows

### Flow 1: Browse destinations

1. User logs in the system.
2. UI loads the destination hierarchy as per user's permissions.
3. User expands teams - binders - folders to explore where they can deliver.
4. Expected outcome: Users only see the hierarchy they are authorized to view.

### Flow 2: File submission

1. Files are selected for upload and staging initiates.
2. User maps files to destination folders.
3. Job is submitted.
4. Job is instantly confirmed, deliveries run in the background.
5. Expected outcome - User gets immediate confirmation and moves on, delivery happens without intervention.

### Flow 3: Job tracking

1. User opens job history and sees active and past status.
2. Opens a job and sees each task state: file, destination, attempts.
3. Failed tasks display descriptive errors.
4. Status updates automatically until deliveries have a final result.
5. Expected outcome - The user knows which deliveries landed, which failed and why.

### Flow 4: File download

1. User opens a colleague's job and selects a file.
2. API checks the requester's permission scope and issues a presigned URL.
3. Browser downloads directly from staging.
4. Expected outcome - Team transparency over all sent documents.

## Decisions with Architectural Impact

Only decisions that stakeholders need to see. Implementation-level decisions go in the TDD.

| Decision | Rationale | Trade-offs |
|---|---|---|
| [ADR-01](docs/adr/ADR-01-aws-deployment-local-emulation.md) - Deployment on AWS with local development on emulated cloud services. | System requirements map directly to native AWS services. | Vendor lock-in. |
| [ADR-02](docs/adr/ADR-02-compute-model-ecs-fargate.md) - Containerized services on ECS Fargate, ALB entry point. | Long-running API and queue-driven workers (up to 1 GB files) fit containers; Lambda's 15-min timeout conflicts with worker delivery. | Less low-level control than EC2; higher cost at sustained load, irrelevant at this scale. |
| [ADR-03](docs/adr/ADR-03-separate-document-platform-service.md) - Document platform runs as a separate service with its own stores. | It stands in for an external product; the API between systems is the contract the spec describes. | Second database and bucket to run; hierarchy and membership live in different systems. |
| [ADR-04](docs/adr/ADR-04-custom-auth-service.md) - Custom auth service instead of managed identity. | Identity model is trivial and tightly coupled to team memberships already in our DB. | We own credential hashing and token signing/verification, mitigated by mature libraries. |
| [ADR-05](docs/adr/ADR-05-signed-tokens-team-claims.md) - Signed tokens carry team claims; services verify locally. | No per-request call to auth; platform filters hierarchy by token claims. | Revoked membership valid until token expiry, bounded by TTL. |
| [ADR-06](docs/adr/ADR-06-relational-metadata-store.md) - Relational database for the metadata store. | Job - task data is relational and [ADR-10](docs/adr/ADR-10-commit-then-dispatch.md) demands atomicity. | Schema migrations, scaling is vertical first. |
| [ADR-07](docs/adr/ADR-07-live-destination-hierarchy.md) - Destination hierarchy queried on live platform. | The document platform owns the hierarchy, single source of truth. | Tree view depends on platform availability and is acceptable because the delivery is also dependent. |
| [ADR-08](docs/adr/ADR-08-presigned-url-file-transfers.md) - Direct transfer via presigned URLs. | File bytes travel from browser to storage directly, the API only mints short lived URLs after auth. | A leaked URL stays valid until expiry (bounded by TTL). |
| [ADR-09](docs/adr/ADR-09-stage-before-submission.md) - Submit enabled once all files finish staging. | File uploads overlap the user's mapping work rather than blocking it. | Users can't submit until all bytes are staged. |
| [ADR-10](docs/adr/ADR-10-commit-then-dispatch.md) - Submission acknowledged before dispatch. | Submission commits job & task records in one transaction while queue messages are dispatched async. | Tasks reach the queue shortly after ack, not atomically. |
| [ADR-11](docs/adr/ADR-11-at-least-once-idempotent-delivery.md) - At least once delivery, idempotent workers, DLQ. | Queue retries + DLQ guarantee no task is silently lost; task id as idempotency key makes redelivery harmless. | Platform stores an idempotency key per delivery. |
| [ADR-12](docs/adr/ADR-12-ui-status-polling.md) - UI polls job status on an interval. | FR5 is satisfied by polling for 200 concurrent users and needs no persistent connection infra. | Status lags up to the poll interval, acceptable since deliveries are not instant anyway. |

## Security

- Every API request carries a token and unauthenticated requests are rejected.
- Only PDF, DOCX, XLSX, PNG and JPG files are accepted. The presigned upload restricts the content type, and the worker checks the file signature before delivery.
- At job submission, the API asks the document platform which team each destination folder belongs to, then checks those teams against the caller's token claims. Folders outside the caller's teams are rejected before anything is committed.
- Download URLs are issued only after the job visibility check (requester shares a team with the submitter).
- API and platform verify signed tokens locally against the auth service's public key.
- Workers deliver under a service credential on behalf of the submitter ([ADR-05](docs/adr/ADR-05-signed-tokens-team-claims.md)).
- File checksum captured at upload, re-verified by workers before delivery and verified again by the platform on receipt.
- Staged files are deleted 30 days after job completion as per lifecycle policy.
- Secrets are injected via environment/secrets manager, nothing in source code.
- All datastores encrypt at rest via KMS: staging, platform storage, metadata DB and platform DB.

## Open questions

1. Can users manually re-run failed tasks? Resolved: not in R1 scope.
2. Can binders accept delivery? Resolved: folders only; teams/binders are browse-only levels.
3. How long should a revoked membership stay valid?

## Technical Design

Once the architecture and user flows above are aligned with stakeholders and the design team, engineering writes the TDD. All schemas, API contracts, task estimates, edge cases, and the launch plan live there.

## Releases

### Release 1: Core

**Target Date:** TBD | **Status:** Planned | **Total Estimate:** After TDD

Scope (feature level):

- Authentication and team memberships.
- Destination browsing (permission-scoped tree).
- File selection, staging and destination mapping.
- Job submission and async delivery.
- Per-task status tracking and job history.
- File downloads for team members.
- Staged-file retention (30-day policy).
- Local dev environment and automated deployment.

Dependencies:

- No external dependencies, all services are built in-house.

Success Metrics:

- Submission acknowledged in <500ms at p99.
- Destination hierarchy loads in <1s at 50 teams.
- Delivery failure rate is <0.1%.
- No unrecorded task outcomes.

Risks:

- **Risk 1:** 1 GB file upload reliability | **Mitigation:** AWS multipart uploads.
- **Risk 2:** Orphaned staged files that were uploaded but never submitted | **Mitigation:** Lifecycle rule for deleting stale objects.
- **Risk 3:** Platform throttling under job spikes | **Mitigation:** Delivery rate caps and retry with backoff, users experience a slightly slower batch, never an outage.
- **Risk 4:** 1 GB deliveries stream through the platform API container | **Mitigation:** workers stream rather than buffer, and the platform can hand out presigned upload URLs in R2 if it becomes a bottleneck.

### Release 2: TBD

**Target Date:** TBD | **Status:** Planned

Manual task retry, observability, potentially push-based status.
