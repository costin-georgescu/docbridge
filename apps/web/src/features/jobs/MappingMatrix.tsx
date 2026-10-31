import { ComponentProps } from "react";
import { Checkbox } from "@base-ui-components/react/checkbox";
import { STATUS_LABELS } from "../uploads/UploadList";
import { UploadItem } from "../uploads/upload-manager";

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
  "flex h-4 w-4 items-center justify-center rounded border border-line bg-surface data-[checked]:border-accent-fill data-[checked]:bg-accent-fill disabled:opacity-50";

function Cell(props: ComponentProps<typeof Checkbox.Root>) {
  return (
    <Checkbox.Root className={CHECKBOX_CLASS} {...props}>
      <Checkbox.Indicator className="text-accent-ink">✓</Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function MappingMatrix({
  rows,
  folders,
  onToggleCell,
  onSetColumn,
  onRemoveFolder,
}: {
  rows: MappingRow[];
  folders: MappingFolder[];
  onToggleCell: (itemId: string, folderId: string) => void;
  onSetColumn: (folderId: string, assigned: boolean) => void;
  onRemoveFolder: (folderId: string) => void;
}) {
  if (folders.length === 0 || rows.length === 0) {
    return null;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-muted">
            <th className="py-2 pr-4 font-medium">File</th>
            <th className="py-2 pr-4 font-medium">Destinations</th>
            {folders.map((folder) => (
              <th key={folder.id} className="py-2 pr-4 font-medium">
                <div className="flex items-center gap-1.5">
                  <Cell
                    aria-label={`Assign ${folder.path} to all files`}
                    checked={rows.every((row) =>
                      row.folderIds.includes(folder.id),
                    )}
                    onCheckedChange={(checked) =>
                      onSetColumn(folder.id, checked === true)
                    }
                  />
                  <span
                    className="max-w-32 truncate text-ink"
                    title={folder.path}
                  >
                    {folder.name}
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
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.item.id}
              className="border-b border-line align-top text-ink"
            >
              <td className="py-2 pr-4">
                <p className="font-medium">{row.item.name}</p>
                <p className="text-xs text-muted">
                  {STATUS_LABELS[row.item.phase]}
                </p>
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
                          aria-label={`Remove ${folder.path} from ${row.item.name}`}
                          onClick={() => onToggleCell(row.item.id, folderId)}
                          className="text-accent/60 hover:text-accent"
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              </td>
              {folders.map((folder) => (
                <td key={folder.id} className="py-2 pr-4">
                  <Cell
                    aria-label={`${row.item.name}: ${folder.path}`}
                    checked={row.folderIds.includes(folder.id)}
                    onCheckedChange={() => onToggleCell(row.item.id, folder.id)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
