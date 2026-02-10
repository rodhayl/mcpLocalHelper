import { ChatRequest, ChatResponse, BackendKind, LlmBackend } from '../types/index.js';
import { BackendManager } from '../adapters/factory.js';
import { ConfigManager } from '../config/index.js';
import { RedactionEngine } from '../utils/redaction.js';
import { getLLMCache, LLMCacheStats } from '../utils/llm-cache.js';
import { ConcurrencyLimiter } from '../utils/concurrency-limiter.js';
import { diagnoseConnectionError } from '../utils/llm-error-helper.js';
import { CircuitOpenError } from '../utils/circuit-breaker.js';

const DEFAULT_MAX_CONCURRENT_LLM_CALLS = 3;
const llmCallLimiter = new ConcurrencyLimiter(DEFAULT_MAX_CONCURRENT_LLM_CALLS);
let llmCallLimiterMax = DEFAULT_MAX_CONCURRENT_LLM_CALLS;

// Request ID counter for tracing concurrent requests
let requestIdCounter = 0;
function generateRequestId(): string {
  return `req-${++requestIdCounter}-${Date.now()}`;
}

export interface LlmChatCallMeta {
  backendRole: BackendKind;
  backendId: string;
  model: string | null;
  cache: {
    enabled: boolean;
    key: string;
    cached: boolean;
    coalesced: boolean;
    coalescedWithRequestId?: string;
  };
  timing: {
    startedAt: string;
    elapsedMs: number;
  };
  // QA_feedback_26012026: Track fallback attempts for circuit breaker recovery
  fallback?: {
    attempted: boolean;
    primaryBackendId: string;
    primaryError: string;
    fallbackBackendId?: string;
    fallbackSuccess: boolean;
  };
}

export class LlmChatTool {
  private backendManager: BackendManager;
  private config: ConfigManager;
  private redaction: RedactionEngine;
  // Improved inflight cache with proper cleanup, timeout, and request tracking
  private inflightCache: Map<
    string,
    { promise: Promise<ChatResponse>; timestamp: number; requestId: string }
  > = new Map();
  private lastInflightCleanup = 0;
  private readonly cleanupIntervalMs = 10000; // Cleanup every 10 seconds

  constructor(backendManager: BackendManager, config: ConfigManager) {
    this.backendManager = backendManager;
    this.config = config;
    const mode =
      this.config.getConfig().privacy?.secretPatterns === 'strict' ? 'strict' : 'default';
    this.redaction = new RedactionEngine({ mode });
  }

  private getConfigUrl(): string {
    const serverConfig = this.config.getConfig().server;
    const host = serverConfig?.host || 'localhost';
    const port = serverConfig?.port || 3000;
    return `http://${host}:${port}/`;
  }

  /**
   * QA_feedback_26012026: Get fallback backends for circuit breaker recovery
   *
   * In orchestration mode (CLI primary), the order is:
   * 1. copilot-cli (if configured and primary failed)
   * 2. opencode-cli (if configured)
   * 3. Local LLM (lmstudio/ollama as ultimate fallback)
   *
   * In normal mode (local primary), the order is:
   * 1. Other local backends (lmstudio/ollama)
   * 2. CLI backends (if configured)
   */
  private getFallbackBackends(primaryBackendId: string): LlmBackend[] {
    const allBackends = this.backendManager.getAllBackends();
    const envSettings = this.config.getEnvSettings();
    const cliOrchestrationEnabled = envSettings.advanced?.cliOrchestrationEnabled || false;

    // Filter out the failed primary backend
    const candidates = allBackends.filter((b) => b.id !== primaryBackendId && b.kind === 'local');

    if (cliOrchestrationEnabled) {
      // In CLI orchestration mode: prefer CLI backends, use local as fallback
      // Order: copilot-cli -> opencode-cli -> local backends (lmstudio/ollama)
      const cliBackends = candidates.filter(
        (b) =>
          b.id.includes('copilot') ||
          b.id.includes('opencode') ||
          (b as any).displayName?.includes('CLI')
      );
      const localBackends = candidates.filter(
        (b) =>
          !b.id.includes('copilot') &&
          !b.id.includes('opencode') &&
          !(b as any).displayName?.includes('CLI')
      );

      // Put copilot first, then opencode, then local
      const sortedCli = cliBackends.sort((a, b) => {
        if (a.id.includes('copilot')) return -1;
        if (b.id.includes('copilot')) return 1;
        return 0;
      });

      return [...sortedCli, ...localBackends];
    } else {
      // Normal mode: prefer local backends, use CLI as fallback
      const localBackends = candidates.filter(
        (b) =>
          !b.id.includes('copilot') &&
          !b.id.includes('opencode') &&
          !(b as any).displayName?.includes('CLI')
      );
      const cliBackends = candidates.filter(
        (b) =>
          b.id.includes('copilot') ||
          b.id.includes('opencode') ||
          (b as any).displayName?.includes('CLI')
      );

      return [...localBackends, ...cliBackends];
    }
  }

