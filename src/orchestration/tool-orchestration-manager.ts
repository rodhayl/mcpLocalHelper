/**
 * Tool Orchestration Manager
 *
 * Manages per-tool orchestration configuration and execution.
 * Wraps the OrchestrationService to provide tool-specific behavior.
 *
 * Key features:
 * - Per-tool orchestration toggle (orchestration vs direct LLM)
 * - Preferred backend per tool (auto, opencode, copilot)
 * - Fallback to direct LLM when orchestration fails
 * - Quick mode for simpler tasks (skips verification)
 * - Comprehensive logging with tool-specific prefixes
 */

import { getOrchestrationService } from './orchestration-service.js';
import type { OrchestrationResult } from '../types/index.js';
import { format } from 'util';

/**
 * Per-tool orchestration configuration
 */
export interface ToolOrchestrationConfig {
  /** Whether orchestration is enabled for this tool (default: true) */
  orchestrationEnabled: boolean;
  /** Preferred CLI backend: 'auto' | 'opencode' | 'copilot' | 'local' */
  preferredBackend: 'auto' | 'opencode' | 'copilot' | 'local';
  /** Fall back to direct LLM if orchestration fails (default: true) */
  fallbackToLocal: boolean;
  /** Quick mode: skip verification for faster execution (default: false) */
  quickMode: boolean;
  /** Pure CLI mode: bypass local LLM entirely, route directly to CLI backend */
  pureCliMode?: boolean;
}

/**
 * Global orchestration settings
 */
export interface GlobalOrchestrationSettings {
  /** Default: all tools use orchestration */
  defaultOrchestrationEnabled: boolean;
  /** Default preferred backend */
  defaultPreferredBackend: 'auto' | 'opencode' | 'copilot' | 'local';
  /** Default fallback behavior */
  defaultFallbackToLocal: boolean;
  /** Default quick mode */
  defaultQuickMode: boolean;
  /** Pure CLI mode: bypass local LLM entirely */
  pureCliMode?: boolean;
  /** Probe backends once at startup */
  probeOnStartup?: boolean;
  /** Skip local LLM initialization in pure CLI mode */
  skipLocalLlmInit?: boolean;
  /** Enable batch execution for multi-step tasks */
  enableBatchExecution?: boolean;
}

/**
 * Result from tool orchestration execution
 */
export interface ToolOrchestrationResult {
  success: boolean;
  content: string;
  mode: 'orchestration' | 'direct-llm' | 'fallback' | 'pure-cli';
  backend?: string;
  timing?: {
    totalMs: number;
    llmMs?: number;
    cliMs?: number;
    spawnMs?: number;
  };
  error?: string;
  /** Number of LLM calls made (0 in pure-cli mode) */
  llmCallCount?: number;
}

/**
 * Context for tool orchestration
 */
export interface ToolOrchestrationContext {
  /** Tool name for logging and config lookup */
  toolName: string;
  /** The task/prompt to execute */
  prompt: string;
  /** Additional context for orchestration */
  context?: {
    filePath?: string;
    workspaceRoot?: string;
    analysisType?: string;
    [key: string]: unknown;
  };
  /** Override config for this specific call */
  configOverride?: Partial<ToolOrchestrationConfig>;
}

// Default global settings (tool-level defaults are derived from these)
const DEFAULT_GLOBAL_SETTINGS: GlobalOrchestrationSettings = {
  defaultOrchestrationEnabled: true,
  defaultPreferredBackend: 'auto',
  defaultFallbackToLocal: true,
  defaultQuickMode: true, // Enable quick mode for faster execution
  pureCliMode: false, // Disabled by default for backward compatibility
  probeOnStartup: true, // Probe backends once at startup
  skipLocalLlmInit: false, // Don't skip local LLM init by default
  enableBatchExecution: true, // Enable batch execution
};

/**
 * Routing log entry for visibility in mcp_health
 * V21 (QA_feedback_8): Track routing decisions for LLM observability
 * V24: Added 'pure-cli' mode for zero LLM overhead executions
 */
