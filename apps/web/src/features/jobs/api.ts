import { CreateJobRequest, CreateJobResponse } from "@docbridge/contracts";
import { session } from "../../auth/session";

export function submitJob(body: CreateJobRequest): Promise<CreateJobResponse> {
  return session.authFetch<CreateJobResponse>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
