import { JobStatus } from "@docbridge/contracts";

const JOB_STYLES: Record<JobStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-700" },
  in_progress: {
    label: "In progress",
    className: "bg-blue-100 text-blue-700",
  },
  completed: { label: "Completed", className: "bg-green-100 text-green-700" },
  completed_with_failures: {
    label: "Completed with failures",
    className: "bg-amber-100 text-amber-700",
  },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const style = JOB_STYLES[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}
    >
      {style.label}
    </span>
  );
}
