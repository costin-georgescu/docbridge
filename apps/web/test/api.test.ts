import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../src/auth/session", () => ({
  session: { authFetch: jest.fn() },
}));

import { session } from "../src/auth/session";
import {
  fetchJob,
  fetchJobTasks,
  isFinalJobStatus,
  listJobs,
} from "../src/features/jobs/api";

const authFetch = jest.mocked(session.authFetch);

describe("isFinalJobStatus", () => {
  it("treats completed, completed_with_failures and failed as final", () => {
    expect(isFinalJobStatus("completed")).toBe(true);
    expect(isFinalJobStatus("completed_with_failures")).toBe(true);
    expect(isFinalJobStatus("failed")).toBe(true);
    expect(isFinalJobStatus("pending")).toBe(false);
    expect(isFinalJobStatus("in_progress")).toBe(false);
  });
});

describe("listJobs", () => {
  beforeEach(() => {
    authFetch.mockClear();
  });

  it("requests the first page without a cursor", async () => {
    authFetch.mockResolvedValue({ items: [], nextCursor: null });
    await listJobs();
    expect(authFetch).toHaveBeenCalledWith("/api/jobs?limit=50");
  });

  it("passes the keyset cursor as a query parameter", async () => {
    authFetch.mockResolvedValue({ items: [], nextCursor: null });
    await listJobs("2026-10-30T09:30:00.000Z~some-id");
    const params = new URLSearchParams({
      limit: "50",
      cursor: "2026-10-30T09:30:00.000Z~some-id",
    });
    expect(authFetch).toHaveBeenCalledWith(`/api/jobs?${params}`);
  });
});

describe("fetchJob", () => {
  beforeEach(() => {
    authFetch.mockClear();
  });

  it("encodes the job id into the request path", async () => {
    authFetch.mockResolvedValue({});
    await fetchJob("33333333-0000-4000-8000-000000000003");
    expect(authFetch).toHaveBeenCalledWith(
      "/api/jobs/33333333-0000-4000-8000-000000000003",
    );
  });
});

describe("fetchJobTasks", () => {
  beforeEach(() => {
    authFetch.mockClear();
  });

  const JOB_ID = "33333333-0000-4000-8000-000000000003";

  it("requests tasks with no parameters by default", async () => {
    authFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchJobTasks(JOB_ID);
    expect(authFetch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/tasks`);
  });

  it("passes status, cursor and limit as query parameters", async () => {
    authFetch.mockResolvedValue({ items: [], nextCursor: null });
    await fetchJobTasks(JOB_ID, {
      status: "failed",
      cursor: "2026-10-30T09:30:00.000Z~some-id",
      limit: 100,
    });
    const params = new URLSearchParams({
      status: "failed",
      cursor: "2026-10-30T09:30:00.000Z~some-id",
      limit: "100",
    });
    expect(authFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/tasks?${params}`,
    );
  });
});
