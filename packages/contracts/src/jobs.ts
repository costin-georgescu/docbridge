import { z } from "zod";

export const MAX_JOB_FILES = 100;
export const MAX_JOB_FOLDERS = 20;
export const MAX_JOB_TASKS = 2000;

export const CreateJobRequest = z.object({
  mappings: z
    .array(
      z.object({
        fileId: z.uuid(),
        folderIds: z.array(z.uuid()),
      }),
    )
    .min(1),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const CreateJobResponse = z.object({
  jobId: z.uuid(),
});

export type CreateJobResponse = z.infer<typeof CreateJobResponse>;

export type JobLimitViolation =
  | "too_many_files"
  | "too_many_folders"
  | "too_many_tasks"
  | "file_without_folder";

export function checkJobLimits(
  mappings: { fileId: string; folderIds: string[] }[],
): {
  files: number;
  folders: number;
  tasks: number;
  violations: JobLimitViolation[];
} {
  const fileIds = new Set<string>();
  const folderIds = new Set<string>();
  let tasks = 0;
  let hasEmptyMapping = false;
  for (const mapping of mappings) {
    fileIds.add(mapping.fileId);
    const fileFolders = new Set(mapping.folderIds);
    if (fileFolders.size === 0) {
      hasEmptyMapping = true;
    }
    tasks += fileFolders.size;
    for (const folderId of fileFolders) {
      folderIds.add(folderId);
    }
  }
  const violations: JobLimitViolation[] = [];
  if (fileIds.size > MAX_JOB_FILES) {
    violations.push("too_many_files");
  }
  if (folderIds.size > MAX_JOB_FOLDERS) {
    violations.push("too_many_folders");
  }
  if (tasks > MAX_JOB_TASKS) {
    violations.push("too_many_tasks");
  }
  if (hasEmptyMapping) {
    violations.push("file_without_folder");
  }
  return {
    files: fileIds.size,
    folders: folderIds.size,
    tasks,
    violations,
  };
}
