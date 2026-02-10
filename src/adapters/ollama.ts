import { BaseBackend } from './base.js';
import {
  ProbeResult,
  ModelInfo,
  ChatRequest,
  ChatResponse,
  OllamaTagsResponse,
  OllamaChatResponse,
  OllamaModel,
  TimeoutsConfig,
} from '../types/index.js';
import { CircuitOpenError } from '../utils/circuit-breaker.js';
import {
  DEFAULT_TIMEOUTS,
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

export class OllamaAdapter extends BaseBackend {
  id: string;
  kind = 'local' as const;
  displayName = 'Ollama';

  private baseUrl: string;
  private timeouts: TimeoutsConfig;
  private circuitBreaker: CircuitBreaker;
  private concurrencyLimit: Semaphore;

  constructor(
    id: string,
    baseUrl: string = 'http://127.0.0.1:11434',
    timeouts?: Partial<TimeoutsConfig>
  ) {
    super();
    this.id = id;
    this.baseUrl = baseUrl;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.circuitBreaker = createBackendCircuitBreaker('Ollama', id);
    this.concurrencyLimit = createBackendSemaphore(2);
  }

  async probe(): Promise<ProbeResult> {
    try {
      // Use configurable probe timeout (default 10s instead of hardcoded 3s)
      const probeTimeoutMs = this.timeouts.backendProbe;
      const tagsRes = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (!tagsRes.ok) {
        throw new Error(`HTTP ${tagsRes.status}: ${tagsRes.statusText}`);
      }
      const tags = (await tagsRes.json().catch(() => null)) as unknown;
      if (!tags || typeof tags !== 'object' || !('models' in (tags as any))) {
        return { available: false, error: 'Unexpected /api/tags response shape' };
      }

      // Verify POST exists
      const chatProbe = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (!chatProbe || chatProbe.status === 404) {
        return { available: false, error: 'Endpoint /api/chat not found' };
      }
      return {
        available: true,
        version: 'unknown', // Ollama doesn't expose version in simple probe
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      // Extract hint from AdapterError if available
      const adapterError = error as { hint?: string };
      let hint = '';
      if (adapterError.hint) {
        hint = ` - ${adapterError.hint}`;
      } else if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED')) {
        hint = ` - Is Ollama running at ${this.baseUrl}? Run 'ollama serve' to start the server.`;
      } else if (errorMsg.includes('timed out')) {
        hint = ' - Ollama may be loading a model. Try again in a few seconds.';
      }
      return {
        available: false,
        error: errorMsg + hint,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.makeRequest(
        `${this.baseUrl}/api/tags`,
        { method: 'GET' },
        getListModelsTimeoutMs(this.timeouts)
      );

      const data = (await response.json()) as OllamaTagsResponse;

      if (!data.models || !Array.isArray(data.models)) {
        return [];
      }

      return data.models.map((model: OllamaModel) => ({
        id: model.name,
        name: model.name,
        context_length: model.details?.parameter_size
          ? this.parseContextLength(model.details.parameter_size)
          : undefined,
        capabilities: ['chat', 'completion'],
      }));
    } catch (error) {
      // Log with hint if available
      const adapterError = error as { hint?: string };
      const hint = adapterError.hint ? ` Hint: ${adapterError.hint}` : '';
      console.error(
        `Failed to list Ollama models: ${error instanceof Error ? error.message : error}${hint}`
      );
      return [];
    }
  }

  /**
   * QA_feedback_9: Get current backend health status with model loading info
   */
  async getHealthStatus(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
    modelLoaded?: boolean;
    modelCount?: number;
  }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return { healthy: false, latencyMs, error: `HTTP ${response.status}` };
      }

      const data = (await response.json()) as { models?: unknown[] };
      const modelCount = Array.isArray(data?.models) ? data.models.length : 0;
      const modelLoaded = modelCount > 0;

      return { healthy: true, latencyMs, modelLoaded, modelCount };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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

  private async _invokeChatInternal(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    const fallback = (await this.listModels())[0]?.id || 'llama2';
    const model = req.model || fallback;

    const ollamaRequest = {
      model,
      messages: req.messages,
      stream: false,
      options: {
        temperature: req.temperature,
        num_predict: req.max_tokens,
      },
    };

    try {
      const response = await this.makeRequest(
        `${this.baseUrl}/api/chat`,
        { method: 'POST', body: JSON.stringify(ollamaRequest) },
        options?.timeoutMs ?? getChatTimeoutMs(this.timeouts),
        undefined,
        { signal: options?.signal }
      );

      const data = (await response.json()) as OllamaChatResponse;

      if (!data.message) {
        throw new Error('Invalid response from Ollama: missing message');
      }

      return {
        message: {
          role: 'assistant',
          content: data.message.content,
        },
        usage: data.prompt_eval_count
          ? {
              prompt_tokens: data.prompt_eval_count,
              completion_tokens: data.eval_count || 0,
              total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
            }
          : undefined,
      };
    } catch (error) {
      // Re-throw with enhanced message including hint
      const adapterError = error as { errorType?: string; hint?: string; message?: string };
      if (adapterError.hint) {
        const enhancedMsg = `${adapterError.message || error} - ${adapterError.hint}`;
        const enhancedError = new Error(enhancedMsg);
        (enhancedError as any).errorType = adapterError.errorType;
        (enhancedError as any).retryable = (error as any).retryable;
        throw enhancedError;
      }
      throw error;
    }
  }

  private parseContextLength(parameterSize: string): number {
    // Parse parameter size like "7B" or "13B"
    const match = parameterSize.match(/(\d+)B/);
    if (match) {
      const billions = parseInt(match[1]);
      // Rough estimation: 2048 tokens per billion parameters
      return billions * 2048;
    }
    return 4096; // Default fallback
  }

  getCircuitBreakerStats(): CircuitBreakerStats {
    return this.circuitBreaker.getStats();
  }

  isCircuitOpen(): boolean {
    return this.circuitBreaker.getState() === 'open';
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  getConcurrencyStats(): SemaphoreStats {
    return this.concurrencyLimit.getStats();
  }
}

export { CircuitOpenError };
