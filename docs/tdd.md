# DocBridge - PAS-001 Technical Design

**Status:** Ready for review | **Blueprint:** [PAS-001](blueprint.md) | **Owner:** Costin Georgescu | **Updated:** 26.10.2026

## 1. Stack

| Layer                  | Choice                                                                                                                                    | Why in one clause                                      | Decision                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Language               | TypeScript everywhere: apps, shared packages, infrastructure                                                                              | one language, shared types                             | [ADR-19](adr/ADR-19-monorepo-pnpm-workspaces.md), [ADR-20](adr/ADR-20-infrastructure-aws-cdk.md) |
| Runtime                | Node.js 24 LTS                                                                                                                            | active LTS since Oct 2025, supported to Apr 2028       |                                                                                                  |
| Backend framework      | NestJS 12                                                                                                                                 | current major since Aug 2026; first-party upgrade path | [ADR-16](adr/ADR-16-backend-framework-nestjs.md)                                                 |
| Validation + contracts | Zod schemas in `packages/contracts`, applied via `nestjs-zod` pipes; OpenAPI generated from the same schemas                              | client and server share one definition                 |                                                                                                  |
| Database access        | Prisma, one schema per database                                                                                                           | typed client, migrations, bulk inserts                 | [ADR-18](adr/ADR-18-database-access-prisma.md)                                                   |
| Web                    | React 19 + Vite, TanStack Query (`refetchInterval` polling) + TanStack Router, Base UI + Tailwind (shadcn/ui), a Web Worker for checksums | static SPA on CDN, polling is a client concern         | [ADR-17](adr/ADR-17-frontend-react-vite-spa.md)                                                  |
| AWS SDK                | AWS SDK v3 (S3, SQS, Secrets Manager presigner), `@aws-crypto/crc32c`                                                                     | first-party clients; CRC32C runs in browser and Node   | [ADR-22](adr/ADR-22-checksum-crc32c.md)                                                          |
| Auth                   | `jose` for RS256 JWT sign/verify + JWKS, `argon2` for password hashing                                                                    | mature libraries, no hand-rolled crypto                |                                                                                                  |
| Tests                  | Jest (unit + integration), Testcontainers (Postgres), LocalStack container (S3, SQS), supertest, Playwright (E2E), k6 (performance)       | real engines for locking, checksums and queues         |                                                                                                  |
| Infrastructure         | AWS CDK v2 (TypeScript)                                                                                                                   | typed constructs in the team's language                | [ADR-20](adr/ADR-20-infrastructure-aws-cdk.md)                                                   |
| Local                  | docker compose (Postgres, LocalStack, six apps)                                                                                           | required by spec                                       |                                                                                                  |
| CI/CD                  | GitHub Actions builds, pushes to ECR and runs `cdk deploy`                                                                                | automated deployment per spec                          |                                                                                                  |

- HTTP applications: api, auth, platform.
- Standalone application contexts (no HTTP listener, `NestFactory.createApplicationContext`): dispatcher, worker.

## 2. Repository layout

```
apps/
  api/          DocBridge API (Nest, HTTP)
  auth/         Auth service (Nest, HTTP)
  platform/     Document platform (Nest, HTTP; only GET /tree publicly routed)
  dispatcher/   Upload-event consumer, task publisher, finalizer, housekeeping (Nest, standalone)
  worker/       Task consumer and delivery (Nest, standalone)
  web/          React SPA
packages/
  contracts/    Zod schemas + TS types: API DTOs, platform DTOs, queue message, token claims, error codes
  auth-core/    JWKS fetch + cache, token verification guard, claims decorators (used by api, platform)
  config/       Zod-validated environment loading shared by all services
  storage/      S3 presign + streaming helpers; CRC32C transform stream; file signature check
  db-auth/      Prisma schema, migrations, generated client for the auth database
  db-docbridge/ Prisma schema, migrations, client for the DocBridge database (api, dispatcher, worker)
  db-platform/  Prisma schema, migrations, client for the platform database
infra/          CDK app: one stack per environment
docker-compose.yml
```

- A service imports only its own `db-*` package.
- Cross-service data goes over HTTP ([ADR-03](adr/ADR-03-separate-document-platform-service.md), [ADR-15](adr/ADR-15-separate-auth-and-docbridge-databases.md)).

## 3. Data model

- Three databases on one Multi-AZ RDS Postgres instance in R1, one role per database, no cross-database queries ([ADR-15](adr/ADR-15-separate-auth-and-docbridge-databases.md)).
- All ids are UUID v7 (time-ordered, generated in the app).
- All timestamps are `timestamptz`.

### 3.1 Auth database (owner: auth service)

`users`

| Column        | Type        | Notes              |
| ------------- | ----------- | ------------------ |
| id            | uuid        | pk                 |
| email         | citext      | unique, not null   |
| password_hash | text        | argon2id, not null |
| display_name  | text        | not null           |
| is_admin      | boolean     | default false      |
| disabled_at   | timestamptz | null while active  |
| created_at    | timestamptz |                    |

`team_memberships`

| Column     | Type        | Notes                                                         |
| ---------- | ----------- | ------------------------------------------------------------- |
| user_id    | uuid        | fk users, on delete cascade                                   |
| team_id    | uuid        | minted by the platform, stored opaque, no FK across databases |
| created_at | timestamptz |                                                               |

- pk `(user_id, team_id)`; index `(team_id)`.

`refresh_tokens`

| Column      | Type        | Notes                              |
| ----------- | ----------- | ---------------------------------- |
| id          | uuid        | pk                                 |
| user_id     | uuid        | fk users                           |
| token_hash  | text        | unique; sha256 of the opaque token |
| expires_at  | timestamptz |                                    |
| revoked_at  | timestamptz | null while valid                   |
| replaced_by | uuid        | null; rotation chain               |
| created_at  | timestamptz |                                    |

- Index `(user_id)`.

`service_clients`

| Column      | Type        | Notes             |
| ----------- | ----------- | ----------------- |
| id          | text        | pk, e.g. `worker` |
| secret_hash | text        |                   |
| scopes      | text[]      |                   |
| created_at  | timestamptz |                   |

- Seeded; the secret itself lives in Secrets Manager.

### 3.2 DocBridge database (owner: DocBridge API; read/write also by dispatcher and worker through the same package)

`staged_files`

| Column              | Type        | Notes                                                     |
| ------------------- | ----------- | --------------------------------------------------------- |
| id                  | uuid        | pk                                                        |
| owner_user_id       | uuid        |                                                           |
| job_id              | uuid        | null; fk jobs, set at submission, one job per staged file |
| file_name           | text        |                                                           |
| content_type        | text        |                                                           |
| size_bytes          | bigint      |                                                           |
| checksum_crc32c     | text        | base64, as S3 reports it                                  |
| storage_key         | text        | unique; `staged/{owner_user_id}/{file_id}`                |
| multipart_upload_id | text        | null once completed                                       |
| status              | enum        | `pending_upload \| staged`                                |
| staged_at           | timestamptz | null                                                      |
| created_at          | timestamptz |                                                           |

