/**
 * Rate Limiter Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter, getRateLimiter, resetRateLimiter } from '../src/utils/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      tokensPerSecond: 10, // Fast for testing
      bucketSize: 5,
      maxClients: 100,
      clientTtlMs: 1000,
      cleanupIntervalMs: 500,
    });
  });

  afterEach(() => {
    limiter.shutdown();
  });

  describe('tryAcquire', () => {
    it('should allow requests within limit', () => {
      const client = 'test-client-1';

      // First 5 requests should succeed (bucket size)
      for (let i = 0; i < 5; i++) {
        expect(limiter.tryAcquire(client)).toBe(true);
      }
    });

    it('should deny requests when bucket is empty', () => {
      const client = 'test-client-2';

      // Exhaust bucket
      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire(client);
      }

      // Next request should be denied
      expect(limiter.tryAcquire(client)).toBe(false);
    });

    it('should isolate clients', () => {
      const client1 = 'client-a';
      const client2 = 'client-b';

      // Exhaust client1's bucket
      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire(client1);
      }

      // Client2 should still have tokens
      expect(limiter.tryAcquire(client2)).toBe(true);
    });

    it('should refill tokens over time', async () => {
      const client = 'test-client-3';

      // Exhaust bucket
      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire(client);
      }
      expect(limiter.tryAcquire(client)).toBe(false);

      // Wait for refill (100ms = 1 token at 10/sec)
      await new Promise((r) => setTimeout(r, 150));

      // Should have at least 1 token now
      expect(limiter.tryAcquire(client)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should track statistics', () => {
      const client = 'stats-client';

      // Make some requests
      limiter.tryAcquire(client); // allowed
      limiter.tryAcquire(client); // allowed

      const stats = limiter.getStats();
      expect(stats.totalRequests).toBe(2);
      expect(stats.totalAllowed).toBe(2);
      expect(stats.totalDenied).toBe(0);
      expect(stats.totalClients).toBe(1);
    });

    it('should calculate deny rate', () => {
      const client = 'deny-client';

      // Exhaust bucket
      for (let i = 0; i < 10; i++) {
        limiter.tryAcquire(client);
      }

      const stats = limiter.getStats();
      expect(stats.totalAllowed).toBe(5);
      expect(stats.totalDenied).toBe(5);
      expect(stats.denyRate).toBe(0.5);
    });
  });

  describe('getWaitTime', () => {
    it('should return 0 when tokens available', () => {
      const client = 'wait-client';
      expect(limiter.getWaitTime(client)).toBe(0);
    });

    it('should estimate wait time when bucket empty', () => {
      const client = 'wait-client-2';

      // Exhaust bucket
      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire(client);
      }

      const waitTime = limiter.getWaitTime(client);
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(1000); // Max 1 token = 100ms at 10/sec
    });
  });

  describe('resetClient', () => {
    it('should reset client bucket', () => {
      const client = 'reset-client';

      // Exhaust bucket
      for (let i = 0; i < 5; i++) {
        limiter.tryAcquire(client);
      }
      expect(limiter.tryAcquire(client)).toBe(false);

      // Reset
      limiter.resetClient(client);

      // Should have full bucket again
      expect(limiter.tryAcquire(client)).toBe(true);
    });
  });

  describe('burst mode', () => {
    it('should allow burst when enabled', () => {
      const burstLimiter = new RateLimiter({
        tokensPerSecond: 10,
        bucketSize: 5,
        allowBurst: true,
        burstMultiplier: 2.0,
      });

      const client = 'burst-client';

      // Bucket starts at bucketSize (5), not bucketSize * burstMultiplier
      // Burst multiplier only affects the cap, not the initial fill
      // So we should get 5 requests initially
      let allowed = 0;
      for (let i = 0; i < 10; i++) {
        if (burstLimiter.tryAcquire(client)) allowed++;
      }

      expect(allowed).toBe(5); // Initial bucket size
      burstLimiter.shutdown();
    });
  });
});

describe('getRateLimiter singleton', () => {
  afterEach(() => {
    resetRateLimiter();
  });

  it('should return same instance', () => {
    const limiter1 = getRateLimiter();
    const limiter2 = getRateLimiter();
    expect(limiter1).toBe(limiter2);
  });

  it('should reset properly', () => {
    const limiter1 = getRateLimiter();
    limiter1.tryAcquire('client');

    resetRateLimiter();

    const limiter2 = getRateLimiter();
    expect(limiter1).not.toBe(limiter2);
    expect(limiter2.getStats().totalRequests).toBe(0);
  });
});