  /**
   * Cleanup stale inflight requests to prevent memory leaks
   * Safe to call frequently - uses interval check internally
   */
  private cleanupInflight(): void {
    const now = Date.now();
    if (now - this.lastInflightCleanup < this.cleanupIntervalMs) {
      return;
    }
    this.lastInflightCleanup = now;

    // Cleanup entries that are old - the promise should have completed by now
    // If a promise is still pending after timeout, it's likely stuck
    let cleanedCount = 0;
    const inflightTimeoutMs = this.config.getTimeouts().llmInflight;
    for (const [key, entry] of this.inflightCache.entries()) {
      if (now - entry.timestamp > inflightTimeoutMs) {
        this.inflightCache.delete(key);
        cleanedCount++;
        // Log stale request cleanup for debugging
        if (process.env.DEBUG_CACHE === '1' || process.env.DEBUG_LLM === '1') {
          console.error(
            `[LLM] Cleaned up stale inflight request: ${entry.requestId} (key: ${key.substring(0, 8)}...)`
          );
        }
      }
    }

    if (cleanedCount > 0 && (process.env.DEBUG_CACHE === '1' || process.env.DEBUG_LLM === '1')) {
      console.error(
        `[LLM] Cleaned up ${cleanedCount} stale inflight requests, ${this.inflightCache.size} remaining`
      );
    }
  }

  private getRetryConfig(): { retries: number; delayMs: number; backoff: number } {
    const retriesRaw = process.env.LLM_CHAT_RETRIES;
    const delayRaw = process.env.LLM_CHAT_RETRY_DELAY_MS;
    const backoffRaw = process.env.LLM_CHAT_RETRY_BACKOFF;

    const retries = retriesRaw ? Math.max(0, Number.parseInt(retriesRaw, 10)) : 2;
    const delayMs = delayRaw ? Math.max(0, Number.parseInt(delayRaw, 10)) : 500;
    const backoff = backoffRaw ? Math.max(1, Number.parseFloat(backoffRaw)) : 1.7;

    return {
      retries: Number.isFinite(retries) ? retries : 2,
      delayMs: Number.isFinite(delayMs) ? delayMs : 500,
      backoff: Number.isFinite(backoff) ? backoff : 1.7,
    };
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((r) => setTimeout(r, ms));
  }

