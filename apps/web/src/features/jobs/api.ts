import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  CreateJobRequest,
  CreateJobResponse,
  JobDetailResponse,
  JobFileDownloadResponse,
  JobListResponse,
  JobStatus,
  JobTaskListResponse,
  TaskStatus,
} from "@docbridge/contracts";
import { session } from "../../auth/session";

export function submitJob(body: CreateJobRequest): Promise<CreateJobResponse> {
  return session.authFetch<CreateJobResponse>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listJobs(cursor?: string): Promise<JobListResponse> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return session.authFetch<JobListResponse>(`/api/jobs?${params}`);
}

export function fetchJob(jobId: string): Promise<JobDetailResponse> {
  return session.authFetch<JobDetailResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}`,
  );
}

export function fetchJobTasks(
  jobId: string,
  opts: { status?: TaskStatus | null; cursor?: string; limit?: number } = {},
): Promise<JobTaskListResponse> {
  const params = new URLSearchParams();
  if (opts.status) {
    params.set("status", opts.status);
  }
  if (opts.cursor) {
    params.set("cursor", opts.cursor);
  }
  if (opts.limit !== undefined) {
    params.set("limit", String(opts.limit));
  }
  const qs = params.toString();
  return session.authFetch<JobTaskListResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/tasks${qs ? `?${qs}` : ""}`,
  );
}

export function requestFileDownload(
  jobId: string,
  fileId: string,
): Promise<JobFileDownloadResponse> {
  return session.authFetch<JobFileDownloadResponse>(
    `/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}/download-url`,
    { method: "POST" },
  );
}

const FINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "completed_with_failures",
  "failed",
]);

export function isFinalJobStatus(status: JobStatus): boolean {
  return FINAL_JOB_STATUSES.has(status);
}

// ADR-12: the list polls every 10 s; a detail polls every 3 s and stops once
// the derived job status is final.
export function useJobs() {
  return useInfiniteQuery({
    queryKey: ["jobs"],
    queryFn: ({ pageParam }) => listJobs(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export function useJob(jobId: string) {
  return useQuery({
    queryKey: ["jobs", jobId],
    queryFn: () => fetchJob(jobId),
    refetchInterval: (query) =>
      query.state.data !== undefined &&
      !isFinalJobStatus(query.state.data.status)
        ? 3_000
        : false,
  });
}

// The task table loads a prefix window of `limit` rows. `countsKey` is a
// serialized copy of the job's status counts: it sits in the query key, so
// the window is only re-fetched when the 3 s job poll actually reports a
// change — unchanged polls cost the small detail response and nothing else.
export function useJobTasks(
  jobId: string,
  status: TaskStatus | null,
  limit: number,
  countsKey: string,
) {
  return useQuery({
    queryKey: ["jobs", jobId, "tasks", status ?? "all", limit, countsKey],
    queryFn: () => fetchJobTasks(jobId, { status, limit }),
    placeholderData: keepPreviousData,
  });
}
