# DocBridge — PAS-001 Blueprint

**Status:** Ready for review | **Owner:** Costin Georgescu | **Updated:** 26.10.2026

## What problem we're solving and why

Clinical trial documentation must be securely distributed to multiple destinations simultaneously.

Distributing one file at a time is slow, unreliable and hard to keep track of, leading to silent failures in a highly regulated industry.

**Current State:** A typical batch that would require 10 regulatory documents in 15 binders across 5 hospitals actually means 150 separate uploads, each requiring the coordinator to manually navigate, select receivers and confirm transfer.

**Impact:** Coordinator hours are wasted on repetitive document transfer operations instead of trial work, no retry mechanism unless someone notices the failed transfer and errors are silent and only discovered in audits.

## Context

Designed against a spec simulating a real clinical document distribution system. DocBridge is a standalone web application that delivers files into a document management platform through its API.

### Key Terminologies

| Term        | Definition                                                            |
| ----------- | --------------------------------------------------------------------- |
| Team        | Highest organizational level, owns binders, declares permissions.     |
| Binder      | Document collection within a team.                                    |
| Folder      | Optional binder subdivision for organizing documents (can be nested). |
| Destination | A folder where a file is delivered.                                   |
| Job         | Process for a submission batch, the actual unit tracked by the user.  |
| Task        | A single file to destination delivery process.                        |

### Related Documentation

- [Design requirements](design-requirements.md)
- [ADRs](adr/)
- [High level design](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share)

### Assumptions

