export const AUTH_REQUIREMENT = Symbol("auth:requirement");

export type AuthRequirement =
  { kind: "user" } | { kind: "admin" } | { kind: "service"; scopes: string[] };
