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

function FileDetails({
  item,
  onRetryItem,
  onRemoveItem,
}: {
  item: UploadItem;
  onRetryItem: (itemId: string) => void;
  onRemoveItem: (itemId: string) => void;
}) {
  const active = item.phase !== "staged" && item.phase !== "error";
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="text-xs text-muted">
            {humanSize(item.sizeBytes)} · {STATUS_LABELS[item.phase]}
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
        <p role="alert" className="mt-1 text-xs text-rose-600 dark:text-rose-300">
          {item.error.message}
        </p>
      )}
    </>
  );
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

  const noFolders = folders.length === 0;
  const allAssigned =
    !noFolders &&
    rows.length > 0 &&
    rows.every((row) => row.folderIds.length === folders.length);
  const anyAssigned = rows.some((row) => row.folderIds.length > 0);

  // Columns are grouped by parent path ("Team / Binder") so folders that
  // share a leaf name stay distinguishable; the leaf name labels each column.
  const groups: { key: string; label: string; folders: MappingFolder[] }[] =
    [];
  const groupByKey = new Map<string, (typeof groups)[number]>();
  for (const folder of folders) {
    const key = parentPath(folder.path) ?? "";
    let group = groupByKey.get(key);
    if (!group) {
      group = { key, label: key, folders: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.folders.push(folder);
  }

  // When no folders are picked the columns area is a placeholder; the table
  // frame (headers, file column) stays identical to the mapped state so the
  // transition between states doesn't reshape the container.
  const folderPlaceholder = (
    <div className="flex h-full min-h-80 items-center justify-center rounded-xl border-2 border-dashed border-line bg-ink/[0.02] p-6">
      <p className="text-center text-sm text-muted">
        Select destination folders in the tree. Every file goes to every
        selected folder — uncheck cells to remove exceptions.
      </p>
    </div>
  );

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead>
          <tr className="text-muted">
            <th
              rowSpan={2}
              className="sticky left-0 top-0 z-30 w-16 min-w-16 border-b border-line bg-surface py-2 pr-1 font-medium"
            >
              <div className="flex items-center gap-1.5">
                <Cell
                  aria-label="Assign every file to every folder"
                  title="Assign every file to every folder"
                  checked={allAssigned}
                  indeterminate={!allAssigned && anyAssigned}
                  disabled={noFolders || rows.length === 0}
                  onCheckedChange={(checked) => onSetAll(checked === true)}
                />
                <span className="text-xs font-normal">All</span>
              </div>
            </th>
            <th
              rowSpan={2}
              className="sticky left-16 top-0 z-30 w-64 min-w-64 border-b border-line bg-surface py-2 pr-4 font-medium"
            >
              File
            </th>
            {groups.map((group) => (
              <th
                key={group.key}
                colSpan={group.folders.length}
                className="sticky top-0 z-20 h-7 border-b border-l border-line bg-surface px-2 text-center text-xs font-normal text-muted"
              >
                <span className="block truncate" title={group.label}>
                  {group.label || "—"}
                </span>
              </th>
            ))}
            {noFolders && (
              <th
                rowSpan={2}
                className="sticky top-0 z-20 border-b border-l border-line bg-surface"
              />
            )}
          </tr>
          <tr className="text-muted">
            {groups.flatMap((group) =>
              group.folders.map((folder, index) => {
                const assigned = rows.filter((row) =>
                  row.folderIds.includes(folder.id),
                ).length;
                return (
                  <th
                    key={folder.id}
                    className={`sticky top-7 z-20 border-b border-line bg-surface py-2 pr-4 font-medium ${
                      index === 0 ? "border-l" : ""
                    }`}
                  >
                    <div
                      className="flex items-center justify-center gap-1.5 whitespace-nowrap"
                      title={folder.path}
                    >
                      <Cell
                        aria-label={`Assign ${folder.path} to all files`}
                        checked={
                          rows.length > 0 && assigned === rows.length
                        }
                        indeterminate={assigned > 0 && assigned < rows.length}
                        disabled={rows.length === 0}
                        onCheckedChange={(checked) =>
                          onSetColumn(folder.id, checked === true)
                        }
                      />
                      <span className="max-w-28 truncate text-ink">
                        {folder.name}
                      </span>
                      <span
                        className="text-xs font-normal tabular-nums text-muted"
                        style={{
                          minWidth: `${String(rows.length).length * 2 + 1}ch`,
                        }}
                      >
                        {assigned}/{rows.length}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${folder.path}`}
                        onClick={() => onRemoveFolder(folder.id)}
                        className="text-muted hover:text-ink"
                      >
                        ×
                      </button>
                    </div>
                  </th>
                );
              }),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr className="border-b border-line align-top">
              <td className="w-16 min-w-16 py-3 pr-1" />
              <td className="w-64 min-w-64 py-3 pr-4 text-muted">
                Add files above to map them.
              </td>
              {noFolders ? (
                <td className="border-l border-line p-3">
                  {folderPlaceholder}
                </td>
              ) : (
                <td
                  colSpan={folders.length}
                  className="border-l border-line"
                />
              )}
            </tr>
          )}
          {rows.map((row, rowIndex) => {
            const item = row.item;
            const rowChecked =
              !noFolders && row.folderIds.length === folders.length;
            const rowPartial =
              row.folderIds.length > 0 && !rowChecked;
            return (
              <tr
                key={item.id}
                className="border-b border-line align-top text-ink"
              >
                <td className="sticky left-0 z-10 w-16 min-w-16 bg-surface py-3 pr-1">
                  <Cell
                    aria-label={`Assign ${item.name} to all folders`}
                    title={`Assign ${item.name} to all folders`}
                    checked={rowChecked}
                    indeterminate={rowPartial}
                    disabled={noFolders}
                    onCheckedChange={(checked) =>
                      onSetRow(item.id, checked === true)
                    }
                  />
                </td>
                <td className="sticky left-16 z-10 w-64 min-w-64 bg-surface py-2 pr-4">
                  <FileDetails
                    item={item}
                    onRetryItem={onRetryItem}
                    onRemoveItem={onRemoveItem}
                  />
                </td>
                {rowIndex === 0 && noFolders && (
                  <td
                    rowSpan={rows.length}
                    className="border-l border-line p-3"
                  >
                    {folderPlaceholder}
                  </td>
                )}
                {groups.flatMap((group) =>
                  group.folders.map((folder, index) => {
                    const checked = row.folderIds.includes(folder.id);
                    return (
                      <td
                        key={folder.id}
                        className={`select-none p-1 align-middle ${
                          index === 0 ? "border-l border-line" : ""
                        }`}
                      >
                        <div
                          role="checkbox"
                          aria-checked={checked}
                          aria-label={`${item.name}: ${folder.path}`}
                          tabIndex={0}
                          className={`flex h-9 w-full min-w-9 cursor-pointer items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-fill ${
                            checked
                              ? "border-accent-fill bg-accent-fill text-accent-ink"
                              : "border-transparent text-muted hover:border-line hover:bg-ink/5"
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
                          {checked ? "✓" : "✕"}
                        </div>
                      </td>
                    );
                  }),
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
