import { ReactNode, useMemo, useState } from "react";
import { Checkbox } from "@base-ui-components/react/checkbox";
import { TreeFolder, TreeResponse } from "@docbridge/contracts";
import { Input } from "../../components/Input";
import { collectExpandableIds, filterTree } from "./filter";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 text-muted transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function countNodes(tree: TreeResponse): {
  teams: number;
  binders: number;
  folders: number;
} {
  let binders = 0;
  let folders = 0;
  const walk = (items: TreeFolder[]) => {
    for (const f of items) {
      folders++;
      walk(f.folders);
    }
  };
  for (const team of tree.teams) {
    binders += team.binders.length;
    for (const binder of team.binders) {
      walk(binder.folders);
    }
  }
  return { teams: tree.teams.length, binders, folders };
}

export interface TreeSelection {
  selected: ReadonlySet<string>;
  onToggle: (folderId: string) => void;
  limitReached: boolean;
}

export function TreeView({
  tree,
  selection,
}: {
  tree: TreeResponse;
  selection?: TreeSelection;
}) {
  const [filter, setFilter] = useState("");
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  const filtering = filter.trim().length > 0;
  const visible = useMemo(() => filterTree(tree, filter), [tree, filter]);
  const autoExpanded = useMemo(
    () => (filtering ? new Set(collectExpandableIds(visible)) : null),
    [filtering, visible],
  );
  const isExpanded = (id: string) =>
    autoExpanded ? autoExpanded.has(id) : manualExpanded.has(id);
  const toggle = (id: string) =>
    setManualExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const counts = countNodes(visible);

  const renderFolders = (folders: TreeFolder[]): ReactNode => (
    <ul role="group" className="ml-[22px] border-l border-line pl-2">
      {folders.map((folder) => {
        const expandable = folder.folders.length > 0;
        const expanded = expandable && isExpanded(folder.id);
        const checked = selection?.selected.has(folder.id) ?? false;
        return (
          <li
            key={folder.id}
            role="treeitem"
            aria-expanded={expandable ? expanded : undefined}
          >
            <div className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-ink/5">
              {selection && (
                <Checkbox.Root
                  checked={selection.selected.has(folder.id)}
                  disabled={
                    selection.limitReached && !selection.selected.has(folder.id)
                  }
                  onCheckedChange={() => selection.onToggle(folder.id)}
                  aria-label={folder.name}
                  className="flex size-[18px] shrink-0 items-center justify-center rounded-md border border-line bg-surface data-[checked]:border-accent-fill data-[checked]:bg-accent-fill disabled:opacity-50"
                >
                  <Checkbox.Indicator className="text-accent-ink">
                    ✓
                  </Checkbox.Indicator>
                </Checkbox.Root>
              )}
              {expandable ? (
                <button
                  type="button"
                  onClick={() => toggle(folder.id)}
                  className={`flex flex-1 items-center gap-1.5 py-0.5 text-left text-sm ${checked ? "font-medium text-accent" : "text-ink"}`}
                >
                  <Chevron expanded={expanded} />
                  {folder.name}
                </button>
              ) : (
                <span
                  className={`block py-0.5 pl-[18px] text-sm ${checked ? "font-medium text-accent" : "text-ink"}`}
                >
                  {folder.name}
                </span>
              )}
            </div>
            {expanded && renderFolders(folder.folders)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Input
        aria-label="Filter destinations"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search teams, binders, folders"
      />
      {tree.teams.length === 0 ? (
        <p className="text-sm text-muted">
          No destinations are assigned to your account.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-ink/[0.02]">
          <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5">
            <span className="text-xs text-muted">
              {counts.teams} teams · {counts.binders} binders · {counts.folders}{" "}
              folders
            </span>
            <span className="flex items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  setManualExpanded(new Set(collectExpandableIds(tree)))
                }
                className="text-xs font-medium text-muted transition-colors hover:text-ink"
              >
                Expand all
              </button>
              <button
                type="button"
                onClick={() => setManualExpanded(new Set())}
                className="text-xs font-medium text-muted transition-colors hover:text-ink"
              >
                Collapse all
              </button>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {visible.teams.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted">No matches.</p>
            ) : (
              <ul role="tree" className="space-y-1">
                {visible.teams.map((team) => {
                  const teamExpanded = isExpanded(team.id);
                  return (
                    <li
                      key={team.id}
                      role="treeitem"
                      aria-expanded={teamExpanded}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(team.id)}
                        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm font-semibold text-ink transition-colors hover:bg-ink/5"
                      >
                        <Chevron expanded={teamExpanded} />
                        {team.name}
                      </button>
                      {teamExpanded && (
                        <ul
                          role="group"
                          className="ml-[22px] space-y-1 border-l border-line pl-2"
                        >
                          {team.binders.map((binder) => {
                            const binderExpanded = isExpanded(binder.id);
                            return (
                              <li
                                key={binder.id}
                                role="treeitem"
                                aria-expanded={binderExpanded}
                              >
                                <button
                                  type="button"
                                  onClick={() => toggle(binder.id)}
                                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm font-medium text-ink transition-colors hover:bg-ink/5"
                                >
                                  <Chevron expanded={binderExpanded} />
                                  {binder.name}
                                </button>
                                {binderExpanded &&
                                  renderFolders(binder.folders)}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
