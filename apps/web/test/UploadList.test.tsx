/**
 * @jest-environment jsdom
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileDropzone } from "../src/features/uploads/FileDropzone";
import { UploadList } from "../src/features/uploads/UploadList";
import { UploadItem } from "../src/features/uploads/upload-manager";

function item(overrides: Partial<UploadItem>): UploadItem {
  return {
    id: "i1",
    name: "a.pdf",
    sizeBytes: 2048,
    contentType: "application/pdf",
    phase: "queued",
    progress: 0,
    fileId: null,
    error: null,
    ...overrides,
  };
}

describe("UploadList", () => {
  it("shows a progress bar while uploading and fires callbacks", async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    const onRemove = jest.fn();
    render(
      <UploadList
        items={[
          item({ id: "u1", phase: "uploading", progress: 0.5 }),
          item({
            id: "e1",
            name: "bad.pdf",
            phase: "error",
            error: {
              code: "upload_failed",
              message: "The upload failed.",
              retryable: true,
            },
          }),
        ]}
        onRetry={onRetry}
        onRemove={onRemove}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByRole("alert").textContent).toContain("upload failed");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("e1");

    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    await user.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("u1");
  });
});

describe("FileDropzone", () => {
  it("calls onFiles when files are chosen via the input", () => {
    const onFiles = jest.fn();
    const { container } = render(<FileDropzone onFiles={onFiles} />);
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});
