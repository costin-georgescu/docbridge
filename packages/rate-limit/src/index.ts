const SWEEP_EVERY_HITS = 1000;

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/**
 * Per-key sliding window. Per-instance: with N service tasks the effective
 * limit is N times the configured limit (same caveat as the login throttle).
 * A limit of 0 or less disables the limiter.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private hitCount = 0;

  now: () => number = () => Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  /** Records a hit; returns false when the key is over the limit. */
  hit(key: string): boolean {
    if (this.limit <= 0) return true;
    this.hitCount++;
    if (this.hitCount % SWEEP_EVERY_HITS === 0) {
      this.sweep();
    }
    const windowStart = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }

  private sweep(): void {
    const windowStart = this.now() - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((t) => t <= windowStart)) {
        this.hits.delete(key);
      }
    }
  }
}

/** One limiter per named bucket, so independent limits share no budget. */
export class RateLimiterRegistry {
  private readonly limiters = new Map<string, SlidingWindowLimiter>();

  hit(bucket: string, key: string, rateLimit: RateLimit): boolean {
    if (rateLimit.limit <= 0) return true;
    let limiter = this.limiters.get(bucket);
    if (!limiter) {
      limiter = new SlidingWindowLimiter(rateLimit.limit, rateLimit.windowMs);
      this.limiters.set(bucket, limiter);
    }
    return limiter.hit(key);
  }
}
