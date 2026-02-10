/**
 * Tool LLM Wrapper
 *
 * Provides orchestration-aware LLM execution for tools.
 * This wrapper intercepts LLM calls and routes them through
 * the orchestration service when configured.
 *
 * Key features:
 * - Per-tool orchestration configuration
 * - Automatic fallback to direct LLM on orchestration failure
 * - Comprehensive logging with tool-specific prefixes
 * - Minimal code changes required in existing tools
 */

import type { ChatRequest, ChatResponse, BackendKind } from '../types/index.js';
import type { LlmChatTool } from '../tools/llm.js';
import {
  getToolOrchestrationManager,
  type ToolOrchestrationContext,
} from './tool-orchestration-manager.js';
import { getOrchestrationService } from './orchestration-service.js';

/**
 * Extended chat options with tool context
 */
export interface ToolChatOptions {
  /** Tool name for orchestration routing */
  toolName?: string;
  /** Additional context for orchestration */
  context?: {
    filePath?: string;
    workspaceRoot?: string;
    analysisType?: string;
    [key: string]: unknown;
  };
  /** Force direct LLM mode (bypass orchestration check) */
  forceDirectLlm?: boolean;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Max retries for transient failures */
  maxRetries?: number;
}

/**
 * Result from tool-aware LLM execution
 */
export interface ToolChatResult {
  response: ChatResponse;
  mode: 'orchestration' | 'direct-llm' | 'fallback' | 'pure-cli';
  backend?: string;
  timing?: {
    totalMs: number;
    llmMs?: number;
    cliMs?: number;
  };
  /** Number of LLM calls made (0 in pure-cli mode) */
  llmCallCount?: number;
}

/**
 * Orchestration-aware LLM wrapper for tools
 */
export class ToolLlmWrapper {
  private llmChat: LlmChatTool;
  private initialized = false;

  constructor(llmChat: LlmChatTool) {
    this.llmChat = llmChat;
    this.initializeOrchestrationHandler();
  }

  /**
   * Initialize the orchestration manager with the direct LLM handler
   */
  private initializeOrchestrationHandler(): void {
    if (this.initialized) return;

    const manager = getToolOrchestrationManager();
    manager.setDirectLlmHandler(async (prompt: string, systemPrompt?: string) => {
      // Create a minimal chat request for direct LLM execution
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await this.llmChat.chat({ messages }, 'local');
      return response.message.content;
    });

    this.initialized = true;
    console.log('[ToolLlmWrapper] Initialized with direct LLM handler');
  }

  /**
   * Execute a chat request with orchestration awareness
   *
   * This method checks the per-tool orchestration configuration
   * and routes to orchestration or direct LLM accordingly.
   */
  async chatWithOrchestration(
    request: ChatRequest,
    backendRole: BackendKind,
    options?: ToolChatOptions
  ): Promise<ToolChatResult> {
    const startMs = Date.now();

    // If no tool name provided or forced to direct LLM, use standard path
    if (!options?.toolName || options.forceDirectLlm || backendRole === 'sota') {
      return this.executeDirectLlm(request, backendRole, options, startMs);
    }

    const manager = getToolOrchestrationManager();
    const config = manager.getToolConfig(options.toolName);

    // Check if orchestration is enabled for this tool
    if (!config.orchestrationEnabled || config.preferredBackend === 'local') {
      console.log(
        `[DIRECT-LLM:${options.toolName}] Orchestration disabled for this tool, using direct LLM`
      );
      return this.executeDirectLlm(request, backendRole, options, startMs);
    }

    // Check if orchestration service is available
    const orchestrationService = getOrchestrationService();
    if (!orchestrationService) {
      if (config.fallbackToLocal) {
        console.log(
          `[FALLBACK:${options.toolName}] Orchestration service not available, falling back to direct LLM`
        );
        return this.executeDirectLlm(request, backendRole, options, startMs, true);
      }
      throw new Error('Orchestration service not initialized and fallback disabled');
    }

    const status = orchestrationService.getStatus();
    if (!status.enabled || status.backends.length === 0) {
      if (config.fallbackToLocal) {
        console.log(
          `[FALLBACK:${options.toolName}] Orchestration not enabled, falling back to direct LLM`
        );
        return this.executeDirectLlm(request, backendRole, options, startMs, true);
      }
      throw new Error('Orchestration not available and fallback disabled');
    }

    // Build prompt from request messages
    const prompt = this.buildPromptFromRequest(request);

    // Execute via orchestration manager
    const ctx: ToolOrchestrationContext = {
      toolName: options.toolName,
      prompt,
      context: options.context,
    };

    try {
      const result = await manager.execute(ctx);

      if (result.success) {
        // V19 (QA_feedback_22012026): Clear routing log marker for orchestration mode
        const elapsed = Date.now() - startMs;
        console.log(
          `[TOOL-ORCH:${options.toolName}] Executed via orchestration (${result.backend || 'cli'}) in ${elapsed}ms`
        );

        // Convert orchestration result to ChatResponse format
        const response: ChatResponse = {
          message: {
            role: 'assistant',
            content: result.content,
          },
        };

        return {
          response,
          mode: result.mode,
          backend: result.backend,
          timing: result.timing,
        };
      }

      // Orchestration failed - check fallback
      if (config.fallbackToLocal) {
        console.log(
          `[FALLBACK:${options.toolName}] Orchestration failed (${result.error}), falling back to direct LLM`
        );
        return this.executeDirectLlm(request, backendRole, options, startMs, true);
      }

      throw new Error(result.error || 'Orchestration failed without fallback');
    } catch (error) {
      if (config.fallbackToLocal) {
        console.log(
          `[FALLBACK:${options.toolName}] Orchestration error, falling back to direct LLM: ${error}`
        );
        return this.executeDirectLlm(request, backendRole, options, startMs, true);
      }
      throw error;
    }
  }

