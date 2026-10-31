import { useState } from "react";
import { JobFileResponse } from "@docbridge/contracts";
import { Card } from "../../components/Card";
import { ApiError } from "../../lib/api";
import { openPresignedUrl } from "../../lib/download";
import { humanSize } from "../../lib/format";
import { requestFileDownload } from "./api";

function describeDownloadError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === "file_expired"
      ? "This file is no longer available for download."
      : err.message;
  }
  return "The download could not be started.";
}

export function JobFileList({
  jobId,
  files,
}: {
  jobId: string;
  files: JobFileResponse[];
}) {
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const download = async (fileId: string) => {
    setPendingIds((prev) => new Set(prev).add(fileId));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
    try {
      const res = await requestFileDownload(jobId, fileId);
      openPresignedUrl(res.url);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [fileId]: describeDownloadError(err) }));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  };

  return (
    <Card title="Files">
      {files.length === 0 ? (
        <p className="text-sm text-muted">This job has no files.</p>
      ) : (
        <table className="w-full divide-y divide-line text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Size</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {files.map((file) => (
              <tr key={file.id}>
                <td className="py-2 text-ink">{file.name}</td>
                <td className="py-2 text-ink">{humanSize(file.sizeBytes)}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={pendingIds.has(file.id)}
                    onClick={() => void download(file.id)}
                    className="text-accent hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                  >
                    {pendingIds.has(file.id) ? "Preparing…" : "Download"}
                  </button>
                  {errors[file.id] && (
                    <p
                      className="text-xs text-rose-600 dark:text-rose-300"
                      role="alert"
                    >
                      {errors[file.id]}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
