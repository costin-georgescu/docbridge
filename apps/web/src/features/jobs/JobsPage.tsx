import { Link } from "@tanstack/react-router";
import { ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useJobs } from "./api";
import { JobStatusBadge } from "./JobStatusBadge";

export function JobsPage() {
  const jobs = useJobs();
  if (jobs.isPending) {
    return <p className="text-sm text-muted">Loading jobs…</p>;
  }
  if (jobs.isError) {
    return (
      <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
        {jobs.error instanceof ApiError
          ? jobs.error.message
          : "Failed to load jobs."}
      </p>
    );
  }
  const items = jobs.data.pages.flatMap((page) => page.items);
  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="mt-1 text-sm text-muted">Every delivery, in order.</p>
      </header>
      {items.length === 0 ? (
        <p className="text-sm text-muted">No jobs yet.</p>
      ) : (
        <ol className="relative ml-1 border-l-2 border-dotted border-accent/40 pl-8">
          {items.map((job) => {
            const done = job.counts.completed + job.counts.failed;
            return (
              <li key={job.id} className="relative pb-8 last:pb-0">
                <span
                  className={`absolute -left-[38px] top-1.5 size-3 rounded-full ring-4 ring-canvas ${
                    job.status === "in_progress"
                      ? "bg-accent-fill"
                      : "bg-muted/50"
                  }`}
                />
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                  {formatDateTime(job.submittedAt)}
                </p>
                <Link
                  to="/jobs/$jobId"
                  params={{ jobId: job.id }}
                  className="mt-1.5 block rounded-2xl border border-line bg-surface p-4 transition-shadow hover:shadow-[0_10px_30px_rgba(16,26,60,0.10)] dark:hover:border-[#2e3c73] dark:hover:shadow-none"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">
                      {job.submitterDisplayName}
                    </p>
                    <JobStatusBadge status={job.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {job.filesCount} files &middot; {done} of {job.tasksCount}{" "}
                    tasks done
                    {job.counts.failed > 0 && (
                      <span className="text-rose-600 dark:text-rose-300">
                        {" "}
                        &middot; {job.counts.failed} failed
                      </span>
                    )}
                  </p>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      {jobs.hasNextPage && (
        <button
          type="button"
          disabled={jobs.isFetchingNextPage}
          onClick={() => void jobs.fetchNextPage()}
          className="ml-8 mt-2 rounded-full border border-line px-5 py-2 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {jobs.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
