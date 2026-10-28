import { describe, expect, it } from "@jest/globals";
import { LoginThrottleService } from "../src/throttle/login-throttle.service";

describe("LoginThrottleService", () => {
  it("allows 10 hits, blocks the 11th, resets after the window", () => {
    let now = 1_000_000;
    const throttle = new LoginThrottleService();
    throttle.now = () => now;
    const key = throttle.keyFor("1.2.3.4", "User@Example.com");
    for (let i = 0; i < 10; i++) {
      expect(throttle.hit(key)).toBe(true);
    }
    expect(throttle.hit(key)).toBe(false);
    now += 30_000;
    expect(throttle.hit(key)).toBe(false);
    now += 31_000;
    expect(throttle.hit(key)).toBe(true);
  });

  it("tracks keys independently and lowercases email", () => {
    const throttle = new LoginThrottleService();
    const a = throttle.keyFor("1.2.3.4", "a@x.com");
    const b = throttle.keyFor("1.2.3.4", "b@x.com");
    for (let i = 0; i < 10; i++) throttle.hit(a);
    expect(throttle.hit(a)).toBe(false);
    expect(throttle.hit(b)).toBe(true);
    expect(throttle.keyFor("1.2.3.4", "A@X.com")).toBe(a);
  });

  it("sweeps stale keys every 1,000 hits", () => {
    let now = 1_000_000;
    const throttle = new LoginThrottleService();
    throttle.now = () => now;
    for (let i = 0; i < 500; i++) {
      throttle.hit(`key-${i}`);
    }
    expect(throttle.size).toBe(500);
    now += 120_000;
    for (let i = 500; i < 1_000; i++) {
      throttle.hit(`key-${i}`);
    }
    expect(throttle.size).toBe(500);
  });
});
