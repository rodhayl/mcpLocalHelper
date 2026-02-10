/**
 * OrchestrationService - Bridges CliOrchestrator with MCP Server components
 *
 * This service:
 * 1. Creates and manages CliOrchestrator instances
 * 2. Wraps LlmChatTool to match LlmBackend interface
 * 3. Wraps CLI adapters (OpenCode, Copilot) to match CliBackend interface
 * 4. Provides orchestration for agent_task and other tools
 */

import { CliOrchestrator } from './cli-orchestrator.js';
import { PlanManager } from './plan-manager.js';
import type { LlmChatTool } from '../tools/llm.js';
import type { ConfigManager } from '../config/index.js';
import type { BackendManager } from '../adapters/factory.js';
import type { OrchestrationResult } from '../types/index.js';
import type { OrchestratorCliBackend, OrchestratorLlmBackend } from './types.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { CopilotAdapter } from '../adapters/copilot.js';

// Use shared interfaces from types.ts (Phase 2 cleanup)
type CliBackend = OrchestratorCliBackend;
type LlmBackend = OrchestratorLlmBackend;

/**
 * Wraps LlmChatTool to match the LlmBackend interface expected by CliOrchestrator
 */
class LlmChatWrapper implements LlmBackend {
  readonly id: string;
  private llmChat: LlmChatTool;
  private callCount: number = 0;

  constructor(id: string, llmChat: LlmChatTool) {
    this.id = id;
    this.llmChat = llmChat;
  }

  async invokeChat(req: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  }): Promise<{ message: { role: 'assistant'; content: string } }> {
    this.callCount++;
    const promptPreview = req.messages[req.messages.length - 1]?.content.substring(0, 100) || '';

    console.log(`\n🧠 [LM-STUDIO] ==========================================`);
    console.log(`🧠 [LM-STUDIO] LLM Call #${this.callCount} (ORCHESTRATION ONLY)`);
    console.log(`🧠 [LM-STUDIO] Purpose: Planning/Verification (NOT code generation)`);
    console.log(`🧠 [LM-STUDIO] Backend: ${this.id} (local)`);
    console.log(`🧠 [LM-STUDIO] Prompt preview: ${promptPreview}...`);
    console.log(`🧠 [LM-STUDIO] ==========================================\n`);

    const response = await this.llmChat.chat(
      {
        messages: req.messages,
        temperature: 0,
      },
      'local' // Use local backend (LM Studio) for orchestration planning
    );

    console.log(`🧠 [LM-STUDIO] Response received, length: ${response.message.content.length}`);

    return {
      message: {
        role: 'assistant',
        content: response.message.content,
      },
    };
  }
}

/**
 * OrchestrationService manages CLI orchestration lifecycle
 */
export class OrchestrationService {
  private config: ConfigManager;
  private llmChat: LlmChatTool;
  private planManager: PlanManager;
  private cliBackends: Map<string, CliBackend> = new Map();

  // V22: Probe cache to avoid repeated process spawns (QA_feedback_29012026)
  // V24: Extended to support startup warmup with infinite TTL
  private probeCache: Map<string, { available: boolean; error?: string; timestamp: number }> =
    new Map();
  private static PROBE_CACHE_TTL_MS = 60000; // Cache for 60 seconds (fallback)
  private warmedUp = false; // V24: Track if backends were warmed up at startup

  constructor(config: ConfigManager, llmChat: LlmChatTool, _backendManager: BackendManager) {
    this.config = config;
    this.llmChat = llmChat;
    this.planManager = new PlanManager();
    this.initializeCliBackends();
  }

