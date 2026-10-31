import http from "k6/http";

// Fixture metadata written by `pnpm perf:seed`.
export const meta = JSON.parse(open("/perf/manifest.json"));

export const AUTH_URL = __ENV.AUTH_URL || "http://auth:3001";
export const API_URL = __ENV.API_URL || "http://api:3000";
export const PLATFORM_URL = __ENV.PLATFORM_URL || "http://platform:3002";

export function login() {
  const res = http.post(
    `${AUTH_URL}/auth/login`,
    JSON.stringify({ email: meta.email, password: meta.password }),
    { headers: { "content-type": "application/json" } },
  );
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.body}`);
  }
  return { token: res.json("accessToken") };
}

export function authHeaders(token) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  };
}
