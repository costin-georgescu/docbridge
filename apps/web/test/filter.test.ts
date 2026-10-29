import { describe, expect, it } from "@jest/globals";
import { TreeResponse } from "@docbridge/contracts";
import { collectExpandableIds, filterTree } from "../src/features/tree/filter";

const tree: TreeResponse = {
  teams: [
    {
      id: "t1",
      name: "Alpha Team",
      binders: [
        {
          id: "b1",
          name: "Invoices",
          folders: [
            {
              id: "f1",
              name: "2024",
              folders: [
                { id: "f2", name: "Archive", folders: [] },
                { id: "f3", name: "Trash", folders: [] },
              ],
            },
            { id: "f4", name: "Inbox", folders: [] },
          ],
        },
        {
          id: "b2",
          name: "HR",
          folders: [{ id: "f5", name: "Contracts", folders: [] }],
        },
      ],
    },
    {
      id: "t2",
      name: "Beta Team",
      binders: [
        {
          id: "b3",
          name: "Legal",
          folders: [{ id: "f6", name: "Archive", folders: [] }],
        },
      ],
    },
  ],
};

describe("filterTree", () => {
  it("keeps the ancestor chain of a matching nested folder and drops siblings", () => {
    const result = filterTree(tree, "trash");
    expect(result.teams).toHaveLength(1);
    const team = result.teams[0];
    expect(team.id).toBe("t1");
    expect(team.binders).toHaveLength(1);
    expect(team.binders[0].id).toBe("b1");
    expect(team.binders[0].folders).toHaveLength(1);
    expect(team.binders[0].folders[0].id).toBe("f1");
    expect(team.binders[0].folders[0].folders).toEqual([
      { id: "f3", name: "Trash", folders: [] },
    ]);
  });

  it("keeps all folders of a binder whose name matches", () => {
    const result = filterTree(tree, "invoices");
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].binders).toEqual([tree.teams[0].binders[0]]);
  });

  it("is case-insensitive", () => {
    const result = filterTree(tree, "ARCHIVE");
    expect(result.teams.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(result.teams[0].binders[0].folders[0].folders).toEqual([
      { id: "f2", name: "Archive", folders: [] },
    ]);
    expect(result.teams[1].binders[0].folders).toEqual([
      { id: "f6", name: "Archive", folders: [] },
    ]);
  });

  it("returns the same reference for an empty or whitespace query", () => {
    expect(filterTree(tree, "")).toBe(tree);
    expect(filterTree(tree, "   ")).toBe(tree);
  });
});

describe("collectExpandableIds", () => {
  it("collects team, binder and non-leaf folder ids", () => {
    expect(collectExpandableIds(tree)).toEqual([
      "t1",
      "b1",
      "f1",
      "b2",
      "t2",
      "b3",
    ]);
  });
});
