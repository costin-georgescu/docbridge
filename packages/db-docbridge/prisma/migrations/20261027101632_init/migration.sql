-- CreateEnum
CREATE TYPE "staged_file_status" AS ENUM ('pending_upload', 'staged');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('pending', 'in_progress', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "task_attempt_outcome" AS ENUM ('succeeded', 'failed_retryable', 'failed_permanent', 'timed_out');

-- CreateTable
CREATE TABLE "staged_files" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "job_id" UUID,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_crc32c" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "multipart_upload_id" TEXT,
    "status" "staged_file_status" NOT NULL,
    "staged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staged_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "submitter_user_id" UUID NOT NULL,
    "submitter_display_name" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "retention_tagged_at" TIMESTAMPTZ(6),
    "files_count" INTEGER NOT NULL,
    "tasks_count" INTEGER NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_teams" (
    "job_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,

    CONSTRAINT "job_teams_pkey" PRIMARY KEY ("job_id","team_id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "staged_file_id" UUID NOT NULL,
    "destination_folder_id" UUID NOT NULL,
    "destination_team_id" UUID NOT NULL,
    "destination_path" TEXT NOT NULL,
    "status" "task_status" NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "platform_document_id" UUID,
    "platform_version_no" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attempts" (
    "id" BIGSERIAL NOT NULL,
    "task_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "task_attempt_outcome",
    "error_code" TEXT,
    "error_message" TEXT,
    "worker_id" TEXT,

    CONSTRAINT "task_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staged_files_storage_key_key" ON "staged_files"("storage_key");

-- CreateIndex
CREATE INDEX "staged_files_owner_user_id_created_at_idx" ON "staged_files"("owner_user_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_submitted_at_id_idx" ON "jobs"("submitted_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "job_teams_team_id_job_id_idx" ON "job_teams"("team_id", "job_id");

-- CreateIndex
CREATE INDEX "tasks_job_id_status_idx" ON "tasks"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_job_id_staged_file_id_destination_folder_id_key" ON "tasks"("job_id", "staged_file_id", "destination_folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_attempts_task_id_attempt_no_key" ON "task_attempts"("task_id", "attempt_no");

-- AddForeignKey
ALTER TABLE "staged_files" ADD CONSTRAINT "staged_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_teams" ADD CONSTRAINT "job_teams_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_staged_file_id_fkey" FOREIGN KEY ("staged_file_id") REFERENCES "staged_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial indexes for the reconciliation sweep, housekeeping and the
-- dispatcher scan; not expressible in the Prisma schema.
CREATE INDEX "staged_files_pending_upload_created_at_idx"
    ON "staged_files" ("created_at") WHERE "status" = 'pending_upload';

CREATE INDEX "staged_files_no_job_created_at_idx"
    ON "staged_files" ("created_at") WHERE "job_id" IS NULL;

CREATE INDEX "tasks_undispatched_created_at_idx"
    ON "tasks" ("created_at") WHERE "dispatched_at" IS NULL;
