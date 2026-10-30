/**
 * @jest-environment jsdom
 */
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { JobStatusBadge } from "../src/features/jobs/JobStatusBadge";

describe("JobStatusBadge", () => {
  it("renders all five derived states", () => {
    render(
      <div>
        <JobStatusBadge status="pending" />
        <JobStatusBadge status="in_progress" />
        <JobStatusBadge status="completed" />
        <JobStatusBadge status="completed_with_failures" />
        <JobStatusBadge status="failed" />
      </div>,
    );
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getByText("In progress")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("Completed with failures")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
  });
});