  /**
   * Execute using direct LLM call
   */
  private async executeDirectLlm(
    request: ChatRequest,
    backendRole: BackendKind,
    options: ToolChatOptions | undefined,
    startMs: number,
    isFallback = false
  ): Promise<ToolChatResult> {
    const toolName = options?.toolName || 'unknown';
    const logPrefix = isFallback ? `[FALLBACK:${toolName}]` : `[DIRECT-LLM:${toolName}]`;

    console.log(`${logPrefix} Executing via direct LLM call`);

    const response = await this.llmChat.chat(request, backendRole, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
      maxRetries: options?.maxRetries,
    });

    const totalMs = Date.now() - startMs;
    console.log(`${logPrefix} Completed in ${totalMs}ms`);

    return {
      response,
      mode: isFallback ? 'fallback' : 'direct-llm',
      backend: 'local-llm',
      timing: {
        totalMs,
        llmMs: totalMs,
      },
    };
  }

  /**
   * Build a unified prompt from a ChatRequest
   */
  private buildPromptFromRequest(request: ChatRequest): string {
    const parts: string[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        parts.push(`[System Instructions]\n${msg.content}\n`);
      } else if (msg.role === 'user') {
        parts.push(`[User Request]\n${msg.content}\n`);
      } else if (msg.role === 'assistant') {
        parts.push(`[Previous Response]\n${msg.content}\n`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Convenience method for tool classes.
   *
   * Wraps `chatWithOrchestration` and returns only the assistant message text.
   * Eliminates the need for every tool to carry its own private
   * `callLlmWithOrchestration` helper (previously duplicated in 4+ files).
   */
  async callToolLlm(
    toolName: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    context?: Record<string, unknown>
  ): Promise<string> {
    const result = await this.chatWithOrchestration({ messages }, 'local', {
      toolName,
      context,
    });
    return result.response.message.content;
  }

  /**
   * Standard chat method (delegates to llmChat)
   * For when you don't want orchestration at all
   */
  async chat(
    request: ChatRequest,
    backendRole: BackendKind,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number }
  ): Promise<ChatResponse> {
    return this.llmChat.chat(request, backendRole, options);
  }

  /**
   * Get the underlying LlmChatTool
   */
  getLlmChatTool(): LlmChatTool {
    return this.llmChat;
  }
}

// Singleton instance cache
const wrapperCache = new WeakMap<LlmChatTool, ToolLlmWrapper>();

/**
 * Get or create a ToolLlmWrapper for the given LlmChatTool
 */
export function getToolLlmWrapper(llmChat: LlmChatTool): ToolLlmWrapper {
  let wrapper = wrapperCache.get(llmChat);
  if (!wrapper) {
    wrapper = new ToolLlmWrapper(llmChat);
    wrapperCache.set(llmChat, wrapper);
  }
  return wrapper;
}

/**
 * Check if orchestration is recommended for a tool
 *
 * Returns true if orchestration is enabled and available,
 * false if direct LLM is preferred.
 */
export function shouldUseOrchestration(toolName: string): boolean {
  const manager = getToolOrchestrationManager();
  return manager.isOrchestrationAvailable(toolName);
}

/**
 * Log tool execution mode for debugging
 */
export function logToolExecutionMode(
  toolName: string,
  mode: 'orchestration' | 'direct-llm' | 'fallback',
  details?: Record<string, unknown>
): void {
  const prefix =
    mode === 'orchestration' ? '[ORCH-MODE' : mode === 'fallback' ? '[FALLBACK' : '[DIRECT-LLM';
  const suffix = `:${toolName}]`;

  console.log(`${prefix}${suffix} Executing tool in ${mode} mode`, details || '');
}
