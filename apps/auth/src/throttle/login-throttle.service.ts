import { Injectable } from "@nestjs/common";
import { LOGIN_THROTTLE } from "../constants";

const SWEEP_EVERY_HITS = 1000;

@Injectable()
export class LoginThrottleService {
  private readonly hits = new Map<string, number[]>();
  private hitCount = 0;

  now: () => number = () => Date.now();

  get size(): number {
    return this.hits.size;
  }

  // Per-instance; with N tasks the effective limit is N×10/min.
  hit(key: string): boolean {
    this.hitCount++;
    if (this.hitCount % SWEEP_EVERY_HITS === 0) {
      this.sweep();
    }
    const windowStart = this.now() - LOGIN_THROTTLE.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= LOGIN_THROTTLE.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }

  private sweep(): void {
    const windowStart = this.now() - LOGIN_THROTTLE.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((t) => t <= windowStart)) {
        this.hits.delete(key);
      }
    }
  }

  keyFor(ip: string, email: string): string {
    return `${ip}|${email.toLowerCase()}`;
  }
}