export interface RoutingLogEntry {
  timestamp: string;
  toolName: string;
  mode: 'orchestration' | 'direct-llm' | 'fallback' | 'pure-cli';
  backend?: string;
  success: boolean;
  durationMs: number;
  error?: string;
  /** Number of LLM calls made (0 in pure-cli mode) */
  llmCallCount?: number;
}

// Keep last N routing logs for mcp_health visibility
const MAX_ROUTING_LOGS = 50;
const routingLogs: RoutingLogEntry[] = [];

/**
 * Get recent routing logs for mcp_health
 */
export function getRoutingLogs(): RoutingLogEntry[] {
  return [...routingLogs];
}

/**
 * Get routing statistics by mode
 */
export function getRoutingStats(): {
  total: number;
  byMode: Record<string, number>;
  byBackend: Record<string, number>;
  successRate: number;
} {
  const byMode: Record<string, number> = {};
  const byBackend: Record<string, number> = {};
  let successCount = 0;

  for (const log of routingLogs) {
    byMode[log.mode] = (byMode[log.mode] || 0) + 1;
    if (log.backend) {
      byBackend[log.backend] = (byBackend[log.backend] || 0) + 1;
    }
    if (log.success) successCount++;
  }

  return {
    total: routingLogs.length,
    byMode,
    byBackend,
    successRate: routingLogs.length > 0 ? successCount / routingLogs.length : 0,
  };
}

/**
 * Add a routing log entry
 * V21 (QA_feedback_8): Exported for use by MCP tool handlers
 */
export function addRoutingLog(entry: Omit<RoutingLogEntry, 'timestamp'>): void {
  const logEntry: RoutingLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  routingLogs.unshift(logEntry);
  if (routingLogs.length > MAX_ROUTING_LOGS) {
    routingLogs.pop();
  }
}

// Singleton instance
let instance: ToolOrchestrationManager | null = null;

/**
 * Tool Orchestration Manager
 *
 * Singleton class that manages per-tool orchestration settings and execution.
 */
export class ToolOrchestrationManager {
  private toolConfigs: Map<string, ToolOrchestrationConfig> = new Map();
  private globalSettings: GlobalOrchestrationSettings = { ...DEFAULT_GLOBAL_SETTINGS };
  private directLlmHandler: ((prompt: string, systemPrompt?: string) => Promise<string>) | null =
    null;

  constructor() {
    process.stderr.write('[ToolOrchestrationManager] Initialized\n');
  }

  /**
   * Set the direct LLM handler for fallback/local mode
   */
  setDirectLlmHandler(handler: (prompt: string, systemPrompt?: string) => Promise<string>): void {
    this.directLlmHandler = handler;
    process.stderr.write('[ToolOrchestrationManager] Direct LLM handler set\n');
  }

  /**
   * Get global orchestration settings
   */
  getGlobalSettings(): GlobalOrchestrationSettings {
    return { ...this.globalSettings };
  }

  /**
   * Update global orchestration settings
   */
  updateGlobalSettings(settings: Partial<GlobalOrchestrationSettings>): void {
    this.globalSettings = { ...this.globalSettings, ...settings };
    process.stderr.write(
      format('[ToolOrchestrationManager] Global settings updated:', this.globalSettings) + '\n'
    );
  }

  /**
   * Get configuration for a specific tool
   */
  getToolConfig(toolName: string): ToolOrchestrationConfig {
    const stored = this.toolConfigs.get(toolName);
    if (stored) {
      return { ...stored };
    }

    // Return defaults based on global settings
    return {
      orchestrationEnabled: this.globalSettings.defaultOrchestrationEnabled,
      preferredBackend: this.globalSettings.defaultPreferredBackend,
      fallbackToLocal: this.globalSettings.defaultFallbackToLocal,
      quickMode: this.globalSettings.defaultQuickMode,
    };
  }

