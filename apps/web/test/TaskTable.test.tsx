/**
 * @jest-environment jsdom
 */
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobFileResponse, JobTaskResponse } from "@docbridge/contracts";
import { TaskTable } from "../src/features/jobs/TaskTable";

const FILE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const files: JobFileResponse[] = [
  { id: FILE_A, name: "a.pdf", sizeBytes: 2048 },
  { id: FILE_B, name: "b.pdf", sizeBytes: 512 },
];

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

describe("TaskTable", () => {
  it("groups tasks under their file with status filter counts", () => {
    render(<TaskTable files={files} tasks={tasks} />);

    expect(screen.getByText("a.pdf")).toBeDefined();
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
  });

  it("renders retrying with the attempt number for pending tasks with attempts", () => {
    render(<TaskTable files={files} tasks={tasks} />);
    expect(screen.getByText("Retrying (attempt 2)")).toBeDefined();
  });

  it("shows descriptive error text from lastError", () => {
    render(<TaskTable files={files} tasks={tasks} />);
    expect(
      screen.getByText("The destination folder was not found on the platform"),
    ).toBeDefined();
    expect(screen.getByText("folder was deleted")).toBeDefined();
    expect(
      screen.getByText("The document platform is temporarily unavailable"),
    ).toBeDefined();
  });

  it("filters tasks by status", async () => {
    const user = userEvent.setup();
    render(<TaskTable files={files} tasks={tasks} />);

    await user.click(
      screen.getByRole("button", { name: "Completed (1)" }),
    );
    expect(
      screen.queryByRole("cell", { name: "Alpha / Invoices / 2024" }),
    ).toBeNull();
    expect(
      screen.getByRole("cell", { name: "Beta / Legal / Contracts" }),
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Pending (1)" }));
    await user.click(screen.getByRole("button", { name: "Failed (1)" }));
    await user.click(screen.getByRole("button", { name: "In progress (0)" }));
    expect(
      screen.getByText("No tasks match the selected filters."),
    ).toBeDefined();
  });

  it("shows a distinct message when the job has no tasks", () => {
    render(<TaskTable files={[]} tasks={[]} />);
    expect(screen.getByText("This job has no tasks.")).toBeDefined();
    expect(
      screen.queryByText("No tasks match the selected filters."),
    ).toBeNull();
  });
});
