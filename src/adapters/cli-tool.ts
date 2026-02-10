import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import {
  ProbeResult,
  ModelInfo,
  ChatRequest,
  ChatResponse,
  CliToolResult,
  CliToolConfig,
  FileChange,
  FileStateSnapshot,
  ValidationResult,
} from '../types/index.js';
import { BaseBackend } from './base.js';
import {
  extractFilesFromContent as sharedExtractFiles,
  extractToolsFromContent as sharedExtractTools,
} from '../utils/cli-parsing.js';
import {
  buildCliCommandArgs,
  buildWorkspaceConstrainedPrompt,
} from '../utils/cli-execution-templates.js';

/**
 * Options for intelligent retry execution
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Backoff multiplier for exponential delay (default: 1.5) */
  backoffMultiplier?: number;
  /** Initial delay in milliseconds before first retry (default: 1000) */
  initialDelayMs?: number;
  /** Minimum score threshold for success (default: 7) */
  scoreThreshold?: number;
}

/**
 * Result from intelligent retry execution
 */
export interface RetryResult {
  /** Whether the task succeeded (score >= threshold) */
  success: boolean;
  /** Final result from CLI tool */
  result: CliToolResult;
  /** Final validation result */
  validation: ValidationResult;
  /** Number of attempts made */
  attempts: number;
  /** Total execution time in milliseconds */
  totalTimeMs: number;
  /** History of all attempts */
  history: RetryAttempt[];
  /** Error message if failed */
  error?: string;
}

/**
 * Individual retry attempt record
 */
export interface RetryAttempt {
  /** Attempt number (1-indexed) */
  attempt: number;
  /** Timestamp of the attempt */
  timestamp: Date;
  /** Task prompt used for this attempt */
  task: string;
  /** Result from CLI tool */
  result: CliToolResult;
  /** Validation result */
  validation: ValidationResult;
  /** Duration of this attempt in milliseconds */
  durationMs: number;
}

/**
 * Result from execCommand with both stdout and stderr
 */
export interface ExecResult {
  /** Standard output from the command */
  stdout: string;
  /** Standard error from the command */
  stderr: string;
  /** Exit code from the command (0 = success) */
  exitCode: number;
}

export abstract class CliToolAdapter extends BaseBackend {
  abstract id: string;
  abstract kind: 'local' | 'sota';
  abstract displayName: string;

  protected config: CliToolConfig;
  protected fileStateManager: FileStateManager;

  constructor(config: CliToolConfig) {
    super();
    this.config = config;
    this.fileStateManager = new FileStateManager();
  }

  abstract executeTask(prompt: string): Promise<CliToolResult>;
  abstract parseOutput(rawOutput: string): CliToolResult;

  /**
   * Get the default model for this adapter
   */
  protected abstract getDefaultModel(): string;

  /**
   * Build validation prompt (shared implementation, can be overridden)
   * V25: Moved to base class to reduce duplication
   */
  buildValidationPrompt(task: string, output: CliToolResult, criteria: string): string {
    return `
## Task Evaluation

### Original Task
${task}

### Actual Output
${output.content || 'No content returned'}

### Files Modified
${output.files_modified.length > 0 ? output.files_modified.join(', ') : 'None'}

### Tools Used
${output.tools_used.length > 0 ? output.tools_used.join(', ') : 'Unknown'}

### Evaluation Criteria
${criteria}

### Instructions
Evaluate if the task is complete and satisfactory. Respond with a JSON object containing:
- score: integer 0-10
- reasoning: detailed explanation of your score
- issues: array of problems found (empty if none)
- suggestions: array of improvements needed (empty if none)

Example response:
{"score": 8, "reasoning": "The task was completed well...", "issues": [], "suggestions": []}

Respond ONLY with the JSON object, no other text.
    `.trim();
  }

