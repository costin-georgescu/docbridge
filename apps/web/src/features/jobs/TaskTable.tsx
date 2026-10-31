import { useMemo, useState } from "react";
import { Card } from "../../components/Card";
import {
  JobFileResponse,
  JobTaskResponse,
  TaskStatus,
} from "@docbridge/contracts";
import { humanSize } from "../../lib/format";
import { describeTaskError } from "./task-errors";

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
  failed:
    "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
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

export function TaskTable({
  files,
  tasks,
}: {
  files: JobFileResponse[];
  tasks: JobTaskResponse[];
}) {
  const [hidden, setHidden] = useState<ReadonlySet<TaskStatus>>(new Set());
  const counts = useMemo(() => {
    const result: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const task of tasks) {
      result[task.status] += 1;
    }
    return result;
  }, [tasks]);
  const groups = useMemo(() => {
    const byFile = new Map<string, JobTaskResponse[]>();
    for (const task of tasks) {
      if (hidden.has(task.status)) {
        continue;
      }
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
  }, [files, tasks, hidden]);

  const toggle = (status: TaskStatus) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Filter tasks</span>
        {TASK_FILTERS.map(({ status, label }) => {
          const active = !hidden.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(status)}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line bg-surface text-muted"
              }`}
            >
              {label} ({counts[status]})
            </button>
          );
        })}
      </div>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted">This job has no tasks.</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted">
          No tasks match the selected filters.
        </p>
      ) : (
        groups.map(({ file, tasks: fileTasks }) => (
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
        ))
      )}
    </div>
  );
}
