/**
 * DirectCliExecutor - Unified Pure CLI Executor for OpenCode and Copilot
 *
 * This executor bypasses all LLM planning and verification overhead,
 * routing prompts directly to CLI backends for execution.
 *
 * V25: Unified implementation for both OpenCode and Copilot CLI backends.
 *      Replaces the OpenCode-specific DirectOpenCodeExecutor with a
 *      backend-agnostic implementation that reuses shared code.
 *
 * Key features:
 * - Zero local LLM calls (pureCliMode)
 * - Supports both OpenCode and Copilot backends
 * - Batch execution support for multi-step tasks
 * - Startup-time probe caching
 * - Streaming output support
 * - Shared output parsing (JSON and text)
 *
 * Performance characteristics:
 * - Eliminates 60-180s of local LLM overhead per orchestration
 * - Single CLI spawn for batched operations
 * - Probe cache avoids repeated availability checks
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CliToolResult, CliToolConfig } from '../types/index.js';
import { extractFilesFromContent, extractToolsFromContent } from '../utils/cli-parsing.js';
import {
  buildCliCommandArgs,
  buildWorkspaceConstrainedPrompt,
} from '../utils/cli-execution-templates.js';

/**
 * Supported CLI backend types
 */
export type CliBackendType = 'opencode' | 'copilot';

/**
 * Backend-specific configuration
 */
export interface CliBackendConfig {
  type: CliBackendType;
  command: string;
  argsTemplate: string[];
  model: string;
  outputFormat: 'json' | 'text';
  timeout: number;
  workingDir?: string;
  environment?: Record<string, string>;
}

/**
 * Default configurations for each backend
 */
export const CLI_BACKEND_DEFAULTS: Record<CliBackendType, Omit<CliBackendConfig, 'workingDir'>> = {
  opencode: {
    type: 'opencode',
    command: 'opencode',
    argsTemplate: ['run', '--format', 'json', '--model', '{model}', '{prompt}'],
    model: 'opencode/big-pickle',
    outputFormat: 'json',
    timeout: 300000,
  },
  copilot: {
    type: 'copilot',
    command: 'copilot',
    argsTemplate: ['--model', '{model}', '-p', '{prompt}', '--allow-all', '--no-ask-user'],
    model: 'gpt-5-mini',
    outputFormat: 'text',
    timeout: 300000,
  },
};

/**
 * Batch execution request
 */
export interface BatchExecutionRequest {
  prompts: string[];
  combineMode: 'sequential' | 'parallel' | 'single-prompt';
}

/**
 * Batch execution result
 */
export interface BatchExecutionResult {
  success: boolean;
  results: CliToolResult[];
  totalMs: number;
  spawnOverheadMs: number;
  batchSize: number;
}

/**
 * Direct execution result with timing breakdown
 */
export interface DirectExecutionResult {
  success: boolean;
  content: string;
  filesModified: string[];
  toolsUsed: string[];
  error?: string;
  backendType: CliBackendType;
  timing: {
    totalMs: number;
    spawnMs: number;
    executionMs: number;
    parseMs: number;
  };
}

/**
 * Probe cache entry
 */
interface ProbeEntry {
  available: boolean;
  error?: string;
  timestamp: number;
  version?: string;
}

/**
 * DirectCliExecutor - Unified Pure CLI mode executor for all backends
 */
export class DirectCliExecutor {
  private config: CliBackendConfig;
  private workspaceRoot: string;

  // Singleton probe cache shared across instances
  private static probeCache: Map<string, ProbeEntry> = new Map();
  private static probeCacheInitialized = false;

  // Infinite TTL - only invalidate on failure
  private static PROBE_CACHE_TTL_MS = Infinity;

  constructor(config: CliBackendConfig, workspaceRoot: string) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Get the backend type
   */
  get backendType(): CliBackendType {
    return this.config.type;
  }

  /**
   * Create executor for a specific backend type with defaults
   */
  static forBackend(
    type: CliBackendType,
    workspaceRoot: string,
    overrides?: Partial<CliBackendConfig>
  ): DirectCliExecutor {
    const defaults = CLI_BACKEND_DEFAULTS[type];
    const config: CliBackendConfig = {
      ...defaults,
      workingDir: workspaceRoot,
      ...overrides,
    };
    return new DirectCliExecutor(config, workspaceRoot);
  }

