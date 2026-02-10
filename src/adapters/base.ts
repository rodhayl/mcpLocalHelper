import { LlmBackend, ProbeResult, ModelInfo, ChatRequest, ChatResponse } from '../types/index.js';

/**
 * Classified error types for better diagnostics and actionable hints
 */
export type AdapterErrorType =
  | 'connection_refused'
  | 'connection_reset'
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'not_found'
  | 'bad_request'
  | 'unauthorized'
  | 'unknown';

export interface AdapterError extends Error {
  errorType: AdapterErrorType;
  statusCode?: number;
  retryable: boolean;
  hint: string;
}

/**
 * Create a classified adapter error with actionable hints
 */
export function createAdapterError(
  message: string,
  errorType: AdapterErrorType,
  statusCode?: number,
  baseUrl?: string
): AdapterError {
  const hints: Record<AdapterErrorType, string> = {
    connection_refused: `Backend unreachable at ${baseUrl || 'configured URL'}. Ensure the LLM server is running and accessible.`,
    connection_reset:
      'Connection was reset by the server. The backend may be overloaded or restarting.',
    timeout:
      'Request timed out. The model may be overloaded or the request is too complex. Try reducing prompt size or increasing timeout.',
    rate_limited:
      'Rate limited by the backend. Wait a moment and retry, or reduce request frequency.',
    server_error: 'Backend returned a server error. Check the LLM server logs for details.',
    not_found:
      'Endpoint or model not found. Verify the model is loaded and the API path is correct.',
    bad_request: 'Invalid request format. Check the request parameters.',
    unauthorized: 'Authentication failed. Check API keys or credentials.',
    unknown: 'An unexpected error occurred. Check server logs for details.',
  };

  const retryable = [
    'connection_refused',
    'connection_reset',
    'timeout',
    'rate_limited',
    'server_error',
  ].includes(errorType);

  const error = new Error(message) as AdapterError;
  error.errorType = errorType;
  error.statusCode = statusCode;
  error.retryable = retryable;
  error.hint = hints[errorType];
  error.name = 'AdapterError';
  return error;
}

/**
 * Classify an error into a known type for retry decisions and hints
 */
function classifyError(error: unknown, baseUrl?: string): AdapterError {
  const msg = error instanceof Error ? error.message : String(error);
  const lowerMsg = msg.toLowerCase();

  // Connection errors
  if (lowerMsg.includes('econnrefused') || lowerMsg.includes('fetch failed')) {
    return createAdapterError(msg, 'connection_refused', undefined, baseUrl);
  }
  if (
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('epipe') ||
    lowerMsg.includes('socket hang up')
  ) {
    return createAdapterError(msg, 'connection_reset', undefined, baseUrl);
  }
  if (
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('aborted')
  ) {
    return createAdapterError(msg, 'timeout', undefined, baseUrl);
  }

  // HTTP status-based errors
  const httpMatch = msg.match(/HTTP (\d{3})/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    if (status === 429) {
      return createAdapterError(msg, 'rate_limited', status, baseUrl);
    }
    if (status === 401 || status === 403) {
      return createAdapterError(msg, 'unauthorized', status, baseUrl);
    }
    if (status === 404) {
      return createAdapterError(msg, 'not_found', status, baseUrl);
    }
    if (status === 400) {
      return createAdapterError(msg, 'bad_request', status, baseUrl);
    }
    if (status >= 500 && status < 600) {
      return createAdapterError(msg, 'server_error', status, baseUrl);
    }
  }

  // Unknown error
  return createAdapterError(msg, 'unknown', undefined, baseUrl);
}

export abstract class BaseBackend implements LlmBackend {
  abstract id: string;
  abstract kind: 'local' | 'sota';
  abstract displayName: string;

