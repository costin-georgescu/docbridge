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
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Deliver documents
        </h1>
      </header>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card
          title="Files"
          className="flex flex-col lg:h-[calc(100vh-14rem)] lg:min-h-[28rem]"
        >
          <FileDropzone
            className={items.length === 0 ? "flex-1" : ""}
            onFiles={(files) => uploadManager.addFiles(files)}
          />
          {items.length > 0 && (
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
              <UploadList
                items={items}
                onRetry={(id) => uploadManager.retry(id)}
                onRemove={(id) => uploadManager.remove(id)}
              />
            </div>
          )}
        </Card>
        {tree.isPending ? (
          <Card
            title="Destinations & mapping"
            className="lg:h-[calc(100vh-14rem)] lg:min-h-[28rem]"
          >
            <p className="text-sm text-muted">Loading destinations…</p>
          </Card>
        ) : tree.isError ? (
          <Card
            title="Destinations & mapping"
            className="lg:h-[calc(100vh-14rem)] lg:min-h-[28rem]"
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
            onSubmitted={(ids) => ids.forEach((id) => uploadManager.remove(id))}
          />
        )}
      </div>
    </div>
  );
}