  /**
   * Build constrained prompt with workspace boundaries
   * V25: Shared implementation for all CLI adapters
   */
  protected buildConstrainedPrompt(prompt: string, outputFormat: 'json' | 'text' = 'text'): string {
    const workspace = this.config.working_dir || process.cwd();
    return buildWorkspaceConstrainedPrompt(prompt, workspace, outputFormat);
  }

  /**
   * Build command and args array (no shell escaping needed)
   * V25: Shared implementation for all CLI adapters
   */
  protected buildCommandArgs(prompt: string): { command: string; args: string[] } {
    const model = this.getDefaultModel();
    return buildCliCommandArgs(this.config.command, this.config.args_template, model, prompt);
  }

  /**
   * Extract file paths from content
   * Phase 2 cleanup: Delegates to shared utility in cli-parsing.ts
   */
  protected extractFilesFromContent(content: string): string[] {
    return sharedExtractFiles(content);
  }

  /**
   * Extract tools used from content
   * Phase 2 cleanup: Delegates to shared utility in cli-parsing.ts
   */
  protected extractToolsFromContent(content: string): string[] {
    return sharedExtractTools(content);
  }

  async probe(): Promise<ProbeResult> {
    try {
      const command = this.config.command;
      const { execSync } = await import('child_process');
      // Use stdio: 'pipe' for all streams and short timeout to prevent interactive prompts
      const result = execSync(`${command} --version`, {
        stdio: ['pipe', 'pipe', 'pipe'], // Pipe stdin, stdout, stderr
        timeout: 5000, // 5 second timeout
        encoding: 'utf-8',
        env: { ...process.env, CI: 'true' }, // Signal non-interactive mode
      });
      const version = result?.trim()?.split('\n')[0] || 'installed';
      return { available: true, version };
    } catch (error) {
      // Check if it's a timeout or actual missing command
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timed out')) {
        return {
          available: false,
          error: `${this.displayName} timed out (may require authentication)`,
        };
      }
      return { available: false, error: `${this.displayName} not found or not accessible` };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'default',
        name: 'CLI Tool (uses its own model)',
        capabilities: ['chat', 'tools'],
      },
    ];
  }

  async invokeChat(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    // Important: as a backend, this must behave like a normal chat model.
    // Do NOT wrap responses in extra JSON envelopes and do NOT run self-validation here.
    // AgentRunner depends on receiving the model's raw output (often JSON) directly.
    const prompt = req.messages
      .filter((m) => m.role === 'user' || m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const { command, args: baseArgs } = this.buildCommandArgs(prompt);
    let args = baseArgs;

    // For OpenCode, prefer human-readable output. `--format json` is typically event streaming output.
    // The caller's prompt already enforces any required JSON schema (e.g. AgentRunner action JSON).
    const cmdLower = String(command).toLowerCase();
    if (cmdLower.includes('opencode')) {
      const i = args.findIndex((a) => a === '--format');
      if (i >= 0 && args[i + 1] === 'json') {
        args = [...args];
        args[i + 1] = 'default';
      }
    }

    const { stdout, stderr, exitCode } = await this.execCommand(command, args, {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    const content = (stdout.trim() || stderr.trim()).trim();

    if (exitCode !== 0 && !content) {
      throw new Error(`${this.displayName} returned exit code ${exitCode}`);
    }

    return {
      message: {
        role: 'assistant',
        content,
      },
    };
  }

  async validateOutput(
    task: string,
    output: CliToolResult,
    criteria: string = 'task completion'
  ): Promise<ValidationResult> {
    const prompt = this.buildValidationPrompt(task, output, criteria);

    try {
      const { execSync } = await import('child_process');
      const response = execSync(
        `echo ${JSON.stringify(prompt)} | ${this.config.command} -p - -f json -q`,
        {
          encoding: 'utf-8',
          timeout: 60000,
          cwd: this.config.working_dir,
        }
      );

      const parsed = JSON.parse(response);
      return {
        score: parsed.score ?? 5,
        reasoning: parsed.reasoning || 'No reasoning provided',
        issues: parsed.issues || [],
        suggestions: parsed.suggestions || [],
      };
    } catch (error) {
      return {
        score: 5,
        reasoning: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        issues: ['Unable to validate output'],
        suggestions: ['Manual review recommended'],
      };
    }
  }

  async executeWithValidation(
    task: string,
    criteria: string = 'task completion',
    maxRetries: number = 3
  ): Promise<{ result: CliToolResult; validation: ValidationResult; attempts: number }> {
    let lastOutput: CliToolResult | null = null;
    let lastValidation: ValidationResult | null = null;
    let currentTask = task;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.executeTask(currentTask);
      lastOutput = result;

      const validation = await this.validateOutput(currentTask, result, criteria);
      lastValidation = validation;

      if (validation.score >= 8) {
        return { result, validation, attempts: attempt };
      }

      if (attempt < maxRetries) {
        currentTask = this.buildRetryPrompt(task, result, validation);
      }
    }

    return {
      result: lastOutput!,
      validation: lastValidation!,
      attempts: maxRetries,
    };
  }

  private buildRetryPrompt(
    originalTask: string,
    lastResult: CliToolResult,
    validation: ValidationResult
  ): string {
    return `
## Original Task
${originalTask}

## Previous Attempt
${lastResult.content}

## Issues Found
${validation.issues.length > 0 ? validation.issues.map((i: string) => `- ${i}`).join('\n') : 'No specific issues identified'}

## Suggestions
${validation.suggestions.length > 0 ? validation.suggestions.map((s: string) => `- ${s}`).join('\n') : 'No specific suggestions'}

Please retry the original task, addressing the issues and suggestions above. Focus on achieving a validation score of 8 or higher.
    `.trim();
  }

  /**
   * Execute task with intelligent retry and feedback loop
   * Includes exponential backoff and comprehensive history tracking
   */
  async executeWithIntelligentRetry(
    task: string,
    criteria: string = 'task completion',
    options: RetryOptions = {}
  ): Promise<RetryResult> {
    const {
      maxRetries = 3,
      backoffMultiplier = 1.5,
      initialDelayMs = 1000,
      scoreThreshold = 7,
    } = options;

    let lastResult: CliToolResult | null = null;
    let lastValidation: ValidationResult | null = null;
    let currentTask = task;
    const startTime = Date.now();
    const history: RetryAttempt[] = [];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[CLI-ADAPTER] Intelligent retry attempt ${attempt}/${maxRetries}`);

      const attemptStart = Date.now();

      // Execute task
      const result = await this.executeTask(currentTask);
      lastResult = result;

      // Validate output
      const validation = await this.validateOutput(currentTask, result, criteria);
      lastValidation = validation;

      const attemptDuration = Date.now() - attemptStart;

      // Record attempt
      history.push({
        attempt,
        timestamp: new Date(),
        task: currentTask.substring(0, 500),
        result,
        validation,
        durationMs: attemptDuration,
      });

      console.log(
        `[CLI-ADAPTER] Attempt ${attempt} completed: score=${validation.score}/10, duration=${attemptDuration}ms`
      );

      // Check if successful
      if (validation.score >= scoreThreshold) {
        return {
          success: true,
          result,
          validation,
          attempts: attempt,
          totalTimeMs: Date.now() - startTime,
          history,
        };
      }

      // Build retry prompt if more attempts available
      if (attempt < maxRetries) {
        currentTask = this.buildIntelligentRetryPrompt(task, result, validation, history);

        // Add exponential backoff
        const delayMs = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        console.log(`[CLI-ADAPTER] Waiting ${delayMs}ms before retry...`);
        await this.sleep(delayMs);
      }
    }

    return {
      success: false,
      result: lastResult!,
      validation: lastValidation!,
      attempts: maxRetries,
      totalTimeMs: Date.now() - startTime,
      history,
      error: `Failed to achieve score ${scoreThreshold} after ${maxRetries} attempts. Final score: ${lastValidation!.score}/10`,
    };
  }

  /**
   * Build an intelligent retry prompt with full history context
   */
  private buildIntelligentRetryPrompt(
    originalTask: string,
    lastResult: CliToolResult,
    validation: ValidationResult,
    history: RetryAttempt[]
  ): string {
    const previousAttempts = history.length;

    let prompt = `## ORIGINAL TASK\n${originalTask}\n\n`;

    if (previousAttempts > 0) {
      prompt += `## PREVIOUS ATTEMPTS (${previousAttempts})\n`;
      history.forEach((h, i) => {
        prompt += `Attempt ${i + 1}: Score ${h.validation.score}/10`;
        if (h.validation.issues.length > 0) {
          prompt += ` - Issues: ${h.validation.issues.slice(0, 2).join(', ')}`;
        }
        prompt += '\n';
      });
      prompt += '\n';
    }

    prompt += `## LATEST ATTEMPT RESULT\n${lastResult.content.substring(0, 1000)}\n\n`;

    if (validation.issues.length > 0) {
      prompt += `## ISSUES TO ADDRESS\n`;
      validation.issues.forEach((issue) => {
        prompt += `- ${issue}\n`;
      });
      prompt += '\n';
    }

    if (validation.suggestions.length > 0) {
      prompt += `## SUGGESTIONS\n`;
      validation.suggestions.forEach((suggestion) => {
        prompt += `- ${suggestion}\n`;
      });
      prompt += '\n';
    }

    prompt += `## INSTRUCTIONS\n`;
    prompt += `Please retry the original task, addressing ALL issues above.\n`;
    prompt += `Target score: ${7}/10 or higher.\n`;
    prompt += `Focus on: ${validation.suggestions.slice(0, 2).join(', ') || 'completeness and correctness'}.`;

    return prompt;
  }

  protected async execCommand(
    command: string,
    args?: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<ExecResult> {
    const cmdStart = Date.now();
    const useArgs = args !== undefined;
    const effectiveTimeout = Math.max(1, Number(opts?.timeoutMs ?? this.config.timeout));
    console.log(
      `[CLI-ADAPTER] 🚀 execCommand START | timeout=${effectiveTimeout}ms | cwd=${this.config.working_dir} | useArgs=${useArgs}`
    );

    if (useArgs) {
      console.log(`[CLI-ADAPTER] 🚀 command: ${command} [${args.length} args]`);
    } else {
      console.log(
        `[CLI-ADAPTER] 🚀 command: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`
      );
    }

    let spawnCommand = command;
    let spawnArgs: string[] = args ?? [];
    let promptAttachmentPath: string | null = null;

    // Windows: npm CLIs often ship a non-Windows shim without extension (e.g. `opencode` as a sh script)
    // alongside a `*.cmd` shim. `spawn(shell=false)` can pick the non-Windows shim first and fail with ENOENT.
    // To keep argument passing safe (avoid shell injection) while supporting npm-installed CLIs, detect a .cmd
    // shim and execute its Node entrypoint directly via `node <script> ...args`.
    if (useArgs && process.platform === 'win32') {
      const resolveCmdShimPath = (nameOrPath: string): string | null => {
        const normalized = String(nameOrPath || '').trim();
        if (!normalized) return null;

        const hasPathSep = normalized.includes('\\') || normalized.includes('/');
        if (hasPathSep || isAbsolute(normalized)) {
          if (/\\.cmd$/i.test(normalized) && existsSync(normalized)) return normalized;
          const candidate = `${normalized}.cmd`;
          if (existsSync(candidate)) return candidate;
          return null;
        }

        const pathEnv = process.env.PATH || '';
        const dirs = pathEnv
          .split(';')
          .map((p) => p.trim().replace(/^"+|"+$/g, ''))
          .filter(Boolean);

        for (const dir of dirs) {
          const candidate = join(dir, `${normalized}.cmd`);
          if (existsSync(candidate)) return candidate;
        }

        return null;
      };

      const tryParseNodeTargetFromCmdShim = (cmdShimPath: string): string | null => {
        try {
          const content = readFileSync(cmdShimPath, 'utf8');
          const dp0VarMatch = content.match(/%dp0%\\+(node_modules\\+[^"]+?)(?:"|\s)/i);
          const tildeDp0Match = content.match(/%~dp0\\+(node_modules\\+[^"]+?)(?:"|\s)/i);
          const relative = (dp0VarMatch?.[1] || tildeDp0Match?.[1] || '').trim();
          if (!relative) return null;

          const scriptPath = join(dirname(cmdShimPath), relative);
          return existsSync(scriptPath) ? scriptPath : null;
        } catch {
          return null;
        }
      };

      const cmdShimPath = resolveCmdShimPath(spawnCommand);
      if (cmdShimPath) {
        const nodeTarget = tryParseNodeTargetFromCmdShim(cmdShimPath);
        if (nodeTarget) {
          spawnCommand = process.execPath;
          spawnArgs = [nodeTarget, ...spawnArgs];
        }
      }
    }

    // Windows has a strict command-line length limit; large prompts can cause hard failures or apparent hangs.
    // For OpenCode CLI, fall back to attaching the full prompt as a file and sending a short message instead.
    if (useArgs) {
      const lower = [spawnCommand, ...spawnArgs.slice(0, 2)].join(' ').toLowerCase();
      const isOpenCode = lower.includes('opencode');
      if (isOpenCode) {
        const estimatedCmdLineLen =
          spawnCommand.length + spawnArgs.reduce((sum, a) => sum + String(a).length + 3, 0);
        const maxArgLen = spawnArgs.reduce((m, a) => Math.max(m, String(a).length), 0);
        const needsPromptFile = maxArgLen > 12000 || estimatedCmdLineLen > 28000;
        if (needsPromptFile) {
          const promptArgIndex = spawnArgs.reduce(
            (best, a, i) => (String(a).length > String(spawnArgs[best] ?? '').length ? i : best),
            0
          );
          const originalPrompt = String(spawnArgs[promptArgIndex] ?? '');
          const id = crypto.randomUUID();
          promptAttachmentPath = join(tmpdir(), `mcp-local-llm-opencode-prompt-${id}.md`);
          writeFileSync(promptAttachmentPath, originalPrompt, 'utf8');

          const basename = promptAttachmentPath.split(/[\\/]/).pop() || 'prompt.md';
          const shortMessage = `Full prompt is attached as ${basename}. Use the attached file content as the prompt and follow it exactly.`;

          spawnArgs[promptArgIndex] = shortMessage;
          spawnArgs.splice(promptArgIndex, 0, '--file', promptAttachmentPath);

          console.log(
            `[CLI-ADAPTER] 📎 OpenCode prompt too large for argv; using --file attachment: ${promptAttachmentPath}`
          );
        }
      }
    }

    return new Promise((resolve, reject) => {
      // Use spawn with args array when provided (bypasses shell interpretation)
      // Fall back to shell=true for legacy command strings
      const child = useArgs
        ? spawn(spawnCommand, spawnArgs, {
            shell: false, // No shell interpretation - args passed directly
            cwd: this.config.working_dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              ...this.config.environment,
              NO_COLOR: '1',
              CI: 'true',
              OPENCODE_NON_INTERACTIVE: '1',
            },
          })
        : spawn(command, {
            shell: true,
            cwd: this.config.working_dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              ...this.config.environment,
              NO_COLOR: '1',
              CI: 'true',
              OPENCODE_NON_INTERACTIVE: '1',
            },
          });

      console.log(`[CLI-ADAPTER] 🔄 Child process spawned | pid=${child.pid}`);

      if (opts?.signal) {
        const onAbort = () => {
          console.warn(
            `[CLI-ADAPTER] 🛑 Abort signal received — killing child process pid=${child.pid}`
          );
          child.kill('SIGTERM');
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        console.log(
          `[CLI-ADAPTER] 📥 stdout chunk (${chunk.length} bytes) at +${Date.now() - cmdStart}ms`
        );
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.log(
          `[CLI-ADAPTER] ⚠️ stderr chunk (${chunk.length} bytes) at +${Date.now() - cmdStart}ms`
        );
      });

      // Set up timeout first so it's available in event handlers
      const timeoutHandle = setTimeout(() => {
        console.warn(
          `[CLI-ADAPTER] ⏰ TIMEOUT after ${effectiveTimeout}ms — killing child process pid=${child.pid}`
        );
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        const elapsed = Date.now() - cmdStart;
        const exitCode = code ?? -1;
        console.log(
          `[CLI-ADAPTER] ✅ Child process closed | code=${exitCode} | elapsed=${elapsed}ms | stdout=${stdout.length} bytes | stderr=${stderr.length} bytes`
        );
        if (promptAttachmentPath) {
          try {
            unlinkSync(promptAttachmentPath);
          } catch {
            // best-effort cleanup
          }
        }
        // Return both stdout and stderr instead of throwing on non-zero exit
        // Let the adapter decide how to handle the result
        resolve({ stdout, stderr, exitCode });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        console.error(
          `[CLI-ADAPTER] ❌ Child process error at +${Date.now() - cmdStart}ms:`,
          error.message
        );
        if (promptAttachmentPath) {
          try {
            unlinkSync(promptAttachmentPath);
          } catch {
            // best-effort cleanup
          }
        }
        reject(error);
      });
    });
  }

  protected async captureFileState(dir?: string): Promise<FileStateSnapshot> {
    return this.fileStateManager.capture(dir || this.config.working_dir || process.cwd());
  }

  protected async detectChanges(before: FileStateSnapshot): Promise<FileChange[]> {
    const after = await this.captureFileState();
    return this.fileStateManager.detectChanges(before, after);
  }
}

class FileStateManager {
  private readonly ignorePatterns = [
    'node_modules',
    '.git',
    '.opencode',
    'dist',
    'build',
    '*.log',
    '*.tmp',
  ];

  async capture(rootDir: string): Promise<FileStateSnapshot> {
    const files = new Map<string, string>();
    const { walkDir } = await import('../utils/file-walker.js');

    try {
      const entries = await walkDir(rootDir);

      for (const entry of entries) {
        if (this.shouldIgnore(entry.path)) continue;

        try {
          const { readFileSync } = await import('fs');
          const content = readFileSync(entry.path, 'utf-8');
          const hash = this.computeHash(content);
          files.set(entry.path, hash);
        } catch {
          // Skip files that can't be read
        }
      }
    } catch {
      // Directory might not exist, return empty snapshot
    }

    return { timestamp: new Date(), files };
  }

  async detectChanges(before: FileStateSnapshot, after: FileStateSnapshot): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    const beforeFiles = new Set(before.files.keys());
    const afterFiles = new Set(after.files.keys());

    for (const [path, afterHash] of after.files) {
      if (!beforeFiles.has(path)) {
        changes.push({ path, type: 'created', after_hash: afterHash });
      } else if (before.files.get(path) !== afterHash) {
        changes.push({
          path,
          type: 'modified',
          before_hash: before.files.get(path),
          after_hash: afterHash,
        });
      }
    }

    for (const path of beforeFiles) {
      if (!afterFiles.has(path)) {
        changes.push({ path, type: 'deleted', before_hash: before.files.get(path) });
      }
    }

    return changes;
  }

  private shouldIgnore(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    return this.ignorePatterns.some((pattern) => {
      if (pattern.startsWith('*')) {
        return normalized.endsWith(pattern.slice(1));
      }
      return normalized.includes(`/${pattern}/`) || normalized.endsWith(`/${pattern}`);
    });
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }
}
