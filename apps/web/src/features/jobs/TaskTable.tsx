import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "../../components/Card";
import {
  JobFileResponse,
  JobTaskResponse,
  TaskCounts,
  TaskStatus,
} from "@docbridge/contracts";
import { humanSize } from "../../lib/format";
import { useJobTasks } from "./api";
import { describeTaskError } from "./task-errors";

const TASK_PAGE_SIZE = 50;

const TASK_FILTERS: { status: TaskStatus; label: string }[] = [
  { status: "pending", label: "Pending" },
  { status: "in_progress", label: "In progress" },
  { status: "completed", label: "Completed" },
  { status: "failed", label: "Failed" },
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_BADGES: Record<TaskStatus, string> = {
  pending: "bg-ink/8 text-muted",
  in_progress: "bg-accent-soft text-accent",
  completed:
    "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
  failed: "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
};

export function TaskStatusBadge({ task }: { task: JobTaskResponse }) {
  const retrying = task.status === "pending" && task.attemptCount > 0;
  const badge = retrying
    ? "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
    : STATUS_BADGES[task.status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${badge}`}
    >
      {retrying
        ? `Retrying (attempt ${task.attemptCount})`
        : STATUS_LABELS[task.status]}
    </span>
  );
}

function TaskError({ task }: { task: JobTaskResponse }) {
  if (!task.lastError) {
    return <span className="text-muted/60">—</span>;
  }
  const error = describeTaskError(task.lastError);
  return (
    <div>
      <p className="text-rose-600 dark:text-rose-300">{error.title}</p>
      {error.detail !== null && (
        <p className="text-xs text-muted">{error.detail}</p>
      )}
    </div>
  );
}

function countOf(counts: TaskCounts, status: TaskStatus): number {
  return status === "in_progress" ? counts.inProgress : counts[status];
}

export function TaskTable({
  jobId,
  files,
  counts,
  tasksCount,
}: {
  jobId: string;
  files: JobFileResponse[];
  counts: TaskCounts;
  tasksCount: number;
}) {
  const [selected, setSelected] = useState<TaskStatus | null>(null);
  const [limit, setLimit] = useState(TASK_PAGE_SIZE);
  // The status filter is applied server-side, so switching chips restarts
  // the loaded window at the first page.
  useEffect(() => {
    setLimit(TASK_PAGE_SIZE);
  }, [selected]);

  const countsKey = `${counts.pending},${counts.inProgress},${counts.completed},${counts.failed}`;
  const query = useJobTasks(jobId, selected, limit, countsKey);
  const tasks = useMemo(() => query.data?.items ?? [], [query.data]);
  const expected = selected === null ? tasksCount : countOf(counts, selected);
  const hasMore = tasks.length >= limit && tasks.length < expected;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") {
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setLimit((l) => l + TASK_PAGE_SIZE);
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);

  const groups = useMemo(() => {
    const byFile = new Map<string, JobTaskResponse[]>();
    for (const task of tasks) {
      const list = byFile.get(task.fileId) ?? [];
      list.push(task);
      byFile.set(task.fileId, list);
    }
    const fileIds = new Set(files.map((f) => f.id));
    const mapped = files
      .map((file) => ({ file, tasks: byFile.get(file.id) ?? [] }))
      .filter((group) => group.tasks.length > 0);
    const orphans = [...byFile.values()]
      .flat()
      .filter((task) => !fileIds.has(task.fileId));
    if (orphans.length > 0) {
      mapped.push({
        file: { id: "unknown", name: "Unknown file", sizeBytes: 0 },
        tasks: orphans,
      });
    }
    return mapped;
  }, [files, tasks]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Filter tasks</span>
        <button
          type="button"
          aria-pressed={selected === null}
          onClick={() => setSelected(null)}
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            selected === null
              ? "border-accent bg-accent-soft text-accent"
              : "border-line bg-surface text-muted"
          }`}
        >
          All ({tasksCount})
        </button>
        {TASK_FILTERS.map(({ status, label }) => {
          const active = selected === status;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() =>
                setSelected((prev) => (prev === status ? null : status))
              }
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line bg-surface text-muted"
              }`}
            >
              {label} ({countOf(counts, status)})
            </button>
          );
        })}
      </div>
      {tasksCount === 0 ? (
        <p className="text-sm text-muted">This job has no tasks.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted">Loading tasks…</p>
      ) : query.isError ? (
        <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
          Failed to load tasks.
        </p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted">
          No tasks match the selected filters.
        </p>
      ) : (
        <>
          {groups.map(({ file, tasks: fileTasks }) => (
            <Card key={file.id}>
              <h3 className="text-sm font-medium text-ink">
                {file.name}{" "}
                <span className="font-normal text-muted">
                  {humanSize(file.sizeBytes)} · {fileTasks.length}{" "}
                  {fileTasks.length === 1 ? "destination" : "destinations"}
                </span>
              </h3>
              <table className="mt-2 w-full divide-y divide-line border-t border-line text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-2 font-medium">Destination</th>
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 font-medium">Last error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {fileTasks.map((task) => (
                    <tr key={task.id}>
                      <td className="py-2 text-ink">{task.destination.path}</td>
                      <td className="py-2">
                        <TaskStatusBadge task={task} />
                      </td>
                      <td className="py-2 text-xs">
                        <TaskError task={task} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
          {hasMore && (
            <div className="text-center">
              <div ref={sentinelRef} />
              <button
                type="button"
                onClick={() => setLimit((l) => l + TASK_PAGE_SIZE)}
                className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted hover:text-ink"
              >
                {query.isFetching
                  ? "Loading…"
                  : `Show more (${expected - tasks.length} left)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
