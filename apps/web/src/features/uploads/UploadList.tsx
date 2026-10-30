import { Button } from "../../components/Button";
import { UploadItem, UploadPhase } from "./upload-manager";

export const STATUS_LABELS: Record<UploadPhase, string> = {
  queued: "Queued",
  hashing: "Computing checksum",
  uploading: "Uploading",
  completing: "Completing",
  processing: "Processing",
  staged: "Staged",
  error: "Failed",
};

function humanSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let value = sizeBytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function UploadList({
  items,
  onRetry,
  onRemove,
}: {
  items: UploadItem[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 bg-white">
      {items.map((item) => {
        const active = item.phase === "hashing" || item.phase === "uploading";
        return (
          <li key={item.id} className="px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">
                  {item.name}
                </p>
                <p className="text-xs text-gray-500">
                  {humanSize(item.sizeBytes)} · {STATUS_LABELS[item.phase]}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {item.phase === "error" && item.error?.retryable && (
                  <Button variant="secondary" onClick={() => onRetry(item.id)}>
                    Retry
                  </Button>
                )}
                <Button variant="secondary" onClick={() => onRemove(item.id)}>
                  Remove
                </Button>
              </div>
            </div>
            {active && (
              <div className="mt-2">
                <div
                  role="progressbar"
                  aria-valuenow={Math.round(item.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
                >
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all"
                    style={{ width: `${Math.round(item.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {item.phase === "error" && item.error && (
              <p role="alert" className="mt-2 text-sm text-red-700">
                {item.error.message}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
