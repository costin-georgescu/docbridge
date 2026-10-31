import { getRouteApi, Link } from "@tanstack/react-router";
import { Card } from "../../components/Card";
import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useJob } from "./api";
import { JobFileList } from "./JobFileList";
import { JobStatusBadge } from "./JobStatusBadge";
import { TaskTable } from "./TaskTable";

const routeApi = getRouteApi("/jobs/$jobId");

export function JobDetailPage() {
  const { jobId } = routeApi.useParams();
  const job = useJob(jobId);
  if (job.isPending) {
    return <p className="text-sm text-muted">Loading job…</p>;
  }
  if (job.isError) {
    return (
      <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
        {job.error instanceof ApiError
          ? job.error.message
          : "Failed to load the job."}
      </p>
    );
  }
  const data = job.data;
  const retrying = data.tasks.filter(
    (t) => t.status === "pending" && t.attemptCount > 0,
  ).length;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-ink">
            Job{" "}
            <span className="font-mono text-sm font-normal">{data.id}</span>
          </h1>
          <JobStatusBadge status={data.status} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Submitted {formatDateTime(data.submittedAt)} by{" "}
          {data.submitterDisplayName}
          {data.completedAt !== null &&
            ` · finished ${formatDateTime(data.completedAt)}`}
        </p>
        <p className="mt-0.5 text-sm text-muted">
          {data.filesCount} {data.filesCount === 1 ? "file" : "files"} ·{" "}
          {data.counts.completed} of {data.tasksCount} tasks delivered
          {data.counts.failed > 0 &&
            ` · ${data.counts.failed} failed`}
          {data.counts.inProgress > 0 &&
            ` · ${data.counts.inProgress} in progress`}
          {retrying > 0 && ` · ${retrying} retrying`}
        </p>
      </Card>
      <JobFileList jobId={data.id} files={data.files} />
      <TaskTable files={data.files} tasks={data.tasks} />
      <p className="text-sm">
        <Link to="/jobs" className="text-accent hover:underline">
          ← Back to jobs
        </Link>
      </p>
    </div>
  );
}
