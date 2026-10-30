import { ApiError } from "../../lib/api";
import { submitJob } from "../jobs/api";
import { JobComposer } from "../jobs/JobComposer";
import { useTree } from "../tree/api";
import { FileDropzone } from "./FileDropzone";
import { uploadManager } from "./instance";
import { UploadList } from "./UploadList";
import { useUploads } from "./useUploads";

export function UploadPage() {
  const items = useUploads();
  const tree = useTree(false);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-gray-900">Upload and submit</h1>
      <FileDropzone onFiles={(files) => uploadManager.addFiles(files)} />
      <UploadList
        items={items}
        onRetry={(id) => uploadManager.retry(id)}
        onRemove={(id) => uploadManager.remove(id)}
      />
      {tree.isPending ? (
        <p className="text-sm text-gray-500">Loading destinations…</p>
      ) : tree.isError ? (
        <p className="text-sm text-red-700" role="alert">
          {tree.error instanceof ApiError
            ? tree.error.message
            : "Failed to load destinations."}
        </p>
      ) : (
        <JobComposer
          items={items}
          tree={tree.data}
          submit={submitJob}
          onSubmitted={(ids) => ids.forEach((id) => uploadManager.remove(id))}
        />
      )}
    </div>
  );
}
