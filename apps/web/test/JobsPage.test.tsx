/**
 * @jest-environment jsdom
 */
import { ReactNode } from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobListResponse } from "@docbridge/contracts";

jest.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

jest.mock("../src/auth/session", () => ({
  session: { authFetch: jest.fn() },
}));

import { session } from "../src/auth/session";
import { JobsPage } from "../src/features/jobs/JobsPage";

const authFetch = jest.mocked(session.authFetch);

const JOB_ID = "33333333-0000-4000-8000-000000000003";

const page: JobListResponse = {
  items: [
    {
      id: JOB_ID,
      submittedAt: "2026-10-30T09:30:00.000Z",
      submitterDisplayName: "Alice Coordinator",
      filesCount: 3,
      tasksCount: 6,
      counts: { pending: 1, inProgress: 2, completed: 2, failed: 1 },
      status: "in_progress",
      completedAt: null,
    },
    {
      id: "44444444-0000-4000-8000-000000000004",
      submittedAt: "2026-10-29T15:00:00.000Z",
      submitterDisplayName: "Bob Coordinator",
      filesCount: 1,
      tasksCount: 2,
      counts: { pending: 0, inProgress: 0, completed: 2, failed: 0 },
      status: "completed",
      completedAt: "2026-10-29T15:01:00.000Z",
    },
  ],
  nextCursor: null,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <JobsPage />
    </QueryClientProvider>,
  );
}

describe("JobsPage", () => {
  beforeEach(() => {
    authFetch.mockClear();
  });

  it("lists jobs with progress and status badges", async () => {
    authFetch.mockResolvedValue(page);
    renderPage();

    expect(await screen.findByText("Alice Coordinator")).toBeDefined();
    expect(screen.getByText("Bob Coordinator")).toBeDefined();
    expect(screen.getByText("In progress")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("3 of 6", { exact: false })).toBeDefined();
    expect(screen.getByText("1 failed", { exact: false })).toBeDefined();
    expect(authFetch).toHaveBeenCalledWith("/api/jobs?limit=50");
  });

  it("offers Load more when a next cursor exists", async () => {
    authFetch.mockResolvedValue({ ...page, nextCursor: "cursor-2" });
    renderPage();
    expect(
      await screen.findByRole("button", { name: "Load more" }),
    ).toBeDefined();
  });
});
