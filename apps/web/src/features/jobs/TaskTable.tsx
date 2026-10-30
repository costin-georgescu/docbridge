import { useMemo, useState } from "react";
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
  pending: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

export function TaskStatusBadge({ task }: { task: JobTaskResponse }) {
  const retrying = task.status === "pending" && task.attemptCount > 0;
  const badge = retrying
    ? "bg-amber-100 text-amber-700"
    : STATUS_BADGES[task.status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge}`}
    >
      {retrying
        ? `Retrying (attempt ${task.attemptCount})`
        : STATUS_LABELS[task.status]}
    </span>
  );
}

function TaskError({ task }: { task: JobTaskResponse }) {
  if (!task.lastError) {
    return <span className="text-gray-400">—</span>;
  }
  const error = describeTaskError(task.lastError);
  return (
    <div>
      <p className="text-red-700">{error.title}</p>
      {error.detail !== null && (
        <p className="text-xs text-gray-500">{error.detail}</p>
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
        <span className="text-sm text-gray-500">Filter tasks</span>
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
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-gray-300 bg-white text-gray-400"
              }`}
            >
              {label} ({counts[status]})
            </button>
          );
        })}
      </div>
      {tasks.length === 0 ? (
        <p className="text-sm text-gray-500">This job has no tasks.</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-gray-500">
          No tasks match the selected filters.
        </p>
      ) : (
        groups.map(({ file, tasks: fileTasks }) => (
          <section key={file.id}>
            <h3 className="text-sm font-medium text-gray-900">
              {file.name}{" "}
              <span className="font-normal text-gray-500">
                {humanSize(file.sizeBytes)} · {fileTasks.length}{" "}
                {fileTasks.length === 1 ? "destination" : "destinations"}
              </span>
            </h3>
            <table className="mt-1 w-full divide-y divide-gray-200 rounded-md border border-gray-200 bg-white text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">Destination</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {fileTasks.map((task) => (
                  <tr key={task.id}>
                    <td className="px-3 py-2 text-gray-900">
                      {task.destination.path}
                    </td>
                    <td className="px-3 py-2">
                      <TaskStatusBadge task={task} />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <TaskError task={task} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}
