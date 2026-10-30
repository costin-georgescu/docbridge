import { describe, expect, it } from "@jest/globals";
import {
  checkJobLimits,
  deriveJobStatus,
  encodeJobCursor,
  JobListQuery,
} from "../src";

const fid = (n: number) => `file-${String(n).padStart(4, "0")}`;
const gid = (n: number) => `folder-${String(n).padStart(4, "0")}`;

describe("checkJobLimits", () => {
  it("reports no violations within limits", () => {
    const result = checkJobLimits([
      { fileId: fid(1), folderIds: [gid(1), gid(2)] },
      { fileId: fid(2), folderIds: [gid(2)] },
    ]);
    expect(result).toEqual({
      files: 2,
      folders: 2,
      tasks: 3,
      violations: [],
    });
  });

  it("flags too_many_files for 101 files", () => {
    const mappings = Array.from({ length: 101 }, (_, i) => ({
      fileId: fid(i),
      folderIds: [gid(1)],
    }));
    const result = checkJobLimits(mappings);
    expect(result.files).toBe(101);
    expect(result.violations).toEqual(["too_many_files"]);
  });

  it("flags too_many_folders for 21 distinct folders", () => {
    const result = checkJobLimits([
      {
        fileId: fid(1),
        folderIds: Array.from({ length: 21 }, (_, i) => gid(i)),
      },
    ]);
    expect(result.folders).toBe(21);
    expect(result.violations).toEqual(["too_many_folders"]);
  });

  it("flags too_many_files and too_many_tasks for 101 files x 20 folders", () => {
    const folders = Array.from({ length: 20 }, (_, i) => gid(i));
    const mappings = Array.from({ length: 101 }, (_, i) => ({
      fileId: fid(i),
      folderIds: folders,
    }));
    const result = checkJobLimits(mappings);
    expect(result.tasks).toBe(2020);
    expect(result.violations).toEqual(["too_many_files", "too_many_tasks"]);
  });

  it("flags file_without_folder for an empty mapping", () => {
    const result = checkJobLimits([
      { fileId: fid(1), folderIds: [] },
      { fileId: fid(2), folderIds: [gid(1)] },
    ]);
    expect(result.violations).toEqual(["file_without_folder"]);
  });

  it("counts duplicate folderIds within one file once", () => {
    const result = checkJobLimits([
      { fileId: fid(1), folderIds: [gid(1), gid(1), gid(2)] },
    ]);
    expect(result).toEqual({ files: 1, folders: 2, tasks: 2, violations: [] });
  });
});

describe("deriveJobStatus", () => {
  const counts = (
    partial: Partial<{
      pending: number;
      inProgress: number;
      completed: number;
      failed: number;
      pendingAttempts: number;
    }>,
  ) => ({
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    pendingAttempts: 0,
    ...partial,
  });

  it("is pending for a job with no tasks", () => {
    expect(deriveJobStatus(counts({}))).toBe("pending");
  });

  it("is pending when all tasks are pending with zero attempts", () => {
    expect(deriveJobStatus(counts({ pending: 5 }))).toBe("pending");
  });

  it("is in_progress when pending tasks have retry attempts", () => {
    expect(
      deriveJobStatus(counts({ pending: 5, pendingAttempts: 2 })),
    ).toBe("in_progress");
  });

  it("is in_progress when a task is running or mixed with completed", () => {
    expect(
      deriveJobStatus(counts({ pending: 3, inProgress: 1 })),
    ).toBe("in_progress");
    expect(
      deriveJobStatus(counts({ pending: 2, completed: 1 })),
    ).toBe("in_progress");
  });

  it("is completed only when every task completed", () => {
    expect(deriveJobStatus(counts({ completed: 4 }))).toBe("completed");
  });

  it("is failed only when every task failed", () => {
    expect(deriveJobStatus(counts({ failed: 4 }))).toBe("failed");
  });

  it("is completed_with_failures for a final mix of completed and failed", () => {
    expect(
      deriveJobStatus(counts({ completed: 3, failed: 1 })),
    ).toBe("completed_with_failures");
  });

  it("is in_progress while a non-final task remains among failures", () => {
    expect(
      deriveJobStatus(counts({ pending: 1, failed: 3, pendingAttempts: 1 })),
    ).toBe("in_progress");
  });
});

describe("JobListQuery", () => {
  const cursor = {
    submittedAt: new Date("2026-10-30T12:34:56.789Z"),
    id: "11111111-2222-4333-8444-555555555555",
  };

  it("round-trips an encoded cursor", () => {
    const parsed = JobListQuery.parse({
      cursor: encodeJobCursor(cursor),
    });
    expect(parsed.cursor).toEqual(cursor);
    expect(parsed.limit).toBe(50);
  });

  it("accepts a missing cursor and a limit", () => {
    const parsed = JobListQuery.parse({ limit: "10" });
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.limit).toBe(10);
  });

  it("rejects a malformed cursor and a limit over 50", () => {
    expect(JobListQuery.safeParse({ cursor: "not-a-cursor" }).success).toBe(
      false,
    );
    expect(JobListQuery.safeParse({ limit: "51" }).success).toBe(false);
  });
});
