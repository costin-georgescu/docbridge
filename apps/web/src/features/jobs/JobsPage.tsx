import { Link } from "@tanstack/react-router";
import { JobSummary } from "@docbridge/contracts";
import { Button } from "../../components/Button";
import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useJobs } from "./api";
import { JobStatusBadge } from "./JobStatusBadge";

function TaskProgress({ job }: { job: JobSummary }) {
  const done = job.counts.completed + job.counts.failed;
  return (
    <span>
      {done} of {job.tasksCount}
      {job.counts.failed > 0 && (
        <span className="text-red-700"> · {job.counts.failed} failed</span>
      )}
    </span>
  );
}

export function JobsPage() {
  const jobs = useJobs();
  if (jobs.isPending) {
    return <p className="text-sm text-gray-500">Loading jobs…</p>;
  }
  if (jobs.isError) {
    return (
      <p className="text-sm text-red-700" role="alert">
        {jobs.error instanceof ApiError
          ? jobs.error.message
          : "Failed to load jobs."}
      </p>
    );
  }
  const items = jobs.data.pages.flatMap((page) => page.items);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-gray-900">Jobs</h1>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No jobs yet.</p>
      ) : (
        <table className="w-full divide-y divide-gray-200 rounded-md border border-gray-200 bg-white text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">Submitted</th>
              <th className="px-3 py-2 font-medium">By</th>
              <th className="px-3 py-2 font-medium">Files</th>
              <th className="px-3 py-2 font-medium">Progress</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((job) => (
              <tr key={job.id}>
                <td className="px-3 py-2">
                  <Link
                    to="/jobs/$jobId"
                    params={{ jobId: job.id }}
                    className="text-blue-600 hover:underline"
                  >
                    {formatDateTime(job.submittedAt)}
                  </Link>
                </td>
                <td className="px-3 py-2 text-gray-900">
                  {job.submitterDisplayName}
                </td>
                <td className="px-3 py-2 text-gray-900">{job.filesCount}</td>
                <td className="px-3 py-2 text-gray-900">
                  <TaskProgress job={job} />
                </td>
                <td className="px-3 py-2">
                  <JobStatusBadge status={job.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {jobs.hasNextPage && (
        <Button
          variant="secondary"
          disabled={jobs.isFetchingNextPage}
          onClick={() => void jobs.fetchNextPage()}
        >
          {jobs.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
