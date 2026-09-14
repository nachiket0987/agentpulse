/**
 * AgentTrace -- Token Bucket Rate Limiter
 *
 * Prevents trace flooding by enforcing per-second and per-minute
 * rate limits using a token bucket algorithm.
 */

export interface RateLimiterConfig {
  /** Maximum sustained traces per second. 0 = disabled. */
  maxTracesPerSecond: number;
  /** Maximum sustained traces per minute. 0 = disabled. */
  maxTracesPerMinute: number;
  /** Extra burst tokens allowed above the sustained rate. */
  burstAllowance: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRatePerMs: number;
}

export class TokenBucketRateLimiter {
  private secondBucket: Bucket;
  private minuteBucket: Bucket;
  private _droppedTraces: number = 0;

  constructor(config: RateLimiterConfig) {
    // Per-second bucket
    this.secondBucket = {
      tokens: config.burstAllowance,
      lastRefill: Date.now(),
      maxTokens: config.maxTracesPerSecond + config.burstAllowance,
      refillRatePerMs: config.maxTracesPerSecond / 1000,
    };

    // Per-minute bucket
    this.minuteBucket = {
      tokens: config.burstAllowance,
      lastRefill: Date.now(),
      maxTokens: config.maxTracesPerMinute + config.burstAllowance,
      refillRatePerMs: config.maxTracesPerMinute / 60000,
    };
  }

  /**
   * Try to consume one token. Returns true if allowed, false if rate-limited.
   */
  tryConsume(): boolean {
    this.refill();

    const secondOk = this.secondBucket.refillRatePerMs === 0 || this.secondBucket.tokens >= 1;
    const minuteOk = this.minuteBucket.refillRatePerMs === 0 || this.minuteBucket.tokens >= 1;

    if (secondOk && minuteOk) {
      if (this.secondBucket.refillRatePerMs > 0) this.secondBucket.tokens -= 1;
      if (this.minuteBucket.refillRatePerMs > 0) this.minuteBucket.tokens -= 1;
      return true;
    }

    this._droppedTraces++;
    return false;
  }

  /**
   * Get the total number of traces dropped due to rate limiting.
   */
  getDroppedTraces(): number {
    return this._droppedTraces;
  }

  /**
   * Reset the dropped traces counter.
   */
  resetDroppedTraces(): void {
    this._droppedTraces = 0;
  }

  private refill(): void {
    const now = Date.now();

    // Refill second bucket
    if (this.secondBucket.refillRatePerMs > 0) {
      const elapsed = now - this.secondBucket.lastRefill;
      const tokensToAdd = elapsed * this.secondBucket.refillRatePerMs;
      this.secondBucket.tokens = Math.min(
        this.secondBucket.maxTokens,
        this.secondBucket.tokens + tokensToAdd,
      );
      this.secondBucket.lastRefill = now;
    }

    // Refill minute bucket
    if (this.minuteBucket.refillRatePerMs > 0) {
      const elapsed = now - this.minuteBucket.lastRefill;
      const tokensToAdd = elapsed * this.minuteBucket.refillRatePerMs;
      this.minuteBucket.tokens = Math.min(
        this.minuteBucket.maxTokens,
        this.minuteBucket.tokens + tokensToAdd,
      );
      this.minuteBucket.lastRefill = now;
    }
  }
}
