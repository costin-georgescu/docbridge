import { UserClaims } from "@docbridge/contracts";

export function decodeClaims(token: string): UserClaims {
  const payload = token.split(".")[1];
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return UserClaims.parse(JSON.parse(json));
}
