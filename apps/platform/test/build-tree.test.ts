import { describe, expect, it } from "@jest/globals";
import { performance } from "node:perf_hooks";
import { buildTree } from "../src/tree/build-tree";

const T1 = "00000000-0000-7000-8000-0000000000a1";
const T2 = "00000000-0000-7000-8000-0000000000a2";
const B1 = "00000000-0000-7000-8000-0000000000b1";
const B2 = "00000000-0000-7000-8000-0000000000b2";
const B3 = "00000000-0000-7000-8000-0000000000b3";
const F_ROOT = "00000000-0000-7000-8000-0000000000f1";
const F_CHILD = "00000000-0000-7000-8000-0000000000f2";
const F_ORPHAN = "00000000-0000-7000-8000-0000000000f3";

describe("buildTree", () => {
  it("nests folders two levels deep under the right binder and team", () => {
    const tree = buildTree(
      [
        { id: T2, name: "Team B" },
        { id: T1, name: "Team A" },
      ],
      [
        { id: B1, teamId: T1, name: "Binder 1" },
        { id: B2, teamId: T2, name: "Binder 2" },
      ],
      [
        { id: F_CHILD, binderId: B1, parentFolderId: F_ROOT, name: "Child" },
        { id: F_ROOT, binderId: B1, parentFolderId: null, name: "Root" },
      ],
    );
    expect(tree.teams.map((t) => t.id)).toEqual([T1, T2]);
    const binder1 = tree.teams[0].binders[0];
    expect(binder1.id).toBe(B1);
    expect(binder1.folders).toEqual([
      {
        id: F_ROOT,
        name: "Root",
        folders: [{ id: F_CHILD, name: "Child", folders: [] }],
      },
    ]);
    expect(tree.teams[1].binders[0].folders).toEqual([]);
  });

  it("drops orphan folders whose parent is missing", () => {
    const tree = buildTree(
      [{ id: T1, name: "Team A" }],
      [{ id: B1, teamId: T1, name: "Binder 1" }],
      [
        { id: F_ORPHAN, binderId: B1, parentFolderId: F_ROOT, name: "Orphan" },
        { id: F_CHILD, binderId: B1, parentFolderId: null, name: "Root" },
      ],
    );
    expect(tree.teams[0].binders[0].folders).toEqual([
      { id: F_CHILD, name: "Root", folders: [] },
    ]);
  });

  it("sorts teams, binders and sibling folders by name", () => {
    const tree = buildTree(
      [
        { id: T2, name: "Zeta" },
        { id: T1, name: "Alpha" },
      ],
      [
        { id: B2, teamId: T1, name: "b-binder" },
        { id: B1, teamId: T1, name: "a-binder" },
      ],
      [
        { id: F_CHILD, binderId: B1, parentFolderId: null, name: "b" },
        { id: F_ROOT, binderId: B1, parentFolderId: null, name: "a" },
      ],
    );
    expect(tree.teams.map((t) => t.name)).toEqual(["Alpha", "Zeta"]);
    expect(tree.teams[0].binders.map((b) => b.name)).toEqual([
      "a-binder",
      "b-binder",
    ]);
    expect(tree.teams[0].binders[0].folders.map((f) => f.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores binders of teams that were not passed in", () => {
    const tree = buildTree(
      [{ id: T1, name: "Team A" }],
      [
        { id: B1, teamId: T1, name: "Binder 1" },
        { id: B3, teamId: T2, name: "Binder 3" },
      ],
      [{ id: F_ROOT, binderId: B3, parentFolderId: null, name: "Root" }],
    );
    expect(tree.teams).toHaveLength(1);
    expect(tree.teams[0].binders.map((b) => b.id)).toEqual([B1]);
  });

  it("builds 50 teams x 10 binders x 20 folders in under 1s", () => {
    const teams = [];
    const binders = [];
    const folders = [];
    for (let t = 0; t < 50; t++) {
      const teamId = `team-${t}`;
      teams.push({ id: teamId, name: `team-${t}` });
      for (let b = 0; b < 10; b++) {
        const binderId = `${teamId}-binder-${b}`;
        binders.push({ id: binderId, teamId, name: `binder-${b}` });
        for (let f = 0; f < 20; f++) {
          const folderId = `${binderId}-folder-${f}`;
          folders.push({
            id: folderId,
            binderId,
            parentFolderId:
              f % 2 === 1 ? `${binderId}-folder-${f - 1}` : null,
            name: `folder-${f}`,
          });
        }
      }
    }
    const start = performance.now();
    const tree = buildTree(teams, binders, folders);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(tree.teams).toHaveLength(50);
    expect(tree.teams[0].binders[0].folders).toHaveLength(10);
  });
});
