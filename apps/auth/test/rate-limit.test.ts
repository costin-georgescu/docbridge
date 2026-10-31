import { describe, expect, it, jest } from "@jest/globals";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { AuthController } from "../src/auth/auth.controller";
import type { AuthService } from "../src/auth/auth.service";
import { AppError } from "../src/common/app-error";
import { config } from "../src/config";
import type { SigningKeyService } from "../src/keys/signing-key.service";
import { LoginThrottleService } from "../src/throttle/login-throttle.service";

const codeOf = (e: unknown): string | undefined =>
  e instanceof AppError
    ? (e.getResponse() as { error?: { code?: string } }).error?.code
    : undefined;

async function rejectsWithCode(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(codeOf(err)).toBe(code);
}

const restore = <K extends keyof typeof config>(key: K) => {
  const original = config[key];
  return () => {
    (config as Record<K, unknown>)[key] = original;
  };
};

function controller(
  auth: Partial<AuthService> = {},
  rateLimit = new RateLimiterRegistry(),
): AuthController {
  return new AuthController(
    auth as AuthService,
    new LoginThrottleService(),
    {} as SigningKeyService,
    rateLimit,
  );
}

describe("auth rate limits", () => {
  it("refresh and logout share the session bucket keyed by client IP", async () => {
    const undo = restore("RATE_LIMIT_SESSION_PER_MIN");
    try {
      config.RATE_LIMIT_SESSION_PER_MIN = 2;
      const ctrl = controller();
      const req = { ip: "1.2.3.4", cookies: {} } as never;
      const res = {
        cookie: jest.fn(),
        clearCookie: jest.fn(),
      } as never;
      // Within budget a bare request fails on cookie validation; past the
      // budget it fails on the limiter before reaching it.
      await rejectsWithCode(ctrl.refresh(req, res), "invalid_refresh");
      await rejectsWithCode(ctrl.refresh(req, res), "invalid_refresh");
      await rejectsWithCode(ctrl.refresh(req, res), "too_many_requests");
      // Logout draws from the same bucket.
      await rejectsWithCode(ctrl.logout(req, res), "too_many_requests");
      // A different client IP still has budget.
      const other = { ip: "5.6.7.8", cookies: {} } as never;
      await expect(ctrl.logout(other, res)).resolves.toBeUndefined();
    } finally {
      undo();
    }
  });

  it("service-token returns 429 past RATE_LIMIT_SERVICE_TOKEN_PER_MIN", async () => {
    const undo = restore("RATE_LIMIT_SERVICE_TOKEN_PER_MIN");
    try {
      config.RATE_LIMIT_SERVICE_TOKEN_PER_MIN = 1;
      const serviceToken = jest
        .fn<() => Promise<never>>()
        .mockRejectedValue(new AppError(401, "unauthorized", "bad secret"));
      const auth = { serviceToken } as Partial<AuthService>;
      const ctrl = controller(auth);
      const body = { clientId: "worker", clientSecret: "s" } as never;
      await rejectsWithCode(ctrl.serviceToken(body, "1.2.3.4"), "unauthorized");
      await rejectsWithCode(
        ctrl.serviceToken(body, "1.2.3.4"),
        "too_many_requests",
      );
      expect(serviceToken).toHaveBeenCalledTimes(1);
    } finally {
      undo();
    }
  });
});
