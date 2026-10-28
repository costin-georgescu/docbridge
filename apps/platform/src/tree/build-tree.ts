import { TreeFolder, TreeResponse } from "@docbridge/contracts";

export interface TeamRow {
  id: string;
  name: string;
}

export interface BinderRow {
  id: string;
  teamId: string;
  name: string;
}

export interface FolderRow {
  id: string;
  binderId: string;
  parentFolderId: string | null;
  name: string;
}

export function buildTree(
  teams: TeamRow[],
  binders: BinderRow[],
  folders: FolderRow[],
): TreeResponse {
  const foldersByParent = new Map<string, FolderRow[]>();
  for (const folder of folders) {
    const key = `${folder.binderId}:${folder.parentFolderId ?? ""}`;
    const list = foldersByParent.get(key);
    if (list) {
      list.push(folder);
    } else {
      foldersByParent.set(key, [folder]);
    }
  }
  const bindersByTeam = new Map<string, BinderRow[]>();
  for (const binder of binders) {
    const list = bindersByTeam.get(binder.teamId);
    if (list) {
      list.push(binder);
    } else {
      bindersByTeam.set(binder.teamId, [binder]);
    }
  }
  const buildFolders = (binderId: string, parentFolderId: string | null): TreeFolder[] =>
    (foldersByParent.get(`${binderId}:${parentFolderId ?? ""}`) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        folders: buildFolders(binderId, folder.id),
      }));
  return {
    teams: teams
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((team) => ({
        id: team.id,
        name: team.name,
        binders: (bindersByTeam.get(team.id) ?? [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((binder) => ({
            id: binder.id,
            name: binder.name,
            folders: buildFolders(binder.id, null),
          })),
      })),
  };
}
