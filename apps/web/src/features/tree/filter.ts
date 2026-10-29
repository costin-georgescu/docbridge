import {
  TreeBinder,
  TreeFolder,
  TreeResponse,
  TreeTeam,
} from "@docbridge/contracts";

export function filterTree(tree: TreeResponse, query: string): TreeResponse {
  const q = query.trim().toLowerCase();
  if (!q) {
    return tree;
  }
  const matches = (name: string) => name.toLowerCase().includes(q);
  const filterFolders = (folders: TreeFolder[]): TreeFolder[] =>
    folders
      .map((folder) =>
        matches(folder.name)
          ? folder
          : { ...folder, folders: filterFolders(folder.folders) },
      )
      .filter((folder) => matches(folder.name) || folder.folders.length > 0);
  const filterBinders = (binders: TreeBinder[]): TreeBinder[] =>
    binders
      .map((binder) =>
        matches(binder.name)
          ? binder
          : { ...binder, folders: filterFolders(binder.folders) },
      )
      .filter((binder) => matches(binder.name) || binder.folders.length > 0);
  const filterTeams = (teams: TreeTeam[]): TreeTeam[] =>
    teams
      .map((team) =>
        matches(team.name)
          ? team
          : { ...team, binders: filterBinders(team.binders) },
      )
      .filter((team) => matches(team.name) || team.binders.length > 0);
  return { teams: filterTeams(tree.teams) };
}

export function collectExpandableIds(tree: TreeResponse): string[] {
  const ids: string[] = [];
  const walkFolders = (folders: TreeFolder[]) => {
    for (const folder of folders) {
      if (folder.folders.length > 0) {
        ids.push(folder.id);
        walkFolders(folder.folders);
      }
    }
  };
  for (const team of tree.teams) {
    ids.push(team.id);
    for (const binder of team.binders) {
      ids.push(binder.id);
      walkFolders(binder.folders);
    }
  }
  return ids;
}
