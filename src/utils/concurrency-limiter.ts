/**
 * Simple async concurrency limiter (semaphore).
 *
 * Used to prevent stampedes against backends that don't tolerate high parallelism.
 *
 * Enhanced with:
 * - Timeout protection to prevent indefinite waiting
 * - Queue length limits to prevent unbounded growth
 * - Diagnostics for debugging concurrency issues
 */

export class ConcurrencyLimiterTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ConcurrencyLimiter: acquire() timed out after ${timeoutMs}ms`);
    this.name = 'ConcurrencyLimiterTimeoutError';
  }
}

export class ConcurrencyLimiterQueueFullError extends Error {
  constructor(maxQueueSize: number) {
    super(`ConcurrencyLimiter: queue full (max ${maxQueueSize} waiters)`);
    this.name = 'ConcurrencyLimiterQueueFullError';
  }
}

export interface ConcurrencyLimiterOptions {
  max: number;
  /** Maximum time to wait for a slot (default: 60000ms = 1 minute) */
  acquireTimeoutMs?: number;
  /** Maximum queue size before rejecting new requests (default: 100) */
  maxQueueSize?: number;
  /** Progressive timeout multiplier for queued position (default: 1.0 = no scaling) */
  queuePositionTimeoutMultiplier?: number;
}

export class ConcurrencyLimiter {
  private max: number;
  private running = 0;
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void; queuedAt: number }> =
    [];
  private acquireTimeoutMs: number;
  private maxQueueSize: number;
  private queuePositionTimeoutMultiplier: number;

  // Diagnostics
  private totalAcquires = 0;
  private totalTimeouts = 0;
  private totalQueueRejects = 0;
  private totalCompletedRuns = 0;
  private totalRunTimeMs = 0;
  private lastRunDurationMs = 0;

  constructor(maxOrOptions: number | ConcurrencyLimiterOptions) {
    if (typeof maxOrOptions === 'number') {
      this.max = Math.max(1, Math.floor(maxOrOptions));
      this.acquireTimeoutMs = 60000; // 1 minute default
      this.maxQueueSize = 100;
      this.queuePositionTimeoutMultiplier = 1.0;
    } else {
      this.max = Math.max(1, Math.floor(maxOrOptions.max));
      this.acquireTimeoutMs = maxOrOptions.acquireTimeoutMs ?? 60000;
      this.maxQueueSize = maxOrOptions.maxQueueSize ?? 100;
      this.queuePositionTimeoutMultiplier = maxOrOptions.queuePositionTimeoutMultiplier ?? 1.0;
    }
  }

  setMax(max: number): void {
    const next = Math.max(1, Math.floor(max));
    this.max = next;
    this.drain();
  }

  getStatus(): { running: number; queued: number; max: number } {
    return { running: this.running, queued: this.waiters.length, max: this.max };
  }

  /** Get detailed diagnostics for debugging */
  getDiagnostics(): {
    running: number;
    queued: number;
    max: number;
    totalAcquires: number;
    totalTimeouts: number;
    totalQueueRejects: number;
    totalCompletedRuns: number;
    avgRunTimeMs: number;
    lastRunDurationMs: number;
    acquireTimeoutMs: number;
    maxQueueSize: number;
    oldestWaiterAgeMs: number;
    estimatedWaitMs: number;
  } {
    const now = Date.now();
    const oldestWaiterAgeMs = this.waiters.length > 0 ? now - this.waiters[0].queuedAt : 0;

    // Estimate wait time based on average run time and queue position
    const avgRunTime =
      this.totalCompletedRuns > 0 ? this.totalRunTimeMs / this.totalCompletedRuns : 30000; // Default 30s estimate
    const estimatedWaitMs =
      this.waiters.length > 0 ? Math.round(avgRunTime * (this.waiters.length / this.max)) : 0;

    return {
      running: this.running,
      queued: this.waiters.length,
      max: this.max,
      totalAcquires: this.totalAcquires,
      totalTimeouts: this.totalTimeouts,
      totalQueueRejects: this.totalQueueRejects,
      totalCompletedRuns: this.totalCompletedRuns,
      avgRunTimeMs:
        this.totalCompletedRuns > 0 ? Math.round(this.totalRunTimeMs / this.totalCompletedRuns) : 0,
      lastRunDurationMs: this.lastRunDurationMs,
      acquireTimeoutMs: this.acquireTimeoutMs,
      maxQueueSize: this.maxQueueSize,
      oldestWaiterAgeMs,
      estimatedWaitMs,
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    const startTime = Date.now();
    try {
      return await fn();
    } finally {
      const duration = Date.now() - startTime;
      this.totalCompletedRuns++;
      this.totalRunTimeMs += duration;
      this.lastRunDurationMs = duration;
      this.release();
    }
  }

  /** Run with explicit timeout override */
  async runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    await this.acquireWithTimeout(timeoutMs);
    const startTime = Date.now();
    try {
      return await fn();
    } finally {
      const duration = Date.now() - startTime;
      this.totalCompletedRuns++;
      this.totalRunTimeMs += duration;
      this.lastRunDurationMs = duration;
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    return this.acquireWithTimeout(this.acquireTimeoutMs);
  }

  private async acquireWithTimeout(timeoutMs: number): Promise<void> {
    this.totalAcquires++;

    if (this.running < this.max) {
      this.running += 1;
      return;
    }

    // Check queue size limit
    if (this.waiters.length >= this.maxQueueSize) {
      this.totalQueueRejects++;
      throw new ConcurrencyLimiterQueueFullError(this.maxQueueSize);
    }

    const queuePosition = this.waiters.length;
    const now = Date.now();

    // Progressive timeout: increase timeout based on queue position
    // This gives later requests more time since they'll wait longer
    const effectiveTimeout =
      this.queuePositionTimeoutMultiplier > 1
        ? Math.round(timeoutMs * Math.pow(this.queuePositionTimeoutMultiplier, queuePosition))
        : timeoutMs;

    // FIFO fairness with timeout: acquire resolves in insertion order.
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, queuedAt: now };
      this.waiters.push(waiter);

      const timer = setTimeout(() => {
        // Remove this waiter from queue
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
          this.totalTimeouts++;
          const waitedMs = Date.now() - now;
          reject(new ConcurrencyLimiterTimeoutError(effectiveTimeout));

          // Log timeout for diagnostics
          if (process.env.DEBUG_CONCURRENCY === '1') {
            console.error(
              `[ConcurrencyLimiter] Timeout after ${waitedMs}ms waiting (position was ${queuePosition}, running=${this.running}/${this.max}, queued=${this.waiters.length})`
            );
          }
        }
      }, effectiveTimeout);

      // Wrap resolve to clear timer
      const originalResolve = waiter.resolve;
      waiter.resolve = () => {
        clearTimeout(timer);
        originalResolve();
      };
    });
    // Slot is already reserved by release()/drain() to prevent oversubscription.
  }

  private release(): void {
    if (this.waiters.length > 0) {
      // Transfer the slot directly to the next waiter (keeps running count stable).
      const waiter = this.waiters.shift();
      waiter?.resolve();
      return;
    }

    this.running = Math.max(0, this.running - 1);
  }

  private drain(): void {
    while (this.running < this.max && this.waiters.length > 0) {
      // Reserve the slot before waking the waiter to prevent thundering herds.
      this.running += 1;
      const waiter = this.waiters.shift();
      waiter?.resolve();
    }
  }
}
