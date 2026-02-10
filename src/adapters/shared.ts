/**
 * Shared adapter utilities
 *
 * Centralizes patterns duplicated across multiple adapters:
 * - Default timeout configuration
 * - Reasoning fallback for OpenAI-compatible responses
 * - Circuit breaker + semaphore factory helpers
 */

import { TimeoutsConfig } from '../types/index.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { Semaphore } from '../utils/semaphore.js';

/**
 * Default TimeoutsConfig values.
 * Matches the Zod defaults in TimeoutsConfigSchema.
 * Used by adapters that accept an optional `Partial<TimeoutsConfig>`.
 */
export const DEFAULT_TIMEOUTS: TimeoutsConfig = {
  tierInstant: 5000,
  tierScript: 30000,
  tierLlmShort: 300000,
  tierLlmLong: 900000,
  backendListModels: 30000,
  backendChat: 600000,
  backendHealthCheck: 30000,
  backendProbe: 10000,
  backendQuickHealth: 2000,
  mcpClientConnect: 15000,
  mcpClientCall: 30000,
  mcpClientLock: 30000,
  agentTaskSync: 90000,
  agentTaskAsync: 900000,
  taskQueue: 300000,
  taskStale: 600000,
  toolExecution: 60000,
  toolGit: 30000,
  httpBase: 180000,
  serverProbe: 5000,
  rateLimitTtl: 300000,
  llmInflight: 60000,
  systemProfileCheck: 2000,
  rootsListTimeout: 2000,
};

/**
 * Some providers (including certain LM Studio builds) may return an empty
 * `content` but include `reasoning`. This helper prefers `content` but
 * falls back to `reasoning` to avoid blank responses.
 *
 * Mutates the message in-place for compatibility with existing callers.
 */
export function applyReasoningFallback(message: {
  role: string;
  content: string;
  [key: string]: unknown;
}): void {
  const raw = message as unknown as { content?: string; reasoning?: string };
  const content = (raw.content || '').trim();
  const reasoning = (raw.reasoning || '').trim();
  if (!content && reasoning) {
    (message as any).content = reasoning;
  }
}

/**
 * Read a timeout value from an environment variable, falling back to a default.
 */
export function envTimeoutOrDefault(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  const v = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : defaultMs;
}

/**
 * Shared timeout resolution for model-list calls.
 */
export function getListModelsTimeoutMs(timeouts: TimeoutsConfig): number {
  return envTimeoutOrDefault('LLM_LIST_MODELS_TIMEOUT_MS', timeouts.backendListModels);
}

/**
 * Shared timeout resolution for chat/completion calls.
 */
export function getChatTimeoutMs(timeouts: TimeoutsConfig): number {
  return envTimeoutOrDefault('LLM_CHAT_TIMEOUT_MS', timeouts.backendChat);
}

/**
 * Create a standard circuit breaker for a backend adapter.
 * Uses consistent configuration across all adapters.
 */
export function createBackendCircuitBreaker(backendType: string, id: string): CircuitBreaker {
  return new CircuitBreaker(
    {
      failureThreshold: 3,
      resetTimeoutMs: 30000,
      halfOpenSuccessThreshold: 1,
      name: `${backendType}-${id}`,
      onStateChange: (from, to) => {
        console.error(`[${backendType}/${id}] Circuit breaker: ${from} -> ${to}`);
      },
    },
    // Custom failure classifier: don't count 4xx or validation errors
    (error: unknown) => {
      if (error && typeof error === 'object') {
        const e = error as { statusCode?: number; status?: number };
        if ((e.statusCode ?? e.status ?? 0) >= 400 && (e.statusCode ?? e.status ?? 0) < 500) {
          return false;
        }
      }
      return true;
    }
  );
}

/**
 * Standard concurrency limiter for backend adapters.
 */
export function createBackendSemaphore(maxConcurrent: number = 2): Semaphore {
  return new Semaphore(maxConcurrent);
}

/**
 * Execute backend operations with both concurrency and circuit-breaker guards.
 */
export async function executeWithBackendGuards<T>(
  semaphore: Semaphore,
  circuitBreaker: CircuitBreaker,
  operation: () => Promise<T>
): Promise<T> {
  await semaphore.acquire();
  try {
    return await circuitBreaker.execute(operation);
  } finally {
    semaphore.release();
  }
}

// Re-export types for convenience
export type { CircuitBreaker, CircuitBreakerStats } from '../utils/circuit-breaker.js';
export type { Semaphore, SemaphoreStats } from '../utils/semaphore.js';