  /**
   * Set configuration for a specific tool
   */
  setToolConfig(toolName: string, config: Partial<ToolOrchestrationConfig>): void {
    const current = this.getToolConfig(toolName);
    const updated = { ...current, ...config };
    this.toolConfigs.set(toolName, updated);
    process.stderr.write(
      format(`[ToolOrchestrationManager] Config updated for ${toolName}:`, updated) + '\n'
    );
  }

  /**
   * Get all tool configurations (for settings UI)
   */
  getAllToolConfigs(): Record<string, ToolOrchestrationConfig> {
    const result: Record<string, ToolOrchestrationConfig> = {};
    for (const [toolName, config] of this.toolConfigs) {
      result[toolName] = { ...config };
    }
    return result;
  }

  /**
   * Bulk update tool configurations by group
   */
  bulkUpdateByGroup(
    toolNames: string[],
    config: Partial<ToolOrchestrationConfig>
  ): { updated: string[]; failed: string[] } {
    const updated: string[] = [];
    const failed: string[] = [];

    for (const toolName of toolNames) {
      try {
        this.setToolConfig(toolName, config);
        updated.push(toolName);
      } catch (error) {
        failed.push(toolName);
        process.stderr.write(
          format(`[ToolOrchestrationManager] Failed to update ${toolName}:`, error) + '\n'
        );
      }
    }

    process.stderr.write(
      `[ToolOrchestrationManager] Bulk update: ${updated.length} updated, ${failed.length} failed\n`
    );
    return { updated, failed };
  }

  /**
   * Reset a tool to default configuration
   */
  resetToolConfig(toolName: string): void {
    this.toolConfigs.delete(toolName);
    process.stderr.write(`[ToolOrchestrationManager] Reset config for ${toolName} to defaults\n`);
  }

  /**
   * Reset all tools to default configuration
   */
  resetAllToolConfigs(): void {
    this.toolConfigs.clear();
    process.stderr.write('[ToolOrchestrationManager] Reset all tool configs to defaults\n');
  }

  /**
   * Check if orchestration is available and enabled for a tool
   */
  isOrchestrationAvailable(toolName: string): boolean {
    const config = this.getToolConfig(toolName);

    // If orchestration is disabled for this tool, return false
    if (!config.orchestrationEnabled) {
      return false;
    }

    // If preferred backend is 'local', orchestration is not used
    if (config.preferredBackend === 'local') {
      return false;
    }

    // Check if orchestration service is available
    const service = getOrchestrationService();
    if (!service) {
      return false;
    }

    const status = service.getStatus();
    return status.enabled && status.backends.length > 0;
  }

