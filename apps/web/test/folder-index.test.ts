import { describe, expect, it } from "@jest/globals";
import { TreeResponse } from "@docbridge/contracts";
import { buildFolderIndex } from "../src/features/jobs/folder-index";

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
              folders: [{ id: "f2", name: "Archive", folders: [] }],
            },
            { id: "f3", name: "Inbox", folders: [] },
          ],
        },
      ],
    },
    {
      id: "t2",
      name: "Beta Team",
      binders: [
        {
          id: "b2",
          name: "Legal",
          folders: [{ id: "f4", name: "Contracts", folders: [] }],
        },
      ],
    },
  ],
};

describe("buildFolderIndex", () => {
  it("indexes every folder with its full path", () => {
    const index = buildFolderIndex(tree);
    expect(index.size).toBe(4);
    expect(index.get("f1")).toEqual({
      id: "f1",
      name: "2024",
      path: "Alpha Team / Invoices / 2024",
    });
    expect(index.get("f2")?.path).toBe(
      "Alpha Team / Invoices / 2024 / Archive",
    );
    expect(index.get("f4")?.path).toBe("Beta Team / Legal / Contracts");
    expect(index.has("t1")).toBe(false);
    expect(index.has("b1")).toBe(false);
  });
});
