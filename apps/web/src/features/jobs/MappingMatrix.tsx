import { ComponentProps, useEffect, useRef } from "react";
import { Checkbox } from "@base-ui-components/react/checkbox";
import { humanSize } from "../../lib/format";
import { STATUS_LABELS, UploadItem } from "../uploads/upload-manager";

export interface MappingRow {
  item: UploadItem;
  folderIds: string[];
}

export interface MappingFolder {
  id: string;
  name: string;
  path: string;
}

const CHECKBOX_CLASS =
  "flex h-4 w-4 items-center justify-center rounded border border-line bg-surface data-[checked]:border-accent-fill data-[checked]:bg-accent-fill data-[indeterminate]:border-accent-fill data-[indeterminate]:bg-accent-fill disabled:opacity-50";

function Cell({
  className = "",
  indeterminate = false,
  checked,
  children,
  ...props
}: ComponentProps<typeof Checkbox.Root> & { indeterminate?: boolean }) {
  return (
    <Checkbox.Root
      className={`${CHECKBOX_CLASS} ${className}`}
      indeterminate={indeterminate}
      checked={checked}
      {...props}
    >
      <Checkbox.Indicator className="text-accent-ink">
        {children ?? (indeterminate ? "–" : "✓")}
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

function parentPath(path: string): string | null {
  const cut = path.lastIndexOf(" / ");
  return cut > 0 ? path.slice(0, cut) : null;
}

export function MappingMatrix({
  rows,
  folders,
  onToggleCell,
  onSetCell,
  onSetRow,
  onSetColumn,
  onSetAll,
  onRemoveFolder,
  onRetryItem,
  onRemoveItem,
}: {
  rows: MappingRow[];
  folders: MappingFolder[];
  onToggleCell: (itemId: string, folderId: string) => void;
  onSetCell: (itemId: string, folderId: string, assigned: boolean) => void;
  onSetRow: (itemId: string, assigned: boolean) => void;
  onSetColumn: (folderId: string, assigned: boolean) => void;
  onSetAll: (assigned: boolean) => void;
  onRemoveFolder: (folderId: string) => void;
  onRetryItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
}) {
  // Drag-paint: pressing on a cell starts a paint stroke whose value is the
  // opposite of that cell's state; moving into other cells applies it.
  const paint = useRef<boolean | null>(null);
  useEffect(() => {
    const end = () => {
      paint.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  if (rows.length === 0) {
    return null;
  }

  const noFolders = folders.length === 0;
  const allAssigned =
    !noFolders &&
    rows.every((row) => row.folderIds.length === folders.length);
  const anyAssigned = rows.some((row) => row.folderIds.length > 0);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead>
          <tr className="text-muted">
            <th className="sticky left-0 top-0 z-30 w-10 min-w-10 border-b border-line bg-surface py-2 pr-1 font-medium">
              <Cell
                aria-label="Assign every file to every folder"
                checked={allAssigned}
                indeterminate={!allAssigned && anyAssigned}
                disabled={noFolders}
                onCheckedChange={(checked) => onSetAll(checked === true)}
              />
            </th>
            <th className="sticky left-10 top-0 z-30 w-64 min-w-64 border-b border-line bg-surface py-2 pr-4 font-medium">
              File
            </th>
            <th className="sticky top-0 z-20 w-64 border-b border-line bg-surface py-2 pr-4 font-medium">
              Destinations
            </th>
            {folders.map((folder) => {
              const parent = parentPath(folder.path);
              const assigned = rows.filter((row) =>
                row.folderIds.includes(folder.id),
              ).length;
              return (
                <th
                  key={folder.id}
                  className="sticky top-0 z-20 border-b border-line bg-surface py-2 pr-4 font-medium"
                >
                  <div className="flex items-start gap-1.5" title={folder.path}>
                    <Cell
                      className="mt-0.5"
                      aria-label={`Assign ${folder.path} to all files`}
                      checked={assigned === rows.length}
                      indeterminate={assigned > 0 && assigned < rows.length}
                      onCheckedChange={(checked) =>
                        onSetColumn(folder.id, checked === true)
                      }
                    />
                    <span className="block min-w-0">
                      <span className="block max-w-36 truncate text-ink">
                        {folder.name}
                      </span>
                      {parent && (
                        <span className="block max-w-36 truncate text-xs font-normal text-muted">
                          {parent}
                        </span>
                      )}
                      <span className="block text-xs font-normal text-muted">
                        {assigned}/{rows.length}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${folder.path}`}
                      onClick={() => onRemoveFolder(folder.id)}
                      className="mt-0.5 text-muted hover:text-ink"
                    >
                      ×
                    </button>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const item = row.item;
            const active = item.phase !== "staged" && item.phase !== "error";
            const rowChecked =
              !noFolders && row.folderIds.length === folders.length;
            const rowPartial =
              row.folderIds.length > 0 && !rowChecked;
            return (
              <tr
                key={item.id}
                className="border-b border-line align-top text-ink"
              >
                <td className="sticky left-0 z-10 w-10 min-w-10 bg-surface py-3 pr-1">
                  <Cell
                    aria-label={`Assign ${item.name} to all folders`}
                    checked={rowChecked}
                    indeterminate={rowPartial}
                    disabled={noFolders}
                    onCheckedChange={(checked) =>
                      onSetRow(item.id, checked === true)
                    }
                  />
                </td>
                <td className="sticky left-10 z-10 w-64 min-w-64 bg-surface py-2 pr-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium" title={item.name}>
                        {item.name}
                      </p>
                      <p className="text-xs text-muted">
                        {humanSize(item.sizeBytes)} ·{" "}
                        {STATUS_LABELS[item.phase]}
                      </p>
                    </div>
                    <span className="flex shrink-0 gap-2 text-xs">
                      {item.phase === "error" && item.error?.retryable && (
                        <button
                          type="button"
                          aria-label={`Retry ${item.name}`}
                          onClick={() => onRetryItem(item.id)}
                          className="font-medium text-accent hover:underline"
                        >
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => onRemoveItem(item.id)}
                        className="font-medium text-muted hover:text-ink"
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  {active && (
                    <div
                      role="progressbar"
                      aria-valuenow={Math.round(item.progress * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink/10"
                    >
                      <div
                        className="h-full rounded-full bg-accent-fill transition-all"
                        style={{
                          width: `${Math.round(item.progress * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {item.phase === "error" && item.error && (
                    <p
                      role="alert"
                      className="mt-1 text-xs text-rose-600 dark:text-rose-300"
                    >
                      {item.error.message}
                    </p>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <div className="flex max-w-64 flex-wrap gap-1">
                    {row.folderIds.map((folderId) => {
                      const folder = folders.find((f) => f.id === folderId);
                      if (!folder) {
                        return null;
                      }
                      return (
                        <span
                          key={folderId}
                          title={folder.path}
                          className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent"
                        >
                          {folder.name}
                          <button
                            type="button"
                            aria-label={`Remove ${folder.path} from ${item.name}`}
                            onClick={() => onToggleCell(item.id, folderId)}
                            className="text-accent/60 hover:text-accent"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </td>
                {noFolders && (
                  <td className="py-2 pr-4 text-sm text-muted">
                    Select destination folders in the tree.
                  </td>
                )}
                {folders.map((folder) => {
                  const checked = row.folderIds.includes(folder.id);
                  return (
                    <td key={folder.id} className="select-none p-1">
                      <div
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`${item.name}: ${folder.path}`}
                        tabIndex={0}
                        className={`flex h-9 w-full min-w-9 cursor-pointer items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-fill ${
                          checked
                            ? "border-accent-fill bg-accent-fill text-accent-ink"
                            : "border-transparent hover:border-line hover:bg-ink/5"
                        }`}
                        onMouseDown={(event) => {
                          if (event.button !== 0) {
                            return;
                          }
                          event.preventDefault();
                          paint.current = !checked;
                          onSetCell(item.id, folder.id, !checked);
                        }}
                        onMouseEnter={(event) => {
                          if (
                            paint.current !== null &&
                            (event.buttons & 1) === 1
                          ) {
                            onSetCell(item.id, folder.id, paint.current);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === " " || event.key === "Enter") {
                            event.preventDefault();
                            onToggleCell(item.id, folder.id);
                          }
                        }}
                      >
                        {checked && "✓"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
