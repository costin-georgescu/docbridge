import { describe, expect, it } from "@jest/globals";
import { RateLimiterRegistry, SlidingWindowLimiter } from "../src";

describe("SlidingWindowLimiter", () => {
  it("allows hits up to the limit, blocks the next, resets after the window", () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(10, 60_000);
    limiter.now = () => now;
    for (let i = 0; i < 10; i++) {
      expect(limiter.hit("k")).toBe(true);
    }
    expect(limiter.hit("k")).toBe(false);
    now += 30_000;
    expect(limiter.hit("k")).toBe(false);
    now += 31_000;
    expect(limiter.hit("k")).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    expect(limiter.hit("b")).toBe(true);
  });

  it("sweeps stale keys every 1,000 hits", () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(10, 60_000);
    limiter.now = () => now;
    for (let i = 0; i < 500; i++) {
      limiter.hit(`key-${i}`);
    }
    expect(limiter.size).toBe(500);
    now += 120_000;
    for (let i = 500; i < 1_000; i++) {
      limiter.hit(`key-${i}`);
    }
    expect(limiter.size).toBe(500);
  });

  it("is unlimited when the limit is 0", () => {
    const limiter = new SlidingWindowLimiter(0, 60_000);
    for (let i = 0; i < 100; i++) {
      expect(limiter.hit("k")).toBe(true);
    }
    expect(limiter.size).toBe(0);
  });
});

describe("RateLimiterRegistry", () => {
  it("keeps separate budgets per bucket", () => {
    const registry = new RateLimiterRegistry();
    const rateLimit = { limit: 2, windowMs: 60_000 };
    expect(registry.hit("a", "u1", rateLimit)).toBe(true);
    expect(registry.hit("a", "u1", rateLimit)).toBe(true);
    expect(registry.hit("a", "u1", rateLimit)).toBe(false);
    expect(registry.hit("b", "u1", rateLimit)).toBe(true);
  });

  it("treats a limit of 0 as unlimited", () => {
    const registry = new RateLimiterRegistry();
    for (let i = 0; i < 100; i++) {
      expect(registry.hit("a", "k", { limit: 0, windowMs: 1_000 })).toBe(true);
    }
  });
});
