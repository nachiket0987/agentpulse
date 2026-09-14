import { describe, expect, it, vi } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limiter.js';

// Helper to control Date.now in tests
function withFakeTime(fn: (now: { now: number; advance: (ms: number) => void }) => void): void {
  let fakeNow = 1_000_000_000_000;
  const origNow = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
  try {
    fn({
      get now() {
        return fakeNow;
      },
      advance(ms: number) {
        fakeNow += ms;
      },
    });
  } finally {
    Date.now = origNow;
  }
}

describe('TokenBucketRateLimiter', () => {
  describe('constructor defaults', () => {
    it('creates a limiter with burst tokens pre-loaded', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 10,
          maxTracesPerMinute: 100,
          burstAllowance: 5,
        });
        expect(limiter.getDroppedTraces()).toBe(0);
      });
    });
  });

  describe('disabled limits (0 = unlimited)', () => {
    it('allows all traces when both limits are 0', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 0,
          maxTracesPerMinute: 0,
          burstAllowance: 0,
        });
        for (let i = 0; i < 1000; i++) {
          expect(limiter.tryConsume()).toBe(true);
        }
        expect(limiter.getDroppedTraces()).toBe(0);
      });
    });

    it('allows all traces when only per-second is set to 0', () => {
      withFakeTime(({ advance }) => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 0,
          maxTracesPerMinute: 60,
          burstAllowance: 0,
        });
        // Should allow 60 per minute (burst=0, refill=1/sec)
        for (let i = 0; i < 60; i++) {
          advance(1000);
          expect(limiter.tryConsume()).toBe(true);
        }
      });
    });

    it('allows all traces when only per-minute is set to 0', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 10,
          maxTracesPerMinute: 0,
          burstAllowance: 5,
        });
        // Burst of 5 available immediately from second bucket
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        // 6th should fail — burst exhausted, need refill
        expect(limiter.tryConsume()).toBe(false);
      });
    });
  });

  describe('burst consumption', () => {
    it('allows burst tokens above the sustained rate', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 1,
          maxTracesPerMinute: 60,
          burstAllowance: 3,
        });
        // Burst of 3 should be available immediately
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        // 4th should fail — no refill yet, burst exhausted
        expect(limiter.tryConsume()).toBe(false);
        expect(limiter.getDroppedTraces()).toBe(1);
      });
    });
  });

  describe('per-second refill', () => {
    it('refills tokens at the per-second rate', () => {
      withFakeTime(({ advance }) => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 10,
          maxTracesPerMinute: 600,
          burstAllowance: 1,
        });
        // Consume the burst token
        expect(limiter.tryConsume()).toBe(true);
        // Advance 100ms — should refill 1 token (10/sec = 1 per 100ms)
        advance(100);
        expect(limiter.tryConsume()).toBe(true);
      });
    });

    it('caps refill at maxTokens', () => {
      withFakeTime(({ advance }) => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 1,
          maxTracesPerMinute: 600,
          burstAllowance: 2,
        });
        // maxTokens = 1 + 2 = 3
        // Advance a lot, tokens should cap at 3
        advance(100000);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        // 4th should fail — capped at 3
        expect(limiter.tryConsume()).toBe(false);
      });
    });
  });

  describe('per-minute enforcement', () => {
    it('drops traces exceeding per-minute limit', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 0,
          maxTracesPerMinute: 3,
          burstAllowance: 0,
        });
        // With burst=0 and refill rate = 3/60000 per ms, at t=0 no tokens available
        expect(limiter.tryConsume()).toBe(false);
        expect(limiter.getDroppedTraces()).toBe(1);
      });
    });

    it('allows tokens as per-minute bucket refills', () => {
      withFakeTime(({ advance }) => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 0,
          maxTracesPerMinute: 60,
          burstAllowance: 1,
        });
        // burst=1 available immediately
        expect(limiter.tryConsume()).toBe(true);
        // 1 minute = 60000ms, refills 60 tokens. Advance 1 min.
        advance(60000);
        expect(limiter.tryConsume()).toBe(true);
      });
    });
  });

  describe('combined per-second and per-minute', () => {
    it('drops when either bucket is exhausted', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 1,
          maxTracesPerMinute: 1,
          burstAllowance: 0,
        });
        // Both buckets start with 0 tokens (maxTraces=1, burst=0 => maxTokens=1, but tokens start at burst=0)
        // Wait, tokens start at burstAllowance=0; maxTokens = 1+0 = 1
        // On first refill, elapsed=0, so no tokens added.
        // First tryConsume should fail — no tokens in either bucket
        expect(limiter.tryConsume()).toBe(false);
        expect(limiter.getDroppedTraces()).toBe(1);
      });
    });

    it('passes when both buckets have tokens', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 10,
          maxTracesPerMinute: 600,
          burstAllowance: 5,
        });
        // Both buckets have burst=5 tokens
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.tryConsume()).toBe(true);
        expect(limiter.getDroppedTraces()).toBe(0);
      });
    });
  });

  describe('getDroppedTraces / resetDroppedTraces', () => {
    it('tracks dropped traces count', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 1,
          maxTracesPerMinute: 600,
          burstAllowance: 1,
        });
        // Use the burst token
        expect(limiter.tryConsume()).toBe(true);
        // Next calls should be dropped until refill
        expect(limiter.tryConsume()).toBe(false);
        expect(limiter.tryConsume()).toBe(false);
        expect(limiter.tryConsume()).toBe(false);
        expect(limiter.getDroppedTraces()).toBe(3);
      });
    });

    it('resets dropped traces counter', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 1,
          maxTracesPerMinute: 600,
          burstAllowance: 0,
        });
        // All calls fail
        limiter.tryConsume();
        limiter.tryConsume();
        expect(limiter.getDroppedTraces()).toBe(2);
        limiter.resetDroppedTraces();
        expect(limiter.getDroppedTraces()).toBe(0);
      });
    });
  });

  describe('no limit configured (both zero)', () => {
    it('constructor with all zeros still works', () => {
      withFakeTime(() => {
        const limiter = new TokenBucketRateLimiter({
          maxTracesPerSecond: 0,
          maxTracesPerMinute: 0,
          burstAllowance: 0,
        });
        // Should never rate-limit
        for (let i = 0; i < 10000; i++) {
          expect(limiter.tryConsume()).toBe(true);
        }
        expect(limiter.getDroppedTraces()).toBe(0);
      });
    });
  });
});
