export const AUTH_REQUIREMENT = Symbol("auth:requirement");

export type AuthRequirement =
  | { kind: "any" }
  | { kind: "user" }
  | { kind: "admin" }
  | { kind: "service"; scopes: string[] };
