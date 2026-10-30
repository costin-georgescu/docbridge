import { TreeFolder, TreeResponse } from "@docbridge/contracts";

export interface FolderIndexEntry {
  id: string;
  name: string;
  path: string;
}

export function buildFolderIndex(
  tree: TreeResponse,
): Map<string, FolderIndexEntry> {
  const index = new Map<string, FolderIndexEntry>();
  const walk = (folders: TreeFolder[], ancestors: string[]) => {
    for (const folder of folders) {
      const path = [...ancestors, folder.name].join(" / ");
      index.set(folder.id, { id: folder.id, name: folder.name, path });
      walk(folder.folders, [...ancestors, folder.name]);
    }
  };
  for (const team of tree.teams) {
    for (const binder of team.binders) {
      walk(binder.folders, [team.name, binder.name]);
    }
  }
  return index;
}