  private isTransientError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    // CLI backends can time out due to prompt complexity or interactive issues; retrying usually just wastes time.
    if (msg.includes('Command timed out')) return false;
    return (
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('EPIPE') ||
      msg.includes('fetch failed') ||
      msg.includes('HTTP 429') ||
      msg.includes('HTTP 500') ||
      msg.includes('HTTP 502') ||
      msg.includes('HTTP 503') ||
      msg.includes('HTTP 504') ||
      msg.includes('timed out')
    );
  }

  private async withRetries<T>(
    label: string,
    fn: (attempt: number) => Promise<T>,
    overrides?: { retries?: number; signal?: AbortSignal }
  ): Promise<T> {
    const { retries: defaultRetries, delayMs, backoff } = this.getRetryConfig();
    const retries = overrides?.retries ?? defaultRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (overrides?.signal?.aborted) {
          throw new Error('Operation aborted');
        }
        return await fn(attempt);
      } catch (e) {
        lastError = e;
        const transient = this.isTransientError(e);
        if (attempt >= retries || !transient) {
          throw e;
        }
        const wait = Math.round(delayMs * Math.pow(backoff, attempt));
        console.error(
          `[LLM] ${label} failed (attempt ${attempt + 1}/${retries + 1}): ${String(e)}; retrying in ${wait}ms`
        );
        await this.sleep(wait);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async chatWithMeta(
    request: ChatRequest,
    backendRole: BackendKind,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number }
  ): Promise<{ response: ChatResponse; meta: LlmChatCallMeta }> {
    const startMs = Date.now();

    let backend;
    let configuredModel: string | undefined;

    if (backendRole === 'local') {
      const localBackendId = this.config.getConfig().defaults.localBackendId;
      configuredModel = this.config.getConfig().defaults.localModel;
      backend = this.backendManager.getBackend(localBackendId);
      if (!backend) {
        throw diagnoseConnectionError(
          new Error(`Local backend '${localBackendId}' not available`),
          localBackendId,
          this.getConfigUrl()
        );
      }
    } else if (backendRole === 'sota') {
      // SOTA backend is only available in testing mode
      // In production mode, the calling LLM (e.g., GitHub Copilot) acts as SOTA
      if (!this.config.isSotaAvailable()) {
        throw new Error(
          'SOTA backend is not available. ' +
            'In production mode, the calling LLM (e.g., GitHub Copilot) acts as the SOTA backend. ' +
            'For testing purposes, enable testing mode via the settings page (/api/settings).'
        );
      }

      const sotaBackendId = this.config.getConfig().defaults.sotaBackendId;
      configuredModel = this.config.getConfig().defaults.sotaModel;

      if (!sotaBackendId) {
        throw diagnoseConnectionError(
          new Error('SOTA backend not configured'),
          'sota',
          this.getConfigUrl()
        );
      }

      backend = this.backendManager.getBackend(sotaBackendId);
      if (!backend) {
        throw diagnoseConnectionError(
          new Error(`SOTA backend '${sotaBackendId}' not available`),
          sotaBackendId,
          this.getConfigUrl()
        );
      }
    } else {
      throw new Error(`Invalid backend role: ${backendRole}`);
    }

    // Provide a safer default timeout for CLI-based backends when callers don't specify one.
    // This prevents long (5–10 minute) hangs in tools/tests that forget to pass timeoutMs.
    const isCliBackend =
      backend.id.includes('opencode') ||
      backend.id.includes('copilot') ||
      backend.id.endsWith('-cli');
    const timeoutMs = options?.timeoutMs ?? (isCliBackend ? 120000 : undefined);

    // Validate the request
    if (!request.messages || request.messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    // Apply redaction to messages; use stronger SOTA filters when needed
    const redactedMessages = request.messages.map((msg) => ({
      ...msg,
      content:
        backendRole === 'sota'
          ? this.redaction.applySotaFilters(msg.content)
          : this.redaction.redact(msg.content),
    }));

    const redactedRequest = {
      ...request,
      messages: redactedMessages,
      // Use configured model if available and not already specified
      model: request.model || configuredModel,
    };

    const cache = getLLMCache();
    const cacheStats = cache.getStats();

    const cacheModelKey =
      redactedRequest.model && redactedRequest.model.trim()
        ? `${backend.id}:${redactedRequest.model}`
        : backend.id;

    // Use full message array for cache key - dramatically improves hit rate
    const cacheOptions = { temperature: request.temperature };
    const cacheKey = cache.getKeyFromMessages(redactedMessages, cacheModelKey, cacheOptions);

    const meta: LlmChatCallMeta = {
      backendRole,
      backendId: backend.id,
      model: redactedRequest.model ?? null,
      cache: {
        enabled: cacheStats.enabled,
        key: cacheKey,
        cached: false,
        coalesced: false,
      },
      timing: {
        startedAt: new Date(startMs).toISOString(),
        elapsedMs: 0,
      },
    };

    // Check cache first
    const cachedResponse = cache.getFromMessages(redactedMessages, cacheModelKey, cacheOptions);
    if (cachedResponse) {
      meta.cache.cached = true;
      meta.timing.elapsedMs = Date.now() - startMs;
      return { response: cachedResponse as ChatResponse, meta };
    }

    const allowInflightDedupe =
      options?.signal === undefined && timeoutMs === undefined && options?.maxRetries === undefined;
    if (allowInflightDedupe) {
      // Check for inflight request with same key (cleanup stale ones first)
      this.cleanupInflight();
      const inflightEntry = this.inflightCache.get(cacheKey);
      if (inflightEntry) {
        meta.cache.coalesced = true;
        meta.cache.coalescedWithRequestId = inflightEntry.requestId;
        // Record as a hit since this avoids a duplicate LLM call
        cache.recordCoalescedHit();
        const response = await inflightEntry.promise;
        meta.timing.elapsedMs = Date.now() - startMs;
        return { response, meta };
      }
    }

    const run = async (targetBackend: LlmBackend): Promise<ChatResponse> => {
      // V20: Add routing log marker for auditability (QA_feedback_27012026)
      console.log(
        `[DIRECT-LLM:${targetBackend.id}] Routing ${backendRole} request to backend: ${targetBackend.id}`
      );

      if (backendRole === 'sota') {
        const totalLength = redactedMessages.reduce((sum, m) => sum + m.content.length, 0);
        console.error(
          `[SOTA] Sending filtered request: messages=${redactedMessages.length}, total_length=${totalLength}, model=${redactedRequest.model || 'auto'}`
        );
      }

      const configuredMax = this.config.getConfig().server?.maxConcurrentClients;
      const maxConcurrent = Math.max(
        1,
        Number.isFinite(configuredMax as number)
          ? Number(configuredMax)
          : DEFAULT_MAX_CONCURRENT_LLM_CALLS
      );
      if (maxConcurrent !== llmCallLimiterMax) {
        llmCallLimiterMax = maxConcurrent;
        llmCallLimiter.setMax(maxConcurrent);
      }

      const response = await this.withRetries(
        `invokeChat(${targetBackend.id})`,
        async () => {
          return await llmCallLimiter.run(
            async () =>
              await targetBackend.invokeChat(redactedRequest, {
                signal: options?.signal,
                timeoutMs,
              })
          );
        },
        { retries: options?.maxRetries, signal: options?.signal }
      );

      // Strip <think> tags from LLM response (common in Qwen and other models)
      if (response.message && response.message.content) {
        response.message.content = this.redaction.stripThinkTags(response.message.content);
      }

      // Cache the response using full message array
      if (response.message) {
        cache.setFromMessages(redactedMessages, response, cacheModelKey, cacheOptions);
      }

      return response;
    };

    // QA_feedback_26012026: Execute with fallback support for circuit breaker recovery
    const executeWithFallback = async (): Promise<ChatResponse> => {
      try {
        return await run(backend);
      } catch (error) {
        // Check if this is a circuit breaker error that warrants fallback
        const isCircuitOpen =
          error instanceof CircuitOpenError ||
          (error instanceof Error && error.message.includes('Circuit breaker'));

        if (!isCircuitOpen) {
          // Not a circuit breaker error, just throw it
          console.error(`Chat failed with backend ${backend.id}:`, error);
          throw diagnoseConnectionError(error, backend.id, this.getConfigUrl());
        }

        // Try fallback backends
        const fallbackBackends = this.getFallbackBackends(backend.id);
        if (fallbackBackends.length === 0) {
          console.error(
            `[LLM] Circuit breaker open for ${backend.id}, no fallback backends available`
          );
          throw diagnoseConnectionError(error, backend.id, this.getConfigUrl());
        }

        console.error(
          `[LLM] Circuit breaker open for ${backend.id}, attempting fallback to: ${fallbackBackends.map((b) => b.id).join(', ')}`
        );

        // Store fallback attempt info in meta
        meta.fallback = {
          attempted: true,
          primaryBackendId: backend.id,
          primaryError: error instanceof Error ? error.message : String(error),
          fallbackSuccess: false,
        };

        // Try each fallback backend in order
        for (const fallbackBackend of fallbackBackends) {
          try {
            console.error(`[LLM] Trying fallback backend: ${fallbackBackend.id}`);
            const response = await run(fallbackBackend);

            // Fallback succeeded - update meta
            meta.backendId = fallbackBackend.id;
            meta.fallback.fallbackBackendId = fallbackBackend.id;
            meta.fallback.fallbackSuccess = true;
            console.error(`[LLM] Fallback to ${fallbackBackend.id} succeeded`);

            return response;
          } catch (fallbackError) {
            console.error(`[LLM] Fallback to ${fallbackBackend.id} failed:`, fallbackError);
            // Continue to next fallback backend
          }
        }

        // All fallbacks failed
        console.error(`[LLM] All fallback backends failed for original backend ${backend.id}`);
        throw diagnoseConnectionError(error, backend.id, this.getConfigUrl());
      }
    };

    const promise = executeWithFallback().finally(() => {
      if (allowInflightDedupe) {
        this.inflightCache.delete(cacheKey);
      }
    });
    if (allowInflightDedupe) {
      const requestId = generateRequestId();
      this.inflightCache.set(cacheKey, { promise, timestamp: Date.now(), requestId });
    }

    const response = await promise;
    meta.timing.elapsedMs = Date.now() - startMs;
    return { response, meta };
  }

  async chat(
    request: ChatRequest,
    backendRole: BackendKind,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number }
  ): Promise<ChatResponse> {
    const { response } = await this.chatWithMeta(request, backendRole, options);
    return response;
  }

  getAvailableBackends(): { local: string[]; sota: string[] } {
    const local = this.backendManager.getLocalBackends().map((b) => b.id);
    // Only show SOTA backends if testing mode is enabled
    const sota = this.config.isSotaAvailable()
      ? this.backendManager.getSotaBackends().map((b) => b.id)
      : [];

    return { local, sota };
  }

  /**
   * Check if SOTA backend is available for use
   */
  isSotaAvailable(): boolean {
    return this.config.isSotaAvailable();
  }

  /**
   * Get LLM cache statistics
   */
  getCacheStats(): LLMCacheStats {
    return getLLMCache().getStats();
  }

  /**
   * Get current LLM call concurrency status.
   * This reflects the global limiter used across all LlmChatTool instances.
   */
  getConcurrencyStatus(): { running: number; queued: number; max: number } {
    return llmCallLimiter.getStatus();
  }

  /**
   * Refine and improve a user prompt using local LLM analysis
   */
  async refinePrompt(options: {
    prompt: string;
    context?: string;
    style?: 'concise' | 'detailed' | 'technical' | 'creative';
    iterations?: number;
  }): Promise<{
    originalPrompt: string;
    refinedPrompts: Array<{
      version: number;
      prompt: string;
      improvements: string[];
      reasoning: string;
    }>;
    recommendation: string;
    suggestedQuestions?: string[];
  }> {
    const { prompt, context, style = 'detailed', iterations = 1 } = options;
    const safeIterations = Math.min(3, Math.max(1, iterations));

    const styleGuides: Record<string, string> = {
      concise: 'Make the prompt brief and to the point. Remove unnecessary words.',
      detailed: 'Add specificity and context. Include success criteria and constraints.',
      technical: 'Use precise technical terminology. Include format specifications and edge cases.',
      creative: 'Make the prompt open-ended and inspiring. Encourage novel approaches.',
    };

    const systemPrompt = `You are an expert prompt engineer. Analyze and improve prompts to be clearer, more specific, and more effective.

Style: ${style} - ${styleGuides[style] || styleGuides.detailed}
${context ? `Context: ${context}` : ''}

Return a valid JSON object with this structure:
{
  "refinedPrompt": "The improved version of the prompt",
  "improvements": ["improvement 1", "improvement 2"],
  "reasoning": "Why these changes make the prompt better",
  "suggestedQuestions": ["Optional clarifying questions for the user"]
}

Respond ONLY with the JSON object, no additional text.`;

    const refinedPrompts: Array<{
      version: number;
      prompt: string;
      improvements: string[];
      reasoning: string;
    }> = [];
    let currentPrompt = prompt;
    let suggestedQuestions: string[] | undefined;

    for (let i = 0; i < safeIterations; i++) {
      try {
        const response = await this.chat(
          {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Improve this prompt:\n\n${currentPrompt}` },
            ],
          },
          'local'
        );

        const parsed = this.parseRefineResponse(response.message.content);
        refinedPrompts.push({
          version: i + 1,
          prompt: parsed.refinedPrompt,
          improvements: parsed.improvements,
          reasoning: parsed.reasoning,
        });

        if (i === 0 && parsed.suggestedQuestions) {
          suggestedQuestions = parsed.suggestedQuestions;
        }

        currentPrompt = parsed.refinedPrompt;
      } catch (error) {
        // If parsing fails, add raw response as a refinement
        refinedPrompts.push({
          version: i + 1,
          prompt: currentPrompt,
          improvements: ['Failed to parse LLM response'],
          reasoning: error instanceof Error ? error.message : 'Unknown error',
        });
        break;
      }
    }

    return {
      originalPrompt: prompt,
      refinedPrompts,
      recommendation:
        refinedPrompts.length > 0 ? refinedPrompts[refinedPrompts.length - 1].prompt : prompt,
      suggestedQuestions,
    };
  }

  /**
   * Parse the LLM response for prompt refinement
   */
  private parseRefineResponse(content: string): {
    refinedPrompt: string;
    improvements: string[];
    reasoning: string;
    suggestedQuestions?: string[];
  } {
    // Try to extract JSON from the response
    let jsonStr = content.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object in response
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
      jsonStr = objMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        refinedPrompt: parsed.refinedPrompt || parsed.refined_prompt || parsed.prompt || content,
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
        reasoning: parsed.reasoning || parsed.explanation || 'No reasoning provided',
        suggestedQuestions: Array.isArray(parsed.suggestedQuestions)
          ? parsed.suggestedQuestions
          : undefined,
      };
    } catch {
      // If JSON parsing fails, use the content as the refined prompt
      return {
        refinedPrompt: content,
        improvements: ['Response was not in expected JSON format'],
        reasoning: 'LLM returned non-JSON response',
      };
    }
  }
}
