export const ACCESS_TOKEN_TTL_S = 900;
export const REFRESH_TOKEN_TTL_S = 28_800;
export const SERVICE_TOKEN_TTL_S = 3600;
export const REFRESH_COOKIE = "docbridge_refresh";
export const REFRESH_COOKIE_PATH = "/auth";
export const LOGIN_THROTTLE = { limit: 10, windowMs: 60_000 };
export const ISSUER = "docbridge-auth";
export const AUDIENCE = "docbridge";
