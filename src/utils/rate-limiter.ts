/**
 * Per-Client Rate Limiter - Token Bucket Algorithm
 *
 * Provides fair resource allocation across multiple clients to prevent
 * any single client from monopolizing the LLM backend.
 *
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Per-client isolation with configurable limits
 * - Burst handling with token accumulation
 * - Automatic cleanup of stale client buckets
 * - Detailed diagnostics for monitoring
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter({
 *   tokensPerSecond: 2,
 *   bucketSize: 10,
 *   maxClients: 100
 * });
 *
 * // Check if request can proceed
 * if (await limiter.tryAcquire('client-123')) {
 *   // Process request
 * } else {
 *   // Rate limited - return 429
 * }
 * ```
 */

export interface RateLimiterConfig {
  /** Whether rate limiting is enabled (default: true). Set to false to disable rate limiting. */
  enabled: boolean;
  /** Tokens added per second per client (default: 10) */
  tokensPerSecond: number;
  /** Maximum tokens a client can accumulate (default: 50) */
  bucketSize: number;
  /** Maximum tracked clients before cleanup (default: 1000) */
  maxClients: number;
  /** Time before inactive client bucket is removed in ms (default: 300000 = 5min) */
  clientTtlMs: number;
  /** Cleanup interval in ms (default: 60000 = 1min) */
  cleanupIntervalMs: number;
  /** Enable burst mode: allow bucket overflow for bursty traffic (default: false) */
  allowBurst: boolean;
  /** Burst multiplier when allowBurst is true (default: 2.0) */
  burstMultiplier: number;
}

interface ClientBucket {
  tokens: number;
  lastRefillTime: number;
  totalRequests: number;
  totalAllowed: number;
  totalDenied: number;
  lastRequestTime: number;
}

export interface RateLimiterStats {
  totalClients: number;
  activeClients: number;
  totalRequests: number;
  totalAllowed: number;
  totalDenied: number;
  denyRate: number;
  config: RateLimiterConfig;
  topDeniedClients: Array<{ clientId: string; denied: number; allowed: number }>;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  enabled: true,
  tokensPerSecond: 10,
  bucketSize: 50,
  maxClients: 1000,
  clientTtlMs: 300000, // 5 minutes
  cleanupIntervalMs: 60000, // 1 minute
  allowBurst: false,
  burstMultiplier: 2.0,
};

