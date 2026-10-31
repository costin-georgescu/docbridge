import { describe, expect, it, jest } from "@jest/globals";
import { RateLimiterRegistry } from "@docbridge/rate-limit";
import { AppError } from "../src/common/app-error";
import { config } from "../src/config";
import { TreeController } from "../src/tree/tree.controller";
import type { TreeService } from "../src/tree/tree.service";

const codeOf = (e: unknown): string | undefined =>
  e instanceof AppError
    ? (e.getResponse() as { error?: { code?: string } }).error?.code
    : undefined;

describe("platform rate limits", () => {
  it("GET /tree returns 429 past RATE_LIMIT_TREE_PER_MIN", () => {
    const original = config.RATE_LIMIT_TREE_PER_MIN;
    try {
      config.RATE_LIMIT_TREE_PER_MIN = 1;
      const getTree = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ teams: [] });
      const controller = new TreeController(
        { getTree } as unknown as TreeService,
        new RateLimiterRegistry(),
      );
      const claims = { sub: "u", teams: [], admin: true } as never;
      controller.getTree(claims, "1.2.3.4", { all: true } as never);
      try {
        controller.getTree(claims, "1.2.3.4", { all: true } as never);
      } catch (e) {
        expect(codeOf(e)).toBe("too_many_requests");
      }
      // A different client IP still has budget.
      controller.getTree(claims, "5.6.7.8", { all: true } as never);
      expect(getTree).toHaveBeenCalledTimes(2);
    } finally {
      config.RATE_LIMIT_TREE_PER_MIN = original;
    }
  });
});
