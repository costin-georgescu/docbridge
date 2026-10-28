import { describe, expect, it } from "@jest/globals";
import { folderPath } from "../src/folders/build-paths";
import { FolderRow } from "../src/tree/build-tree";

const BINDER = { name: "Binder" };
const TEAM = { name: "Team" };

function foldersById(rows: FolderRow[]): Map<string, FolderRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

describe("folderPath", () => {
  it("builds the path of a root folder", () => {
    const map = foldersById([
      { id: "f1", binderId: "b1", parentFolderId: null, name: "Folder" },
    ]);
    expect(folderPath("f1", map, BINDER, TEAM)).toBe("Team / Binder / Folder");
  });

  it("builds a nested path root-first", () => {
    const map = foldersById([
      { id: "f1", binderId: "b1", parentFolderId: null, name: "Parent" },
      { id: "f2", binderId: "b1", parentFolderId: "f1", name: "Child" },
    ]);
    expect(folderPath("f2", map, BINDER, TEAM)).toBe(
      "Team / Binder / Parent / Child",
    );
  });

  it("does not hang on a cycle", () => {
    const map = foldersById([
      { id: "f1", binderId: "b1", parentFolderId: "f2", name: "One" },
      { id: "f2", binderId: "b1", parentFolderId: "f1", name: "Two" },
    ]);
    const path = folderPath("f1", map, BINDER, TEAM);
    expect(path.startsWith("Team / Binder / ")).toBe(true);
  });
});
