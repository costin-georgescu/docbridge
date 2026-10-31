import { ApiError } from "../../lib/api";
import { Card } from "../../components/Card";
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
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Deliver documents
        </h1>
      </header>
      <Card>
        <FileDropzone onFiles={(files) => uploadManager.addFiles(files)} />
        <UploadList
          items={items}
          onRetry={(id) => uploadManager.retry(id)}
          onRemove={(id) => uploadManager.remove(id)}
        />
      </Card>
      {tree.isPending ? (
        <p className="text-sm text-muted">Loading destinations…</p>
      ) : tree.isError ? (
        <p className="text-sm text-rose-600 dark:text-rose-300" role="alert">
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
