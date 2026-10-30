import { useMemo, useReducer, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CreateJobRequest,
  CreateJobResponse,
  MAX_JOB_FILES,
  MAX_JOB_FOLDERS,
  MAX_JOB_TASKS,
  TreeResponse,
} from "@docbridge/contracts";
import { ApiError } from "../../lib/api";
import { Button } from "../../components/Button";
import { TreeView } from "../tree/TreeView";
import { UploadItem } from "../uploads/upload-manager";
import { buildFolderIndex } from "./folder-index";
import { initialMappingState, mappingReducer, summarize } from "./mapping";
import { MappingMatrix } from "./MappingMatrix";

export function JobComposer({
  items,
  tree,
  submit,
  onSubmitted,
}: {
  items: UploadItem[];
  tree: TreeResponse;
  submit: (req: CreateJobRequest) => Promise<CreateJobResponse>;
  onSubmitted: (itemIds: string[], jobId: string) => void;
}) {
  const [state, dispatch] = useReducer(mappingReducer, initialMappingState);
  const [error, setError] = useState<ApiError | null>(null);
  const [genericError, setGenericError] = useState(false);
  const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const folderIndex = useMemo(() => buildFolderIndex(tree), [tree]);
  const summary = summarize(state, items);
  const folders = state.folderIds
    .map((id) => folderIndex.get(id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);

  const mutation = useMutation({
    mutationFn: (request: CreateJobRequest) => submit(request),
    onSuccess: (response, request) => {
      setError(null);
      setGenericError(false);
      setSubmittedJobId(response.jobId);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      dispatch({ type: "reset" });
      onSubmitted(
        request.mappings.map((m) => {
          const row = summary.rows.find((r) => r.item.fileId === m.fileId);
          return row?.item.id ?? m.fileId;
        }),
        response.jobId,
      );
    },
    onError: (err) => {
      setSubmittedJobId(null);
      if (err instanceof ApiError) {
        setError(err);
      } else {
        setGenericError(true);
      }
    },
  });

  const change = (action: Parameters<typeof dispatch>[0]) => {
    setError(null);
    setGenericError(false);
    dispatch(action);
  };

  return (
    <div className="space-y-4">
      <section>
        <h2 className="text-sm font-medium text-gray-900">Destinations</h2>
        <TreeView
          tree={tree}
          selection={{
            selected: new Set(state.folderIds),
            onToggle: (folderId) => change({ type: "toggleFolder", folderId }),
            limitReached: state.folderIds.length >= MAX_JOB_FOLDERS,
          }}
        />
      </section>
      <section>
        <h2 className="text-sm font-medium text-gray-900">Mapping</h2>
        <MappingMatrix
          rows={summary.rows}
          folders={folders}
          onToggleCell={(itemId, folderId) =>
            change({ type: "toggleCell", itemId, folderId })
          }
          onSetColumn={(folderId, assigned) =>
            change({
              type: "setColumn",
              folderId,
              itemIds: summary.rows.map((r) => r.item.id),
              assigned,
            })
          }
          onRemoveFolder={(folderId) =>
            change({ type: "toggleFolder", folderId })
          }
        />
      </section>
      <div className="space-y-2">
        <p className="text-sm text-gray-900">
          <span
            className={
              summary.counts.files > MAX_JOB_FILES ? "text-red-700" : undefined
            }
          >
            Files {summary.counts.files.toLocaleString("en-US")}/
            {MAX_JOB_FILES.toLocaleString("en-US")}
          </span>
          {" · "}
          <span
            className={
              summary.counts.folders > MAX_JOB_FOLDERS
                ? "text-red-700"
                : undefined
            }
          >
            Folders {summary.counts.folders.toLocaleString("en-US")}/
            {MAX_JOB_FOLDERS.toLocaleString("en-US")}
          </span>
          {" · "}
          <span
            className={
              summary.counts.tasks > MAX_JOB_TASKS ? "text-red-700" : undefined
            }
          >
            Tasks {summary.counts.tasks.toLocaleString("en-US")}/
            {MAX_JOB_TASKS.toLocaleString("en-US")}
          </span>
        </p>
        <Button
          disabled={summary.request === null || mutation.isPending}
          onClick={() => {
            if (summary.request) {
              setError(null);
              setGenericError(false);
              mutation.mutate(summary.request);
            }
          }}
        >
          {mutation.isPending ? "Submitting…" : "Submit"}
        </Button>
        {submittedJobId !== null && (
          <p role="status" className="text-sm text-green-700">
            Job submitted. {submittedJobId}
          </p>
        )}
        {error !== null && (
          <div role="alert" className="text-sm text-red-700">
            <p>{error.message}</p>
            {Array.isArray(error.details.fileIds) && (
              <ul>
                {(error.details.fileIds as string[]).map((fileId) => (
                  <li key={fileId}>
                    {items.find((item) => item.fileId === fileId)?.name ??
                      fileId}
                  </li>
                ))}
              </ul>
            )}
            {Array.isArray(error.details.folderIds) && (
              <ul>
                {(error.details.folderIds as string[]).map((folderId) => (
                  <li key={folderId}>
                    {folderIndex.get(folderId)?.path ?? folderId}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {genericError && (
          <p role="alert" className="text-sm text-red-700">
            Submission failed. Try again.
          </p>
        )}
        {summary.blockers.length > 0 && (
          <ul className="text-sm text-gray-500">
            {summary.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
