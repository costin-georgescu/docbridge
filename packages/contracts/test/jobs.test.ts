import { describe, expect, it } from "@jest/globals";
import { checkJobLimits } from "../src";

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
