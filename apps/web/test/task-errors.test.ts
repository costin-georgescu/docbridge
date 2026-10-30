import { describe, expect, it } from "@jest/globals";
import { describeTaskError } from "../src/features/jobs/task-errors";

describe("describeTaskError", () => {
  it("maps known codes to descriptive text with the message as detail", () => {
    expect(
      describeTaskError({
        code: "file_signature_mismatch",
        message: "object does not match the application/pdf signature",
      }),
    ).toEqual({
      title: "The file contents do not match the declared file type",
      detail: "object does not match the application/pdf signature",
    });
  });

  it("falls back to the raw message and code for unknown codes", () => {
    expect(
      describeTaskError({ code: "surprise_error", message: "went wrong" }),
    ).toEqual({ title: "went wrong", detail: "surprise_error" });
    expect(describeTaskError({ code: "surprise_error", message: null })).toEqual(
      { title: "Delivery failed", detail: "surprise_error" },
    );
  });
});
