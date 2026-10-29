import { useQuery } from "@tanstack/react-query";
import { TreeResponse } from "@docbridge/contracts";
import { session } from "../../auth/session";

export function fetchTree(all = false): Promise<TreeResponse> {
  return session.authFetch<TreeResponse>(all ? "/tree?all=true" : "/tree");
}

export function useTree(all: boolean) {
  return useQuery({
    queryKey: ["tree", all],
    queryFn: () => fetchTree(all),
    staleTime: Infinity,
  });
}
