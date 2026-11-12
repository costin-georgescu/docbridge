-- Keyset index for GET /api/jobs/:id/tasks, ordered (created_at, id) per job.
CREATE INDEX "tasks_job_id_created_at_id_idx"
    ON "tasks" ("job_id", "created_at", "id");
