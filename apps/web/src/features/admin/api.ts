import {
  CreateUserRequest,
  ReplaceTeamsRequest,
  UserListResponse,
  UserResponse,
} from "@docbridge/contracts";
import { session } from "../../auth/session";
import { useTree } from "../tree/api";

export function listUsers(cursor?: string): Promise<UserListResponse> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) {
    params.set("cursor", cursor);
  }
  return session.authFetch<UserListResponse>(`/auth/users?${params}`);
}

export function createUser(body: CreateUserRequest): Promise<UserResponse> {
  return session.authFetch<UserResponse>("/auth/users", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function replaceTeams(
  id: string,
  teamIds: string[],
): Promise<UserResponse> {
  const body: ReplaceTeamsRequest = { teamIds };
  return session.authFetch<UserResponse>(`/auth/users/${id}/teams`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function disableUser(id: string): Promise<void> {
  return session.authFetch<void>(`/auth/users/${id}/disable`, {
    method: "POST",
  });
}

export function useTeams() {
  const tree = useTree(true);
  return {
    data: tree.data?.teams
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    isPending: tree.isPending,
  };
}
