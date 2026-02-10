import { BaseBackend, createAdapterError } from './base.js';
import {
  ProbeResult,
  ModelInfo,
  ChatRequest,
  ChatResponse,
  OpenAIModelsResponse,
  OpenAIChatCompletionResponse,
  OpenAIModelData,
  TimeoutsConfig,
} from '../types/index.js';
import { CircuitOpenError } from '../utils/circuit-breaker.js';
import {
  DEFAULT_TIMEOUTS,
  applyReasoningFallback,
  getChatTimeoutMs,
  getListModelsTimeoutMs,
  executeWithBackendGuards,
  createBackendCircuitBreaker,
  createBackendSemaphore,
  type CircuitBreaker,
  type CircuitBreakerStats,
  type Semaphore,
  type SemaphoreStats,
} from './shared.js';

export class LmStudioAdapter extends BaseBackend {
  id: string;
  kind = 'local' as const;
  displayName = 'LM Studio';

  private apiBaseUrl: string;
  private timeouts: TimeoutsConfig;
  private circuitBreaker: CircuitBreaker;
  private concurrencyLimit: Semaphore;

  constructor(
    id: string,
    baseUrl: string = 'http://127.0.0.1:1234',
    timeouts?: Partial<TimeoutsConfig>
  ) {
    super();
    this.id = id;
    const trimmed = baseUrl.replace(/\/+$/, '');
    this.apiBaseUrl = /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.circuitBreaker = createBackendCircuitBreaker('LMStudio', id);
    this.concurrencyLimit = createBackendSemaphore(2);
  }

  /**
   * Get current backend health status with timing information
   */
  async getHealthStatus(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
    modelLoaded?: boolean;
  }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30 second health check timeout

