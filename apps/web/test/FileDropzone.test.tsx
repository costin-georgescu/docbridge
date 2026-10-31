/**
 * @jest-environment jsdom
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react";
import { FileDropzone } from "../src/features/uploads/FileDropzone";

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