- Index `(owner_user_id, created_at)`.
- Partial index `(created_at) WHERE status = 'pending_upload'` (reconciliation sweep).
- Partial index where `job_id IS NULL` (housekeeping).

`jobs`

| Column                 | Type        | Notes                                                          |
| ---------------------- | ----------- | -------------------------------------------------------------- |
| id                     | uuid        | pk                                                             |
| submitter_user_id      | uuid        |                                                                |
| submitter_display_name | text        | from token `name` claim; the API never reads the auth database |
| submitted_at           | timestamptz |                                                                |
| completed_at           | timestamptz | null; set by the finalizer when no task is pending/in_progress |
| retention_tagged_at    | timestamptz | null                                                           |
| files_count            | int         |                                                                |
| tasks_count            | int         |                                                                |

- Index `(submitted_at desc, id desc)` (keyset pagination).

`job_teams`

| Column  | Type | Notes                      |
| ------- | ---- | -------------------------- |
| job_id  | uuid | fk jobs, on delete cascade |
| team_id | uuid |                            |

- pk `(job_id, team_id)`; index `(team_id, job_id)`.
- Snapshot of the submitter's team claims at submission; visibility = requester's claims ∩ job_teams ≠ ∅.

`tasks`

| Column                | Type        | Notes                                           |
| --------------------- | ----------- | ----------------------------------------------- |
| id                    | uuid        | pk                                              |
| job_id                | uuid        | fk jobs                                         |
| staged_file_id        | uuid        | fk staged_files                                 |
| destination_folder_id | uuid        |                                                 |
| destination_team_id   | uuid        |                                                 |
| destination_path      | text        | snapshot `Team / Binder / Folder` for display   |
| status                | enum        | `pending \| in_progress \| completed \| failed` |
| dispatched_at         | timestamptz | null                                            |
| attempt_count         | int         | default 0                                       |
| started_at            | timestamptz | null                                            |
| finished_at           | timestamptz | null                                            |
| last_error_code       | text        | null                                            |
| last_error_message    | text        | null                                            |
| platform_document_id  | uuid        | null                                            |
| platform_version_no   | int         | null                                            |
| created_at            | timestamptz |                                                 |

- Unique `(job_id, staged_file_id, destination_folder_id)`.
- Index `(job_id, status)` (status aggregation, [ADR-23](adr/ADR-23-job-status-derived-on-read.md)).
- Partial index `(created_at) WHERE dispatched_at IS NULL` (dispatcher scan, [ADR-24](adr/ADR-24-dispatcher-skip-locked.md)).

`task_attempts`

| Column        | Type        | Notes                                                                                |
| ------------- | ----------- | ------------------------------------------------------------------------------------ |
| id            | bigserial   | pk                                                                                   |
| task_id       | uuid        | fk tasks                                                                             |
| attempt_no    | int         |                                                                                      |
| started_at    | timestamptz |                                                                                      |
| finished_at   | timestamptz | null while running                                                                   |
| outcome       | enum        | `succeeded \| failed_retryable \| failed_permanent \| timed_out`, null while running |
| error_code    | text        |                                                                                      |
| error_message | text        |                                                                                      |
| worker_id     | text        |                                                                                      |

- Unique `(task_id, attempt_no)`.

### 3.3 Platform database (owner: document platform)

`teams`

| Column     | Type        | Notes |
| ---------- | ----------- | ----- |
| id         | uuid        | pk    |
| name       | text        |       |
| created_at | timestamptz |       |

`binders`

| Column  | Type | Notes    |
| ------- | ---- | -------- |
| id      | uuid | pk       |
| team_id | uuid | fk teams |
| name    | text |          |

- Unique `(team_id, name)`.

`folders`

| Column           | Type | Notes            |
| ---------------- | ---- | ---------------- |
| id               | uuid | pk               |
| binder_id        | uuid | fk binders       |
| parent_folder_id | uuid | null; fk folders |
| name             | text |                  |

- Unique `(binder_id, parent_folder_id, name)`; index `(binder_id)`.

`documents`

| Column     | Type        | Notes      |
| ---------- | ----------- | ---------- |
| id         | uuid        | pk         |
| folder_id  | uuid        | fk folders |
| name       | text        |            |
| created_at | timestamptz |            |

- Unique `(folder_id, name)` — the same name in the same folder is a new version, not a new document.

`document_versions`

| Column               | Type        | Notes                                                                               |
| -------------------- | ----------- | ----------------------------------------------------------------------------------- |
| id                   | uuid        | pk                                                                                  |
| document_id          | uuid        | fk documents                                                                        |
| version_no           | int         |                                                                                     |
| storage_key          | text        | unique; `versions/{delivery_task_id}`                                               |
| size_bytes           | bigint      |                                                                                     |
| checksum_crc32c      | text        |                                                                                     |
| content_type         | text        |                                                                                     |
| submitted_by_user_id | uuid        |                                                                                     |
| delivery_task_id     | uuid        | unique; idempotency key ([ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)) |
| created_at           | timestamptz |                                                                                     |

- Unique `(document_id, version_no)`.

### 3.4 State machines

`staged_file`

| State          | Set by     | Transition                                                                |
| -------------- | ---------- | ------------------------------------------------------------------------- |
| pending_upload | api        | on record creation                                                        |
| staged         | dispatcher | on upload event + HeadObject confirms checksum and size                   |
| (deleted)      | dispatcher | `job_id IS NULL` records deleted by housekeeping after 2 days, object too |

- Records with `job_id` set live as long as the job.

`task`

| State       | Set by | Transition                                                                    |
| ----------- | ------ | ----------------------------------------------------------------------------- |
| pending     | api    | at submission                                                                 |
| in_progress | worker | on message receive                                                            |
| pending     | worker | after a retryable failure (`attempt_count` and `last_error_*` stay populated) |
| completed   | worker | platform 200/201                                                              |
| failed      | worker | permanent error on any attempt, or retryable error on attempt 3               |

- Between retry attempts the task sits in `pending` with `attempt_count > 0`; the UI renders that as "retrying". This matches the spec's definition that pending means the queue holds the message.

`job` (derived, [ADR-23](adr/ADR-23-job-status-derived-on-read.md))

| State                   | Derivation                                            |
| ----------------------- | ----------------------------------------------------- |
| pending                 | all tasks pending and `attempt_count` 0               |
| in_progress             | at least one task not final and not all pending       |
| completed               | all tasks completed                                   |
| completed_with_failures | none pending/in_progress, some failed, some completed |
| failed                  | all tasks failed                                      |

- Final states: `completed`, `completed_with_failures`, `failed`. `completed_at` is set when the job reaches a final state.

## 4. API contracts

Conventions:

