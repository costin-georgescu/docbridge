import {
  checkJobLimits,
  CreateJobRequest,
  MAX_JOB_FILES,
  MAX_JOB_FOLDERS,
  MAX_JOB_TASKS,
} from "@docbridge/contracts";
import { UploadItem } from "../uploads/upload-manager";

export interface MappingState {
  folderIds: string[];
  assignments: Record<string, string[]>;
}

export const initialMappingState: MappingState = {
  folderIds: [],
  assignments: {},
};

export type MappingAction =
  | { type: "toggleFolder"; folderId: string }
  | { type: "toggleCell"; itemId: string; folderId: string }
  | {
      type: "setColumn";
      folderId: string;
      itemIds: string[];
      assigned: boolean;
    }
  | { type: "reset" };

function ordered(folderIds: string[], assigned: Iterable<string>): string[] {
  const set = new Set(assigned);
  return folderIds.filter((id) => set.has(id));
}

export function mappingReducer(
  state: MappingState,
  action: MappingAction,
): MappingState {
  switch (action.type) {
    case "toggleFolder": {
      if (state.folderIds.includes(action.folderId)) {
        const assignments: Record<string, string[]> = {};
        for (const [itemId, folderIds] of Object.entries(state.assignments)) {
          const next = folderIds.filter((id) => id !== action.folderId);
          if (next.length > 0) {
            assignments[itemId] = next;
          }
        }
        return {
          folderIds: state.folderIds.filter((id) => id !== action.folderId),
          assignments,
        };
      }
      if (state.folderIds.length >= MAX_JOB_FOLDERS) {
        return state;
      }
      return { ...state, folderIds: [...state.folderIds, action.folderId] };
    }
    case "toggleCell": {
      if (!state.folderIds.includes(action.folderId)) {
        return state;
      }
      const current = state.assignments[action.itemId] ?? [];
      const has = current.includes(action.folderId);
      const next = ordered(
        state.folderIds,
        has
          ? current.filter((id) => id !== action.folderId)
          : [...current, action.folderId],
      );
      const assignments = { ...state.assignments };
      if (next.length > 0) {
        assignments[action.itemId] = next;
      } else {
        delete assignments[action.itemId];
      }
      return { ...state, assignments };
    }
    case "setColumn": {
      if (!state.folderIds.includes(action.folderId)) {
        return state;
      }
      const assignments = { ...state.assignments };
      for (const itemId of action.itemIds) {
        const current = assignments[itemId] ?? [];
        const has = current.includes(action.folderId);
        if (action.assigned === has) {
          continue;
        }
        const next = ordered(
          state.folderIds,
          action.assigned
            ? [...current, action.folderId]
            : current.filter((id) => id !== action.folderId),
        );
        if (next.length > 0) {
          assignments[itemId] = next;
        } else {
          delete assignments[itemId];
        }
      }
      return { ...state, assignments };
    }
    case "reset":
      return initialMappingState;
  }
}

export interface MappingSummary {
  rows: { item: UploadItem; folderIds: string[] }[];
  counts: { files: number; folders: number; tasks: number };
  blockers: string[];
  request: CreateJobRequest | null;
}

export function summarize(
  state: MappingState,
  items: UploadItem[],
): MappingSummary {
  const rows = items.map((item) => ({
    item,
    folderIds: ordered(
      state.folderIds,
      (state.assignments[item.id] ?? []).filter((id) =>
        state.folderIds.includes(id),
      ),
    ),
  }));
  const counts = {
    files: items.length,
    folders: state.folderIds.length,
    tasks: rows.reduce((sum, row) => sum + row.folderIds.length, 0),
  };
  const blockers: string[] = [];
  if (items.length === 0) {
    blockers.push("Add files to submit.");
  }
  const failed = items.filter((item) => item.phase === "error").length;
  if (failed > 0) {
    blockers.push(`Remove or retry ${failed} failed file(s).`);
  }
  const pending = items.filter(
    (item) => item.phase !== "error" && item.phase !== "staged",
  ).length;
  if (pending > 0) {
    blockers.push(`Waiting for ${pending} file(s) to finish uploading.`);
  }
  const withoutFolder = rows.filter((row) => row.folderIds.length === 0).length;
  if (withoutFolder > 0) {
    blockers.push(`${withoutFolder} file(s) have no destination.`);
  }
  const limits = checkJobLimits(
    rows.map((row) => ({
      fileId: row.item.id,
      folderIds: row.folderIds,
    })),
  );
  for (const violation of limits.violations) {
    if (violation === "too_many_files") {
      blockers.push(
        `A job can include at most ${MAX_JOB_FILES.toLocaleString("en-US")} files.`,
      );
    } else if (violation === "too_many_folders") {
      blockers.push(
        `A job can use at most ${MAX_JOB_FOLDERS.toLocaleString("en-US")} folders.`,
      );
    } else if (violation === "too_many_tasks") {
      blockers.push(
        `A job can create at most ${MAX_JOB_TASKS.toLocaleString("en-US")} deliveries.`,
      );
    }
  }
  const request =
    blockers.length === 0
      ? {
          mappings: rows.map((row) => ({
            fileId: row.item.fileId!,
            folderIds: row.folderIds,
          })),
        }
      : null;
  return { rows, counts, blockers, request };
}
