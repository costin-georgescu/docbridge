import { JobStatus } from "@docbridge/contracts";

const JOB_STYLES: Record<JobStatus, { label: string; className: string }> = {
  pending: {
    label: "Pending",
    className: "bg-ink/8 text-muted",
  },
  in_progress: {
    label: "In progress",
    className: "bg-accent-soft text-accent",
  },
  completed: {
    label: "Completed",
    className:
      "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300",
  },
  completed_with_failures: {
    label: "Completed with failures",
    className:
      "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300",
  },
  failed: {
    label: "Failed",
    className:
      "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
  },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const style = JOB_STYLES[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${style.className}`}
    >
      {style.label}
    </span>
  );
}
