import { z } from "zod";

export const TreeFolder: z.ZodType<TreeFolder> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    name: z.string(),
    folders: z.array(TreeFolder),
  }),
);

export type TreeFolder = {
  id: string;
  name: string;
  folders: TreeFolder[];
};

export const TreeBinder = z.object({
  id: z.uuid(),
  name: z.string(),
  folders: z.array(TreeFolder),
});

export type TreeBinder = z.infer<typeof TreeBinder>;

export const TreeTeam = z.object({
  id: z.uuid(),
  name: z.string(),
  binders: z.array(TreeBinder),
});

export type TreeTeam = z.infer<typeof TreeTeam>;

export const TreeResponse = z.object({
  teams: z.array(TreeTeam),
});

export type TreeResponse = z.infer<typeof TreeResponse>;

export const TreeQuery = z.object({
  all: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export type TreeQuery = z.infer<typeof TreeQuery>;

export const ResolveFoldersRequest = z.object({
  folderIds: z.array(z.uuid()).min(1).max(2000),
});

export type ResolveFoldersRequest = z.infer<typeof ResolveFoldersRequest>;

export const ResolveFoldersResponse = z.object({
  resolved: z.array(
    z.object({
      folderId: z.uuid(),
      teamId: z.uuid(),
      path: z.string(),
    }),
  ),
  missing: z.array(z.uuid()),
});

export type ResolveFoldersResponse = z.infer<typeof ResolveFoldersResponse>;

export const CreateTeamRequest = z.object({
  name: z.string().min(1).max(200),
});

export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;

export const CreateBinderRequest = z.object({
  teamId: z.uuid(),
  name: z.string().min(1).max(200),
});

export type CreateBinderRequest = z.infer<typeof CreateBinderRequest>;

export const CreateFolderRequest = z.object({
  binderId: z.uuid(),
  parentFolderId: z.uuid().nullable().default(null),
  name: z.string().min(1).max(200),
});

export type CreateFolderRequest = z.infer<typeof CreateFolderRequest>;

export const TeamResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
});

export type TeamResponse = z.infer<typeof TeamResponse>;

export const BinderResponse = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  name: z.string(),
});

export type BinderResponse = z.infer<typeof BinderResponse>;

export const FolderResponse = z.object({
  id: z.uuid(),
  binderId: z.uuid(),
  parentFolderId: z.uuid().nullable(),
  name: z.string(),
});

export type FolderResponse = z.infer<typeof FolderResponse>;