- JSON everywhere
- `Authorization: Bearer <access token>` on every request except login, refresh and JWKS.
- Errors are `{ "error": { "code": "snake_case", "message": "...", "details": {} } }`
- ids are UUIDs
- pagination is keyset via `?cursor=&limit=`
- all request and response bodies are Zod schemas in `packages/contracts`.
- Public routes go through the ALB: `/api/*` to the DocBridge API, `GET /tree` to the platform and the auth service's enumerated public paths: `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/users*` and `/auth/.well-known/*`. Paths are enumerated rather than `/auth/*` so `POST /auth/service-token` is never publicly routed (4.2). The only request the listener forwards to the platform is GET `/tree` ([ADR-14](adr/ADR-14-platform-read-via-alb.md)). All other platform paths stay private on the service-discovery name `platform.docbridge.local` (Cloud Map), used by the API and the workers.

### 4.1 Tokens

- Access token (user): RS256 JWT with a `kid` header; claims `{ iss: "docbridge-auth", aud: "docbridge", sub: <user id>, name: <display name>, teams: [<team id>], admin: boolean, iat, exp }`; TTL 15 minutes.

- Refresh token: opaque 256-bit random, delivered as an httpOnly, Secure, SameSite=Strict cookie scoped to path `/auth` (so `/auth/logout` also receives it and can revoke the chain); TTL 8 hours; rotated on every use (the old one is marked replaced); stored hashed. The access token lives in SPA memory only. The cookie requires the UI and the backend to share one registrable domain (`app.<domain>` on CloudFront, `api.<domain>` on the ALB), so the browser treats them as same-site; the services answer CORS for the `app.` origin with credentials allowed.

- Service token ([ADR-21](adr/ADR-21-worker-service-credential.md)): same signer; `{ sub: "service:worker", scope: ["documents:write"], exp }`; TTL 1 hour.

- JWKS at `GET /auth/.well-known/jwks.json`; `packages/auth-core` fetches at startup, caches, and refetches once on an unknown `kid`.

Consequence for blueprint open question 3: a revoked membership or a disabled account stays effective at most 15 minutes (the access TTL); refresh is refused as soon as the account is disabled.

### 4.2 Auth service

| Method + Path                   | Auth                      | Request                                   | Response                                          | Errors                                                                                     |
| ------------------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| POST /auth/login                | none                      | {email, password}                         | 200 {accessToken, expiresIn} + Set-Cookie refresh | 401 invalid_credentials, 423 account_disabled, 429 too_many_attempts (10/min per ip+email) |
| POST /auth/refresh              | refresh cookie            | –                                         | 200 {accessToken, expiresIn} + rotated cookie     | 401 invalid_refresh                                                                        |
| POST /auth/logout               | refresh cookie            | –                                         | 204 (revokes the chain)                           |                                                                                            |
| GET /auth/.well-known/jwks.json | none                      | –                                         | 200 JWKS (public, cache-control 1 h)              |                                                                                            |
| POST /auth/service-token        | none (client credentials) | {clientId, clientSecret}                  | 200 {accessToken, expiresIn}                      | 401                                                                                        |
| POST /auth/users                | admin                     | {email, displayName, password, teamIds[]} | 201 user                                          |                                                                                            |
| GET /auth/users                 | admin                     | cursor                                    | 200 list                                          |                                                                                            |
| PUT /auth/users/:id/teams       | admin                     | {teamIds[]}                               | 200 (replace set)                                 |                                                                                            |
| POST /auth/users/:id/disable    | admin                     | –                                         | 204 (sets disabled_at, revokes refresh tokens)    |                                                                                            |

- `POST /auth/service-token` is reachable only on the internal service name `auth.docbridge.local`; the ALB does not route this path.

### 4.3 DocBridge API

| Method + Path                            | Auth          | Request                                                | Response                                                                                                                                                                                                                 | Errors                                                                                                                                                                                                                             |
| ---------------------------------------- | ------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /api/uploads                        | user          | `{ fileName, contentType, sizeBytes, checksumCrc32c }` | 201 one of `{ fileId, mode: "single", url, headers: { "Content-Type", "x-amz-checksum-crc32c" }, expiresAt }` or `{ fileId, mode: "multipart", uploadId, partSizeBytes, parts: [{ partNumber, url }], expiresAt }`       | 415 unsupported_file_type, 413 file_too_large (> 1 GiB), 422 validation_error                                                                                                                                                      |
| POST /api/uploads/:fileId/complete       | user, owner   | `{ parts: [{ partNumber, etag }] }`                    | 200 {}                                                                                                                                                                                                                   | 400 checksum_mismatch, 404, 409 not_multipart                                                                                                                                                                                      |
| GET /api/uploads?ids=a,b,c               | user, owner   | –                                                      | 200 `[{ fileId, status: "pending_upload" \| "staged" }]` — polled every 2 s by the UI until all staged ([ADR-09](adr/ADR-09-stage-before-submission.md), [ADR-13](adr/ADR-13-upload-completion-storage-events.md))       |                                                                                                                                                                                                                                    |
| POST /api/jobs                           | user          | `{ mappings: [{ fileId, folderIds: [uuid] }] }`        | 202 { jobId }                                                                                                                                                                                                            | 403 folder_not_authorized {folderIds}, 404 folder_not_found {folderIds}, 409 file_not_staged / file_expired / file_already_submitted / file_not_owned {fileIds}, 422 limits_exceeded, 503 platform_unavailable (nothing committed) |
| GET /api/jobs?cursor&limit≤50            | user          | –                                                      | 200 `{ items: [{ id, submittedAt, submitterDisplayName, filesCount, tasksCount, counts: { pending, inProgress, completed, failed }, status, completedAt }], nextCursor }` — visible if requester's teams ∩ job_teams ≠ ∅ |                                                                                                                                                                                                                                    |
| GET /api/jobs/:id                        | user, visible | –                                                      | 200 `{ ...job fields, files: [{ id, name, sizeBytes }], tasks: [{ id, fileId, destination: { folderId, path }, status, attemptCount, lastError: { code, message } \| null, startedAt, finishedAt }] }`                   | 403 job_not_visible (same response for not found, to avoid existence leaks)                                                                                                                                                        |
| GET /api/jobs/:id/files/:fileId/download | user, visible | –                                                      | 200 `{ url, expiresAt }` presigned GET, 5 min TTL, `response-content-disposition: attachment; filename=...`                                                                                                              | 403 job_not_visible, 404 file_not_in_job, 410 file_expired                                                                                                                                                                         |

- `POST /api/uploads`: mode is `multipart` when `sizeBytes` > 64 MiB; part size 16 MiB (max 64 parts at 1 GiB). The single-PUT URL is bound to content type and checksum ([ADR-08](adr/ADR-08-presigned-url-file-transfers.md)) and expires in 15 min; part URLs expire in 1 h; multipart is created server-side with `ChecksumAlgorithm: CRC32C`, `ChecksumType: FULL_OBJECT`. `unsupported_file_type` covers a content type not in the allowlist or an extension mismatch.

- `POST /api/uploads/:fileId/complete`: the API calls CompleteMultipartUpload with `ChecksumCRC32C` set to the stored value. A 400 checksum_mismatch means S3 rejected the full-object checksum; the record stays `pending_upload` and the client may re-upload.

