import { Button } from "../../components/Button";
import { humanSize } from "../../lib/format";
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
    <ul className="mt-2 divide-y divide-line">
      {items.map((item) => {
        const active = item.phase === "hashing" || item.phase === "uploading";
        return (
          <li key={item.id} className="px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">
                  {item.name}
                </p>
                <p className="text-xs text-muted">
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
                  className="h-2 w-full overflow-hidden rounded-full bg-ink/10"
                >
                  <div
                    className="h-full rounded-full bg-accent-fill transition-all"
                    style={{ width: `${Math.round(item.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {item.phase === "error" && item.error && (
              <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-300">
                {item.error.message}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