      const response = await fetch(`${this.apiBaseUrl}/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return { healthy: false, latencyMs, error: `HTTP ${response.status}` };
      }

      const data = (await response.json()) as { data?: unknown[] };
      const modelLoaded = Array.isArray(data?.data) && data.data.length > 0;

      return { healthy: true, latencyMs, modelLoaded };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async probe(): Promise<ProbeResult> {
    try {
      await this.makeRequest(
        `${this.apiBaseUrl}/models`,
        { method: 'GET' },
        getListModelsTimeoutMs(this.timeouts)
      );

      return {
        available: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      // Extract hint from AdapterError if available, otherwise provide fallback hints
      let hint = '';
      const adapterError = error as { errorType?: string; hint?: string };
      if (adapterError.hint) {
        hint = ` - ${adapterError.hint}`;
      } else if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED')) {
        hint = ` - Is LM Studio running at ${this.apiBaseUrl.replace('/v1', '')}? Check that a model is loaded.`;
      } else if (errorMsg.includes('timed out')) {
        hint = ' - LM Studio may be busy loading a model. Try again in a few seconds.';
      }
      return {
        available: false,
        error: errorMsg + hint,
      };
    }
  }

  /**
   * Quick health check with short timeout (1 second).
   * Use this to verify LM Studio is reachable before making expensive calls.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000); // 1 second timeout

      const response = await fetch(`${this.apiBaseUrl}/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.makeRequest(
        `${this.apiBaseUrl}/models`,
        { method: 'GET' },
        getListModelsTimeoutMs(this.timeouts)
      );

      const data = (await response.json()) as OpenAIModelsResponse;

      if (!data.data || !Array.isArray(data.data)) {
        return [];
      }

      return data.data.map((model: OpenAIModelData) => ({
        id: model.id,
        name: model.id,
        context_length: undefined, // LM Studio doesn't expose this consistently
        capabilities: ['chat', 'completion'],
      }));
    } catch (error) {
      // Log with hint if available
      const adapterError = error as { hint?: string };
      const hint = adapterError.hint ? ` Hint: ${adapterError.hint}` : '';
      console.error(
        `Failed to list LM Studio models: ${error instanceof Error ? error.message : error}${hint}`
      );
      return [];
    }
  }

  async invokeChat(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    return executeWithBackendGuards(this.concurrencyLimit, this.circuitBreaker, async () =>
      this._invokeChatInternal(req, options)
    );
  }

  /**
   * Internal chat implementation - called through circuit breaker
   */
  private async _invokeChatInternal(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    const model = req.model || (await this.listModels())[0]?.id || 'local-model';
    const startTime = Date.now();

    // LM Studio's OpenAI-compatible endpoint is stricter than some other providers.
    // In practice, passing through extra message fields (e.g., tool_call_id) or
    // invalid numeric values (NaN/float max_tokens) can cause HTTP 400.
    const messages = Array.isArray(req.messages)
      ? req.messages.map((m) => {
          const role = typeof (m as any)?.role === 'string' ? String((m as any).role) : 'user';
          const contentRaw = (m as any)?.content;
          const content = typeof contentRaw === 'string' ? contentRaw : String(contentRaw ?? '');
          return { role, content };
        })
      : [];

    // Guard: LM Studio requires at least one message with non-empty content
    // Empty messages array causes HTTP 400 "Invalid request format"
    // Use AdapterError with status 400 to avoid triggering circuit breaker
    if (messages.length === 0 || !messages.some((m) => m.content.trim().length > 0)) {
      throw createAdapterError(
        'Cannot send chat request: messages array is empty or has no content. ' +
          'LM Studio requires at least one message with non-empty content.',
        'bad_request',
        400
      );
    }

    const openaiRequest: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    if (typeof req.temperature === 'number' && Number.isFinite(req.temperature)) {
      openaiRequest.temperature = req.temperature;
    }
    if (
      typeof req.max_tokens === 'number' &&
      Number.isInteger(req.max_tokens) &&
      req.max_tokens > 0
    ) {
      openaiRequest.max_tokens = req.max_tokens;
    }

    try {
      const response = await this.makeRequest(
        `${this.apiBaseUrl}/chat/completions`,
        { method: 'POST', body: JSON.stringify(openaiRequest) },
        options?.timeoutMs ?? getChatTimeoutMs(this.timeouts),
        { operation: `chat(${model})` },
        { signal: options?.signal }
      );

      const data = (await response.json()) as OpenAIChatCompletionResponse;
      const duration = Date.now() - startTime;

      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(
          `Invalid response from LM Studio after ${duration}ms: missing choices or message`
        );
      }

      // Fall back to `reasoning` field if `content` is empty
      applyReasoningFallback(data.choices[0].message as any);

      // Log slow responses for diagnostics
      if (
        duration > 30000 &&
        (process.env.DEBUG_ADAPTER === '1' || process.env.DEBUG_LLM === '1')
      ) {
        console.error(
          `[LMStudio] Slow response: ${duration}ms for model ${model} (${req.messages.length} messages)`
        );
      }

      return {
        message: data.choices[0].message,
        usage: data.usage
          ? {
              prompt_tokens: data.usage.prompt_tokens,
              completion_tokens: data.usage.completion_tokens,
              total_tokens: data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      // Re-throw with enhanced message including hint and timing
      const adapterError = error as { errorType?: string; hint?: string; message?: string };
      if (adapterError.hint) {
        const enhancedMsg = `${adapterError.message || error} (took ${duration}ms) - ${adapterError.hint}`;
        const enhancedError = new Error(enhancedMsg);
        (enhancedError as any).errorType = adapterError.errorType;
        (enhancedError as any).retryable = (error as any).retryable;
        throw enhancedError;
      }
      throw error;
    }
  }

  /**
   * Get circuit breaker statistics for monitoring
   */
  getCircuitBreakerStats(): CircuitBreakerStats {
    return this.circuitBreaker.getStats();
  }

  /**
   * Check if circuit breaker is open (backend considered unavailable)
   */
  isCircuitOpen(): boolean {
    return this.circuitBreaker.getState() === 'open';
  }

  /**
   * Manually reset the circuit breaker (for admin use)
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Get concurrency limiter statistics for monitoring
   */
  getConcurrencyStats(): SemaphoreStats {
    return this.concurrencyLimit.getStats();
  }
}

export { CircuitOpenError };
