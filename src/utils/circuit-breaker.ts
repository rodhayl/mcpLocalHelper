/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascading failures by failing fast when a backend is unresponsive.
 *
 * States:
 * - CLOSED: Normal operation, tracking failures
 * - OPEN: Fail-fast mode, reject requests immediately
 * - HALF_OPEN: Test mode, allow limited requests to probe recovery
 *
 * @example
 * const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 });
 *
 * try {
 *   const result = await breaker.execute(() => fetchData());
 * } catch (error) {
 *   if (error instanceof CircuitOpenError) {
 *     // Handle fail-fast case
 *   }
 * }
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before attempting to half-open from open state */
  resetTimeoutMs: number;
  /** Number of test requests to allow in half-open state before closing */
  halfOpenSuccessThreshold?: number;
  /** Optional name for logging/metrics */
  name?: string;
  /** Callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState, breaker: CircuitBreaker) => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  readonly resetAfterMs: number;

  constructor(message: string, resetAfterMs: number) {
    super(message);
    this.name = 'CircuitOpenError';
    this.resetAfterMs = resetAfterMs;
  }
}

/**
 * Determines if an error should count as a circuit breaker failure
 */
export type FailureClassifier = (error: unknown) => boolean;

const defaultFailureClassifier: FailureClassifier = (error: unknown) => {
  // Don't count client errors (4xx) as circuit failures
  if (error && typeof error === 'object') {
    const statusCode = (error as any).statusCode || (error as any).status;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return false;
    }
    // Don't count validation errors
    if ((error as any).name === 'ZodError' || (error as any).name === 'ValidationError') {
      return false;
    }
  }
  return true;
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private halfOpenSuccesses = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private failureClassifier: FailureClassifier;

  constructor(
    private readonly config: CircuitBreakerConfig,
    failureClassifier?: FailureClassifier
  ) {
    this.failureClassifier = failureClassifier ?? defaultFailureClassifier;
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    // Check if we should transition from open to half-open
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - (this.lastFailureTime ?? 0);
      if (timeSinceFailure >= this.config.resetTimeoutMs) {
        this.transitionTo('half-open');
      } else {
        const remainingMs = this.config.resetTimeoutMs - timeSinceFailure;
        throw new CircuitOpenError(
          `Circuit breaker '${this.config.name ?? 'unnamed'}' is open. ` +
            `Will attempt reset in ${Math.ceil(remainingMs / 1000)}s.`,
          remainingMs
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      // Only count as circuit failure if classifier says so
      if (this.failureClassifier(error)) {
        this.onFailure();
      }
      throw error;
    }
  }

  /**
   * Record a successful execution
   */
  private onSuccess(): void {
    this.successes++;
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();
    this.failures = 0; // Reset consecutive failures

    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      const threshold = this.config.halfOpenSuccessThreshold ?? 1;
      if (this.halfOpenSuccesses >= threshold) {
        this.transitionTo('closed');
      }
    }
  }

  /**
   * Record a failed execution
   */
  private onFailure(): void {
    this.failures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      // Any failure in half-open immediately reopens
      this.transitionTo('open');
    } else if (this.state === 'closed') {
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;

    // Reset counters on state change
    if (newState === 'half-open') {
      this.halfOpenSuccesses = 0;
    } else if (newState === 'closed') {
      this.failures = 0;
      this.halfOpenSuccesses = 0;
    }

    // Notify listener
    if (this.config.onStateChange) {
      try {
        this.config.onStateChange(oldState, newState, this);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Force circuit to closed state (for testing/admin)
   */
  reset(): void {
    this.transitionTo('closed');
    this.failures = 0;
    this.successes = 0;
    this.halfOpenSuccesses = 0;
  }

  /**
   * Force circuit to open state (for maintenance)
   */
  trip(): void {
    this.lastFailureTime = Date.now();
    this.transitionTo('open');
  }

  /**
   * Check if circuit is allowing requests
   */
  isAllowingRequests(): boolean {
    if (this.state === 'closed' || this.state === 'half-open') {
      return true;
    }
    // Check if enough time has passed to transition to half-open
    const timeSinceFailure = Date.now() - (this.lastFailureTime ?? 0);
    return timeSinceFailure >= this.config.resetTimeoutMs;
  }
}

/**
 * Registry for managing multiple circuit breakers
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private defaultConfig: Partial<CircuitBreakerConfig> = {
    failureThreshold: 3,
    resetTimeoutMs: 30000,
    halfOpenSuccessThreshold: 1,
  };

  constructor(defaultConfig?: Partial<CircuitBreakerConfig>) {
    if (defaultConfig) {
      this.defaultConfig = { ...this.defaultConfig, ...defaultConfig };
    }
  }

  /**
   * Get or create a circuit breaker by name
   */
  get(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({
        ...this.defaultConfig,
        ...config,
        name,
      } as CircuitBreakerConfig);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Get all circuit breaker stats
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Check if any circuit is open
   */
  hasOpenCircuits(): boolean {
    for (const breaker of this.breakers.values()) {
      if (breaker.getState() === 'open') {
        return true;
      }
    }
    return false;
  }
}

// Default singleton registry
let defaultRegistry: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new CircuitBreakerRegistry();
  }
  return defaultRegistry;
}

export function resetCircuitBreakerRegistry(): void {
  defaultRegistry = null;
}