- Files delivered to a folder are visible to all users with access to that team's folders.
- Delivery destinations are folders only; teams and binders are browsing levels (open question 2, resolved by reviewer decision; this deviates from the spec's "teams, binders, folders" and means a binder with no folders cannot receive deliveries).
- In case of users losing access mid-job, file distribution will continue until completion.
- When a file with the same name already exists, the system creates a new version of that document while retaining the previous.
- Authorization grants users full access to that team's resources, no role specific authorization for v1 (ex. read-only auditor).
- Team memberships managed in the auth service are the single source of truth for permissions. The platform relies on the team claims in the user's token and keeps no copy of its own ([ADR-05](adr/ADR-05-signed-tokens-team-claims.md)).

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

[System Design diagram](https://app.eraser.io/workspace/Vk4jEqnF0LIV0BCPlIG3?origin=share)

| Component           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web UI              | Destination browsing, file selection and mapping, job submission, live status views, downloads initiation (presigned URLs).                                                                                                                                                                                                                                                                                              |
| CDN                 | Serves the web UI assets to the browser.                                                                                                                                                                                                                                                                                                                                                                                 |
| Load balancer (ALB) | Single public entry point. Routes requests to the DocBridge API, the auth service and the platform's `GET /tree`, terminates TLS.                                                                                                                                                                                                                                                                                        |
| Auth service        | Manages users, credentials and team memberships. Issues signed tokens that other services verify locally.                                                                                                                                                                                                                                                                                                                |
| Auth database       | Stores users, credentials and team memberships. Owned by the auth service ([ADR-15](adr/ADR-15-separate-auth-and-docbridge-databases.md)).                                                                                                                                                                                                                                                                               |
| DocBridge API       | Acknowledges job submissions and commits job + task records in one transaction after checking that all files are staged. Serves staged-file status and job status, issues presigned URLs after auth check.                                                                                                                                                                                                               |
| DocBridge database  | Stores jobs, staged file metadata and task delivery records. Owned by the DocBridge API.                                                                                                                                                                                                                                                                                                                                 |
| Staging storage     | Holds file bytes between upload and delivery so that they don't pass through the API. Provides downloads directly, deletes files 30 days after job completion as per the retention policy (lifecycle rule keyed on a completion tag applied when the job finishes).                                                                                                                                                      |
| Upload events queue | Receives object-created events from staging storage. Consumed by the dispatcher to mark staged files as ready for submission ([ADR-13](adr/ADR-13-upload-completion-storage-events.md)).                                                                                                                                                                                                                                 |
| Dispatcher          | Scans committed jobs for tasks that have no queue message yet and publishes them, retrying until every task is dispatched. Consumes upload events and marks staged files so submission can verify each file is in storage without calling it ([ADR-13](adr/ADR-13-upload-completion-storage-events.md)).                                                                                                                 |
| Task queue          | Holds pending delivery messages durably and decouples submission from processing. Retries failed messages and parks exhausted ones in a dead letter queue.                                                                                                                                                                                                                                                               |
| Workers             | Consume task messages, fetch files from staging, verify integrity and deliver to the document platform via its API using a service credential, passing the submitter's user id so the stored document version records who sent it. Record every attempt and error on the task, including marking it failed on the final attempt. Repeat delivery of the same task is ignored.                                            |
| Document platform   | The destination document management platform. Owns the team, binder, folder hierarchy, filters it by the team claims in the caller's token, stores delivered documents and handles duplicates via versioning. Publicly reachable only for `GET /tree` via the load balancer; delivery, resolve and admin endpoints are called only by the DocBridge API and the workers ([ADR-14](adr/ADR-14-platform-read-via-alb.md)). |
| Platform database   | Stores teams, binders, folders and document records with versions. Owned by the document platform.                                                                                                                                                                                                                                                                                                                       |
| Platform storage    | Holds delivered file bytes for the document platform.                                                                                                                                                                                                                                                                                                                                                                    |
| KMS                 | Holds and manages encryption keys for data at rest, no in app crypto.                                                                                                                                                                                                                                                                                                                                                    |

### File lifecycle

1. The browser computes a checksum for each file and uploads the file directly to staging storage through a presigned URL.
2. Storage validates the checksum on upload ([ADR-08](adr/ADR-08-presigned-url-file-transfers.md)).
3. Staging storage emits an object-created event to the upload events queue. The dispatcher consumes it and marks the file staged, so the API knows a file is in storage without trusting the browser ([ADR-13](adr/ADR-13-upload-completion-storage-events.md)).
4. Uploads run in the background while the user maps destinations ([ADR-09](adr/ADR-09-stage-before-submission.md)).
5. The UI polls staged-file status from the API; Submit is enabled only when every file is marked staged, and the API rejects a submission that references an unstaged file.
6. A worker picks up each task, fetches the file from staging, re-verifies the checksum and delivers the file together with its checksum through the document platform's API.
7. The platform verifies the checksum on receipt before storing the document version.
8. The staged copy stays available for download through a presigned GET for 30 days after job completion, then the lifecycle policy deletes it.
9. At submission, the job records the submitter's team ids from their token. A user can view a job and download its files if they share at least one team with the submitter. This is a check between the requester's token claims and the team ids stored on the job, so the API never needs to read the membership table, only the auth service does.

### Asynchronous processing and failure handling

- Submission commits the job and all task records in one transaction and acknowledges immediately. The request consists of one batched folder-to-team lookup against the platform and one database transaction. Queue publishing happens after the ack, done by the dispatcher ([ADR-10](adr/ADR-10-commit-then-dispatch.md)).
- A failed delivery is attempted at least 3 times in total. On the last allowed attempt the worker marks the task failed with the last error, then the message moves to the dead-letter queue ([ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)).
- A worker crash can cause the same task message to be processed twice. Workers send the task id as an idempotency key so the platform ignores the repeat delivery ([ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)).
- One failed task never affects the other tasks in the same job. Job status is derived from the status of its tasks.
- The UI refreshes status on a polling interval, no persistent connection needed ([ADR-12](adr/ADR-12-ui-status-polling.md)).
- Availability target of 99.9% is met by running every service (API, auth, document platform, dispatcher, workers) as an ECS service with at least two tasks spread across availability zones. The Postgres databases run on Multi-AZ RDS instances. Storage, queues and KMS are managed services with their own SLAs, so there is no single instance whose loss takes the system down.

## User Flows

### Flow 1: Browse destinations

Sequence diagram: [flow-1-browse-destinations.eraser](diagrams/flow-1-browse-destinations.eraser)

1. User logs in the system.
2. UI loads the destination hierarchy as per user's permissions.
3. User expands teams - binders - folders to explore where they can deliver.
4. Expected outcome: Users only see the hierarchy they are authorized to view.

### Flow 2: File submission

Sequence diagrams: [flow-2a-file-submission.eraser](diagrams/flow-2a-file-submission.eraser) (user path, ends at the ack), [flow-2b-background-delivery.eraser](diagrams/flow-2b-background-delivery.eraser) (dispatch and delivery)

1. Files are selected for upload and staging initiates.
2. User maps files to destination folders.
3. Job is submitted.
4. Job is instantly confirmed, deliveries run in the background.
5. Expected outcome - User gets immediate confirmation and moves on, delivery happens without intervention.

### Flow 3: Job tracking

Sequence diagram: [flow-3-job-tracking.eraser](diagrams/flow-3-job-tracking.eraser)

1. User opens job history and sees active and past status.
2. Opens a job and sees each task state: file, destination, attempts.
3. Failed tasks display descriptive errors.
4. Status updates automatically until deliveries have a final result.
5. Expected outcome - The user knows which deliveries landed, which failed and why.

### Flow 4: File download

Sequence diagram: [flow-4-file-download.eraser](diagrams/flow-4-file-download.eraser)

1. User opens a colleague's job and selects a file.
2. API checks the requester's permission scope and issues a presigned URL.
3. Browser downloads directly from staging.
4. Expected outcome - Team transparency over all sent documents.

## Decisions with Architectural Impact

[Architecture decision records](adr/)

## Security

- Every API request carries a token and unauthenticated requests are rejected.
- Only PDF, DOCX, XLSX, PNG and JPG files are accepted. The presigned upload restricts the content type, and the worker checks the file signature before delivery.
- At job submission, the API asks the document platform which team each destination folder belongs to, then checks those teams against the caller's token claims. Folders outside the caller's teams are rejected before anything is committed.
- Download URLs are issued only after the job visibility check (requester shares a team with the submitter).
- API and platform verify signed tokens locally against the auth service's public key.
- Workers deliver under a service credential on behalf of the submitter and pass the submitter's user id so the platform records it on the document version ([ADR-05](adr/ADR-05-signed-tokens-team-claims.md)).
- File checksum captured at upload, re-verified by workers before delivery and verified again by the platform on receipt.
- Staged files are deleted 30 days after job completion as per lifecycle policy.
- Secrets are injected via environment/secrets manager, nothing in source code.
- All datastores encrypt at rest via KMS: staging, platform storage, Auth DB, DocBridge DB and Platform DB.
- The document platform is publicly reachable only for the destination tree read, which requires a valid token; delivery and admin endpoints are never routed on the load balancer ([ADR-14](adr/ADR-14-platform-read-via-alb.md)).

## Open questions

1. Can users manually re-run failed tasks? Resolved: not in R1 scope.
2. Can binders accept delivery? Resolved: folders only, per reviewer decision; teams/binders are browse-only levels.
3. How long should a revoked membership stay valid? Resolved: 15 minutes, the access token TTL ([TDD 4.1](tdd.md)).
4. What is the workers' service credential — an auth-issued service token verified with the same public key, or a static secret from the secrets manager? Resolved: auth-issued service token ([ADR-21](adr/ADR-21-worker-service-credential.md)).

## Technical Design

[Technical design document](tdd.md). All schemas, API contracts, task estimates, edge cases and the launch plan.

## Releases

### Release 1: Core

**Target Date:** TBD | **Status:** Planned | **Total Estimate:** 40 days ([TDD 8](tdd.md#8-estimate-summary))

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

- **Risk 1:** 1 GB file upload reliability | **Mitigation:** AWS multipart uploads (per-part presigned URLs plus a completion call). S3 verifies full-object checksums on multipart objects only for CRC algorithms, so the checksum algorithm is fixed in the TDD.
- **Risk 2:** Orphaned staged files that were uploaded but never submitted | **Mitigation:** Lifecycle rule for deleting stale objects.
- **Risk 3:** Platform throttling under job spikes | **Mitigation:** Delivery rate caps and retry with backoff, users experience a slightly slower batch, never an outage.
- **Risk 4:** 1 GB deliveries stream through the platform API container | **Mitigation:** workers stream rather than buffer, and the platform can hand out presigned upload URLs in R2 if it becomes a bottleneck.

### Release 2: TBD

**Target Date:** TBD | **Status:** Planned

Manual task retry, observability, potentially push-based status.
