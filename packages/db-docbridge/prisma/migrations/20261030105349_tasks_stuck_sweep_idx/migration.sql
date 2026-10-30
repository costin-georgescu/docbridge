-- Partial expression index for the dispatcher's stuck-task sweep
-- (TDD 2.6); not expressible in the Prisma schema.
CREATE INDEX "tasks_nonfinal_activity_idx"
    ON "tasks" (COALESCE(started_at, dispatched_at))
    WHERE "status" IN ('pending', 'in_progress') AND "dispatched_at" IS NOT NULL;