  /**
   * Get retry configuration from environment variables
   * Enhanced with jitter support to prevent thundering herd
   */
  protected getRetryConfig(): {
    maxRetries: number;
    baseDelayMs: number;
    backoffMultiplier: number;
    maxDelayMs: number;
    jitterFactor: number;
  } {
    const retriesRaw = process.env.LLM_ADAPTER_RETRIES;
    const delayRaw = process.env.LLM_ADAPTER_RETRY_DELAY_MS;
    const backoffRaw = process.env.LLM_ADAPTER_RETRY_BACKOFF;
    const maxDelayRaw = process.env.LLM_ADAPTER_MAX_DELAY_MS;
    const jitterRaw = process.env.LLM_ADAPTER_JITTER;

    const maxRetries = retriesRaw ? Math.max(0, parseInt(retriesRaw, 10)) : 3;
    const baseDelayMs = delayRaw ? Math.max(0, parseInt(delayRaw, 10)) : 500;
    const backoffMultiplier = backoffRaw ? Math.max(1, parseFloat(backoffRaw)) : 1.5;
    const maxDelayMs = maxDelayRaw ? Math.max(0, parseInt(maxDelayRaw, 10)) : 30000;
    const jitterFactor = jitterRaw ? Math.max(0, Math.min(1, parseFloat(jitterRaw))) : 0.2;

    return {
      maxRetries: Number.isFinite(maxRetries) ? maxRetries : 3,
      baseDelayMs: Number.isFinite(baseDelayMs) ? baseDelayMs : 500,
      backoffMultiplier: Number.isFinite(backoffMultiplier) ? backoffMultiplier : 1.5,
      maxDelayMs: Number.isFinite(maxDelayMs) ? maxDelayMs : 30000,
      jitterFactor: Number.isFinite(jitterFactor) ? jitterFactor : 0.2,
    };
  }

  /**
   * Sleep helper for retry delays with jitter support
   */
  protected async sleep(ms: number, jitterFactor: number = 0): Promise<void> {
    if (ms <= 0) return;
    // Add jitter to prevent thundering herd problem
    const jitter = jitterFactor > 0 ? ms * jitterFactor * (Math.random() - 0.5) * 2 : 0;
    const effectiveDelay = Math.max(0, Math.round(ms + jitter));
    await new Promise((resolve) => setTimeout(resolve, effectiveDelay));
  }

  /**
   * Calculate delay for a given retry attempt with exponential backoff and jitter
   */
  protected calculateRetryDelay(attempt: number): number {
    const { baseDelayMs, backoffMultiplier, maxDelayMs, jitterFactor } = this.getRetryConfig();
    const exponentialDelay = Math.round(baseDelayMs * Math.pow(backoffMultiplier, attempt));
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    // Add jitter to prevent thundering herd
    const jitter = jitterFactor > 0 ? cappedDelay * jitterFactor * (Math.random() - 0.5) * 2 : 0;
    return Math.max(0, Math.round(cappedDelay + jitter));
  }

  /**
   * Get adaptive timeout that increases with retry attempts
   * This helps handle temporarily slow backends
   */
  protected getAdaptiveTimeout(baseTimeoutMs: number, attempt: number): number {
    // Increase timeout by 25% for each retry, capped at 3x original
    const multiplier = Math.min(3, 1 + attempt * 0.25);
    return Math.round(baseTimeoutMs * multiplier);
  }

  /**
   * Make an HTTP request with retry logic, adaptive timeouts, and classified error handling
   * Enhanced with:
   * - Adaptive timeout escalation for retries
   * - Jitter to prevent thundering herd
   * - Better progress tracking for diagnostics
   */
  protected async makeRequest(
    url: string,
    options: RequestInit,
    timeoutMs?: number,
    requestContext?: { operation?: string; attempt?: number },
    control?: { signal?: AbortSignal }
  ): Promise<Response> {
    const envTimeoutRaw = process.env.LLM_HTTP_TIMEOUT_MS;
    const envTimeout = envTimeoutRaw ? Number.parseInt(envTimeoutRaw, 10) : NaN;
    const baseTimeoutMs =
      timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180000);

    const { maxRetries, jitterFactor } = this.getRetryConfig();
    const baseUrl = new URL(url).origin;
    const operation = requestContext?.operation || 'request';