- `POST /api/jobs` limits: ≤ 100 files, ≤ 20 distinct folders, ≤ 2,000 tasks, every file has ≥ 1 folder (`limits_exceeded`); staged files older than 24 h report `file_expired`. The budget is one platform call plus one transaction ([ADR-10](adr/ADR-10-commit-then-dispatch.md)); see Flow 2 step 5.

### 4.4 Document platform (internal except `GET /tree`)

| Method + Path                                     | Auth                                   | Request                                                                                                                                               | Response                                                                                                                                                                                                                                                                                                                                      | Errors                                                                      |
| ------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| GET /tree                                         | user token                             | –                                                                                                                                                     | 200 `{ teams: [{ id, name, binders: [{ id, name, folders: [{ id, name, folders: [...] }] }] }] }`, filtered `WHERE team_id = ANY(token.teams)`; folders nested in memory from one query per table; the only publicly routed platform path ([ADR-14](adr/ADR-14-platform-read-via-alb.md), [ADR-07](adr/ADR-07-live-destination-hierarchy.md)) |                                                                             |
| POST /folders/resolve                             | user or service token                  | { folderIds[] }                                                                                                                                       | 200 `{ resolved: [{ folderId, teamId, path }], missing: [folderId] }`                                                                                                                                                                                                                                                                         |                                                                             |
| PUT /folders/:folderId/documents                  | service token, scope `documents:write` | headers `X-Delivery-Task-Id`, `X-Submitter-User-Id`, `X-File-Name`, `X-Checksum-CRC32C`, `Content-Type`, `Content-Length`; body = raw bytes, streamed | 201 `{ documentId, versionNo }`; 200 `{ documentId, versionNo, alreadyDelivered: true }` when a version with this task id exists (checked BEFORE reading the body)                                                                                                                                                                            | 400 checksum_mismatch (object deleted), 404 folder_not_found, 413, 415, 503 |
| POST /admin/teams, /admin/binders, /admin/folders | admin token                            | create                                                                                                                                                | 201                                                                                                                                                                                                                                                                                                                                           |                                                                             |

- The admin endpoints are used by the seed script and a future admin UI; there is no admin UI on the platform in R1.

### 4.5 Queue messages (in `packages/contracts`)

- Task queue message body: `{ "v": 1, "taskId": uuid, "jobId": uuid }` — the worker loads everything else from the database so a stale message can never carry stale data. Standard queue (not FIFO, [ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)), visibility timeout 20 min, redrives to a DLQ (14-day retention) after `maxReceiveCount: 3`, long polling 20 s.

- Upload events queue: raw S3 event notification (`s3:ObjectCreated:Put`, `s3:ObjectCreated:CompleteMultipartUpload`) for prefix `staged/`; the dispatcher parses `s3.object.key` to the file id. Visibility 60 s; redrives to its own DLQ after `maxReceiveCount: 5`.

### 4.6 Error codes

| Code                    | HTTP      | Surface                            | UI shows as actionable text |
| ----------------------- | --------- | ---------------------------------- | --------------------------- |
| invalid_credentials     | 401       | auth                               | yes                         |
| account_disabled        | 423       | auth                               | yes                         |
| too_many_attempts       | 429       | auth                               | yes                         |
| invalid_refresh         | 401       | auth                               | no (silent re-login)        |
| unsupported_file_type   | 415       | api                                | yes                         |
| file_too_large          | 413       | api                                | yes                         |
| validation_error        | 422       | api                                | yes                         |
| checksum_mismatch       | 400       | api, platform, task                | yes                         |
| not_multipart           | 409       | api                                | no                          |
| folder_not_authorized   | 403       | api                                | yes                         |
| folder_not_found        | 404       | api, platform, task                | yes                         |
| file_not_staged         | 409       | api                                | yes                         |
| file_expired            | 409 / 410 | api                                | yes                         |
| file_already_submitted  | 409       | api                                | yes                         |
| file_not_owned          | 409       | api                                | yes                         |
| limits_exceeded         | 422       | api                                | yes                         |
| platform_unavailable    | 503       | api, task                          | yes                         |
| job_not_visible         | 403       | api                                | yes                         |
| file_not_in_job         | 404       | api                                | yes                         |
| file_signature_mismatch | task      | task `lastError`                   | yes                         |
| platform_rejected       | task      | task `lastError` (4xx other)       | yes                         |
| delivery_timeout        | task      | task `lastError` (15 min deadline) | yes                         |
| staged_object_missing   | task      | task `lastError` (staging 404)     | yes                         |
| storage_unavailable     | task      | task `lastError` (staging 5xx)     | yes                         |

- Permanent task errors (fail on first attempt): `checksum_mismatch`, `file_signature_mismatch`, `folder_not_found`, `platform_rejected`, `staged_object_missing`. Retryable: `platform_unavailable`, `delivery_timeout`, `storage_unavailable`.

## 5. Flow walkthroughs

- Each blueprint flow is broken into numbered steps.
- Every step carries its implementation detail, an estimate in days and a decision link where a real choice exists.

### Flow 0: Groundwork

**Step 0.1 - Monorepo scaffold (1.5 d)**

- pnpm workspaces with six apps and the shared packages, tsconfig project references, ESLint/Prettier, Jest config, GitHub Actions running lint + typecheck + unit on every PR.
- Decision: [ADR-16](adr/ADR-16-backend-framework-nestjs.md), [ADR-17](adr/ADR-17-frontend-react-vite-spa.md), [ADR-19](adr/ADR-19-monorepo-pnpm-workspaces.md).

**Step 0.2 - Local environment (1.5 d)**

- Docker compose with Postgres (three databases, three roles created by an init script), LocalStack (S3 with event notifications to SQS, SQS, KMS, Secrets Manager), six apps with hot reload; `packages/config` Zod-validated env; one `make up` / `pnpm dev`. All configuration comes from env, per spec.

**Step 0.3 - Schemas, migrations, seed (1 d)**

- The three Prisma schemas from section 3; `prisma migrate`; a seed script that creates teams/binders/folders in the platform via the admin endpoints, and the admin user, coordinators and memberships in auth with matching team ids.
- Decision: [ADR-18](adr/ADR-18-database-access-prisma.md).

**Step 0.4 - Infrastructure (3.5 d)**

- CDK stack: VPC (2 AZ, private subnets for services, NAT), Route 53 records and ACM certificates for `app.` and `api.` under one domain (4.1), ALB (TLS, rules `/api/*`, `GET /tree` and the enumerated auth public paths per section 4, CORS for the `app.` origin), ECS cluster + five services (sizes in Parameters), Cloud Map namespace `docbridge.local`, RDS Postgres Multi-AZ, staging and platform buckets (SSE-KMS CMK, block public access, TLS-only bucket policy, CORS for the UI origin on staging, event notification to the upload events queue, lifecycle rule added in Launch), two queues + two DLQs, Secrets Manager entries, IAM task roles per service (least privilege, section 6.3), CloudFront + S3 for the web bundle, ECR repos, and the GitHub Actions deploy workflow (builds, pushes and runs `cdk deploy`; migrations run as a one-off ECS task before the service update).
- Decision: [ADR-20](adr/ADR-20-infrastructure-aws-cdk.md).