  /**
   * Warm up backends at startup (call from server init)
   * Probes all backends once and caches results indefinitely
   */
  static async warmupBackends(
    backends: Map<string, { probe: () => Promise<{ available: boolean; error?: string }> }>
  ): Promise<void> {
    if (DirectCliExecutor.probeCacheInitialized) {
      return;
    }

    console.log('[DirectCliExecutor] Warming up CLI backends at startup...');
    const probePromises = Array.from(backends.entries()).map(async ([id, backend]) => {
      try {
        const startMs = performance.now();
        const result = await backend.probe();
        const probeMs = Math.round(performance.now() - startMs);

        DirectCliExecutor.probeCache.set(id, {
          available: result.available,
          error: result.error,
          timestamp: Date.now(),
        });

        console.log(
          `[DirectCliExecutor] Backend ${id}: ${result.available ? 'AVAILABLE' : 'UNAVAILABLE'} (probe took ${probeMs}ms)`
        );
        return { id, ...result };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        DirectCliExecutor.probeCache.set(id, {
          available: false,
          error: errorMsg,
          timestamp: Date.now(),
        });
        console.log(`[DirectCliExecutor] Backend ${id}: PROBE FAILED - ${errorMsg}`);
        return { id, available: false, error: errorMsg };
      }
    });

    await Promise.all(probePromises);
    DirectCliExecutor.probeCacheInitialized = true;
    console.log('[DirectCliExecutor] Backend warmup complete');
  }

  /**
   * Check if a backend is available (uses cache, no network call)
   */
  static isBackendAvailable(backendId: string): boolean {
    const cached = DirectCliExecutor.probeCache.get(backendId);
    return cached?.available ?? false;
  }

  /**
   * Get first available backend from a list of preferences
   */
  static getFirstAvailableBackend(preferences: string[]): string | null {
    for (const backendId of preferences) {
      if (DirectCliExecutor.isBackendAvailable(backendId)) {
        return backendId;
      }
    }
    return null;
  }

  /**
   * Invalidate probe cache for a specific backend (call on failure)
   */
  static invalidateBackend(backendId: string): void {
    DirectCliExecutor.probeCache.delete(backendId);
    console.log(`[DirectCliExecutor] Invalidated cache for ${backendId}`);
  }

  /**
   * Reset all probe caches (for testing)
   */
  static resetCaches(): void {
    DirectCliExecutor.probeCache.clear();
    DirectCliExecutor.probeCacheInitialized = false;
  }

