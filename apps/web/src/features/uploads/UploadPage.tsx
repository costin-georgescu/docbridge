import { useNavigate } from "@tanstack/react-router";
import { ApiError } from "../../lib/api";
import { Card } from "../../components/Card";
import { submitJob } from "../jobs/api";
import { JobComposer } from "../jobs/JobComposer";
import { useTree } from "../tree/api";
import { FileDropzone } from "./FileDropzone";
import { uploadManager } from "./instance";
import { useUploads } from "./useUploads";

export function UploadPage() {
  const navigate = useNavigate();
  const items = useUploads();
  const tree = useTree(false);
  return (
    <div className="flex h-full min-h-[36rem] min-w-[64rem] flex-col gap-4 pb-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Deliver documents
        </h1>
      </header>
      <FileDropzone
        hasItems={items.length > 0}
        onFiles={(files) => uploadManager.addFiles(files)}
      />
      {tree.isPending ? (
        <Card
          title="Destinations & mapping"
          className="h-full min-h-0 flex-1"
        >
          <p className="text-sm text-muted">Loading destinations…</p>
        </Card>
      ) : tree.isError ? (
        <Card
          title="Destinations & mapping"
          className="h-full min-h-0 flex-1"
        >
          <p
            className="text-sm text-rose-600 dark:text-rose-300"
            role="alert"
          >
            {tree.error instanceof ApiError
              ? tree.error.message
              : "Failed to load destinations."}
          </p>
        </Card>
      ) : (
        <JobComposer
          items={items}
          tree={tree.data}
          submit={submitJob}
          onSubmitted={(ids, jobId) => {
            ids.forEach((id) => uploadManager.remove(id));
            void navigate({ to: "/jobs/$jobId", params: { jobId } });
          }}
          onRetryItem={(id) => uploadManager.retry(id)}
          onRemoveItem={(id) => uploadManager.remove(id)}
        />
      )}
    </div>
  );
}