### Flow 1: Browse destinations

**Step 1.1 - Auth service (2 d)**

- users/memberships/refresh tokens per 3.1; argon2id hashing; login/refresh/logout/jwks/service-token/admin endpoints per 4.2; the RS256 keypair loaded from Secrets Manager with a `kid`; throttling on login.
- Decision: [ADR-04](adr/ADR-04-custom-auth-service.md), [ADR-05](adr/ADR-05-signed-tokens-team-claims.md), [ADR-21](adr/ADR-21-worker-service-credential.md).

**Step 1.2 - `packages/auth-core` (0.5 d)**

- JWKS client with cache; the Nest guards `@RequireUser()`, `@RequireService('documents:write')`, `@RequireAdmin()`; a typed claims param decorator; unit tests with a test keypair.

**Step 1.3 - Platform hierarchy (1.5 d)**

- Schema 3.3; `GET /tree` filtered by claims (three queries, nest in memory, measured < 1 s at 50 teams × 10 binders × 20 folders); `POST /folders/resolve` (returns team id and path); the admin create endpoints.
- Decision: [ADR-07](adr/ADR-07-live-destination-hierarchy.md), [ADR-03](adr/ADR-03-separate-document-platform-service.md).

**Step 1.4 - Public route for the destination tree (0.5 d)**

- ALB rule routing `GET /tree` to the platform; no other platform path is routed, so delivery, resolve and admin endpoints answer only on the internal service name. Verified: an unauthenticated call is rejected and a non-routed path is unreachable externally.
- Decision: [ADR-14](adr/ADR-14-platform-read-via-alb.md).

**Step 1.5 - Web: login + tree + admin (2 d)**

- Login form; access token held in memory; silent refresh 60 s before expiry; on 401, refresh then retry once. The destination tree component loads the whole tree once, expands/collapses client-side and filters by search. A minimal admin screen: list users, create user, assign teams; the team list comes from `GET /tree` unfiltered for admins via an `?all=true` admin-only flag on the platform tree.

### Flow 2: File submission

**Step 2.1 - API uploads (1.5 d)**

- `POST /api/uploads` with the allowlist (content type AND extension: pdf, docx, xlsx, png, jpg/jpeg), the size cap, the single-vs-multipart decision, presigning via `@aws-sdk/s3-request-presigner`; the complete endpoint; the status poll endpoint.
- Decision: [ADR-08](adr/ADR-08-presigned-url-file-transfers.md), [ADR-22](adr/ADR-22-checksum-crc32c.md).

**Step 2.2 - Web upload manager (2.5 d)**

- File picker + drag-drop; CRC32C computed in a Web Worker over `file.stream()` chunks so the UI never blocks; request upload; single PUT with the required headers, or multipart with 4 parts in parallel, per-part retry (3× exponential), resumable within the session; per-file progress; polls `GET /api/uploads` every 2 s; upload errors surfaced per file with a retry button.
- Decision: [ADR-09](adr/ADR-09-stage-before-submission.md).

**Step 2.3 - Dispatcher: upload events (1 d)**

- Consume the upload events queue; parse the key to the file id; HeadObject with `ChecksumMode: ENABLED` and compare CRC32C and size with the record; `UPDATE staged_files SET status='staged', staged_at=now() WHERE id=$1 AND status='pending_upload'` (idempotent for duplicate events); on mismatch, which should not happen since S3 already validated. Log and leave pending; delete the message. A reconciliation sweep every 60s HeadObjects records that are `pending_upload`, older than 60 s and younger than 24 h (cap 200 per sweep), to cover a lost event.
- Decision: [ADR-13](adr/ADR-13-upload-completion-storage-events.md).

**Step 2.4 - Web mapping UI (1.5 d)**

- A matrix of files × chosen folders; multi-select folders from the tree; per-file destination chips; live counters (files/20 folders/2,000 tasks) with limits enforced client-side and server-side; Submit enabled only when all files are staged and every file has ≥ 1 folder.

**Step 2.5 - API: POST /api/jobs (1.5 d)**

- (a) Zod validation + limits. 
- (b) `POST platform/folders/resolve` with the caller's token: a missing folder gets 404, a team outside `token.teams` gets 403, and nothing is committed. 
- (c) One Prisma interactive transaction: insert job + job_teams (from `token.teams`); `UPDATE staged_files SET job_id=$job WHERE id = ANY($ids) AND owner_user_id=$caller AND status='staged' AND job_id IS NULL AND staged_at > now() - interval '24 hours' RETURNING id`. If the returned count ≠ requested, roll back and run a classification query to answer 409 with the offending ids and reason; `createMany` tasks (status pending, `destination_team_id` and `destination_path` from the resolve response); commit. 
- (d) 202 { jobId }. Latency budget: resolve ≤ 50 ms, transaction ≤ 150 ms at 2,000 rows (measured in 5.3). A same-user double submit gets 409 file_already_submitted on the second request because `job_id` is already set.
- Decision: [ADR-10](adr/ADR-10-commit-then-dispatch.md), [ADR-06](adr/ADR-06-relational-metadata-store.md).

**Step 2.6 - Dispatcher: task publisher (1 d)**

- Loop: claim a batch inside one transaction (`BEGIN; SELECT id, job_id FROM tasks WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED;`), publish it with `SendMessageBatch` in groups of 10, mark the published rows with `UPDATE tasks SET dispatched_at = now() WHERE id = ANY(succeeded)` and `COMMIT`; run again immediately if the batch was full, else sleep 1 s. Partial batch failures leave rows unmarked for the next scan.
- A second sweep in the same loop re-publishes non-final tasks whose message is presumed dead: `status IN ('pending','in_progress') AND dispatched_at IS NOT NULL AND COALESCE(started_at, dispatched_at) < now() - interval '25 minutes'` — longer than the maximum a live message can stay invisible (20 min visibility timeout + 2 min backoff + slack). This covers receives consumed by worker crashes before three attempts: `maxReceiveCount` counts deliveries, not attempts, so a message can reach the DLQ while its task still has attempts left. Republishing a task whose message is actually still in flight is harmless because workers deduplicate by task status ([ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)).
- Decision: [ADR-24](adr/ADR-24-dispatcher-skip-locked.md), [ADR-10](adr/ADR-10-commit-then-dispatch.md).

**Step 2.7 - Worker (2.5 d)**