    let lastError: AdapterError | null = null;
    const startTime = Date.now();
    const requestId = `${this.id}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (control?.signal?.aborted) {
        const aborted = classifyError(new Error('aborted'), baseUrl);
        aborted.retryable = false;
        throw aborted;
      }

      // Adaptive timeout: increase for retries to handle temporary slowdowns
      const adaptiveTimeout = this.getAdaptiveTimeout(baseTimeoutMs, attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(
          new Error(`Request timed out after ${adaptiveTimeout}ms (attempt ${attempt + 1})`)
        );
      }, adaptiveTimeout);
      const onAbort = () => {
        try {
          controller.abort(new Error('aborted'));
        } catch {
          // Intentionally empty - abort errors are expected during cleanup
        }
      };
      if (control?.signal) {
        if (control.signal.aborted) {
          onAbort();
        } else {
          try {
            control.signal.addEventListener('abort', onAbort, { once: true });
          } catch {
            // Intentionally empty - signal listener errors are non-critical
          }
        }
      }

      const attemptStart = Date.now();

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
            ...options.headers,
          },
        });

        clearTimeout(timer);
        if (control?.signal) {
          try {
            control.signal.removeEventListener('abort', onAbort);
          } catch {
            // Intentionally empty - listener removal errors are non-critical
          }
        }
        const attemptDuration = Date.now() - attemptStart;

        if (!response.ok) {
          const errorMsg = `HTTP ${response.status}: ${response.statusText}`;
          const classified = classifyError(new Error(errorMsg), baseUrl);

          // Don't retry non-retryable errors
          if (!classified.retryable || attempt >= maxRetries) {
            classified.message = `${classified.message} (after ${attempt + 1} attempt(s), ${Date.now() - startTime}ms total)`;
            throw classified;
          }

          lastError = classified;
          const delay = this.calculateRetryDelay(attempt);
          if (process.env.DEBUG_ADAPTER === '1' || process.env.DEBUG_LLM === '1') {
            console.error(
              `[Adapter] ${operation} failed (attempt ${attempt + 1}/${maxRetries + 1}, ${attemptDuration}ms): ${errorMsg}; retrying in ${delay}ms (adaptive timeout: ${adaptiveTimeout}ms)`
            );
          }
          await this.sleep(delay, jitterFactor);
          continue;
        }

        // Log success on retry for diagnostics
        if (attempt > 0 && (process.env.DEBUG_ADAPTER === '1' || process.env.DEBUG_LLM === '1')) {
          console.error(
            `[Adapter] ${operation} succeeded on attempt ${attempt + 1} after ${Date.now() - startTime}ms total`
          );
        }

        return response;
      } catch (error) {
        clearTimeout(timer);
        if (control?.signal) {
          try {
            control.signal.removeEventListener('abort', onAbort);
          } catch {
            // Intentionally empty - listener removal errors are non-critical
          }
        }
        const attemptDuration = Date.now() - attemptStart;

        // Already classified error
        if ((error as AdapterError).errorType) {
          throw error;
        }

        const classified = classifyError(error, baseUrl);
        if (control?.signal?.aborted) {
          classified.retryable = false;
          throw classified;
        }

        // Don't retry non-retryable errors
        if (!classified.retryable || attempt >= maxRetries) {
          classified.message = `${classified.message} (after ${attempt + 1} attempt(s), ${Date.now() - startTime}ms total)`;
          throw classified;
        }

        lastError = classified;
        const delay = this.calculateRetryDelay(attempt);
        if (process.env.DEBUG_ADAPTER === '1' || process.env.DEBUG_LLM === '1') {
          console.error(
            `[Adapter] ${operation} failed (attempt ${attempt + 1}/${maxRetries + 1}, ${attemptDuration}ms): ${classified.message}; retrying in ${delay}ms (next timeout: ${this.getAdaptiveTimeout(baseTimeoutMs, attempt + 1)}ms)`
          );
        }
        await this.sleep(delay, jitterFactor);
      }
    }

    // Enhance the final error with total duration info
    const totalDuration = Date.now() - startTime;
    if (lastError) {
      lastError.message = `${lastError.message} (exhausted ${maxRetries + 1} attempts over ${totalDuration}ms)`;
    }

    throw (
      lastError ||
      createAdapterError(
        `Request failed after all retries (${totalDuration}ms total)`,
        'unknown',
        undefined,
        baseUrl
      )
    );
  }

  abstract probe(): Promise<ProbeResult>;
  abstract listModels(): Promise<ModelInfo[]>;
  abstract invokeChat(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse>;
}
