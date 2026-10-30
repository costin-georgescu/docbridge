/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobFileResponse } from "@docbridge/contracts";
import { ApiError } from "../src/lib/api";

jest.mock("../src/auth/session", () => ({
  session: { authFetch: jest.fn() },
}));

jest.mock("../src/lib/download", () => ({
  openPresignedUrl: jest.fn(),
}));

import { session } from "../src/auth/session";
import { openPresignedUrl } from "../src/lib/download";
import { JobFileList } from "../src/features/jobs/JobFileList";

const authFetch = jest.mocked(session.authFetch);
const openUrl = jest.mocked(openPresignedUrl);

const JOB_ID = "33333333-0000-4000-8000-000000000003";
const FILE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

const files: JobFileResponse[] = [
  { id: FILE_A, name: "a.pdf", sizeBytes: 2048 },
  { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", name: "b.pdf", sizeBytes: 512 },
];

describe("JobFileList", () => {
  beforeEach(() => {
    authFetch.mockClear();
    openUrl.mockClear();
  });

  it("lists the job's files with sizes and a download action each", () => {
    render(<JobFileList jobId={JOB_ID} files={files} />);

    expect(screen.getByText("a.pdf")).toBeDefined();
    expect(screen.getByText("b.pdf")).toBeDefined();
    expect(screen.getByText("2.0 KiB")).toBeDefined();
    expect(screen.getByText("512 B")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(2);
  });

  it("requests a presigned URL and opens it", async () => {
    authFetch.mockResolvedValue({
      url: "https://staging.local/a.pdf?sig=1",
      expiresAt: "2026-10-30T12:00:00.000Z",
    });
    const user = userEvent.setup();
    render(<JobFileList jobId={JOB_ID} files={files} />);

    await user.click(screen.getAllByRole("button", { name: "Download" })[0]);

    expect(authFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/files/${FILE_A}/download`,
    );
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://staging.local/a.pdf?sig=1",
      ),
    );
  });

  it("explains when the file has expired", async () => {
    authFetch.mockRejectedValue(
      new ApiError(410, "file_expired", "File is no longer available"),
    );
    const user = userEvent.setup();
    render(<JobFileList jobId={JOB_ID} files={files} />);

    await user.click(screen.getAllByRole("button", { name: "Download" })[0]);

    expect(
      await screen.findByText(
        "This file is no longer available for download.",
      ),
    ).toBeDefined();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps a failed download's error while another file downloads", async () => {
    authFetch
      .mockRejectedValueOnce(
        new ApiError(410, "file_expired", "File is no longer available"),
      )
      .mockResolvedValueOnce({
        url: "https://staging.local/b.pdf?sig=2",
        expiresAt: "2026-10-30T12:00:00.000Z",
      });
    const user = userEvent.setup();
    render(<JobFileList jobId={JOB_ID} files={files} />);

    const buttons = screen.getAllByRole("button", { name: "Download" });
    await user.click(buttons[0]);
    await user.click(buttons[1]);

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://staging.local/b.pdf?sig=2",
      ),
    );
    expect(
      screen.getByText("This file is no longer available for download."),
    ).toBeDefined();
  });

  it("surfaces the API error message for other failures", async () => {
    authFetch.mockRejectedValue(
      new ApiError(403, "job_not_visible", "Job not found or not visible"),
    );
    const user = userEvent.setup();
    render(<JobFileList jobId={JOB_ID} files={files} />);

    await user.click(screen.getAllByRole("button", { name: "Download" })[0]);

    expect(
      await screen.findByText("Job not found or not visible"),
    ).toBeDefined();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
