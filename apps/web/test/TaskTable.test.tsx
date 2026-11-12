/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  JobFileResponse,
  JobTaskResponse,
  TaskCounts,
} from "@docbridge/contracts";

jest.mock("../src/auth/session", () => ({
  session: { authFetch: jest.fn() },
}));

import { session } from "../src/auth/session";
import { TaskTable } from "../src/features/jobs/TaskTable";

const authFetch = jest.mocked(session.authFetch);

const JOB_ID = "33333333-0000-4000-8000-000000000003";
const FILE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const files: JobFileResponse[] = [
  { id: FILE_A, name: "a.pdf", sizeBytes: 2048 },
  { id: FILE_B, name: "b.pdf", sizeBytes: 512 },
];

const counts: TaskCounts = {
  pending: 1,
  inProgress: 0,
  completed: 1,
  failed: 1,
};

function task(overrides: Partial<JobTaskResponse>): JobTaskResponse {
  return {
    id: "t1",
    fileId: FILE_A,
    destination: {
      folderId: "11111111-0000-4000-8000-000000000001",
      path: "Alpha / Invoices / 2024",
    },
    status: "completed",
    attemptCount: 1,
    lastError: null,
    startedAt: "2026-10-30T10:00:00.000Z",
    finishedAt: "2026-10-30T10:00:30.000Z",
    ...overrides,
  };
}

const tasks: JobTaskResponse[] = [
  task({ id: "t1" }),
  task({
    id: "t2",
    destination: {
      folderId: "22222222-0000-4000-8000-000000000002",
      path: "Beta / Legal / Contracts",
    },
    status: "pending",
    attemptCount: 2,
    lastError: {
      code: "platform_unavailable",
      message: "platform answered 503",
    },
    startedAt: null,
    finishedAt: null,
  }),
  task({
    id: "t3",
    fileId: FILE_B,
    destination: {
      folderId: "33333333-0000-4000-8000-000000000003",
      path: "Gamma / Archive",
    },
    status: "failed",
    attemptCount: 3,
    lastError: { code: "folder_not_found", message: "folder was deleted" },
  }),
];

function renderTable(opts: {
  tasksCount?: number;
  counts?: TaskCounts;
  tasksFiles?: JobFileResponse[];
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskTable
        jobId={JOB_ID}
        files={opts.tasksFiles ?? files}
        counts={opts.counts ?? counts}
        tasksCount={opts.tasksCount ?? tasks.length}
      />
    </QueryClientProvider>,
  );
}

describe("TaskTable", () => {
  beforeEach(() => {
    authFetch.mockClear();
    authFetch.mockResolvedValue({ items: tasks, nextCursor: null });
  });

  it("groups tasks under their file with filter counts from the job summary", async () => {
    renderTable({});

    expect(await screen.findByText("a.pdf")).toBeDefined();
    expect(screen.getByText("b.pdf")).toBeDefined();
    expect(
      screen.getByRole("cell", { name: "Alpha / Invoices / 2024" }),
    ).toBeDefined();
    expect(
      screen.getByRole("cell", { name: "Beta / Legal / Contracts" }),
    ).toBeDefined();
    expect(screen.getByText("Pending (1)")).toBeDefined();
    expect(screen.getByText("Completed (1)")).toBeDefined();
    expect(screen.getByText("Failed (1)")).toBeDefined();
    expect(authFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/tasks?limit=50`,
    );
  });

  it("renders retrying with the attempt number for pending tasks with attempts", async () => {
    renderTable({});
    expect(await screen.findByText("Retrying (attempt 2)")).toBeDefined();
  });

  it("shows descriptive error text from lastError", async () => {
    renderTable({});
    expect(
      await screen.findByText(
        "The destination folder was not found on the platform",
      ),
    ).toBeDefined();
    expect(screen.getByText("folder was deleted")).toBeDefined();
    expect(
      screen.getByText("The document platform is temporarily unavailable"),
    ).toBeDefined();
  });

  it("asks the server for the selected status when a filter chip is clicked", async () => {
    const user = userEvent.setup();
    renderTable({});

    await user.click(await screen.findByRole("button", { name: "Failed (1)" }));
    expect(authFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/tasks?status=failed&limit=50`,
    );

    authFetch.mockClear();
    await user.click(screen.getByRole("button", { name: "All (3)" }));
    expect(authFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/tasks?limit=50`,
    );
  });

  it("offers a Show more control while the loaded window is shorter than the count", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      task({ id: `t${i}` }),
    );
    authFetch.mockResolvedValue({ items: fullPage, nextCursor: "cursor-1" });
    const user = userEvent.setup();
    renderTable({ tasksCount: 120 });

    const more = await screen.findByRole("button", {
      name: "Show more (70 left)",
    });
    authFetch.mockClear();
    await user.click(more);
    expect(authFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/tasks?limit=100`,
    );
  });

  it("shows a distinct message when the job has no tasks", async () => {
    authFetch.mockResolvedValue({ items: [], nextCursor: null });
    renderTable({ tasksCount: 0, counts: { ...counts, pending: 0 } });
    expect(screen.getByText("This job has no tasks.")).toBeDefined();
    expect(
      screen.queryByText("No tasks match the selected filters."),
    ).toBeNull();
  });

  it("shows the empty-filter message when a status has no rows", async () => {
    authFetch.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    renderTable({});

    await user.click(
      await screen.findByRole("button", { name: "In progress (0)" }),
    );
    expect(
      await screen.findByText("No tasks match the selected filters."),
    ).toBeDefined();
  });
});