  /**
   * Execute a tool with orchestration or direct LLM based on configuration
   *
   * This is the main entry point for tool execution.
   * V21 (QA_feedback_8): Now logs routing decisions to routingLogs for mcp_health visibility
   * V24: Added pure-cli mode for zero LLM overhead execution
   */
  async execute(ctx: ToolOrchestrationContext): Promise<ToolOrchestrationResult> {
    const startMs = Date.now();
    const config = ctx.configOverride
      ? { ...this.getToolConfig(ctx.toolName), ...ctx.configOverride }
      : this.getToolConfig(ctx.toolName);

    const logPrefix = `[TOOL-ORCH:${ctx.toolName}]`;

    // Check if pure CLI mode is enabled (global or per-tool)
    const isPureCliMode = config.pureCliMode ?? this.globalSettings.pureCliMode ?? false;
    const preferredBackend = config.preferredBackend;

    process.stderr.write(`\n${logPrefix} ==========================================\n`);
    process.stderr.write(`${logPrefix} Starting tool execution\n`);
    process.stderr.write(`${logPrefix} Orchestration enabled: ${config.orchestrationEnabled}\n`);
    process.stderr.write(`${logPrefix} Preferred backend: ${config.preferredBackend}\n`);
    process.stderr.write(`${logPrefix} Fallback to local: ${config.fallbackToLocal}\n`);
    process.stderr.write(`${logPrefix} Quick mode: ${config.quickMode}\n`);
    process.stderr.write(`${logPrefix} Pure CLI mode: ${isPureCliMode}\n`);
    process.stderr.write(`${logPrefix} ==========================================\n\n`);

    let result: ToolOrchestrationResult;

    // Case 0: PURE CLI MODE - bypass all LLM overhead (V24)
    // V25: Now supports both opencode and copilot backends
    if (isPureCliMode && (preferredBackend === 'opencode' || preferredBackend === 'copilot')) {
      process.stderr.write(`${logPrefix} Using PURE CLI MODE - zero LLM overhead\n`);
      result = await this.executePureCli(ctx, config, startMs);
      this.logRoutingDecision(ctx.toolName, result);
      return result;
    }

    // Case 1: Direct LLM mode (orchestration disabled or preferred backend is 'local')
    if (!config.orchestrationEnabled || config.preferredBackend === 'local') {
      result = await this.executeDirectLlm(ctx, config, startMs);
      this.logRoutingDecision(ctx.toolName, result);
      return result;
    }

    // Case 2: Orchestration mode
    const orchestrationAvailable = this.isOrchestrationAvailable(ctx.toolName);
    if (!orchestrationAvailable) {
      console.log(`${logPrefix} Orchestration not available, checking fallback...`);

      if (config.fallbackToLocal) {
        process.stderr.write(`${logPrefix} Falling back to direct LLM\n`);
        result = await this.executeDirectLlm(ctx, config, startMs, true);
        this.logRoutingDecision(ctx.toolName, result);
        return result;
      }

      result = {
        success: false,
        content: '',
        mode: 'orchestration',
        error: 'Orchestration not available and fallback disabled',
        timing: { totalMs: Date.now() - startMs },
      };
      this.logRoutingDecision(ctx.toolName, result);
      return result;
    }

    // Execute with orchestration
    try {
      result = await this.executeOrchestration(ctx, config, startMs);

      // If orchestration failed and fallback is enabled
      if (!result.success && config.fallbackToLocal) {
        process.stderr.write(`${logPrefix} Orchestration failed, falling back to direct LLM\n`);
        result = await this.executeDirectLlm(ctx, config, startMs, true);
        this.logRoutingDecision(ctx.toolName, result);
        return result;
      }

      this.logRoutingDecision(ctx.toolName, result);
      return result;
    } catch (error) {
      process.stderr.write(format(`${logPrefix} Orchestration error:`, error) + '\n');

      if (config.fallbackToLocal) {
        process.stderr.write(`${logPrefix} Falling back to direct LLM after error\n`);
        result = await this.executeDirectLlm(ctx, config, startMs, true);
        this.logRoutingDecision(ctx.toolName, result);
        return result;
      }

      result = {
        success: false,
        content: '',
        mode: 'orchestration',
        error: error instanceof Error ? error.message : 'Unknown orchestration error',
        timing: { totalMs: Date.now() - startMs },
      };
      this.logRoutingDecision(ctx.toolName, result);
      return result;
    }
  }

  /**
   * Log a routing decision to the routingLogs array
   * V21 (QA_feedback_8): Makes routing visible in mcp_health
   * V24: Added llmCallCount for pure-cli mode visibility
   */
  private logRoutingDecision(toolName: string, result: ToolOrchestrationResult): void {
    addRoutingLog({
      toolName,
      mode: result.mode,
      backend: result.backend,
      success: result.success,
      durationMs: result.timing?.totalMs ?? 0,
      error: result.error,
      llmCallCount: result.llmCallCount,
    });
  }

