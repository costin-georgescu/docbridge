import { FolderRow } from "../tree/build-tree";

const MAX_DEPTH = 64;

export function folderPath(
  folderId: string,
  foldersById: Map<string, FolderRow>,
  binder: { name: string },
  team: { name: string },
): string {
  const chain: string[] = [];
  let current = foldersById.get(folderId);
  let depth = 0;
  while (current && depth < MAX_DEPTH) {
    chain.unshift(current.name);
    current = current.parentFolderId
      ? foldersById.get(current.parentFolderId)
      : undefined;
    depth++;
  }
  return [team.name, binder.name, ...chain].join(" / ");
}
