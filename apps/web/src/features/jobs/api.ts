import {
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  CreateJobRequest,
  CreateJobResponse,
  JobDetailResponse,
  JobListResponse,
  JobStatus,
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
