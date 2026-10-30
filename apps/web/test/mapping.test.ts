import { describe, expect, it } from "@jest/globals";
import {
  initialMappingState,
  mappingReducer,
  summarize,
} from "../src/features/jobs/mapping";
import { UploadItem } from "../src/features/uploads/upload-manager";

const FILE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const F1 = "f1111111-1111-4111-8111-111111111111";
const F2 = "f2222222-2222-4222-8222-222222222222";
const folderId = (n: number) =>
  `f${String(n).padStart(4, "0")}-0000-4000-8000-000000000000`;

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    id: "i1",
    name: "a.pdf",
    sizeBytes: 10,
    contentType: "application/pdf",
    phase: "staged",
    progress: 1,
    fileId: FILE_A,
    error: null,
    ...overrides,
  };
}

describe("mappingReducer", () => {
  it("appends folders in selection order", () => {
    let s = mappingReducer(initialMappingState, {
      type: "toggleFolder",
      folderId: F2,
    });
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    expect(s.folderIds).toEqual([F2, F1]);
  });

  it("ignores a 21st folder", () => {
    let s = initialMappingState;
    for (let i = 0; i < 21; i++) {
      s = mappingReducer(s, { type: "toggleFolder", folderId: folderId(i) });
    }
    expect(s.folderIds).toHaveLength(20);
    expect(s.folderIds).not.toContain(folderId(20));
  });

  it("removing a folder strips it from every assignment", () => {
    let s = initialMappingState;
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    s = mappingReducer(s, { type: "toggleFolder", folderId: F2 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i1", folderId: F1 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i1", folderId: F2 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i2", folderId: F1 });
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    expect(s.folderIds).toEqual([F2]);
    expect(s.assignments).toEqual({ i1: [F2] });
  });

  it("toggleCell on an unchosen folder is a no-op", () => {
    const s = mappingReducer(initialMappingState, {
      type: "toggleCell",
      itemId: "i1",
      folderId: F1,
    });
    expect(s).toBe(initialMappingState);
  });

  it("toggleCell keeps assignment order in chosen-folder order", () => {
    let s = initialMappingState;
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    s = mappingReducer(s, { type: "toggleFolder", folderId: F2 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i1", folderId: F2 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i1", folderId: F1 });
    expect(s.assignments.i1).toEqual([F1, F2]);
  });

  it("setColumn assigns and unassigns", () => {
    let s = initialMappingState;
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    s = mappingReducer(s, {
      type: "setColumn",
      folderId: F1,
      itemIds: ["i1", "i2"],
      assigned: true,
    });
    expect(s.assignments).toEqual({ i1: [F1], i2: [F1] });
    s = mappingReducer(s, {
      type: "setColumn",
      folderId: F1,
      itemIds: ["i1", "i2"],
      assigned: false,
    });
    expect(s.assignments).toEqual({});
  });
});

describe("summarize", () => {
  const staged = item();

  it("blocker: no items", () => {
    const s = summarize(initialMappingState, []);
    expect(s.blockers).toEqual(["Add files to submit."]);
    expect(s.request).toBeNull();
  });

  it("blocker: failed item", () => {
    const s = summarize(initialMappingState, [
      item({
        id: "e1",
        phase: "error",
        error: { code: "x", message: "m", retryable: true },
      }),
      staged,
    ]);
    expect(s.blockers).toContain("Remove or retry 1 failed file(s).");
    expect(s.request).toBeNull();
  });

  it("blocker: uploading item", () => {
    const s = summarize(initialMappingState, [
      item({ id: "u1", phase: "uploading" }),
      staged,
    ]);
    expect(s.blockers).toContain("Waiting for 1 file(s) to finish uploading.");
    expect(s.request).toBeNull();
  });

  it("blocker: file without destination", () => {
    const s = summarize(initialMappingState, [staged]);
    expect(s.blockers).toEqual(["1 file(s) have no destination."]);
    expect(s.request).toBeNull();
  });

  it("blockers: too many files and tasks", () => {
    let s = initialMappingState;
    const folders = Array.from({ length: 20 }, (_, i) => folderId(i));
    for (const f of folders) {
      s = mappingReducer(s, { type: "toggleFolder", folderId: f });
    }
    const items = Array.from({ length: 101 }, (_, i) =>
      item({ id: `i${i}`, fileId: `file-${i}` }),
    );
    s = mappingReducer(s, {
      type: "setColumn",
      folderId: folders[0],
      itemIds: items.map((it) => it.id),
      assigned: true,
    });
    for (const f of folders.slice(1)) {
      s = mappingReducer(s, {
        type: "setColumn",
        folderId: f,
        itemIds: items.map((it) => it.id),
        assigned: true,
      });
    }
    const sum = summarize(s, items);
    expect(sum.blockers).toContain("A job can include at most 100 files.");
    expect(sum.blockers).toContain(
      "A job can create at most 2,000 deliveries.",
    );
    expect(sum.request).toBeNull();
  });

  it("ignores assignments for items no longer present", () => {
    let s = initialMappingState;
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "gone", folderId: F1 });
    const sum = summarize(s, [staged]);
    expect(sum.counts.tasks).toBe(0);
    expect(sum.blockers).toContain("1 file(s) have no destination.");
  });

  it("builds the request in chosen-folder order when valid", () => {
    let s = initialMappingState;
    s = mappingReducer(s, { type: "toggleFolder", folderId: F2 });
    s = mappingReducer(s, { type: "toggleFolder", folderId: F1 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i1", folderId: F1 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i1", folderId: F2 });
    s = mappingReducer(s, { type: "toggleCell", itemId: "i2", folderId: F1 });
    const items = [staged, item({ id: "i2", name: "b.pdf", fileId: FILE_B })];
    const sum = summarize(s, items);
    expect(sum.blockers).toEqual([]);
    expect(sum.request).toEqual({
      mappings: [
        { fileId: FILE_A, folderIds: [F2, F1] },
        { fileId: FILE_B, folderIds: [F1] },
      ],
    });
  });
});