- Poller (long poll, up to 10 messages, `WORKER_CONCURRENCY` = 8 in flight per container). Per message: load the task; if status is final, delete the message (duplicate); if `in_progress` and `started_at` < 15 min ago, delete the message (concurrent duplicate; the owning message will retry if needed); otherwise `UPDATE tasks SET status='in_progress', attempt_count=attempt_count+1, started_at=now() RETURNING attempt_count` plus an insert into task_attempts. Pre-check: `attempt_count` > 3 marks the task failed (defensive). Then GetObject streams the object from staging, the first 8 bytes are checked against the signature table (PDF `25 50 44 46`, PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, DOCX/XLSX `50 4B 03 04`; the two Office types share the zip signature and are told apart by the declared type in R1), the stream passes through a CRC32C transform and into `PUT platform/folders/:id/documents` with Node fetch (`duplex: "half"`), a 15 min deadline, and the service token from cache (renewed at 50 min).
- Outcome handling: on 201/200 the task is completed with `finished_at` and platform ids, and the message is deleted. A permanent error (400 `checksum_mismatch`, 404 `folder_not_found`, 415, other 4xx, `file_signature_mismatch`, `staged_object_missing`) marks the task failed with code + message on this attempt and deletes the message. A retryable error (platform 5xx or 429, staging 5xx, connection error, deadline) records a `failed_retryable` attempt and sets `last_error_*`; when `attempt_count` ≥ 3 the task is marked failed and `ChangeMessageVisibility` 0 lets SQS redrive the message to the DLQ on the next receive ([ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)); otherwise the status returns to `pending` and `ChangeMessageVisibility` applies the backoff (30 s after attempt 1, 2 min after attempt 2).
- SIGTERM: stop polling, wait for in-flight up to the ECS `stopTimeout` of 120 s; a transfer longer than that is cut and retried by visibility expiry — one attempt may be spent on a deploy, accepted.
- Decision: [ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md), [ADR-21](adr/ADR-21-worker-service-credential.md), [ADR-22](adr/ADR-22-checksum-crc32c.md).

**Step 2.8 - Platform delivery endpoint (2 d)**