  /**
   * Execute using orchestration service
   */
  private async executeOrchestration(
    ctx: ToolOrchestrationContext,
    config: ToolOrchestrationConfig,
    startMs: number
  ): Promise<ToolOrchestrationResult> {
    const logPrefix = `[ORCH-MODE:${ctx.toolName}]`;

    const service = getOrchestrationService();
    if (!service) {
      throw new Error('Orchestration service not initialized');
    }

    // Build the orchestration task from prompt and context
    const task = this.buildOrchestrationTask(ctx);

    // Determine preferred backend
    const preferredBackend =
      config.preferredBackend !== 'auto'
        ? config.preferredBackend === 'opencode'
          ? 'opencode-cli'
          : 'copilot-cli'
        : undefined;

    // FAST PATH: In quickMode, use direct CLI without LLM planning
    if (config.quickMode) {
      process.stderr.write(`${logPrefix} Executing via DIRECT CLI (quickMode - no LLM planning)\n`);

      const result: OrchestrationResult = await service.executeDirectCli(task, preferredBackend);

      const totalMs = Date.now() - startMs;
      process.stderr.write(
        `${logPrefix} Direct CLI completed in ${totalMs}ms, success: ${result.success}\n`
      );

      return {
        success: result.success && (result.score ?? 0) >= 7,
        content: this.extractContentFromOrchestration(result),
        mode: 'orchestration',
        backend: result.timing?.cliBackendUsed,
        timing: {
          totalMs,
          llmMs: 0, // No LLM calls in quickMode
          cliMs: result.timing?.cliExecutionMs,
        },
        error: result.error,
      };
    }

    // FULL PATH: Use LLM planning + CLI execution + verification
    process.stderr.write(`${logPrefix} Executing via CLI orchestration with LLM planning\n`);

    // Configure orchestration options based on tool config
    const options: { contextRoot?: string; quickMode?: boolean; preferredBackend?: string } = {
      contextRoot: ctx.context?.workspaceRoot,
      quickMode: config.quickMode,
    };

    // Set preferred backend if not 'auto'
    if (preferredBackend) {
      options.preferredBackend = preferredBackend;
    }

    process.stderr.write(
      `${logPrefix} Task: ${task.substring(0, 200)}${task.length > 200 ? '...' : ''}\n`
    );

    const result: OrchestrationResult = await service.orchestrate(task, options);

    const totalMs = Date.now() - startMs;
    process.stderr.write(
      `${logPrefix} Completed in ${totalMs}ms, success: ${result.success}, score: ${result.score}/10\n`
    );

    return {
      success: result.success && result.score >= 7,
      content: this.extractContentFromOrchestration(result),
      mode: 'orchestration',
      backend: result.timing?.cliBackendUsed,
      timing: {
        totalMs,
        llmMs: result.timing?.llmTotalMs,
        cliMs: result.timing?.cliExecutionMs,
      },
      error: result.error,
    };
  }

  /**
   * Execute using direct LLM call
   */
  private async executeDirectLlm(
    ctx: ToolOrchestrationContext,
    _config: ToolOrchestrationConfig,
    startMs: number,
    isFallback = false
  ): Promise<ToolOrchestrationResult> {
    const logPrefix = `[DIRECT-LLM:${ctx.toolName}]`;
    const mode = isFallback ? 'fallback' : 'direct-llm';

    console.log(
      `${logPrefix} Executing via direct LLM call (${isFallback ? 'fallback' : 'configured'})`
    );

    if (!this.directLlmHandler) {
      return {
        success: false,
        content: '',
        mode,
        error: 'Direct LLM handler not set',
        timing: { totalMs: Date.now() - startMs },
      };
    }

    try {
      const content = await this.directLlmHandler(ctx.prompt);
      const totalMs = Date.now() - startMs;

      process.stderr.write(`${logPrefix} Completed in ${totalMs}ms\n`);

      return {
        success: true,
        content,
        mode,
        backend: 'local-llm',
        timing: { totalMs, llmMs: totalMs },
      };
    } catch (error) {
      process.stderr.write(format(`${logPrefix} Error:`, error) + '\n');

      return {
        success: false,
        content: '',
        mode,
        error: error instanceof Error ? error.message : 'Unknown LLM error',
        timing: { totalMs: Date.now() - startMs },
      };
    }
  }