  /**
   * Initialize CLI backends (OpenCode, Copilot) for orchestration
   */
  private initializeCliBackends(): void {
    const workspaceRoot = this.config.getDefaultWorkspaceRoot();
    const cfg = this.config.getConfig();

    const inferModelFromArgs = (args?: string[]): string => {
      if (!args || args.length === 0) return '';
      const modelFlagIdx = args.findIndex((a) => a === '--model' || a === '-m');
      if (modelFlagIdx >= 0 && args[modelFlagIdx + 1]) return args[modelFlagIdx + 1];
      // Common Copilot template: ["--model","gpt-5-mini"]
      const maybeModel = args.find((a) => /^gpt-|^opencode\//.test(a));
      return maybeModel || '';
    };

    const getBackendConfig = (id: string) => cfg.backends.find((b: any) => b?.id === id);

    // Create OpenCode CLI backend
    const opencodeCfg: any = getBackendConfig('opencode-cli') || {};
    const opencodeModel = inferModelFromArgs(opencodeCfg.args_template);
    const opencodeAdapter = new OpenCodeAdapter('opencode-cli', {
      command: opencodeCfg.command,
      args_template: opencodeCfg.args_template,
      environment: opencodeCfg.environment,
      working_dir: opencodeCfg.working_dir || workspaceRoot,
      timeout: opencodeCfg.timeout ?? 300000,
      auto_approve: opencodeCfg.auto_approve ?? true,
    });
    this.cliBackends.set('opencode-cli', {
      id: 'opencode-cli',
      model: opencodeModel || undefined,
      executeTask: (prompt: string) => opencodeAdapter.executeTask(prompt),
      probe: () => opencodeAdapter.probe(),
    });

    // Create Copilot CLI backend
    const copilotCfg: any = getBackendConfig('copilot-cli') || {};
    const copilotModel = inferModelFromArgs(copilotCfg.args_template);
    const copilotAdapter = new CopilotAdapter('copilot-cli', {
      command: copilotCfg.command,
      args_template: copilotCfg.args_template,
      environment: copilotCfg.environment,
      working_dir: copilotCfg.working_dir || workspaceRoot,
      timeout: copilotCfg.timeout ?? 300000,
      auto_approve: copilotCfg.auto_approve ?? true,
    });
    this.cliBackends.set('copilot-cli', {
      id: 'copilot-cli',
      model: copilotModel || undefined,
      executeTask: (prompt: string) => copilotAdapter.executeTask(prompt),
      probe: () => copilotAdapter.probe(),
    });

    console.log(
      '[OrchestrationService] CLI backends initialized: opencode-cli, copilot-cli',
      JSON.stringify(
        {
          opencode: {
            command: opencodeCfg.command || 'opencode',
            model: opencodeModel || '(default)',
          },
          copilot: {
            command: copilotCfg.command || 'copilot',
            model: copilotModel || '(default)',
          },
        },
        null,
        2
      )
    );
  }

  /**
   * Warm up CLI backends at server startup (V24)
   * Probes all backends once and caches results indefinitely.
   * Call this from server initialization for optimal performance.
   */
  async warmupBackends(): Promise<void> {
    if (this.warmedUp) {
      console.log('[OrchestrationService] Backends already warmed up, skipping');
      return;
    }

    console.log('[OrchestrationService] Warming up CLI backends at startup...');
    const startMs = performance.now();

    // Probe all backends in parallel
    const probePromises = Array.from(this.cliBackends.entries()).map(async ([id, backend]) => {
      try {
        const probeStartMs = performance.now();
        const result = await backend.probe();
        const probeMs = Math.round(performance.now() - probeStartMs);

        // Cache with infinite TTL (timestamp 0 = never expire)
        this.probeCache.set(id, {
          available: result.available,
          error: result.error,
          timestamp: 0, // Special value: never expire
        });

        console.log(
          `[OrchestrationService] Backend ${id}: ${result.available ? 'AVAILABLE' : 'UNAVAILABLE'} (${probeMs}ms)`
        );
        return { id, available: result.available };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        this.probeCache.set(id, {
          available: false,
          error: errorMsg,
          timestamp: 0,
        });
        console.log(`[OrchestrationService] Backend ${id}: PROBE FAILED - ${errorMsg}`);
        return { id, available: false, error: errorMsg };
      }
    });

    await Promise.all(probePromises);

    const totalMs = Math.round(performance.now() - startMs);
    this.warmedUp = true;

    // Also warm up DirectCliExecutor cache (V25: unified for both backends)
    try {
      const { DirectCliExecutor } = await import('./direct-cli-executor.js');
      await DirectCliExecutor.warmupBackends(this.cliBackends);
    } catch (e) {
      console.log('[OrchestrationService] DirectCliExecutor warmup skipped:', e);
    }

    console.log(`[OrchestrationService] Backend warmup complete in ${totalMs}ms`);
  }

  /**
   * Check if backends are warmed up
   */
  isWarmedUp(): boolean {
    return this.warmedUp;
  }

  /**
   * Check if CLI orchestration is enabled in settings
   */
  isEnabled(): boolean {
    const settings = this.config.getEnvSettings();
    return settings.advanced?.cliOrchestrationEnabled === true;
  }

  /**
   * Get enabled CLI backends from settings
   */
  getEnabledBackends(): string[] {
    const settings = this.config.getEnvSettings();
    return settings.advanced?.cliOrchestrationBackends || [];
  }

  /**
   * Get the orchestrator configuration from settings
   */
  private getOrchestratorConfig() {
    const settings = this.config.getEnvSettings();
    // Default to enabled with opencode-cli backend for performance
    const enabled = settings.advanced?.cliOrchestrationEnabled ?? true;
    const backends = settings.advanced?.cliOrchestrationBackends ?? ['opencode-cli'];
    return {
      cliOrchestrationEnabled: enabled,
      cliOrchestrationBackends: backends.length > 0 ? backends : ['opencode-cli'],
      cliAutoVerify: settings.advanced?.cliAutoVerify ?? true,
      cliScoreThreshold: settings.advanced?.cliScoreThreshold ?? 7,
      cliMaxIterations: settings.advanced?.cliMaxIterations ?? 3,
    };
  }

  /**
   * Create a new CliOrchestrator instance with current settings
   */
  private createOrchestrator(availableBackends?: string[]): CliOrchestrator {
    const config = this.getOrchestratorConfig();
    const llmWrapper = new LlmChatWrapper('lm-studio', this.llmChat);
    const allowSet =
      Array.isArray(availableBackends) && availableBackends.length > 0
        ? new Set(availableBackends)
        : null;

    // Filter backends to only enabled ones
    const enabledBackends = new Map<string, CliBackend>();
    for (const backendId of config.cliOrchestrationBackends) {
      if (allowSet && !allowSet.has(backendId)) continue;
      const backend = this.cliBackends.get(backendId);
      if (backend) {
        enabledBackends.set(backendId, backend);
      }
    }

    return new CliOrchestrator(config, this.planManager, enabledBackends, llmWrapper);
  }

  /**
   * Probe all CLI backends to check availability (runs in parallel)
   * V22: Uses caching to avoid repeated process spawns (QA_feedback_29012026)
   * V24: Respects infinite TTL for warmed-up backends (timestamp === 0)
   */
  async probeBackends(): Promise<Map<string, { available: boolean; error?: string }>> {
    const results = new Map<string, { available: boolean; error?: string }>();
    const now = Date.now();
    const backendsToProbe: Array<[string, CliBackend]> = [];

    // Check cache first - return cached results if still valid
    for (const [id, backend] of this.cliBackends.entries()) {
      const cached = this.probeCache.get(id);
      // V24: timestamp === 0 means infinite TTL (warmed up at startup)
      const isValid =
        cached &&
        (cached.timestamp === 0 ||
          now - cached.timestamp < OrchestrationService.PROBE_CACHE_TTL_MS);
      if (isValid) {
        results.set(id, { available: cached.available, error: cached.error });
      } else {
        backendsToProbe.push([id, backend]);
      }
    }

    // If all backends are cached, return immediately (FAST PATH)
    if (backendsToProbe.length === 0) {
      return results;
    }

    // Run probes in parallel for backends not in cache
    const probePromises = backendsToProbe.map(async ([id, backend]) => {
      try {
        const result = await backend.probe();
        return { id, result };
      } catch (error) {
        return {
          id,
          result: {
            available: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        };
      }
    });

    const probeResults = await Promise.all(probePromises);
    for (const { id, result } of probeResults) {
      // Update cache with fresh probe results
      this.probeCache.set(id, { ...result, timestamp: now });
      results.set(id, result);
    }

    return results;
  }

  /**
   * Execute task directly via CLI backend without LLM planning
   *
   * This is the FAST PATH for simple tool calls that don't need
   * multi-step decomposition. Skips LLM planning and verification.
   *
   * @param task The task prompt to execute
   * @param preferredBackend Preferred CLI backend (optional)
   * @returns OrchestrationResult with execution details
   */
  async executeDirectCli(task: string, preferredBackend?: string): Promise<OrchestrationResult> {
    const startMs = Date.now();

    if (!this.isEnabled()) {
      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: 'CLI orchestration not enabled',
          completedAreas: [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 0,
        error: 'CLI orchestration not enabled',
      };
    }

    // Get available backends
    const enabledBackends = this.getEnabledBackends();
    const targetBackend =
      preferredBackend && enabledBackends.includes(preferredBackend)
        ? preferredBackend
        : enabledBackends[0];

    const backend = this.cliBackends.get(targetBackend);
    if (!backend) {
      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: `Backend ${targetBackend} not available`,
          completedAreas: [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 0,
        error: `Backend ${targetBackend} not available`,
      };
    }

    console.log(`[DirectCLI] Executing via ${targetBackend} (no LLM planning)`);

    try {
      const result = await backend.executeTask(task);
      const totalMs = Date.now() - startMs;

      console.log(`[DirectCLI] Completed in ${totalMs}ms, success=${result.success}`);

      const now = new Date().toISOString();
      return {
        success: result.success,
        planId: `direct-${Date.now()}`,
        score: result.success ? 8 : 3,
        verification: {
          score: result.success ? 8 : 3,
          reasoning: result.success ? result.content : result.error || 'CLI execution failed',
          completedAreas: result.success ? ['task'] : [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 1,
        timing: {
          llmPlanningMs: 0,
          llmVerificationMs: 0,
          llmFinalVerificationMs: 0,
          llmTotalMs: 0,
          llmCallCount: 0,
          cliExecutionMs: totalMs,
          cliCallCount: 1,
          cliBackendUsed: targetBackend,
          cliModelUsed: 'direct',
          totalMs,
          stepsExecuted: 1,
          startTime: now,
          endTime: now,
        },
      };
    } catch (error) {
      const totalMs = Date.now() - startMs;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.log(`[DirectCLI] Failed after ${totalMs}ms: ${errorMsg}`);

      const now = new Date().toISOString();
      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: errorMsg,
          completedAreas: [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 1,
        error: errorMsg,
        timing: {
          llmPlanningMs: 0,
          llmVerificationMs: 0,
          llmFinalVerificationMs: 0,
          llmTotalMs: 0,
          llmCallCount: 0,
          cliExecutionMs: totalMs,
          cliCallCount: 1,
          cliBackendUsed: targetBackend,
          cliModelUsed: 'direct',
          totalMs,
          stepsExecuted: 0,
          startTime: now,
          endTime: now,
        },
      };
    }
  }

  /**
   * Execute a task using CLI orchestration
   *
   * This is the main entry point for orchestrated task execution.
   * It routes through CLI backends for execution while using
   * the local LLM (LM Studio) for planning and verification.
   *
   * @param task The task description to execute
   * @param options Optional execution options
   * @returns OrchestrationResult with execution details
   */
  async orchestrate(
    task: string,
    _options?: {
      contextRoot?: string;
      forceBackend?: string;
    }
  ): Promise<OrchestrationResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: 'CLI orchestration is not enabled. Enable it in settings.',
          completedAreas: [],
          missingItems: [],
          suggestions: ['Enable CLI orchestration in the settings page'],
        },
        iterations: 0,
        error: 'CLI orchestration is not enabled',
      };
    }

    const enabledBackends = this.getEnabledBackends();
    if (enabledBackends.length === 0) {
      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: 'No CLI backends are enabled. Select at least one backend in settings.',
          completedAreas: [],
          missingItems: [],
          suggestions: ['Enable opencode-cli or copilot-cli in settings'],
        },
        iterations: 0,
        error: 'No CLI backends enabled',
      };
    }

    // Probe backends to ensure they're available
    const probeResults = await this.probeBackends();
    const availableBackends = enabledBackends.filter((id) => {
      const result = probeResults.get(id);
      return result?.available === true;
    });

    if (availableBackends.length === 0) {
      const errors = enabledBackends
        .map((id) => `${id}: ${probeResults.get(id)?.error || 'unavailable'}`)
        .join(', ');

      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: `No CLI backends are available. Errors: ${errors}`,
          completedAreas: [],
          missingItems: [],
          suggestions: [
            'Install OpenCode CLI: npm install -g opencode',
            'Install Copilot CLI: npm install -g @github/copilot && copilot auth login',
          ],
        },
        iterations: 0,
        error: `No CLI backends available: ${errors}`,
      };
    }

    console.log(
      `[OrchestrationService] Starting orchestration with backends: ${availableBackends.join(', ')}`
    );
    console.log(`[OrchestrationService] Task: ${task.substring(0, 100)}...`);

    // Create orchestrator with current settings
    const orchestrator = this.createOrchestrator(availableBackends);

    // Execute orchestration
    const result = await orchestrator.orchestrate(task);

    console.log(
      `[OrchestrationService] Orchestration complete: success=${result.success}, score=${result.score}/10`
    );

    return result;
  }

  /**
   * Get orchestration status and configuration
   */
  getStatus(): {
    enabled: boolean;
    backends: string[];
    availableBackends: string[];
    config: {
      autoVerify: boolean;
      scoreThreshold: number;
      maxIterations: number;
    };
  } {
    const config = this.getOrchestratorConfig();

    return {
      enabled: config.cliOrchestrationEnabled,
      backends: config.cliOrchestrationBackends,
      availableBackends: Array.from(this.cliBackends.keys()),
      config: {
        autoVerify: config.cliAutoVerify,
        scoreThreshold: config.cliScoreThreshold,
        maxIterations: config.cliMaxIterations,
      },
    };
  }

  /**
   * Get all plans from the plan manager
   */
  getAllPlans() {
    return this.planManager.listPlans();
  }

  /**
   * Get a specific plan by ID
   */
  getPlan(planId: string) {
    return this.planManager.getPlan(planId);
  }

  /**
   * Delete a plan by ID
   */
  deletePlan(planId: string): boolean {
    return this.planManager.deletePlan(planId);
  }

  /**
   * Refresh CLI backends (call when workspace root changes)
   */
  refresh(): void {
    this.cliBackends.clear();
    this.probeCache.clear(); // V22: Clear probe cache on refresh
    this.initializeCliBackends();
  }
}

/**
 * Singleton instance for the orchestration service
 */
let orchestrationServiceInstance: OrchestrationService | null = null;

/**
 * Initialize the orchestration service singleton
 */
export function initOrchestrationService(
  config: ConfigManager,
  llmChat: LlmChatTool,
  backendManager: BackendManager
): OrchestrationService {
  orchestrationServiceInstance = new OrchestrationService(config, llmChat, backendManager);
  return orchestrationServiceInstance;
}

/**
 * Get the orchestration service singleton
 */
export function getOrchestrationService(): OrchestrationService | null {
  return orchestrationServiceInstance;
}
