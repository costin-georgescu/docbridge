import { Injectable } from "@nestjs/common";
import { SlidingWindowLimiter } from "@docbridge/rate-limit";
import { LOGIN_THROTTLE } from "../constants";

@Injectable()
export class LoginThrottleService {
  // Per-instance; with N tasks the effective limit is N×10/min.
  private readonly limiter = new SlidingWindowLimiter(
    LOGIN_THROTTLE.limit,
    LOGIN_THROTTLE.windowMs,
  );

  get now(): () => number {
    return this.limiter.now;
  }

  set now(fn: () => number) {
    this.limiter.now = fn;
  }

  get size(): number {
    return this.limiter.size;
  }

  hit(key: string): boolean {
    return this.limiter.hit(key);
  }

  keyFor(ip: string, email: string): string {
    return `${ip}|${email.toLowerCase()}`;
  }
}