  /**
   * Execute using pure CLI mode - zero LLM overhead (V24)
   *
   * V25: Now supports both OpenCode and Copilot via unified DirectCliExecutor
   *
   * This bypasses all LLM planning and verification, routing directly
   * to the configured CLI backend for maximum throughput.
   */
  private async executePureCli(
    ctx: ToolOrchestrationContext,
    config: ToolOrchestrationConfig,
    startMs: number
  ): Promise<ToolOrchestrationResult> {
    const logPrefix = `[PURE-CLI:${ctx.toolName}]`;

    // Import DirectCliExecutor dynamically to avoid circular deps
    const { DirectCliExecutor, createDirectCliExecutor } = await import('./direct-cli-executor.js');

    // Determine which backend to use (V25: supports both opencode and copilot)
    const preferredBackend =
      config.preferredBackend === 'auto'
        ? DirectCliExecutor.getFirstAvailableBackend(['opencode-cli', 'copilot-cli'])
        : `${config.preferredBackend}-cli`;

    const backendType = preferredBackend === 'copilot-cli' ? 'copilot' : 'opencode';

    process.stderr.write(`${logPrefix} Executing via PURE CLI - zero LLM overhead\n`);
    process.stderr.write(`${logPrefix} Backend: ${backendType}\n`);

    // Check if backend is available from startup cache
    if (!preferredBackend || !DirectCliExecutor.isBackendAvailable(preferredBackend)) {
      process.stderr.write(`${logPrefix} ${backendType} CLI not available, falling back\n`);
      return {
        success: false,
        content: '',
        mode: 'pure-cli',
        error: `${backendType} CLI backend not available`,
        timing: { totalMs: Date.now() - startMs },
        llmCallCount: 0,
      };
    }

    const workspaceRoot = ctx.context?.workspaceRoot || process.cwd();
    const executor = createDirectCliExecutor({}, workspaceRoot, backendType);

    try {
      const result = await executor.execute(ctx.prompt);
      const totalMs = Date.now() - startMs;

      process.stderr.write(
        `${logPrefix} Completed in ${totalMs}ms (spawn: ${result.timing.spawnMs}ms)\n`
      );

      return {
        success: result.success,
        content: result.content,
        mode: 'pure-cli',
        backend: preferredBackend,
        timing: {
          totalMs,
          llmMs: 0, // Zero LLM overhead
          cliMs: result.timing.executionMs,
          spawnMs: result.timing.spawnMs,
        },
        error: result.error,
        llmCallCount: 0, // Zero LLM calls
      };
    } catch (error) {
      process.stderr.write(format(`${logPrefix} Error:`, error) + '\n');

      // Invalidate cache on failure
      DirectCliExecutor.invalidateBackend(preferredBackend);

      return {
        success: false,
        content: '',
        mode: 'pure-cli',
        error: error instanceof Error ? error.message : 'Unknown CLI error',
        timing: { totalMs: Date.now() - startMs },
        llmCallCount: 0,
      };
    }
  }