- Guard on the service token; `SELECT` a version by `delivery_task_id` and answer 200 alreadyDelivered without reading the body; resolve the folder (404); stream the body through a CRC32C transform into platform storage with `@aws-sdk/lib-storage` Upload at key `versions/{taskId}`; compare the computed checksum with the header and on mismatch DeleteObject + 400. Then a transaction: `INSERT INTO documents (folder_id, name) ... ON CONFLICT (folder_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, `SELECT ... FROM documents WHERE id=$1 FOR UPDATE`, `version_no = coalesce(max(version_no),0)+1`, insert the version with `delivery_task_id`. A unique violation on `delivery_task_id` (two workers delivering the same task concurrently) rolls back, deletes our copy with DeleteObject and responds 200 alreadyDelivered with the winner's ids.
- Decision: [ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md), [ADR-03](adr/ADR-03-separate-document-platform-service.md).

**Step 2.9 - Dispatcher: finalizer + retention tagging (0.5 d)**

- Every 10 s: `UPDATE jobs SET completed_at = now() WHERE completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.job_id = jobs.id AND t.status IN ('pending','in_progress')) RETURNING id` (claimed with SKIP LOCKED while two instances run). For each returned job, `PutObjectTagging retention=completed` on its staged objects (≤ 100 calls, retried; `retention_tagged_at` set when all succeed; untagged jobs are retried on the next sweep). Housekeeping daily: delete staged_files with `job_id IS NULL` older than 2 days together with their objects (`DeleteObjects` in batches of 1,000).
- Decision: [ADR-23](adr/ADR-23-job-status-derived-on-read.md), [ADR-24](adr/ADR-24-dispatcher-skip-locked.md).

### Flow 3: Job tracking

**Step 3.1 - API job reads (1 d)**

- `GET /api/jobs` keyset-paginated over jobs visible via job_teams, then one grouped count query over the page's job ids, status derived per 3.4. `GET /api/jobs/:id` joins tasks to staged_files. 403 for invisible and missing alike.
- Decision: [ADR-23](adr/ADR-23-job-status-derived-on-read.md), [ADR-12](adr/ADR-12-ui-status-polling.md).

**Step 3.2 - Web job list + detail (1.5 d)**

- TanStack Query with `refetchInterval` 10 s on the list and 3 s on a non-final job detail (polling stops when final); task table with status filters, grouping by file, descriptive error text from `lastError`, "retrying (attempt n)" rendering for pending tasks with `attempt_count` > 0; a job status badge for the five derived states.
- Decision: [ADR-12](adr/ADR-12-ui-status-polling.md).

### Flow 4: File download

**Step 4.1 - API download (0.5 d)**

- Visibility check via job_teams; membership of the file in the job via tasks; presigned GET for 5 min with attachment disposition. The API answers 410 `file_expired` when the staged file's `staged_at + 32 days` has passed. The same boundary as the lifecycle rule, which deletes 32 days after object creation (`staged_at` is the closest record of that moment); this check replaces a storage call on the download path.
- Decision: [ADR-08](adr/ADR-08-presigned-url-file-transfers.md).

**Step 4.2 - Web download (0.5 d)**

- File list inside the job detail with a download action that opens the presigned URL.

### Cross-cutting

**Step 5.1 - Integration test infrastructure and suites (2.5 d)**

- Testcontainers Postgres per database, a LocalStack container, Jest projects per app. Suites: the submission transaction (limits, the 403/404/409 paths, 2,000 tasks committed atomically, rollback leaves no rows); the dispatcher claim with two concurrent instances publishes each task once; worker end-to-end against the real platform app in-process (success, each permanent error, a retryable error backs off and reaches the DLQ after 3); platform idempotency under two concurrent deliveries of one task id; versioning under two concurrent deliveries of the same name to one folder; the upload event marks staged idempotently; the finalizer sets `completed_at` exactly once.

**Step 5.2 - E2E (1.5 d)**

- Playwright against docker compose: the four blueprint flows plus admin user creation; a 100 MB fixture exercises multipart.

**Step 5.3 - Performance (1 d)**

- k6: `POST /api/jobs` at 100 files × 20 folders under 200 virtual users must hold p99 < 500 ms; `GET /tree` at 50 teams must hold p95 < 1 s; tune indexes and pool size (`connection_limit` per service) from the results.

**Step 5.4 - Staging on real AWS (2 d)**

- Deploy; manual 1 GB upload + delivery (CRC32C full-object multipart behaviour on real S3, which LocalStack may not emulate exactly); an RDS failover drill while a job is in flight; verify CloudFront, CORS and cookies; verify the lifecycle rule and tagging.

**Step 5.5 - Hardening (1.5 d)**

- IAM least-privilege review per task role; bucket policies; security headers on CloudFront; dependency audit; log scrubbing (no file names or emails in logs, ids only); rate limits.

## 6. Beyond the happy path

### 6.1 Concurrency

- Two dispatcher instances: disjoint batches via SKIP LOCKED (2.6, [ADR-24](adr/ADR-24-dispatcher-skip-locked.md)).
- Dispatcher crash between publish and mark: rows stay unmarked, are re-published next scan, and the worker deduplicates by task status (2.6, 2.7).
- Two workers on one task after a visibility expiry: the platform's unique `delivery_task_id` decides, the loser deletes its object (2.8, [ADR-11](adr/ADR-11-at-least-once-idempotent-delivery.md)).
- Two deliveries of the same file name to one folder: `ON CONFLICT` + `FOR UPDATE` on the document row serializes version numbering (2.8).
- Two workers finishing the last two tasks of a job: neither sets `completed_at`; the finalizer does (2.9, [ADR-23](adr/ADR-23-job-status-derived-on-read.md)).
- Same-user double submit: the second request gets 409 file_already_submitted because `job_id` is already set (2.5).
- Duplicate S3 events: the conditional `UPDATE ... WHERE status='pending_upload'` absorbs them (2.3).
- A membership change mid-job: the job_teams snapshot keeps visibility stable and delivery continues (blueprint assumption).
- A worker's service token expiring mid-transfer: the token is attached at request start and the platform verifies it at start; long bodies are not re-verified (2.7, 2.8).
- A task message dying before three attempts (crashes consume queue receives without outcome writes): the dispatcher's stuck-task sweep re-publishes it, so the task never sits non-final with no live message (2.6).

### 6.2 Failure modes

| Dependency down           | Immediate effect                                                     | System behaviour                                                                                                                           | Recovery                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DocBridge Postgres        | API 503 on reads and writes                                          | workers do not delete messages, set visibility 60 s and continue; dispatcher idles                                                         | RDS Multi-AZ failover ≈ 60 s; Prisma reconnects; no task outcome lost because the outcome write and the message delete are ordered write-then-delete           |
| Auth service              | refresh fails, user returns to the login screen                                         | logged-in users continue up to 15 min; workers hold service tokens for 1 h, renewed at 50 min                                              | an outage > 1 h fails deliveries as retryable and backs off                                                                                                          |
| Document platform         | destination tree 503 with message; submission 503, nothing committed | deliveries see 5xx, retry with backoff and park in the DLQ after 3                                                                                           | DLQ'd tasks are manual recovery, out of R1 scope per blueprint open question 1; tasks show failed with `platform_unavailable` and the user is told to resubmit |
| Task queue (SQS)          | tasks not dispatched                                                 | submission unaffected ([ADR-10](adr/ADR-10-commit-then-dispatch.md)); dispatcher retries; workers idle                                     | resume on recovery, nothing lost                                                                                                                               |
| Upload events queue       | files stay `pending_upload`                                          | reconciliation sweep marks them within 60 s via HeadObject                                                                                 | automatic                                                                                                                                                      |
| Staging S3                | uploads fail in the browser                                          | per-part retry on the client; workers fail retryable with `storage_unavailable`; `staged_object_missing` only on a 404, which is permanent | automatic                                                                                                                                                      |
| Dispatcher                | tasks remain undispatched, UI shows pending                          | second instance or restart resumes                                                                                                         | nothing lost                                                                                                                                                   |
| Worker crash mid-transfer | message reappears after 20 min                                       | the stale `in_progress` rule lets the next worker proceed; idempotency prevents a duplicate version if the first delivery actually landed  | automatic                                                                                                                                                      |
| Task message dies before three attempts | task non-final with no live message; job never completes | dispatcher stuck-task sweep re-publishes it (2.6)                                                                                        | automatic                                                                                                                                                      |
| KMS                       | every store refuses reads/writes                                     | full outage; nothing to design around                                                                                                      | AWS SLA                                                                                                                                                        |
| ALB/Fargate AZ loss       | capacity halves                                                      | two tasks per service across AZs; Multi-AZ RDS                                                                                             | automatic                                                                                                                                                      |

### 6.3 Security & access

- Who can do what: a user owns their uploads, submits to folders within their own teams, sees jobs sharing a team and downloads from those jobs; an admin manages users and memberships; the service worker can only deliver; the platform's only public path is the authenticated `GET /tree` — delivery and admin endpoints are never routed.
- Sensitive data: file contents (clinical documents) exist only in staging and platform storage under SSE-KMS, never through the API containers, never in logs. Emails and password hashes live only in the auth database, which the API cannot connect to ([ADR-15](adr/ADR-15-separate-auth-and-docbridge-databases.md)). Tokens are never logged.
- The file-type allowlist is enforced three times: declared type + extension at presign, content type bound into the presigned PUT, file signature in the worker.
- Presigned URL TTLs: PUT 15 min, part URLs 1 h, GET 5 min.
- CORS on the staging bucket is limited to the UI origin and PUT/GET.
- Secrets via ECS secrets from Secrets Manager: DB credentials, the signing keypair, the worker client secret.
- Postgres requires TLS; one role per database.
- Dependencies pinned; `pnpm audit` in CI.

Task roles are least-privilege per service; the shared ECS execution role handles ECR pulls, secret injection and log writes and is separate from these.

| Task role  | S3                                                                   | SQS                                                                             | KMS                                          |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| api        | `PutObject`, `GetObject` on `staged/*` (presign only)                | —                                                                               | `GenerateDataKey`, `Decrypt` on staging key  |
| dispatcher | `GetObject` (HEAD), `PutObjectTagging`, `DeleteObject` on `staged/*` | `ReceiveMessage`, `DeleteMessage` on upload events; `SendMessage` on task queue | `Decrypt` on staging key                     |
| worker     | `GetObject` on `staged/*`                                            | `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on task queue      | `Decrypt` on staging key                     |
| platform   | `PutObject`, `GetObject`, `DeleteObject` on `versions/*`             | —                                                                               | `GenerateDataKey`, `Decrypt` on platform key |
| auth       | —                                                                    | —                                                                               | —                                            |

Multipart initiate/part/complete run under `s3:PutObject`; incomplete multipart uploads are removed by an `AbortIncompleteMultipartUpload` lifecycle rule. Queues use SSE-SQS managed keys, so SQS needs no KMS grants. Every task role gets `secretsmanager:GetSecretValue` on only its own secrets (listed above) plus `kms:Decrypt` on the secrets key.

### 6.4 Testing

| Area                            | Unit | Integration | E2E/Perf       | Manual                     |
| ------------------------------- | ---- | ----------- | -------------- | -------------------------- |
| Token issue/verify, guards      | x    |             |                |                            |
| Submission transaction          |      | x           | x (k6)         |                            |
| Dispatcher claim (2 inst.)      |      | x           |                |                            |
| Worker delivery + retries       | x    | x           |                | x (staging 1 GB)           |
| Platform idempotency/versioning |      | x           |                |                            |
| Upload event marking            |      | x           |                | x (event shape on real S3) |
| Finalizer                       |      | x           |                |                            |
| Full UI flows                   |      |             | x (Playwright) |                            |
| LocalStack-vs-S3 fidelity       |      |             |                | x                          |

Rule: anything touching Postgres locking, S3 checksums or SQS visibility gets an integration test against the real engine (Testcontainers/LocalStack), not a mock. LocalStack-specific doubts — full-object CRC32C on multipart, the event notification shape — are verified manually in staging (5.4).

## 7. Launch

### 7.1 Data migration

Greenfield. `prisma migrate deploy` runs as a one-off ECS task per database before the service rollout. Migrations are expand-only within a release, so the previous image keeps working against the new schema and a rollback never needs a down migration.

### 7.2 Configuration and feature flags

The spec mandates env/secrets for all configuration; R1 has no runtime flag service. Rollout control is membership-driven: a team is "on DocBridge" once its coordinators have accounts and memberships, so a pilot is provisioning two teams. Operational knobs (the Parameters table) are env vars changeable by redeploying the task definition.

### 7.3 Rollout

dev (compose), then staging (real AWS, 5.4), then production: pilot with two teams for two weeks while watching the metrics below, then provision the remaining teams in batches.

### 7.4 Rollback

The ECS deployment circuit breaker rolls back automatically to the previous task definition on failed health checks; otherwise a manual `cdk deploy` of the previous image tag. The schema is forward-compatible (7.1). In-flight tasks survive a rollback because state lives in Postgres and SQS, not in containers; staged files are untouched.

### 7.5 Monitoring

Default CloudWatch only, per the spec's v1 scope.

| Signal                    | Source                                          | Alarm                                   |
| ------------------------- | ----------------------------------------------- | --------------------------------------- |
| ALB 5xx rate, p99 latency | per target group                                | p99 `POST /api/jobs` > 500 ms for 5 min |
| Task queue age            | ApproximateAgeOfOldestMessage                   | > 10 min                                |
| Task DLQ depth            | ApproximateNumberOfMessagesVisible              | > 0                                     |
| Upload events DLQ depth   | ApproximateNumberOfMessagesVisible              | > 0                                     |
| ECS CPU/memory            | per service                                     | sustained high                          |
| RDS                       | CPU, connections, free storage, failover events | thresholds per instance                 |
| Staging S3 4xx            | checksum rejections                             | spike                                   |
| Worker structured logs    | per attempt: task id, outcome, duration         | —                                       |
| Delivery failure rate     | scheduled query, failed/total tasks per day     | > 0.1% (until R2 observability)         |

Autoscaling: workers target-tracking on task queue visible messages per worker (min 2, max 20); the API on CPU 60%.

## 8. Estimate summary

| Flow          | Days                                     | Cumulative | Milestone                                                   |
| ------------- | ---------------------------------------- | ---------- | ----------------------------------------------------------- |
| Flow 0        | 7.5                                      | ~8         | whole system runs locally via docker compose; infra deploys |
| Flow 1        | 6.5                                      | ~14        | login works; tree browses with real permissions             |
| Flow 2        | 14                                       | ~28        | a file goes end to end: pick, stage, submit, delivered      |
| Flow 3        | 2.5                                      | ~31        | job list and detail track live deliveries                   |
| Flow 4        | 1                                        | ~32        | a teammate downloads a file from a job                      |
| Cross-cutting | 8.5                                      | ~40        | tested on real AWS, hardened, pilot-ready                   |
| **Total**     | **40** (one engineer, ≈ 8 working weeks) |            |                                                             |

## 9. Decisions

### 9.1 New architecture decisions

- [ADR-16](adr/ADR-16-backend-framework-nestjs.md) — NestJS for all Node services.
- [ADR-17](adr/ADR-17-frontend-react-vite-spa.md) — React SPA served as static assets.
- [ADR-18](adr/ADR-18-database-access-prisma.md) — Prisma as schema, migration and query layer.
- [ADR-19](adr/ADR-19-monorepo-pnpm-workspaces.md) — one repository, pnpm workspaces.
- [ADR-20](adr/ADR-20-infrastructure-aws-cdk.md) — infrastructure in AWS CDK, TypeScript.
- [ADR-21](adr/ADR-21-worker-service-credential.md) — workers deliver with an auth-issued service token.
- [ADR-22](adr/ADR-22-checksum-crc32c.md) — CRC32C as the end-to-end integrity checksum.
- [ADR-23](adr/ADR-23-job-status-derived-on-read.md) — job status computed from task counts at read time.
- [ADR-24](adr/ADR-24-dispatcher-skip-locked.md) — dispatcher instances claim work with SKIP LOCKED.

### 9.2 Parameters

| Parameter                                | Value                                                                                                                                           | Where                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Access token TTL                         | 15 min                                                                                                                                          | auth                    |
| Refresh token TTL                        | 8 h                                                                                                                                             | auth                    |
| Service token TTL / renew                | 1 h / 50 min                                                                                                                                    | auth, worker            |
| Multipart threshold                      | 64 MiB                                                                                                                                          | api                     |
| Part size                                | 16 MiB                                                                                                                                          | api                     |
| Parallel parts                           | 4                                                                                                                                               | web                     |
| Presigned PUT TTL                        | 15 min                                                                                                                                          | api                     |
| Part URL TTL                             | 1 h                                                                                                                                             | api                     |
| Presigned GET TTL                        | 5 min                                                                                                                                           | api                     |
| Staged file submission window            | 24 h                                                                                                                                            | api                     |
| Orphan staged-file cleanup               | 2 days                                                                                                                                          | dispatcher housekeeping |
| Retention lifecycle                      | 32 days after object creation for tag `retention=completed` (≥ 30 days after completion given the 24 h submission bound and sub-day completion) | staging bucket          |
| Incomplete multipart abort               | 7 days                                                                                                                                          | staging bucket          |
| Max files per job                        | 100                                                                                                                                             | api, web                |
| Max distinct folders per job             | 20                                                                                                                                              | api, web                |
| Max tasks per job                        | 2,000                                                                                                                                           | api, web                |
| Max file size                            | 1 GiB                                                                                                                                           | api, web                |
| Dispatcher batch                         | 100                                                                                                                                             | dispatcher              |
| Dispatcher idle sleep                    | 1 s                                                                                                                                             | dispatcher              |
| Stuck task re-dispatch bound             | 25 min                                                                                                                                          | dispatcher              |
| Finalizer interval                       | 10 s                                                                                                                                            | dispatcher              |
| Reconciliation sweep                     | 60 s                                                                                                                                            | dispatcher              |
| Worker concurrency                       | 8                                                                                                                                               | worker                  |
| Worker per-attempt deadline              | 15 min                                                                                                                                          | worker                  |
| Task queue visibility timeout            | 20 min                                                                                                                                          | infra                   |
| Max attempts                             | 3                                                                                                                                               | worker                  |
| Retry backoff                            | 30 s / 2 min                                                                                                                                    | worker                  |
| UI poll: uploads / job detail / job list | 2 s / 3 s / 10 s                                                                                                                                | web                     |
| ECS sizes                                | api 2 × (0.5 vCPU, 1 GiB); auth 2 × (0.25, 0.5); platform 2 × (1, 2); dispatcher 2 × (0.25, 0.5); worker 2–20 × (1, 2)                          | infra                   |
| RDS                                      | db.t4g.medium Multi-AZ                                                                                                                          | infra                   |
| Login throttle                           | 10/min per ip+email                                                                                                                             | auth                    |

### 9.3 Blueprint open questions resolved here

- Question 3 resolves to 15 minutes, the access token TTL.
- Question 4 resolves to the auth-issued service token ([ADR-21](adr/ADR-21-worker-service-credential.md)).

### 9.4 Refinements to blueprint statements

- Orphan staged files are deleted by the dispatcher's housekeeping sweep, not a lifecycle rule, because a lifecycle rule can't express "objects without a completion tag."
- Permanent delivery errors fail on the first attempt; the spec's three-attempt rule is applied to transient failures.
- Job status has five values, adding `completed_with_failures` to show partial failure.