export class RateLimiter {
  private config: RateLimiterConfig;
  private buckets: Map<string, ClientBucket> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Global stats
  private totalRequests = 0;
  private totalAllowed = 0;
  private totalDenied = 0;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanup();
  }

  /**
   * Try to acquire a token for the given client.
   * Returns true if allowed, false if rate limited.
   * If rate limiting is disabled, always returns true.
   *
   * @param clientId - Unique client identifier (e.g., session ID, IP address)
   * @param cost - Number of tokens to consume (default: 1)
   * @returns True if request is allowed, false if rate limited
   */
  tryAcquire(clientId: string, cost: number = 1): boolean {
    // If rate limiting is disabled, always allow
    if (!this.config.enabled) {
      this.totalRequests++;
      this.totalAllowed++;
      return true;
    }

    this.totalRequests++;
    const bucket = this.getOrCreateBucket(clientId);
    this.refillBucket(bucket);

    bucket.totalRequests++;
    bucket.lastRequestTime = Date.now();

    // Check if we have enough tokens
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      bucket.totalAllowed++;
      this.totalAllowed++;
      return true;
    }

    // Rate limited
    bucket.totalDenied++;
    this.totalDenied++;
    return false;
  }

  /**
   * Async version that waits for tokens to become available.
   * Returns immediately if tokens available, otherwise waits.
   *
   * @param clientId - Unique client identifier
   * @param cost - Number of tokens to consume (default: 1)
   * @param maxWaitMs - Maximum time to wait in ms (default: 5000)
   * @returns True if acquired, false if timeout
   */
  async acquire(clientId: string, cost: number = 1, maxWaitMs: number = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (this.tryAcquire(clientId, cost)) {
        return true;
      }

      // Calculate wait time until next token
      const bucket = this.buckets.get(clientId);
      if (!bucket) return false;

      const tokensNeeded = cost - bucket.tokens;
      const waitMs = Math.min(
        Math.ceil((tokensNeeded / this.config.tokensPerSecond) * 1000),
        maxWaitMs - (Date.now() - startTime)
      );

      if (waitMs <= 0) break;

      await this.sleep(Math.min(waitMs, 100)); // Check every 100ms max
    }

    return false;
  }

  /**
   * Get the current token count for a client.
   *
   * @param clientId - Client identifier
   * @returns Current token count, or bucketSize if client not tracked
   */
  getTokens(clientId: string): number {
    const bucket = this.buckets.get(clientId);
    if (!bucket) return this.config.bucketSize;
    this.refillBucket(bucket);
    return bucket.tokens;
  }

  /**
   * Get estimated wait time in ms before client can make a request.
   *
   * @param clientId - Client identifier
   * @param cost - Token cost of the request (default: 1)
   * @returns Estimated wait time in ms, 0 if request can proceed immediately
   */
  getWaitTime(clientId: string, cost: number = 1): number {
    const bucket = this.buckets.get(clientId);
    if (!bucket) return 0;

    this.refillBucket(bucket);
    if (bucket.tokens >= cost) return 0;

    const tokensNeeded = cost - bucket.tokens;
    return Math.ceil((tokensNeeded / this.config.tokensPerSecond) * 1000);
  }

  /**
   * Reset rate limit for a specific client.
   *
   * @param clientId - Client to reset
   */
  resetClient(clientId: string): void {
    this.buckets.delete(clientId);
  }

  /**
   * Get comprehensive statistics about rate limiting.
   *
   * @returns Rate limiter statistics
   */
  getStats(): RateLimiterStats {
    const now = Date.now();
    let activeClients = 0;

    // Count active clients (activity within TTL)
    for (const bucket of this.buckets.values()) {
      if (now - bucket.lastRequestTime < this.config.clientTtlMs) {
        activeClients++;
      }
    }

    // Get top denied clients
    const clientDenyList = Array.from(this.buckets.entries())
      .map(([clientId, bucket]) => ({
        clientId,
        denied: bucket.totalDenied,
        allowed: bucket.totalAllowed,
      }))
      .filter((c) => c.denied > 0)
      .sort((a, b) => b.denied - a.denied)
      .slice(0, 10);

    const total = this.totalAllowed + this.totalDenied;

    return {
      totalClients: this.buckets.size,
      activeClients,
      totalRequests: this.totalRequests,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
      denyRate: total > 0 ? this.totalDenied / total : 0,
      config: { ...this.config },
      topDeniedClients: clientDenyList,
    };
  }

  /**
   * Clear all rate limiting state.
   */
  clear(): void {
    this.buckets.clear();
    this.totalRequests = 0;
    this.totalAllowed = 0;
    this.totalDenied = 0;
  }

  /**
   * Shutdown the rate limiter and stop cleanup timers.
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }

  /**
   * Update configuration dynamically.
   *
   * @param config - Partial configuration to update
   */
  updateConfig(config: Partial<RateLimiterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private getOrCreateBucket(clientId: string): ClientBucket {
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = {
        tokens: this.config.bucketSize,
        lastRefillTime: Date.now(),
        totalRequests: 0,
        totalAllowed: 0,
        totalDenied: 0,
        lastRequestTime: Date.now(),
      };
      this.buckets.set(clientId, bucket);
    }
    return bucket;
  }

  private refillBucket(bucket: ClientBucket): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefillTime;
    const tokensToAdd = (elapsedMs / 1000) * this.config.tokensPerSecond;

    if (tokensToAdd >= 0.001) {
      // Only update if meaningful
      const effectiveBucketSize = this.config.allowBurst
        ? this.config.bucketSize * this.config.burstMultiplier
        : this.config.bucketSize;

      bucket.tokens = Math.min(bucket.tokens + tokensToAdd, effectiveBucketSize);
      bucket.lastRefillTime = now;
    }
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);

    // Don't prevent process exit
    this.cleanupTimer.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    const staleThreshold = now - this.config.clientTtlMs;
    const toDelete: string[] = [];

    for (const [clientId, bucket] of this.buckets.entries()) {
      if (bucket.lastRequestTime < staleThreshold) {
        toDelete.push(clientId);
      }
    }

    for (const clientId of toDelete) {
      this.buckets.delete(clientId);
    }

    // If still over max clients, remove oldest
    if (this.buckets.size > this.config.maxClients) {
      const sorted = Array.from(this.buckets.entries()).sort(
        (a, b) => a[1].lastRequestTime - b[1].lastRequestTime
      );

      const toRemove = this.buckets.size - this.config.maxClients;
      for (let i = 0; i < toRemove; i++) {
        this.buckets.delete(sorted[i][0]);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
let rateLimiterInstance: RateLimiter | null = null;

/**
 * Get or create the global rate limiter instance.
 *
 * @param config - Optional configuration for the rate limiter
 * @returns The global RateLimiter instance
 */
export function getRateLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter(config);
  }
  return rateLimiterInstance;
}

/**
 * Reset the global rate limiter instance.
 */
export function resetRateLimiter(): void {
  if (rateLimiterInstance) {
    rateLimiterInstance.shutdown();
  }
  rateLimiterInstance = null;
}
