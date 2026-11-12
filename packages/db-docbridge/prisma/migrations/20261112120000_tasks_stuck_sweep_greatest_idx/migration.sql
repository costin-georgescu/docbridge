-- Recreates the stuck-sweep index on GREATEST(started_at, dispatched_at)
-- to match the dispatcher's sweep predicate; not expressible in the Prisma schema.
DROP INDEX "tasks_nonfinal_activity_idx";
CREATE INDEX "tasks_nonfinal_activity_idx"
    ON "tasks" (GREATEST(started_at, dispatched_at))
    WHERE "status" IN ('pending', 'in_progress') AND "dispatched_at" IS NOT NULL;