  /**
   * Execute a single task directly via CLI - FAST PATH
   * No LLM planning, no verification, pure CLI execution
   */
  async execute(prompt: string): Promise<DirectExecutionResult> {
    const startMs = performance.now();
    const backendLabel = this.config.type.toUpperCase();

    console.log(`\n[DirectCliExecutor] ==========================================`);
    console.log(`[DirectCliExecutor] PURE CLI MODE - ${backendLabel}`);
    console.log(`[DirectCliExecutor] Zero LLM overhead`);
    console.log(`[DirectCliExecutor] Prompt length: ${prompt.length} chars`);
    console.log(`[DirectCliExecutor] ==========================================\n`);

    const constrainedPrompt = this.buildConstrainedPrompt(prompt);
    const { command, args: initialArgs } = this.buildCommandArgs(constrainedPrompt);
    let args = initialArgs;
    let promptFilePath: string | null = null;

    // Windows has a strict command-line length limit; large prompts can cause hard failures or apparent hangs.
    // For OpenCode CLI, fall back to attaching the full prompt as a file and sending a short message instead.
    const estimatedCmdLineLen =
      command.length + args.reduce((sum, a) => sum + String(a).length + 3, 0);
    const needsPromptFile =
      this.config.type === 'opencode' &&
      (constrainedPrompt.length > 12000 || estimatedCmdLineLen > 28000);
    if (needsPromptFile) {
      const id = randomUUID();
      promptFilePath = join(tmpdir(), `mcp-local-llm-opencode-prompt-${id}.md`);
      writeFileSync(promptFilePath, constrainedPrompt, 'utf8');

      const promptArgIndex = args.findIndex((a) => a === constrainedPrompt);
      const shortMessage =
        `Full instructions are attached as a file (${promptFilePath.split(/[/\\\\]/).pop()}). ` +
        'Use the attached file content as the prompt and follow it exactly.';

      if (promptArgIndex >= 0) {
        const newArgs = [...args];
        newArgs[promptArgIndex] = shortMessage;
        newArgs.splice(promptArgIndex, 0, '--file', promptFilePath);
        args = newArgs;
      } else {
        // Fallback: append as attachment + short message
        args = [...args, '--file', promptFilePath, shortMessage];
      }

      console.log(
        `[DirectCliExecutor] Prompt too large for argv; using --file attachment: ${promptFilePath}`
      );
    }

    try {
      const spawnStartMs = performance.now();
      const { stdout, stderr, exitCode } = await this.execCommandWithStreaming(command, args);
      const spawnMs = Math.round(performance.now() - spawnStartMs);

      const parseStartMs = performance.now();
      const rawOutput = stdout.trim() || stderr.trim();
      const result = this.parseOutput(rawOutput);
      const parseMs = Math.round(performance.now() - parseStartMs);

      const totalMs = Math.round(performance.now() - startMs);

      console.log(
        `[DirectCliExecutor] ${backendLabel} completed in ${totalMs}ms (spawn: ${spawnMs}ms, parse: ${parseMs}ms)`
      );

      return {
        success: result.success && exitCode === 0,
        content: result.content,
        filesModified: result.files_modified,
        toolsUsed: result.tools_used,
        error: result.error,
        backendType: this.config.type,
        timing: {
          totalMs,
          spawnMs,
          executionMs: spawnMs, // CLI execution includes spawn
          parseMs,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const totalMs = Math.round(performance.now() - startMs);

      // Invalidate cache on failure
      const backendId = `${this.config.type}-cli`;
      DirectCliExecutor.invalidateBackend(backendId);

      return {
        success: false,
        content: '',
        filesModified: [],
        toolsUsed: [],
        error: errorMsg,
        backendType: this.config.type,
        timing: {
          totalMs,
          spawnMs: 0,
          executionMs: 0,
          parseMs: 0,
        },
      };
    } finally {
      if (promptFilePath) {
        try {
          unlinkSync(promptFilePath);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  /**
   * Execute multiple tasks in a single CLI invocation - BATCH MODE
   * Combines prompts to reduce spawn overhead
   */
  async executeBatch(request: BatchExecutionRequest): Promise<BatchExecutionResult> {
    const startMs = performance.now();
    const results: CliToolResult[] = [];

    console.log(`\n[DirectCliExecutor] ==========================================`);
    console.log(`[DirectCliExecutor] BATCH MODE - ${request.prompts.length} prompts`);
    console.log(`[DirectCliExecutor] Backend: ${this.config.type}`);
    console.log(`[DirectCliExecutor] Combine mode: ${request.combineMode}`);
    console.log(`[DirectCliExecutor] ==========================================\n`);

    if (request.combineMode === 'single-prompt') {
      // Combine all prompts into one mega-prompt
      const combinedPrompt = this.combinePromptsForBatch(request.prompts);
      const result = await this.execute(combinedPrompt);

      // Split the response back into individual results
      const splitResults = this.splitBatchResponse(result.content, request.prompts.length);
      results.push(...splitResults);
    } else if (request.combineMode === 'sequential') {
      // Execute prompts sequentially but reuse connection context
      for (const prompt of request.prompts) {
        const result = await this.execute(prompt);
        results.push({
          success: result.success,
          content: result.content,
          files_modified: result.filesModified,
          tools_used: result.toolsUsed,
          error: result.error,
        });
      }
    } else {
      // Parallel execution - spawn multiple CLI processes
      const promises = request.prompts.map((prompt) => this.execute(prompt));
      const parallelResults = await Promise.all(promises);

      for (const result of parallelResults) {
        results.push({
          success: result.success,
          content: result.content,
          files_modified: result.filesModified,
          tools_used: result.toolsUsed,
          error: result.error,
        });
      }
    }

    const totalMs = Math.round(performance.now() - startMs);
    const spawnOverheadMs = request.combineMode === 'single-prompt' ? 1 : request.prompts.length;

    return {
      success: results.every((r) => r.success),
      results,
      totalMs,
      spawnOverheadMs: spawnOverheadMs * 500, // Approximate spawn overhead
      batchSize: request.prompts.length,
    };
  }

  /**
   * Execute command with streaming output support
   */
  private execCommandWithStreaming(
    command: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(command, args, {
        shell: false, // Direct spawn, no shell overhead
        cwd: this.workspaceRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...this.config.environment,
          NO_COLOR: '1',
          CI: 'true',
          OPENCODE_NON_INTERACTIVE: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      // Set up timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGTERM');
          reject(new Error(`CLI timeout after ${this.config.timeout}ms`));
        }
      }, this.config.timeout);

      // Stream stdout
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      // Stream stderr
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 1,
          });
        }
      });
    });
  }

  /**
   * Build constrained prompt with workspace boundaries
   * Shared implementation for all backends
   */
  private buildConstrainedPrompt(prompt: string): string {
    const workspace = this.config.workingDir || this.workspaceRoot;
    return buildWorkspaceConstrainedPrompt(prompt, workspace, this.config.outputFormat);
  }

  /**
   * Build command and args array for spawn
   * Shared implementation for all backends
   */
  private buildCommandArgs(prompt: string): { command: string; args: string[] } {
    return buildCliCommandArgs(
      this.config.command,
      this.config.argsTemplate,
      this.config.model,
      prompt
    );
  }

  /**
   * Parse CLI output into structured result
   * Handles both JSON (OpenCode) and text (Copilot) formats
   */
  private parseOutput(rawOutput: string): CliToolResult {
    const trimmed = rawOutput.trim();

    if (!trimmed) {
      return {
        success: false,
        content: '',
        files_modified: [],
        tools_used: [],
        error: 'Empty output from CLI',
      };
    }

    // For JSON output format, try to parse as JSON first
    if (this.config.outputFormat === 'json') {
      try {
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            success: parsed.success ?? true,
            content: parsed.content || trimmed,
            files_modified:
              parsed.files_modified || extractFilesFromContent(parsed.content || trimmed),
            tools_used: parsed.tools_used || [],
            error: parsed.error,
          };
        }
      } catch {
        // Fall through to text parsing
      }
    }

    // Text output format or JSON parse failed - extract structured info from text
    return {
      success: trimmed.length > 0 && !trimmed.toLowerCase().includes('error'),
      content: trimmed,
      files_modified: extractFilesFromContent(trimmed),
      tools_used: extractToolsFromContent(trimmed),
    };
  }

  /**
   * Combine multiple prompts into a single batch prompt
   */
  private combinePromptsForBatch(prompts: string[]): string {
    return `
## BATCH EXECUTION
Execute the following ${prompts.length} tasks in sequence, returning results for each.

${prompts.map((p, i) => `### Task ${i + 1}\n${p}`).join('\n\n')}

## OUTPUT FORMAT
Return a JSON array with results for each task:
{
  "batch_results": [
    { "task_index": 0, "success": true, "content": "...", "files_modified": [], "tools_used": [] },
    { "task_index": 1, "success": true, "content": "...", "files_modified": [], "tools_used": [] }
  ]
}
    `.trim();
  }

  /**
   * Split batch response back into individual results
   */
  private splitBatchResponse(content: string, expectedCount: number): CliToolResult[] {
    const results: CliToolResult[] = [];

    try {
      const parsed = JSON.parse(content);
      if (parsed.batch_results && Array.isArray(parsed.batch_results)) {
        for (const result of parsed.batch_results) {
          results.push({
            success: result.success ?? true,
            content: result.content || '',
            files_modified: result.files_modified || [],
            tools_used: result.tools_used || [],
            error: result.error,
          });
        }
      }
    } catch {
      // If parsing fails, create a single result with the full content
      results.push({
        success: true,
        content,
        files_modified: [],
        tools_used: [],
      });
    }

    // Pad with empty results if needed
    while (results.length < expectedCount) {
      results.push({
        success: false,
        content: '',
        files_modified: [],
        tools_used: [],
        error: 'No result for this task in batch response',
      });
    }

    return results;
  }
}

/**
 * Factory function to create DirectCliExecutor for OpenCode
 */
export function createOpenCodeExecutor(
  workspaceRoot: string,
  overrides?: Partial<CliBackendConfig>
): DirectCliExecutor {
  return DirectCliExecutor.forBackend('opencode', workspaceRoot, overrides);
}

/**
 * Factory function to create DirectCliExecutor for Copilot
 */
export function createCopilotExecutor(
  workspaceRoot: string,
  overrides?: Partial<CliBackendConfig>
): DirectCliExecutor {
  return DirectCliExecutor.forBackend('copilot', workspaceRoot, overrides);
}

/**
 * Factory function to create DirectCliExecutor from CliToolConfig
 * Backwards compatible with DirectOpenCodeExecutor usage
 */
export function createDirectCliExecutor(
  config: Partial<CliToolConfig>,
  workspaceRoot: string,
  backendType: CliBackendType = 'opencode'
): DirectCliExecutor {
  const defaults = CLI_BACKEND_DEFAULTS[backendType];

  const fullConfig: CliBackendConfig = {
    type: backendType,
    command: config.command || defaults.command,
    argsTemplate: config.args_template || defaults.argsTemplate,
    model: defaults.model,
    outputFormat: defaults.outputFormat,
    workingDir: config.working_dir || workspaceRoot,
    timeout: config.timeout || defaults.timeout,
    environment: config.environment,
  };

  return new DirectCliExecutor(fullConfig, workspaceRoot);
}