  /**
   * Build an orchestration task from tool context
   */
  private buildOrchestrationTask(ctx: ToolOrchestrationContext): string {
    const parts: string[] = [];

    parts.push(`Tool: ${ctx.toolName}`);
    parts.push('');
    parts.push('Task:');
    parts.push(ctx.prompt);

    if (ctx.context) {
      parts.push('');
      parts.push('Context:');
      if (ctx.context.filePath) {
        parts.push(`- File: ${ctx.context.filePath}`);
      }
      if (ctx.context.workspaceRoot) {
        parts.push(`- Workspace: ${ctx.context.workspaceRoot}`);
      }
      if (ctx.context.analysisType) {
        parts.push(`- Analysis Type: ${ctx.context.analysisType}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract content from orchestration result
   */
  private extractContentFromOrchestration(result: OrchestrationResult): string {
    // Try to extract content from verification
    if (result.verification?.reasoning) {
      return result.verification.reasoning;
    }

    // Return a summary
    return `Orchestration ${result.success ? 'completed' : 'failed'} with score ${result.score}/10`;
  }

  /**
   * Serialize configuration for persistence
   */
  toJSON(): {
    globalSettings: GlobalOrchestrationSettings;
    toolConfigs: Record<string, ToolOrchestrationConfig>;
  } {
    return {
      globalSettings: this.globalSettings,
      toolConfigs: this.getAllToolConfigs(),
    };
  }

  /**
   * Load configuration from persistence
   */
  fromJSON(data: {
    globalSettings?: Partial<GlobalOrchestrationSettings>;
    toolConfigs?: Record<string, Partial<ToolOrchestrationConfig>>;
  }): void {
    if (data.globalSettings) {
      this.updateGlobalSettings(data.globalSettings);
    }

    if (data.toolConfigs) {
      for (const [toolName, config] of Object.entries(data.toolConfigs)) {
        this.setToolConfig(toolName, config);
      }
    }

    process.stderr.write('[ToolOrchestrationManager] Configuration loaded from persistence\n');
  }
}

/**
 * Get the singleton instance
 */
export function getToolOrchestrationManager(): ToolOrchestrationManager {
  if (!instance) {
    instance = new ToolOrchestrationManager();
  }
  return instance;
}

/**
 * Initialize the tool orchestration manager with config
 */
export function initToolOrchestrationManager(config?: {
  globalSettings?: Partial<GlobalOrchestrationSettings>;
  toolConfigs?: Record<string, Partial<ToolOrchestrationConfig>>;
}): ToolOrchestrationManager {
  const manager = getToolOrchestrationManager();

  if (config) {
    manager.fromJSON(config);
  }

  return manager;
}

/**
 * List of all known LLM-enhanced tools that can be configured
 */
export const ALL_LLM_TOOLS = [
  // LlmEnhancedTools
  'analyze_file',
  'explore_directory',
  'search',
  'local_code_review',
  'generate_docs',
  // 'generate_tests' - REMOVED V21 (QA_feedback_8: unreliable output quality)
  'suggest_refactoring',
  'suggest_edit',
  'draft_file',
  'linter',
  'fix_syntax',
  'todos',
  'generate_agents_md',

  // CodeAssistanceTools
  'code_helper',
  'regex_helper',
  'refactor_helper',
  'mcp_translate_code',
  'mcp_plan_implementation',
  'mcp_error_explainer',
  'mcp_analyze_complexity',
  'mcp_diff_summarizer',
  'mcp_summarize_logs',
  'mcp_terminal_command',

  // SummarizationTools
  'summarize',

  // VerifyPlanTool
  'verify_plan',

  // HighValueTools
  'codebase_qa',
] as const;

export type LlmToolName = (typeof ALL_LLM_TOOLS)[number];

/**
 * Tool categories for batch configuration
 */
export const TOOL_CATEGORIES = {
  'code-generation': ['generate_docs', 'draft_file', 'generate_agents_md'], // generate_tests removed V21
  'code-analysis': [
    'analyze_file',
    'local_code_review',
    'suggest_refactoring',
    'mcp_analyze_complexity',
  ],
  'code-editing': ['suggest_edit', 'linter', 'fix_syntax', 'todos'],
  'code-assistance': [
    'code_helper',
    'regex_helper',
    'refactor_helper',
    'mcp_translate_code',
    'mcp_error_explainer',
  ],
  summarization: ['summarize', 'codebase_qa', 'mcp_summarize_logs', 'mcp_diff_summarizer'],
  planning: ['mcp_plan_implementation', 'verify_plan'],
  search: ['search', 'explore_directory'],
  utility: ['mcp_terminal_command'],
} as const;

export type ToolCategory = keyof typeof TOOL_CATEGORIES;
