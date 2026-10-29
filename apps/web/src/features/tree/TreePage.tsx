import { ApiError } from "../../lib/api";
import { useTree } from "./api";
import { TreeView } from "./TreeView";

export function TreePage() {
  const tree = useTree(false);
  if (tree.isPending) {
    return <p className="text-sm text-gray-500">Loading destinations…</p>;
  }
  if (tree.isError) {
    return (
      <p className="text-sm text-red-700" role="alert">
        {tree.error instanceof ApiError
          ? tree.error.message
          : "Failed to load destinations."}
      </p>
    );
  }
  return <TreeView tree={tree.data} />;
}
