/**
 * Semaphore for Concurrency Limiting
 *
 * Limits concurrent operations to prevent overwhelming local LLM models.
 *
 * @example
 * const semaphore = new Semaphore(2); // Max 2 concurrent
 *
 * async function limitedOperation() {
 *   await semaphore.acquire();
 *   try {
 *     return await expensiveOperation();
 *   } finally {
 *     semaphore.release();
 *   }
 * }
 */

export interface SemaphoreStats {
  total: number;
  available: number;
  waiting: number;
}

export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private waiting: Array<{ resolve: () => void; timeout?: ReturnType<typeof setTimeout> }> = [];
  private totalAcquired = 0;
  private totalReleased = 0;

  constructor(permits: number) {
    if (permits < 1) {
      throw new Error('Semaphore must have at least 1 permit');
    }
    this.permits = permits;
    this.maxPermits = permits;
  }

  /**
   * Acquire a permit, waiting if necessary
   * @param timeoutMs Optional timeout in milliseconds
   * @throws TimeoutError if timeout expires before permit acquired
   */
  async acquire(timeoutMs?: number): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      this.totalAcquired++;
      return;
    }

    // Need to wait for a permit
    return new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void; timeout?: ReturnType<typeof setTimeout> } = {
        resolve: () => {
          this.totalAcquired++;
          resolve();
        },
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          const idx = this.waiting.indexOf(waiter);
          if (idx !== -1) {
            this.waiting.splice(idx, 1);
            reject(new SemaphoreTimeoutError(`Semaphore acquire timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      this.waiting.push(waiter);
    });
  }

  /**
   * Try to acquire a permit without waiting
   * @returns true if permit was acquired, false otherwise
   */
  tryAcquire(): boolean {
    if (this.permits > 0) {
      this.permits--;
      this.totalAcquired++;
      return true;
    }
    return false;
  }

  /**
   * Release a permit
   */
  release(): void {
    this.totalReleased++;

    const next = this.waiting.shift();
    if (next) {
      if (next.timeout) {
        clearTimeout(next.timeout);
      }
      // Don't increment permits - giving directly to waiter
      next.resolve();
    } else {
      this.permits++;
      // Ensure we don't exceed max permits
      if (this.permits > this.maxPermits) {
        this.permits = this.maxPermits;
      }
    }
  }

  /**
   * Get current stats
   */
  getStats(): SemaphoreStats {
    return {
      total: this.maxPermits,
      available: this.permits,
      waiting: this.waiting.length,
    };
  }

  /**
   * Get available permit count
   */
  available(): number {
    return this.permits;
  }

  /**
   * Get number of waiting requests
   */
  waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Execute function with semaphore guard
   */
  async withPermit<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Error thrown when semaphore acquire times out
 */
export class SemaphoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemaphoreTimeoutError';
  }
}

/**
 * Registry for managing named semaphores
 */
export class SemaphoreRegistry {
  private semaphores = new Map<string, Semaphore>();

  /**
   * Get or create a semaphore by name
   */
  get(name: string, permits = 2): Semaphore {
    let semaphore = this.semaphores.get(name);
    if (!semaphore) {
      semaphore = new Semaphore(permits);
      this.semaphores.set(name, semaphore);
    }
    return semaphore;
  }

  /**
   * Get all semaphore stats
   */
  getAllStats(): Record<string, SemaphoreStats> {
    const stats: Record<string, SemaphoreStats> = {};
    for (const [name, semaphore] of this.semaphores) {
      stats[name] = semaphore.getStats();
    }
    return stats;
  }
}

// Default singleton registry
let defaultRegistry: SemaphoreRegistry | null = null;

export function getSemaphoreRegistry(): SemaphoreRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SemaphoreRegistry();
  }
  return defaultRegistry;
}

export function resetSemaphoreRegistry(): void {
  defaultRegistry = null;
}
