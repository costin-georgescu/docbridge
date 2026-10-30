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

export const JobStatus = z.enum([
  "pending",
  "in_progress",
  "completed",
  "completed_with_failures",
  "failed",
]);

export type JobStatus = z.infer<typeof JobStatus>;

export const TaskStatus = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskCounts = z.object({
  pending: z.number().int(),
  inProgress: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
});

export type TaskCounts = z.infer<typeof TaskCounts>;

// Status derivation per TDD 3.4. `pendingAttempts` is the summed
// attempt_count of pending tasks: a pending task with attempts is
// "retrying", which counts as in progress, not pending.
export function deriveJobStatus(
  counts: TaskCounts & { pendingAttempts: number },
): JobStatus {
  const total =
    counts.pending + counts.inProgress + counts.completed + counts.failed;
  if (total === 0) return "pending";
  if (counts.completed === total) return "completed";
  if (counts.failed === total) return "failed";
  if (counts.pending + counts.inProgress === 0) {
    return "completed_with_failures";
  }
  if (counts.pending === total && counts.pendingAttempts === 0) {
    return "pending";
  }
  return "in_progress";
}

export type JobListCursor = { submittedAt: Date; id: string };

// Composite keyset cursor over (submitted_at desc, id desc).
const JobCursorParts = z.tuple([z.iso.datetime(), z.uuid()]);

export function encodeJobCursor(cursor: JobListCursor): string {
  return `${cursor.submittedAt.toISOString()}~${cursor.id}`;
}

export const JobListQuery = z.object({
  cursor: z
    .string()
    .transform((s, ctx) => {
      const sep = s.indexOf("~");
      if (sep < 0) {
        ctx.addIssue({ code: "custom", message: "invalid cursor" });
        return z.NEVER;
      }
      const parsed = JobCursorParts.safeParse([
        s.slice(0, sep),
        s.slice(sep + 1),
      ]);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "invalid cursor" });
        return z.NEVER;
      }
      return { submittedAt: new Date(parsed.data[0]), id: parsed.data[1] };
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export type JobListQuery = z.infer<typeof JobListQuery>;

export const JobSummary = z.object({
  id: z.uuid(),
  submittedAt: z.iso.datetime(),
  submitterDisplayName: z.string(),
  filesCount: z.number().int(),
  tasksCount: z.number().int(),
  counts: TaskCounts,
  status: JobStatus,
  completedAt: z.iso.datetime().nullable(),
});

export type JobSummary = z.infer<typeof JobSummary>;

export const JobListResponse = z.object({
  items: z.array(JobSummary),
  nextCursor: z.string().nullable(),
});

export type JobListResponse = z.infer<typeof JobListResponse>;

export const JobFileResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  sizeBytes: z.number(),
});

export type JobFileResponse = z.infer<typeof JobFileResponse>;

export const JobTaskResponse = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  destination: z.object({
    folderId: z.uuid(),
    path: z.string(),
  }),
  status: TaskStatus,
  attemptCount: z.number().int(),
  lastError: z
    .object({ code: z.string(), message: z.string().nullable() })
    .nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export type JobTaskResponse = z.infer<typeof JobTaskResponse>;

export const JobDetailResponse = JobSummary.extend({
  files: z.array(JobFileResponse),
  tasks: z.array(JobTaskResponse),
});

export type JobDetailResponse = z.infer<typeof JobDetailResponse>;

export const JobFileDownloadResponse = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
});

export type JobFileDownloadResponse = z.infer<typeof JobFileDownloadResponse>;

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
