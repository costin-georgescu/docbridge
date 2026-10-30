import { useState } from "react";
import { JobFileResponse } from "@docbridge/contracts";
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
    <section>
      <h2 className="text-sm font-medium text-gray-900">Files</h2>
      {files.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">This job has no files.</p>
      ) : (
        <table className="mt-1 w-full divide-y divide-gray-200 rounded-md border border-gray-200 bg-white text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {files.map((file) => (
              <tr key={file.id}>
                <td className="px-3 py-2 text-gray-900">{file.name}</td>
                <td className="px-3 py-2 text-gray-900">
                  {humanSize(file.sizeBytes)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={pendingIds.has(file.id)}
                    onClick={() => void download(file.id)}
                    className="text-blue-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-400 disabled:no-underline"
                  >
                    {pendingIds.has(file.id) ? "Preparing…" : "Download"}
                  </button>
                  {errors[file.id] && (
                    <p className="text-xs text-red-700" role="alert">
                      {errors[file.id]}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
