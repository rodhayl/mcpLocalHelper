import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'fs';
import { dirname, isAbsolute, resolve, join } from 'path';
import { tmpdir } from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { ConfigManager } from '../config/index.js';
import type { LlmChatTool } from '../tools/llm.js';
import type { FileTools } from '../tools/file.js';
import type { GrepTools } from '../tools/grep.js';
import type { SummarizationTools } from '../tools/summarize.js';
import type { EditTools } from '../tools/edit.js';
import type { LlmEnhancedTools } from '../tools/llm-enhanced.js';
import type { HighValueTools } from '../tools/highvalue.js';
import type { McpClientManager } from '../utils/mcp-client.js';
import { inferReadOnlyFromTaskText } from '../utils/task-intent.js';
import { debug, type LogCategory } from '../utils/debug-logger.js';
import { extractJsonFromText } from '../utils/llm-json.js';
import { AgentResultCache } from './agent-result-cache.js';
import { getPlanMemory } from './plan-memory.js';
import { getSemanticMemory } from './semantic-memory.js';
import { getSmartDefaultsManager } from '../utils/smart-defaults.js';
import { AGENT_ONLY_TOOLS } from '../server/tool-discovery.js';

/**
 * AGENTS.md Support - Read project-specific agent instructions
 * Following the agents.md specification (https://agents.md/)
 *
 * Priority order:
 * 1. .mcp-local-llm/AGENTS.md (MCP-specific instructions)
 * 2. AGENTS.md (root level)
 * 3. AGENT.md (legacy support)
 */
function readAgentsMd(contextRoot: string): string | undefined {
  const candidates = [
    join(contextRoot, '.mcp-local-llm', 'AGENTS.md'),
    join(contextRoot, 'AGENTS.md'),
    join(contextRoot, 'AGENT.md'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        // Truncate to ~2000 chars to avoid context bloat (as per LLM feedback)
        const maxChars = 2000;
        if (content.length > maxChars) {
          return content.substring(0, maxChars) + '\n... [truncated for context efficiency]';
        }
        return content;
      } catch {
        // Intentionally empty - file exists but can't be read
      }
    }
  }
  return undefined;
}

/**
 * Build project context string for agent prompts
 * Addresses LLM feedback: "tools do not inherently know the project language"
 */
function buildProjectContextPrompt(contextRoot: string): string {
  const smartDefaults = getSmartDefaultsManager();
  smartDefaults.initialize(contextRoot);
  const ctx = smartDefaults.getProjectContext(contextRoot);

  if (ctx.projectType === 'unknown' && ctx.languages.length === 0) {
    return '';
  }

  const parts: string[] = [];

  if (ctx.projectType !== 'unknown') {
    parts.push(`Project type: ${ctx.projectType}`);
  }

  if (ctx.languages.length > 0) {
    parts.push(`Languages: ${ctx.languages.join(', ')}`);
  }

  if (ctx.detectedTypes.length > 1) {
    parts.push(`Frameworks: ${ctx.detectedTypes.join(', ')}`);
  }

  // Add key exclude hints based on project type
  const excludeHints: string[] = [];
  if (ctx.languages.includes('python')) {
    excludeHints.push('venv/', '.venv/', '__pycache__/', '.pytest_cache/');
  }
  if (ctx.languages.includes('javascript') || ctx.languages.includes('typescript')) {
    excludeHints.push('node_modules/', 'dist/', 'build/');
  }
  if (ctx.languages.includes('rust')) {
    excludeHints.push('target/');
  }
  if (ctx.languages.includes('go')) {
    excludeHints.push('vendor/');
  }

  if (excludeHints.length > 0) {
    parts.push(`Exclude from searches: ${excludeHints.join(', ')}`);
  }

  return parts.length > 0 ? `[PROJECT CONTEXT]\n${parts.join('\n')}\n` : '';
}

const VALID_ACTION_TYPES = [
  'search_repo',
  'read_file',
  'list_files',
  'summarize_path',
  'summarize_repo',
  'codebase_qa',
  'generate_tests',
  'security_scan',
  'analyze_file',
  'find_and_fix',
  'local_code_review',
  'http_request',
  'extract_http_routes',
  'write_json_file',
  'mcp_generate_cheatsheet',
  'generate_api_inventory',
  'apply_diff',
  'create_file',
  'propose_changes',
  'mcp_connect',
  'mcp_list_tools',
  'mcp_call',
  'done',
] as const;
type ValidActionType = (typeof VALID_ACTION_TYPES)[number];

/**
 * Maximum timeout for a single LLM call during agent task execution.
 *
 * This prevents the agent from hanging indefinitely when the LLM is slow or unresponsive.
 * Without this, if no global deadline is set, LLM calls would use the default backend
 * timeout which can be as high as 10 minutes (600000ms).
 *
 * Set to 60 seconds as a reasonable balance between:
 * - Allowing time for complex LLM reasoning (especially for local models)
 * - Preventing unacceptably long hangs that appear as "frozen" agent
 */
const MAX_SINGLE_LLM_CALL_MS = 60000;

export interface AgentTaskOptions {
  contextRoot: string;
  maxSubtasks?: number;
  maxSteps?: number;
  maxActionsPerStep?: number;
  allowMcpServers?: string[];
  allowedActions?: string[];
  readOnly?: boolean;
  autoConnectMcp?: boolean;
  writeAllowlistPaths?: string[];
  /** If true, plan only; do not execute actions. */
  dryRun?: boolean;
  /** Optional wall-clock budget for this run (best-effort). */
  timeoutMs?: number;
  /** Optional abort signal for cooperative cancellation. */
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
}

export type AgentProgressEvent =
  | { type: 'task_start'; task: string }
  | { type: 'plan_generated'; subtasks: number; steps: number }
  | { type: 'subtask_start'; subtaskId: string; title: string }
  | {
      type: 'step_start';
      subtaskId: string;
      stepId: string;
      title: string;
      index: number;
      total: number;
    }
  | { type: 'action'; subtaskId: string; stepId: string; actionType: string; ok: boolean }
  | {
      type: 'step_end';
      subtaskId: string;
      stepId: string;
      status: 'completed' | 'failed' | 'skipped';
    }
  | { type: 'task_end'; success: boolean };

export interface AgentTaskResult {
  success: boolean;
  task: string;
  contextRoot: string;
  effectiveOptions: {
    readOnly: boolean;
    inferredReadOnly: boolean;
    autoConnectMcp: boolean;
    maxSubtasks: number;
    maxSteps: number;
    maxActionsPerStep: number;
    allowMcpServers: string[];
    allowedActions?: string[];
    writeAllowlistPaths: string[] | null;
    dryRun?: boolean;
  };
  plan: {
    subtasks: Array<{
      id: string;
      title: string;
      task: string;
      steps: Array<{
        id: string;
        title: string;
        description: string;
        targets: string[];
      }>;
    }>;
  };
  partial?: boolean;
  execution: Array<{
    subtaskId: string;
    stepId: string;
    status: 'completed' | 'failed' | 'skipped';
    autoCompleted?: boolean;
    actions: Array<{
      actionType: string;
      params: Record<string, unknown>;
      ok: boolean;
      output?: unknown;
      error?: string;
    }>;
  }>;
  final: {
    summary: string;
    notes?: string[];
    metrics?: {
      plannedSteps: number;
      executedSteps: number;
      completedSteps: number;
      failedSteps: number;
      skippedSteps: number;
      autoCompletedSteps?: number;
      okActions: number;
      failedActions: number;
    };
  };
  error?: string;

  // Plan 3: Agent Completion Intelligence - support for "Continue" command
  /** Reason why the task ended (completed, step_limit, action_limit, timeout, error, cancelled) */
  completionReason?:
    | 'completed'
    | 'step_limit'
    | 'action_limit'
    | 'timeout'
    | 'error'
    | 'cancelled';
  /** Whether the task can be continued with a "Continue" command */
  continueAvailable?: boolean;
  /** State needed to continue the task (remaining subtasks, steps, context) */
  continueState?: {
    remainingSubtasks: Array<{ id: string; title: string; task: string }>;
    remainingSteps: Array<{
      subtaskId: string;
      stepId: string;
      title: string;
      description: string;
    }>;
    lastCompletedStepId?: string;
    context?: Record<string, unknown>;
  };
  /** Project context detected for this task */
  projectContext?: {
    projectType: string;
    languages: string[];
    detectedTypes: string[];
  };
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function isLikelyFilePath(pathValue: string): boolean {
  const name = pathValue.split('/').pop() || '';
  return /\.[a-z0-9]{1,8}$/i.test(name);
}

interface AgentRunContext {
  readOnly: boolean;
  writeAllowlistPaths: string[] | null;
  signal?: AbortSignal;
  deadlineTs?: number;
  correlationId?: string; // PLAN A: Correlation ID for request tracing
}

const SubtasksSchema = z.object({
  subtasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      task: z.string(),
    })
  ),
});

const StepsSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      targets: z.array(z.string()).default([]),
    })
  ),
});

const NextActionSchema = z.object({
  actionType: z.enum(VALID_ACTION_TYPES),
  params: z.record(z.string(), z.unknown()).default({}),
});

export class AgentRunner {
  private runContext = new AsyncLocalStorage<AgentRunContext>();
  private recentObservations: Array<{ action: string; output: unknown }> = [];
  private readonly MAX_OBSERVATIONS = 10;
  /** V12: Per-task file read tracking to prevent re-reading same file across subtasks */
  private taskFileReadHistory: Set<string> = new Set();

  constructor(
    private deps: {
      config: ConfigManager;
      llmChat: LlmChatTool;
      fileTools: FileTools;
      grepTools: GrepTools;
      summarization: SummarizationTools;
      editTools: EditTools;
      mcpClient: McpClientManager;
      llmEnhancedTools?: LlmEnhancedTools;
      highValueTools?: HighValueTools;
    }
  ) {}

  private getContext(): AgentRunContext {
    return (
      this.runContext.getStore() || {
        readOnly: false,
        writeAllowlistPaths: null,
        signal: undefined,
        deadlineTs: undefined,
      }
    );
  }

  private getRemainingMs(): number | null {
    const deadlineTs = this.getContext().deadlineTs;
    if (deadlineTs === undefined) return null;
    return Math.max(0, deadlineTs - Date.now());
  }

  private throwIfAborted(where?: string): void {
    const ctx = this.getContext();
    if (ctx.signal?.aborted) {
      const err = new Error(where ? `Agent task aborted (${where})` : 'Agent task aborted');
      (err as any).name = 'AbortError';
      throw err;
    }
    if (ctx.deadlineTs !== undefined && Date.now() > ctx.deadlineTs) {
      const err = new Error('Agent task timed out');
      (err as any).name = 'TimeoutError';
      throw err;
    }
  }

  /**
   * Track an observation (action output) for path correction.
   * Keeps only the most recent MAX_OBSERVATIONS to limit memory.
   */
  private addObservation(action: string, output: unknown): void {
    this.recentObservations.push({ action, output });
    if (this.recentObservations.length > this.MAX_OBSERVATIONS) {
      this.recentObservations.shift();
    }
  }

  /**
   * PLAN A: Emit structured action trace for observability
   * Logs action execution with correlation ID for debugging agent issues
   */
  private emitActionTrace(
    subtaskId: string,
    stepId: string,
    actionType: string,
    result: { ok: boolean; durationMs?: number; error?: string }
  ): void {
    const ctx = this.getContext();
    const category: LogCategory = 'agent';
    const message = `Action: ${actionType} (subtask: ${subtaskId}, step: ${stepId}) - ${result.ok ? 'SUCCESS' : 'FAILED'}`;
    const context = {
      subtaskId,
      stepId,
      actionType,
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.error,
    };

    // Log with correlation ID if available
    if (result.ok) {
      debug.debug(category, message, context, ctx.correlationId);
    } else {
      debug.warn(category, message, context, ctx.correlationId);
    }
  }
  private async llmJsonFromMessages(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: { maxRetries?: number; maxTokens?: number }
  ): Promise<unknown> {
    const maxRetries = opts?.maxRetries ?? 4;
    const maxTokens = opts?.maxTokens ?? 1400;
    let lastRaw = '';
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.throwIfAborted('llmJson');

      const remaining = this.getRemainingMs();
      // FIX: Always enforce a maximum per-call timeout to prevent indefinite hangs.
      // Previously, when remaining was null (no deadline set), timeoutMs would be undefined,
      // causing the LLM call to use the default backend timeout of 10 MINUTES.
      // Now we cap it at MAX_SINGLE_LLM_CALL_MS (60 seconds) regardless.
      const timeoutMs =
        remaining !== null
          ? Math.max(1, Math.min(MAX_SINGLE_LLM_CALL_MS, Math.max(1, remaining - 750)))
          : MAX_SINGLE_LLM_CALL_MS;

      const resp = await this.deps.llmChat.chat(
        {
          messages,
          temperature: 0,
          max_tokens: maxTokens,
        },
        'local',
        {
          maxRetries: 0,
          timeoutMs,
          signal: this.getContext().signal,
        }
      );

      const raw = resp.message.content || '';
      lastRaw = raw;
      try {
        return extractJsonFromText(raw);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        const rawPreview = typeof raw === 'string' ? raw.slice(0, 800) : String(raw).slice(0, 800);
        if (process.env.AGENT_DEBUG_JSON === '1') {
          console.warn(
            `[agent-json] parse error attempt=${attempt + 1}/${maxRetries}: ${err}\n${rawPreview}`
          );
          if (typeof raw === 'string') {
            const m = /position\s+(\d+)/i.exec(err);
            if (m) {
              const pos = Number(m[1]);
              const s = Math.max(0, pos - 25);
              const e2 = Math.min(raw.length, pos + 25);
              const ctx = raw.slice(s, e2);
              const codes = ctx
                .split('')
                .map((c) => c.charCodeAt(0))
                .join(',');
              console.warn(`[agent-json] context[${s}:${e2}]: ${ctx}`);
              console.warn(`[agent-json] codes: ${codes}`);
            }
          }
        }
        messages.push({
          role: 'user',
          content:
            'The previous response was not valid JSON. ' +
            'Return ONLY valid JSON with the exact schema requested. ' +
            'No markdown, no explanations.\n\n' +
            `Invalid output (truncated):\n${rawPreview}\n\n` +
            `Parse error: ${err}\n\n` +
            'Reminder: Return ONLY raw JSON (no code fences, no surrounding quotes). Do not escape quotes. Use forward slashes in paths to avoid invalid escapes.',
        });

        // Memory protection: trim message history if it grows too large
        // Keep system prompt (first message) and last 6 messages to avoid unbounded growth
        const MAX_MESSAGES = 8;
        if (messages.length > MAX_MESSAGES) {
          const systemMsg = messages[0].role === 'system' ? messages[0] : null;
          const recentMessages = messages.slice(-6);
          messages.length = 0;
          if (systemMsg) messages.push(systemMsg);
          messages.push(...recentMessages);
        }
      }
    }

    throw new Error(
      `LLM did not return valid JSON after retries. Last output: ${JSON.stringify(lastRaw)}`
    );
  }

  private async llmJsonWithSchema<T>(input: {
    schema: z.ZodType<T>;
    system: string;
    user: string;
    schemaHint: string;
    maxAttempts?: number;
    coerce?: (raw: unknown) => unknown;
    /** If true, attempt to extract partial result on final failure */
    allowPartial?: boolean;
  }): Promise<T> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ];

    const maxAttempts = input.maxAttempts ?? 4;
    let last: unknown = undefined;
    let lastRaw = '';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.throwIfAborted('llmJsonWithSchema');
      const remaining = this.getRemainingMs();
      // If we have a global budget, avoid starting another LLM call when we're too close to the deadline.
      if (remaining !== null && remaining < 1500) {
        const err = new Error('Agent task timed out');
        (err as any).name = 'TimeoutError';
        throw err;
      }
      last = await this.llmJsonFromMessages(messages, { maxRetries: 2 });
      lastRaw = typeof last === 'string' ? last : JSON.stringify(last);
      const candidate = input.coerce ? input.coerce(last) : last;
      const parsed = input.schema.safeParse(candidate);
      if (parsed.success) return parsed.data;

      messages.push({
        role: 'user',
        content:
          'Your previous JSON did not match the required schema.\n' +
          `${input.schemaHint}\n\n` +
          `Validation errors:\n${parsed.error.message}\n\n` +
          'Return ONLY valid JSON for the schema. No markdown, no explanations.',
      });
    }

    // Final attempt with coercion
    const finalParsed = input.schema.safeParse(input.coerce ? input.coerce(last) : last);
    if (finalParsed.success) return finalParsed.data;

    // Graceful degradation: attempt to extract partial result if allowed
    if (input.allowPartial) {
      const partial = this.attemptPartialExtraction(lastRaw, input.schemaHint);
      if (partial !== null) {
        const partialParsed = input.schema.safeParse(
          input.coerce ? input.coerce(partial) : partial
        );
        if (partialParsed.success) {
          debug.warn('agent', 'Used partial extraction for schema validation', {
            schemaHint: input.schemaHint.slice(0, 100),
          });
          return partialParsed.data;
        }
      }
    }

    throw new Error(finalParsed.error.message);
  }

  /**
   * Attempt to extract a partial/usable result from malformed LLM output.
   * This is a last-resort graceful degradation for small models that struggle with JSON.
   */
  private attemptPartialExtraction(raw: string, schemaHint: string): unknown {
    // Try to find any JSON-like object in the output
    const jsonMatches = raw.match(/\{[\s\S]*\}/g);
    if (jsonMatches) {
      for (const match of jsonMatches) {
        try {
          return JSON.parse(match);
        } catch {
          // Try with JSON repair
          try {
            return extractJsonFromText(match);
          } catch {
            // Continue to next match
          }
        }
      }
    }

    // For summary-like schemas, try to extract raw text content
    if (schemaHint.includes('summary') || schemaHint.includes('result')) {
      // Strip markdown code fences and return as summary
      const cleaned = raw
        .replace(/```[\s\S]*?```/g, '')
        .replace(/^#+\s+/gm, '')
        .trim();
      if (cleaned.length > 20) {
        return { summary: cleaned.slice(0, 2000) };
      }
    }

    return null;
  }

  private normalizeActionType(actionTypeRaw: string): ValidActionType | null {
    const normalized = String(actionTypeRaw || '')
      .trim()
      .toLowerCase()
      .replace(/[ -]+/g, '_')
      .replace(/^mcp\\./g, 'mcp_');

    if ((VALID_ACTION_TYPES as readonly string[]).includes(normalized)) {
      return normalized as ValidActionType;
    }

    const map: Record<string, ValidActionType> = {
      grep: 'search_repo',
      search: 'search_repo',
      find: 'search_repo',
      ripgrep: 'search_repo',
      rg: 'search_repo',
      searchrepo: 'search_repo',
      search_repo_v2: 'search_repo',

      ls: 'list_files',
      list_files: 'list_files',
      listfiles: 'list_files',
      list_dir: 'list_files',
      list_directory: 'list_files',
      listdirectory: 'list_files',
      files: 'list_files',

      read: 'read_file',
      open: 'read_file',
      open_file: 'read_file',
      readfile: 'read_file',
      read_file_contents: 'read_file',

      summarize: 'summarize_path',
      summarise: 'summarize_path',
      summarizefile: 'summarize_path',
      summarize_dir: 'summarize_path',
      summarize_directory: 'summarize_path',
      summarize_repository: 'summarize_repo',

      patch: 'apply_diff',
      apply: 'apply_diff',
      apply_patch: 'apply_diff',
      applydiff: 'apply_diff',
      edit: 'apply_diff',

      create: 'create_file',
      write_file: 'create_file',
      write_to_file: 'create_file',
      writefile: 'create_file',
      add_file: 'create_file',

      connect: 'mcp_connect',
      connect_mcp: 'mcp_connect',
      connect_server: 'mcp_connect',
      mcpconnect: 'mcp_connect',

      list_tools: 'mcp_list_tools',
      tools: 'mcp_list_tools',
      mcp_tools: 'mcp_list_tools',

      call: 'mcp_call',
      invoke: 'mcp_call',
      tool: 'mcp_call',
      use_tool: 'mcp_call',
      call_tool: 'mcp_call',

      finish: 'done',
      complete: 'done',
      final: 'done',
    };

    const mapped = map[normalized] || map[normalized.replace(/_/g, '')];
    return mapped || null;
  }

  private inferActionTypeFromParams(params: Record<string, unknown>): ValidActionType | null {
    const keys = new Set(Object.keys(params));

    // done
    if (keys.has('result') && keys.size <= 2) return 'done';

    // search_repo
    if (keys.has('query') && (keys.has('root') || keys.has('maxMatches'))) return 'search_repo';
    if (keys.has('pattern') && (keys.has('root') || keys.has('maxMatches'))) return 'search_repo';

    // read_file
    if (keys.has('path') && (keys.has('maxBytes') || keys.size <= 2)) return 'read_file';

    // list_files
    if (
      (keys.has('extensions') ||
        keys.has('maxDepth') ||
        keys.has('includeHidden') ||
        keys.has('maxResults')) &&
      (keys.has('root') || keys.has('path'))
    )
      return 'list_files';

    // http_request
    if (
      keys.has('url') &&
      (keys.has('method') || keys.has('headers') || keys.has('body') || keys.has('timeoutMs'))
    )
      return 'http_request';

    // summarize
    if (keys.has('path') && keys.has('mode')) return 'summarize_path';
    if (keys.has('root') && keys.has('mode')) return 'summarize_repo';

    if (keys.has('sourceFilePath') && keys.has('destFilePath')) return 'generate_api_inventory';
    if (keys.has('filePath') && (keys.has('includePrefix') || keys.has('maxRoutes')))
      return 'extract_http_routes';

    // edits
    if (keys.has('filePath') && (keys.has('json') || keys.has('data'))) return 'write_json_file';
    if (keys.has('filePath') && keys.has('diff')) return 'apply_diff';
    if (keys.has('filePath') && keys.has('content')) return 'create_file';

    if (
      keys.has('serverName') &&
      keys.has('filePath') &&
      (keys.has('toolNames') || keys.has('tools'))
    )
      return 'mcp_generate_cheatsheet';

    // mcp
    if (keys.has('serverName') && keys.has('toolName')) return 'mcp_call';
    if (keys.has('serverName') && keys.has('arguments')) return 'mcp_call';
    if (keys.has('serverName') && keys.has('args')) return 'mcp_call';
    if (keys.has('serverName') && keys.has('parameters')) return 'mcp_call';
    if (keys.has('serverName') && keys.size === 1) return 'mcp_connect';

    return null;
  }

  private extractActionCandidate(
    raw: unknown
  ): { actionType: unknown; params: Record<string, unknown> } | null {
    if (typeof raw === 'string') {
      return { actionType: raw, params: {} };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const obj: any = raw;
    const actionType =
      obj.actionType ??
      obj.action_type ??
      obj.action ??
      obj.type ??
      obj.tool ??
      obj.toolName ??
      obj.name ??
      obj.nextAction;

    const paramsRaw =
      obj.params ?? obj.parameters ?? obj.arguments ?? obj.args ?? obj.input ?? undefined;

    const params =
      paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
        ? (paramsRaw as Record<string, unknown>)
        : (obj as Record<string, unknown>);

    const inferred = actionType ? null : this.inferActionTypeFromParams(params);
    if (!actionType && inferred) {
      return { actionType: inferred, params };
    }

    return { actionType, params };
  }

  private async decompose(
    task: string,
    maxSubtasks: number,
    constraintsText?: string,
    semanticContext?: string,
    projectContext?: string,
    agentsMdContent?: string
  ): Promise<Array<{ id: string; title: string; task: string }>> {
    // Build enhanced system prompt with project context
    let system =
      'You are a senior engineer agent. Break the user task into small, concrete subtasks.\n' +
      'Return ONLY valid JSON with this shape:\n' +
      '{ "subtasks": [ { "id": "t1", "title": "...", "task": "..." } ] }\n' +
      'Use forward slashes in any paths.\n' +
      'Do NOT invent/guess file paths. If a path is unknown, describe it as a pattern to search for.\n' +
      `Rules: 1) <= ${maxSubtasks} subtasks. 2) Each subtask must be independently executable. 3) Avoid vague steps.\n` +
      'Prefer a single linear subtask when the task is a straightforward procedure.\n' +
      'Do NOT add setup/cleanup steps unless explicitly required by the task.';

    // Inject project context (addresses "tools do not know project language" feedback)
    if (projectContext) {
      system += `\n\n${projectContext}`;
    }

    // Inject AGENTS.md instructions if available
    if (agentsMdContent) {
      system += `\n\n[PROJECT AGENT INSTRUCTIONS]\n${agentsMdContent}`;
    }

    const user =
      `Task:\n${task}\n\n` +
      (semanticContext ? `Context:\n${semanticContext}\n\n` : '') +
      (constraintsText ? `Execution constraints:\n${constraintsText}\n\n` : '') +
      'If the task is already small, return a single subtask.';

    try {
      const parsed = await this.llmJsonWithSchema({
        schema: SubtasksSchema,
        system,
        user,
        schemaHint: '{ "subtasks": [ { "id": "t1", "title": "...", "task": "..." } ] }',
        maxAttempts: 3,
        coerce: (raw) => {
          if (Array.isArray(raw)) return { subtasks: raw };
          if (raw && typeof raw === 'object') {
            const obj: any = raw;
            if (obj.subtasks) return obj;
            if (obj.plan?.subtasks) return { subtasks: obj.plan.subtasks };
          }
          return raw;
        },
      });
      const subtasks = parsed.subtasks.slice(0, maxSubtasks);
      if (subtasks.length) return subtasks;
    } catch {
      // Intentionally empty - fallback to single subtask below
    }

    // Fallback: if the model can’t emit valid JSON, still proceed with a single subtask.
    return [{ id: 't1', title: 'Task', task }];
  }

  private async planSteps(
    subtask: { id: string; title: string; task: string },
    contextRoot: string,
    maxSteps: number,
    constraintsText?: string,
    semanticContext?: string,
    projectContext?: string,
    agentsMdContent?: string
  ) {
    let system =
      'You are planning work to be executed by tools. Create a short ordered plan.\n' +
      'Return ONLY valid JSON with this shape:\n' +
      '{ "steps": [ { "id": "s1", "title": "...", "description": "...", "targets": ["file/or/dir/or/pattern"] } ] }\n' +
      'Use forward slashes in any paths.\n' +
      `Rules: 1) <= ${maxSteps} steps. 2) Each step should mention concrete targets (paths or patterns) when possible.\n` +
      'Do NOT invent/guess file paths. If needed, add a step to discover paths via search_repo/list_files first.\n' +
      'Keep steps minimal and directly executable; avoid meta steps like "verify installation", "cleanup", or "stop server" unless required.\n' +
      (constraintsText
        ? `Only plan steps that can be executed within these constraints:\n${constraintsText}\n`
        : '');

    // Inject project context
    if (projectContext) {
      system += `\n${projectContext}`;
    }

    // Inject AGENTS.md instructions
    if (agentsMdContent) {
      system += `\n[PROJECT AGENT INSTRUCTIONS]\n${agentsMdContent}`;
    }

    const user =
      `Context root: ${contextRoot.replace(/\\\\/g, '/')}\n` +
      `Subtask (${subtask.id}): ${subtask.title}\n` +
      `${subtask.task}\n` +
      (semanticContext ? `Context:\n${semanticContext}\n\n` : '');

    try {
      const parsed = await this.llmJsonWithSchema({
        schema: StepsSchema,
        system,
        user,
        schemaHint:
          '{ "steps": [ { "id": "s1", "title": "...", "description": "...", "targets": ["..."] } ] }',
        maxAttempts: 3,
        coerce: (raw) => {
          if (Array.isArray(raw)) return { steps: raw };
          if (raw && typeof raw === 'object') {
            const obj: any = raw;
            if (obj.steps) return obj;
            if (obj.plan?.steps) return { steps: obj.plan.steps };
          }
          return raw;
        },
      });
      const steps = parsed.steps.slice(0, maxSteps);
      if (steps.length) return steps;
    } catch {
      // Intentionally empty - fallback to single step below
    }

    // Fallback: if planning JSON is invalid, keep going with a single coarse step.
    return [
      {
        id: 's1',
        title: subtask.title || 'Execute',
        description: subtask.task || 'Execute the subtask using the available tools.',
        targets: [],
      },
    ];
  }

  private toolCatalog(_contextRoot: string, allowMcpServers: string[]) {
    const allow = Array.isArray(allowMcpServers) ? allowMcpServers : [];
    const hasMcp = allow.length > 0;
    const connected = new Set(this.deps.mcpClient.getConnectedServers());
    const needsConnect = hasMcp && allow.some((s) => !connected.has(s));

    type ToolCatalogItem = {
      actionType: ValidActionType;
      params: Record<string, unknown>;
      note: string;
    };
    const tools: ToolCatalogItem[] = [
      {
        actionType: 'search_repo',
        params: { root: '.', pattern: 'string', maxMatches: 50 },
        note: 'Search repository text (file contents) using regex. Pattern is a content regex, not a file-glob.',
      },
      {
        actionType: 'list_files',
        params: {
          root: '.',
          extensions: ['.ts'],
          maxDepth: 10,
          maxResults: 500,
          includeHidden: false,
        },
        note: 'List file paths under a directory (optionally filter by extensions) and return a count.',
      },
      {
        actionType: 'read_file',
        params: { path: 'string', maxBytes: 16384 },
        note: 'Read a file (path relative to workspace).',
      },
      {
        actionType: 'summarize_path',
        params: { path: 'string', mode: 'compact|extended' },
        note: 'Summarize a file or directory with local LLM.',
      },
      {
        actionType: 'summarize_repo',
        params: { root: '.', mode: 'compact|extended' },
        note: 'Summarize the repository with local LLM.',
      },
      {
        actionType: 'codebase_qa',
        params: { question: 'string', root: '.', maxFiles: 20 },
        note: 'Ask a question about the codebase using local LLM. Searches and analyzes relevant files to answer.',
      },
      {
        actionType: 'generate_tests',
        params: { path: 'string', framework: 'auto', coverage: 'comprehensive' },
        note: 'Generate test cases for a file using local LLM. Returns test code (does not write).',
      },
      {
        actionType: 'security_scan',
        params: { root: '.', scanType: 'both', outputFormat: 'actionable' },
        note: 'Scan for secrets and vulnerabilities. scanType: secrets|vulnerabilities|both',
      },
      {
        actionType: 'analyze_file',
        params: { path: 'string', analysisType: 'full', question: '' },
        note: 'Deep analysis of a file using local LLM. analysisType: quality|security|performance|documentation|full',
      },
      {
        actionType: 'find_and_fix',
        params: { query: 'string', intent: 'string', root: '.', apply: false, maxFiles: 10 },
        note: 'Find code matching query, analyze issues, and suggest fixes. Set apply=true to auto-apply fixes.',
      },
      {
        actionType: 'local_code_review',
        params: { path: 'string or string[]', reviewType: 'comprehensive', focusAreas: [] },
        note: 'Privacy-preserving code review using local LLM. path can be single or comma-separated paths. reviewType: security|performance|style|comprehensive',
      },
      {
        actionType: 'extract_http_routes',
        params: { filePath: 'string', includePrefix: '/api', maxRoutes: 200 },
        note: 'Extract HTTP route registrations (method + path) from a server file (regex-based).',
      },
      {
        actionType: 'generate_api_inventory',
        params: {
          sourceFilePath: 'string',
          destFilePath: 'string',
          includePrefix: '/api',
          overwrite: true,
        },
        note: 'Extract HTTP routes from a source file and write them as JSON to destFilePath (reliable artifact generation).',
      },
      {
        actionType: 'http_request',
        params: {
          url: 'string',
          method: 'GET|POST|PUT|DELETE',
          headers: {},
          body: 'string|object',
          timeoutMs: 60000,
        },
        note: 'Call an HTTP endpoint (localhost-only by default). Returns status + body.',
      },
      {
        actionType: 'write_json_file',
        params: { filePath: 'string', json: {}, pretty: true, overwrite: true },
        note: 'Write a JSON object/array to a file (preferred over embedding huge JSON strings in create_file).',
      },
      {
        actionType: 'apply_diff',
        params: { filePath: 'string', diff: 'unified diff string', dryRun: true },
        note: 'Apply a unified diff to a file (use dryRun first if unsure).',
      },
      {
        actionType: 'create_file',
        params: { filePath: 'string', content: 'string', overwrite: false },
        note: 'Create a file.',
      },
      {
        actionType: 'propose_changes',
        params: {
          changes: [
            {
              filePath: 'string',
              changeType: 'create|modify|delete',
              description: 'string',
              diff: 'optional',
              newContent: 'optional',
            },
          ],
        },
        note: 'Propose code changes WITHOUT applying them. Returns a structured list of proposals for human review. Safe for analysis tasks.',
      },
      {
        actionType: 'done',
        params: { result: 'string' },
        note: 'Finish the current step with a short result note.',
      },
    ];

    if (hasMcp) {
      if (needsConnect) {
        tools.splice(tools.length - 1, 0, {
          actionType: 'mcp_connect',
          params: { serverName: 'string' },
          note: 'Connect to an external MCP server by name.',
        });
      }

      tools.splice(tools.length - 1, 0, {
        actionType: 'mcp_list_tools',
        params: { serverName: 'string' },
        note: 'List tools from a connected MCP server.',
      });

      tools.splice(tools.length - 1, 0, {
        actionType: 'mcp_call',
        params: { serverName: 'string', toolName: 'string', arguments: {} },
        note: 'Call a tool on an external MCP server. For chrome-devtools: use new_page(url) to open a URL, navigate_page(url,type="url") to navigate, take_screenshot(), take_snapshot() for page content.',
      });

      tools.splice(tools.length - 1, 0, {
        actionType: 'mcp_generate_cheatsheet',
        params: {
          serverName: 'string',
          toolNames: ['string'],
          filePath: 'string',
          includeAliases: true,
        },
        note: 'Generate a compact tool schema cheat-sheet from a connected MCP server and save it to a JSON file.',
      });
    }

    return { allowMcpServers: allow, tools };
  }

  private async chooseNextAction(input: {
    task: string;
    contextRoot: string;
    subtask: { id: string; title: string; task: string };
    step: { id: string; title: string; description: string; targets: string[] };
    observations: unknown[];
    allowMcpServers: string[];
    readOnly: boolean;
    remainingActions: number;
    allowedActions?: string[];
  }): Promise<z.infer<typeof NextActionSchema>> {
    const catalogAll = this.toolCatalog(input.contextRoot, input.allowMcpServers);
    const catalog = input.readOnly
      ? {
          ...catalogAll,
          tools: catalogAll.tools.filter(
            (t) =>
              t.actionType !== 'apply_diff' &&
              t.actionType !== 'create_file' &&
              t.actionType !== 'write_json_file' &&
              t.actionType !== 'mcp_generate_cheatsheet' &&
              t.actionType !== 'generate_api_inventory'
          ),
        }
      : catalogAll;

    const allowed = input.allowedActions?.length
      ? new Set(input.allowedActions.map((s) => String(s).trim()))
      : null;
    const catalogFiltered = allowed
      ? {
          ...catalog,
          tools: catalog.tools.filter((t) => allowed.has(t.actionType) || t.actionType === 'done'),
        }
      : catalog;

    const allowedActionTypes = Array.from(new Set(catalogFiltered.tools.map((t) => t.actionType)));
    const catalogText =
      catalogFiltered.tools
        .map((t) => {
          const keys = Object.keys(t.params || {}).join(', ') || '(none)';
          return `- ${t.actionType} (params: ${keys}) - ${t.note}`;
        })
        .join('\n') || '(no tools)';

    const obsText = this.formatObservationsForPrompt(input.observations);
    const loopWarning = this.detectActionLoop(input.observations);
    const writeAllowlistPaths = this.getContext().writeAllowlistPaths;
    const writeConstraint = (() => {
      if (!writeAllowlistPaths || writeAllowlistPaths.length === 0) return '';
      const allFileLike = writeAllowlistPaths.every(isLikelyFilePath);
      const verb = allFileLike ? 'write to these exact paths' : 'write under';
      return `Write constraint: You may ONLY ${verb}: ${writeAllowlistPaths.join(', ')}.`;
    })();
    const system =
      'You are an agent that must pick the NEXT SINGLE action to execute.\n' +
      'Return ONLY valid JSON with this shape:\n' +
      '{ "actionType": "...", "params": { ... } }\n' +
      'Do NOT wrap the JSON in quotes. Do NOT escape quotes.\n' +
      'Use forward slashes in any paths.\n' +
      'CRITICAL PATH RULE: When using read_file, use the EXACT path returned by search_repo or list_files.\n' +
      'Do NOT strip directory prefixes from paths. If search found "database/services/ai.py", use exactly that path.\n' +
      'If the step Targets include explicit file paths, prefer read_file on those targets before searching.\n' +
      'Never guess file paths: if unsure, use list_files or search_repo first.\n' +
      'LLM-POWERED ACTIONS: codebase_qa, generate_tests, security_scan use local LLM - prefer these for analysis tasks.\n' +
      `IMPORTANT: actionType MUST be exactly one of: ${allowedActionTypes.join(', ')}\n` +
      'Keep params small. Do NOT include large file contents, diffs, or long explanations.\n' +
      'If actionType is "done", params.result MUST be a SHORT plain-text note (<= 280 characters).\n' +
      'Do NOT output tool-call tags like "to=search_repo" or "<|channel|>".\n' +
      (writeConstraint ? `${writeConstraint}\n` : '') +
      'Do not include commentary.';
    const user =
      `High-level task:\n${input.task}\n\n` +
      `Current subtask (${input.subtask.id}): ${input.subtask.title}\n${input.subtask.task}\n\n` +
      `Current step (${input.step.id}): ${input.step.title}\n${input.step.description}\nTargets: ${input.step.targets.join(', ') || '(none)'}\n\n` +
      `Remaining actions for this step: ${input.remainingActions}\n` +
      `If remainingActions <= 1, you MUST return actionType="done".\n\n` +
      `Allowed external MCP servers: ${catalogFiltered.allowMcpServers.join(', ') || '(none)'}\n\n` +
      (writeConstraint ? `${writeConstraint}\n\n` : '') +
      `Tool catalog:\n${catalogText}\n\n` +
      `Recent observations (most recent last):\n${obsText}\n` +
      (loopWarning ? `${loopWarning}\n` : '\n') +
      'Pick the next action. If you have enough information to complete the step, return actionType="done".\n' +
      'Example:\n{"actionType":"search_repo","params":{"root":".","pattern":"sse|websocket","maxMatches":50}}\n\n' +
      'Return ONLY JSON.';

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    let lastRaw: unknown = undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.throwIfAborted('chooseNextAction');
      // Keep action selection responses small to avoid truncation (local models may otherwise emit huge diffs).
      lastRaw = await this.llmJsonFromMessages(messages, { maxRetries: 2, maxTokens: 1600 });
      const extracted = this.extractActionCandidate(lastRaw);
      if (!extracted) {
        messages.push({
          role: 'user',
          content:
            'Your JSON did not match the required schema. ' +
            'Return ONLY JSON like: { "actionType": "search_repo", "params": { ... } }.\n' +
            `Allowed actionType values: ${VALID_ACTION_TYPES.join(', ')}`,
        });
        continue;
      }

      const fixedType = this.normalizeActionType(String(extracted.actionType ?? ''));
      if (!fixedType) {
        messages.push({
          role: 'user',
          content:
            `Invalid actionType "${String(extracted.actionType)}". ` +
            `Pick EXACTLY one of: ${VALID_ACTION_TYPES.join(', ')}. ` +
            'Return ONLY JSON.',
        });
        continue;
      }

      if (!allowedActionTypes.includes(fixedType)) {
        messages.push({
          role: 'user',
          content:
            `ActionType "${fixedType}" is not allowed for this step. ` +
            `Pick EXACTLY one of: ${allowedActionTypes.join(', ')}. ` +
            'Return ONLY JSON.',
        });
        continue;
      }

      const fixed = { actionType: fixedType, params: extracted.params ?? {} };

      // Prevent gigantic payloads that tend to get truncated and break JSON parsing.
      if (fixed.actionType === 'apply_diff') {
        const diff = (fixed.params as any)?.diff;
        if (typeof diff === 'string' && diff.length > 12000) {
          messages.push({
            role: 'user',
            content:
              'The diff is too large for action selection and will likely be truncated. ' +
              'Split into smaller diffs or summarize and use fewer lines. Return ONLY JSON.',
          });
          continue;
        }
      }

      if (fixed.actionType === 'create_file') {
        const content = (fixed.params as any)?.content;
        if (typeof content === 'string' && content.length > 12000) {
          messages.push({
            role: 'user',
            content:
              'The file content is too large for action selection and will likely be truncated. ' +
              'Write a smaller file or prefer write_json_file. Return ONLY JSON.',
          });
          continue;
        }
      }

      if (fixed.actionType === 'write_json_file') {
        const json = (fixed.params as any)?.json ?? (fixed.params as any)?.data;
        try {
          const len = JSON.stringify(json).length;
          if (len > 25000) {
            messages.push({
              role: 'user',
              content:
                'The JSON payload is too large for action selection and will likely be truncated. ' +
                'Include fewer fields/tools (only what is required) and try again. Return ONLY JSON.',
            });
            continue;
          }
        } catch {
          // Intentionally empty - JSON size check is best-effort
        }
      }

      if (fixed.actionType === 'done') {
        const r = (fixed.params as any)?.result;
        if (typeof r === 'string' && r.length > 400) {
          messages.push({
            role: 'user',
            content:
              'Your "done" result is too long for action selection. ' +
              'Return a SHORT plain-text note (<= 280 characters) and do not include code. ' +
              'Return ONLY JSON.',
          });
          continue;
        }
      }
      return NextActionSchema.parse(fixed);
    }

    throw new Error(
      `LLM did not return a valid next action after retries. Last output: ${JSON.stringify(lastRaw)}`
    );
  }

  private truncateOutput(value: unknown, max = 8000): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as any;

      if (Array.isArray(v.matches)) {
        const matches = v.matches as any[];
        const totalMatches = matches.length;
        const maxMatches = Math.min(20, totalMatches);
        const files = new Set<string>();
        for (const m of matches) {
          const f = m?.file;
          if (typeof f === 'string' && f.trim()) files.add(f.replace(/\\/g, '/'));
        }
        return {
          matches: matches.slice(0, maxMatches),
          totalMatches,
          filesWithMatches: files.size,
          truncated: totalMatches > maxMatches,
        };
      }

      if (Array.isArray(v.files) && typeof v.count === 'number') {
        const files = v.files as any[];
        const total = Number(v.count);
        const sample = files.slice(0, 50);
        return {
          root: typeof v.root === 'string' ? v.root.replace(/\\/g, '/') : v.root,
          count: total,
          truncated: Boolean(v.truncated) || files.length > sample.length,
          filesSample: sample,
        };
      }

      if (typeof v.path === 'string' && typeof v.content === 'string') {
        const content = v.content as string;
        return {
          path: v.path.replace(/\\/g, '/'),
          bytes: content.length,
          contentPreview: content.slice(0, 400),
          truncated: content.length > 400,
        };
      }
    }

    let str: string;
    if (typeof value === 'string') str = value;
    else {
      try {
        str = JSON.stringify(value);
      } catch {
        str = '[non-serializable output]';
      }
    }
    if (str.length <= max) return value;
    return str.slice(0, max) + `\n[truncated: ${str.length} chars]`;
  }

  private extractFirstPath(text: string): string | null {
    const candidates = [
      /([a-zA-Z]:\\[^"'\r\n]+?\.(?:png|jpg|jpeg|webp))/,
      /((?:\/|\.\/)[^"'\r\n]+?\.(?:png|jpg|jpeg|webp))/,
    ];
    for (const re of candidates) {
      const m = re.exec(text);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  private assertWriteAllowed(filePath: string): void {
    const abs = normalizeSlashes(this.resolveWorkspaceFilePath(filePath));
    const { readOnly, writeAllowlistPaths } = this.getContext();

    // In read-only mode, writes are denied by default unless explicit allowlist paths are provided.
    if (readOnly && (!writeAllowlistPaths || writeAllowlistPaths.length === 0)) {
      throw new Error(`Read-only mode: refusing write to ${abs}`);
    }

    if (!writeAllowlistPaths || writeAllowlistPaths.length === 0) return;

    const ok = writeAllowlistPaths.some((p) => {
      const allowedAbs = normalizeSlashes(this.resolveWorkspaceFilePath(p));
      return (
        abs === allowedAbs ||
        abs.startsWith(allowedAbs.endsWith('/') ? allowedAbs : allowedAbs + '/')
      );
    });
    if (!ok) {
      throw new Error(`Write is not allowed outside: ${writeAllowlistPaths.join(', ')}`);
    }
  }

  /**
   * Try to correct a file path by searching recent observations for the correct path.
   * This handles the common case where the LLM strips directory prefixes from paths.
   *
   * E.g., if search found "database/services/ai_service.py" but LLM tries "services/ai_service.py"
   * we can find the correct path in observations.
   */
  private tryCorrectPath(attemptedPath: string): string | null {
    const observations = this.recentObservations;

    // Normalize the attempted path
    const normalizedAttempt = normalizeSlashes(attemptedPath);
    const fileName = normalizedAttempt.split('/').pop() || '';

    if (!fileName) return null;

    // Look through recent observations for paths that end with the same filename
    for (const obs of observations) {
      const output = obs.output;
      if (!output) continue;

      // Check if output contains file paths (common in search results)
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

      // Look for the filename in the output and extract full paths
      // Match paths with forward slashes, backslashes, or both
      const pathPattern = /["']?([a-zA-Z0-9_/\\.\\-]+\/[a-zA-Z0-9_/\\.\\-]+)["']?/g;
      const pathMatches = outputStr.match(pathPattern);
      if (!pathMatches) continue;

      for (const match of pathMatches) {
        const cleanPath = normalizeSlashes(match.replace(/["']/g, ''));

        // Check if this path ends with our attempted path (or vice versa)
        if (cleanPath.endsWith('/' + fileName) || cleanPath === fileName) {
          // This might be the correct full path
          if (
            cleanPath.length > normalizedAttempt.length &&
            cleanPath.endsWith(normalizedAttempt)
          ) {
            return cleanPath;
          }
          // Or the attempted path might be a suffix
          if (cleanPath.includes(normalizedAttempt) || normalizedAttempt.includes(cleanPath)) {
            // Try the longer path
            if (cleanPath.length > normalizedAttempt.length) {
              return cleanPath;
            }
          }
        }
      }
    }

    return null;
  }

  private resolveWorkspaceFilePath(pathLike: string): string {
    const p = String(pathLike || '').trim();
    if (!p) throw new Error('filePath is required');
    if (isAbsolute(p)) {
      if (!this.deps.config.isPathAllowed(p)) {
        throw new Error(`Destination path is not allowed: ${p}`);
      }
      return p;
    }
    const resolvedPath = this.deps.config.resolveWorkspacePath(p);
    if (!this.deps.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Destination path is not allowed: ${p}`);
    }
    return resolvedPath;
  }

  private ensureDirForFile(destFilePathAbs: string): void {
    mkdirSync(dirname(destFilePathAbs), { recursive: true });
  }

  private safeCopyTempArtifactToWorkspace(srcAbs: string, destAbs: string): void {
    const tmp = tmpdir();
    const srcNorm = resolve(srcAbs);
    const destNorm = resolve(destAbs);
    const tmpNorm = resolve(tmp);

    const srcLower = srcNorm.toLowerCase();
    const tmpLower = tmpNorm.toLowerCase();

    if (!srcLower.startsWith(tmpLower)) {
      throw new Error(`Refusing to copy non-temp source: ${srcAbs}`);
    }
    if (!srcLower.includes('chrome-devtools-mcp-')) {
      throw new Error(`Refusing to copy non-chrome-devtools temp source: ${srcAbs}`);
    }
    if (!/\.(png|jpg|jpeg|webp)$/i.test(srcNorm)) {
      throw new Error(`Refusing to copy non-image temp artifact: ${srcAbs}`);
    }
    if (!this.deps.config.isPathAllowed(destNorm)) {
      throw new Error(`Destination path is not allowed: ${destAbs}`);
    }

    this.assertArtifactWriteAllowed(destNorm);

    const st = statSync(srcNorm);
    if (!st.isFile() || st.size <= 0) {
      throw new Error(`Source temp artifact is not a file: ${srcAbs}`);
    }

    this.ensureDirForFile(destNorm);
    copyFileSync(srcNorm, destNorm);
  }

  private assertArtifactWriteAllowed(destAbs: string): void {
    // In read-only mode, allow artifact writes ONLY under .mcp_cache unless an explicit writeAllowlistPaths is provided.
    const { readOnly, writeAllowlistPaths } = this.getContext();
    if (readOnly && (!writeAllowlistPaths || writeAllowlistPaths.length === 0)) {
      const cacheAbs = normalizeSlashes(
        resolve(this.deps.config.resolveWorkspacePath('.mcp_cache'))
      ).toLowerCase();
      const dest = normalizeSlashes(resolve(destAbs)).toLowerCase();
      const cachePrefix = cacheAbs.endsWith('/') ? cacheAbs : cacheAbs + '/';

      if (dest !== cacheAbs && !dest.startsWith(cachePrefix)) {
        throw new Error(
          `Read-only mode: refusing to write artifacts outside .mcp_cache (${destAbs})`
        );
      }
      return;
    }

    this.assertWriteAllowed(destAbs);
  }

  private isReadOnlyBlockedMcpCall(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): boolean {
    const canonicalTool = String(toolName || '')
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const action = String((args as any)?.action || '')
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

    const explicitMutatingTools = new Set([
      'apply_diff',
      'create_file',
      'write_json_file',
      'generate_api_inventory',
      'mcp_generate_cheatsheet',
      'mcp_terminal_command',
      'terminal_command',
      'shell_command',
      'execute_script',
      'run_command',
    ]);

    if (explicitMutatingTools.has(canonicalTool)) return true;

    // Local MCP server tools can still be called through mcp_call; block mutating intent in read-only mode.
    if (serverName === 'mcp-local-llm') {
      if (
        /(^|_)(write|create|edit|update|apply|delete|remove|rename|move|refactor|fix)(_|$)/.test(
          canonicalTool
        )
      ) {
        return true;
      }
    }

    // Some tools are action-driven; block write-like actions.
    const blockedActions = new Set([
      'apply',
      'write',
      'create',
      'edit',
      'update',
      'delete',
      'remove',
      'rename',
      'move',
      'refactor',
      'implement',
      'fix',
      'find_and_fix',
    ]);
    if (blockedActions.has(action)) return true;

    return false;
  }

  private extractHttpRoutesFromText(input: {
    text: string;
    filePath: string;
    includePrefix: string;
    maxRoutes: number;
  }): Array<{ method: string; path: string; filePath: string }> {
    const includePrefix = String(input.includePrefix || '').trim();
    let normalizedPrefix =
      includePrefix && !includePrefix.startsWith('/')
        ? `/${includePrefix.replace(/^\/+/, '')}`
        : includePrefix;
    if (normalizedPrefix && normalizedPrefix.toLowerCase().includes('/api'))
      normalizedPrefix = '/api';

    const rx =
      /\b(?:this\.)?app\.(get|post|put|delete|patch|options|head)\(\s*['"`]([^'"`]+)['"`]/gi;
    const routes: Array<{ method: string; path: string; filePath: string }> = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = rx.exec(input.text)) && routes.length < Math.max(1, input.maxRoutes)) {
      const method = String(m[1] || '').toUpperCase();
      const path = String(m[2] || '').trim();
      if (normalizedPrefix && !path.startsWith(normalizedPrefix)) continue;
      const key = `${method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method, path, filePath: input.filePath });
    }
    return routes;
  }

  private async executeAction(
    action: z.infer<typeof NextActionSchema>,
    contextRoot: string,
    allowMcpServers: string[]
  ): Promise<unknown> {
    const type = action.actionType;
    const p = action.params || {};
    this.throwIfAborted(`executeAction:${type}`);

    // Central readOnly policy check - block write operations before they can execute
    if (this.getContext().readOnly) {
      const writeActions = [
        'apply_diff',
        'create_file',
        'write_json_file',
        'generate_api_inventory',
        'mcp_generate_cheatsheet',
      ];
      if (writeActions.includes(type)) {
        // Log to console for debugging readOnly enforcement
        console.warn(`[agent] ReadOnly mode blocking write action: ${type}`);
        return {
          blocked: true,
          readOnly: true,
          actionType: type,
          reason: 'readOnly mode is active - write operations are not allowed',
        };
      }
    }

    switch (type) {
      case 'search_repo': {
        const root = String((p as any).root || contextRoot);
        const pattern = String((p as any).pattern || '');
        const maxMatches = Number((p as any).maxMatches || 50);
        try {
          const result = this.deps.grepTools.grepRepo(root, pattern, maxMatches);
          // Track this observation for path correction
          this.addObservation('search_repo', result);
          return result;
        } catch (e) {
          // Return error info instead of crashing agent on invalid regex
          const msg = e instanceof Error ? e.message : String(e);
          return { error: msg, matches: [], pattern, root };
        }
      }
      case 'read_file': {
        const path = String((p as any).path || '');
        const maxBytes = (p as any).maxBytes ? Number((p as any).maxBytes) : undefined;

        // V12: Check if this file was already read in this task
        const normalizedPath = normalizeSlashes(path);
        if (this.taskFileReadHistory.has(normalizedPath)) {
          return {
            alreadyRead: true,
            path: normalizedPath,
            message:
              'This file was already read in this task. Use the previously retrieved content instead of re-reading.',
          };
        }

        try {
          const result = this.deps.fileTools.readFile(path, maxBytes);
          // V12: Track successful reads
          this.taskFileReadHistory.add(normalizedPath);
          return result;
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);

          // If file not found, try to find the correct path from recent search results
          if (errMsg.includes('not found') || errMsg.includes('ENOENT')) {
            const correctedPath = this.tryCorrectPath(path);
            if (correctedPath && correctedPath !== path) {
              const normalizedCorrected = normalizeSlashes(correctedPath);
              // V12: Check corrected path too
              if (this.taskFileReadHistory.has(normalizedCorrected)) {
                return {
                  alreadyRead: true,
                  path: normalizedCorrected,
                  message:
                    'This file was already read in this task. Use the previously retrieved content instead of re-reading.',
                };
              }
              try {
                const result = this.deps.fileTools.readFile(correctedPath, maxBytes);
                // V12: Track successful reads with corrected path
                this.taskFileReadHistory.add(normalizedCorrected);
                return {
                  ...result,
                  pathCorrected: true,
                  originalPath: path,
                  correctedPath,
                };
              } catch {
                // Corrected path also failed, return original error
              }
            }
          }

          // Return helpful error with suggestions
          return {
            error: errMsg,
            path,
            suggestion:
              'Use search_repo or list_files to find the exact file path first. ' +
              'File paths from search results should be used exactly as returned.',
          };
        }
      }
      case 'list_files': {
        const root = String((p as any).root ?? (p as any).path ?? contextRoot);
        const maxDepth = (p as any).maxDepth ? Number((p as any).maxDepth) : 10;
        const maxResults = (p as any).maxResults ? Number((p as any).maxResults) : 500;
        const includeHidden = (p as any).includeHidden === true;
        const extensions = Array.isArray((p as any).extensions)
          ? (p as any).extensions.map((e: any) => String(e))
          : undefined;

        const ft = this.deps.fileTools as any;
        const snap =
          typeof ft?.manifestSnapshotAsync === 'function'
            ? await ft.manifestSnapshotAsync(root, { maxDepth, includeHidden, extensions })
            : ft.manifestSnapshot(root, { maxDepth, includeHidden, extensions });

        const rootNorm = normalizeSlashes(String(root || '.').trim() || '.');
        const prefix =
          rootNorm === '.' || rootNorm === './' ? '' : rootNorm.replace(/\/+$/, '') + '/';
        const files = Array.isArray(snap?.files)
          ? (snap.files as any[]).map((f: any) => {
              const rel = String(f?.relativePath ?? f?.path ?? '').replace(/\\/g, '/');
              return prefix + rel.replace(/^\/+/, '');
            })
          : [];

        const count = typeof snap?.totalFiles === 'number' ? snap.totalFiles : files.length;
        const truncated = Boolean(snap?.truncated) || files.length > maxResults;

        const result = {
          root: rootNorm,
          count,
          files: files.slice(0, maxResults),
          truncated,
        };
        // Track this observation for path correction
        this.addObservation('list_files', result);
        return result;
      }
      case 'summarize_path': {
        const path = String((p as any).path || '');
        const mode = (p as any).mode === 'extended' ? 'extended' : 'compact';
        return await this.deps.summarization.summarizePath(path, mode);
      }
      case 'summarize_repo': {
        const root = String((p as any).root || contextRoot);
        const mode = (p as any).mode === 'extended' ? 'extended' : 'compact';
        return await this.deps.summarization.summarizeRepo(root, mode);
      }
      case 'codebase_qa': {
        if (!this.deps.highValueTools) {
          throw new Error('codebase_qa requires highValueTools to be configured');
        }
        const question = String((p as any).question || '').trim();
        const root = String((p as any).root || contextRoot);
        const maxFiles = (p as any).maxFiles ? Number((p as any).maxFiles) : 20;
        if (!question) throw new Error('question is required');
        return await this.deps.highValueTools.codebaseQA(question, {
          searchScope: [root],
          maxSources: maxFiles,
        });
      }
      case 'generate_tests': {
        if (!this.deps.llmEnhancedTools) {
          throw new Error('generate_tests requires llmEnhancedTools to be configured');
        }
        const path = String((p as any).path || '').trim();
        const framework = ((p as any).framework || 'auto') as string;
        const coverage = ((p as any).coverage || 'comprehensive') as
          | 'basic'
          | 'comprehensive'
          | 'edge-cases';
        if (!path) throw new Error('path is required');
        return await this.deps.llmEnhancedTools.generateTests(path, {
          framework: framework === 'auto' ? undefined : framework,
          coverage,
        });
      }
      case 'security_scan': {
        if (!this.deps.highValueTools) {
          throw new Error('security_scan requires highValueTools to be configured');
        }
        const root = String((p as any).root || contextRoot);
        const scanType = ((p as any).scanType || 'both') as 'secrets' | 'vulnerabilities' | 'both';
        const outputFormat = ((p as any).outputFormat || 'actionable') as
          | 'summary'
          | 'detailed'
          | 'actionable';
        const result = this.deps.highValueTools.secretScan(root, { scanType });
        // Format based on outputFormat
        if (outputFormat === 'summary') {
          return {
            filesScanned: result.statistics.filesScanned,
            findingsCount: result.findings.length,
            types: [...new Set(result.findings.map((f) => f.type))],
          };
        }
        return result;
      }
      case 'analyze_file': {
        if (!this.deps.llmEnhancedTools) {
          throw new Error('analyze_file requires llmEnhancedTools to be configured');
        }
        const path = String((p as any).path || '').trim();
        const analysisType = ((p as any).analysisType || 'full') as
          | 'quality'
          | 'security'
          | 'performance'
          | 'documentation'
          | 'full';
        const question = (p as any).question ? String((p as any).question) : undefined;
        if (!path) throw new Error('path is required');
        return await this.deps.llmEnhancedTools.analyzeFile(path, {
          analysisType,
          question,
        });
      }
      case 'find_and_fix': {
        if (!this.deps.llmEnhancedTools) {
          throw new Error('find_and_fix requires llmEnhancedTools to be configured');
        }
        const query = String((p as any).query || '').trim();
        const intent = String((p as any).intent || '').trim();
        const root = String((p as any).root || contextRoot);
        const apply = (p as any).apply === true;
        const maxFiles = (p as any).maxFiles ? Number((p as any).maxFiles) : 10;
        if (!query) throw new Error('query is required');
        if (!intent) throw new Error('intent is required');
        return await this.deps.llmEnhancedTools.findAndFix(query, intent, {
          root,
          apply,
          maxFiles,
        });
      }
      case 'local_code_review': {
        if (!this.deps.llmEnhancedTools) {
          throw new Error('local_code_review requires llmEnhancedTools to be configured');
        }
        const path = (p as any).path;
        let files: string[];
        if (Array.isArray(path)) {
          files = path.map((f: unknown) => String(f).trim()).filter(Boolean);
        } else {
          files = String(path || '')
            .trim()
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
        }
        const reviewType = ((p as any).reviewType || 'comprehensive') as
          | 'security'
          | 'performance'
          | 'style'
          | 'comprehensive';
        const focusAreas = (p as any).focusAreas
          ? Array.isArray((p as any).focusAreas)
            ? (p as any).focusAreas
            : [String((p as any).focusAreas)]
          : undefined;
        if (files.length === 0)
          throw new Error('path is required (single path or comma-separated paths)');
        return await this.deps.llmEnhancedTools.localCodeReview(files, {
          reviewType,
          focusAreas,
        });
      }
      case 'extract_http_routes': {
        const filePath = String((p as any).filePath || '').trim();
        const includePrefix =
          (p as any).includePrefix !== undefined ? String((p as any).includePrefix).trim() : '/api';
        const maxRoutes = (p as any).maxRoutes ? Number((p as any).maxRoutes) : 200;
        if (!filePath) throw new Error('filePath is required');

        const file = this.deps.fileTools.readFile(filePath, 512_000);
        const text = String((file as any).content || '');
        const routes = this.extractHttpRoutesFromText({ text, filePath, includePrefix, maxRoutes });
        return { filePath, includePrefix, count: routes.length, routes };
      }
      case 'generate_api_inventory': {
        const sourceFilePath = String((p as any).sourceFilePath || '').trim();
        const destFilePath = String((p as any).destFilePath || '').trim();
        const includePrefix =
          (p as any).includePrefix !== undefined ? String((p as any).includePrefix).trim() : '/api';
        const overwrite = (p as any).overwrite !== false;

        if (!sourceFilePath) throw new Error('sourceFilePath is required');
        if (!destFilePath) throw new Error('destFilePath is required');
        const file = this.deps.fileTools.readFile(sourceFilePath, 512_000);
        const text = String((file as any).content || '');
        let routes = this.extractHttpRoutesFromText({
          text,
          filePath: sourceFilePath,
          includePrefix,
          maxRoutes: 1000,
        });
        if (routes.length === 0 && includePrefix.trim() !== '/api') {
          routes = this.extractHttpRoutesFromText({
            text,
            filePath: sourceFilePath,
            includePrefix: '/api',
            maxRoutes: 1000,
          });
        }
        this.assertWriteAllowed(destFilePath);
        await this.deps.editTools.createFile(destFilePath, JSON.stringify(routes, null, 2), {
          overwrite,
        });
        return {
          sourceFilePath,
          destFilePath,
          includePrefix,
          count: Array.isArray(routes) ? routes.length : 0,
        };
      }
      case 'http_request': {
        const url = String((p as any).url || '').trim();
        if (!url) throw new Error('url is required');

        const method = String((p as any).method || 'GET')
          .trim()
          .toUpperCase();

        const requestedTimeoutMs = (p as any).timeoutMs ? Number((p as any).timeoutMs) : 60000;
        const remaining = this.getRemainingMs();
        // Respect the global budget if present, but keep a small buffer for response parsing/serialization.
        const timeoutMs =
          remaining !== null
            ? Math.max(1, Math.min(requestedTimeoutMs, Math.max(1, remaining - 250)))
            : requestedTimeoutMs;
        const headers =
          (p as any).headers && typeof (p as any).headers === 'object'
            ? (p as any).headers
            : undefined;
        const body = (p as any).body;

        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
        }

        const allowAny = process.env.AGENT_HTTP_ALLOW_ANY === '1';
        const host = parsedUrl.hostname.toLowerCase();
        const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
        if (!allowAny && !isLocal) {
          throw new Error(`Refusing non-localhost HTTP request to ${parsedUrl.hostname}`);
        }

        const controller = new AbortController();
        const ctxSignal = this.getContext().signal;
        const onAbort = () => controller.abort();
        if (ctxSignal) {
          if (ctxSignal.aborted) controller.abort();
          else ctxSignal.addEventListener('abort', onAbort, { once: true });
        }

        const t = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
        try {
          const init: any = { method, headers: headers || {}, signal: controller.signal };
          if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
            if (typeof body === 'string') {
              init.body = body;
              if (!init.headers['content-type'] && !init.headers['Content-Type'])
                init.headers['content-type'] = 'text/plain';
            } else {
              init.body = JSON.stringify(body);
              if (!init.headers['content-type'] && !init.headers['Content-Type'])
                init.headers['content-type'] = 'application/json';
            }
          }

          const resp = await fetch(url, init);
          const contentType = resp.headers.get('content-type') || '';
          const text = await resp.text();
          const truncated =
            text.length > 20000
              ? text.slice(0, 20000) + `\n[truncated: ${text.length} chars]`
              : text;
          return {
            url,
            status: resp.status,
            ok: resp.ok,
            contentType,
            body: truncated,
          };
        } finally {
          clearTimeout(t);
          if (ctxSignal) ctxSignal.removeEventListener('abort', onAbort);
        }
      }
      case 'write_json_file': {
        const filePath = String((p as any).filePath || '');
        const json = (p as any).json ?? (p as any).data;
        const pretty = (p as any).pretty !== false;
        const overwrite = (p as any).overwrite !== false;

        if (!filePath) throw new Error('filePath is required');
        if (json === undefined) throw new Error('json is required');
        if (typeof json !== 'object') throw new Error('json must be an object or array');

        this.assertWriteAllowed(filePath);
        const content = JSON.stringify(json, null, pretty ? 2 : 0);
        return this.deps.editTools.createFile(filePath, content, { overwrite });
      }
      case 'apply_diff': {
        const filePath = String((p as any).filePath || '');
        const diff = String((p as any).diff || '');
        const dryRun = (p as any).dryRun === true;
        this.assertWriteAllowed(filePath);
        return this.deps.editTools.applyDiff(filePath, diff, { dryRun });
      }
      case 'create_file': {
        const filePath = String((p as any).filePath || '');
        const content = String((p as any).content || '');
        const overwrite = (p as any).overwrite === true;
        this.assertWriteAllowed(filePath);
        return this.deps.editTools.createFile(filePath, content, { overwrite });
      }
      case 'propose_changes': {
        // propose_changes action: collects proposed edits without applying them
        // Returns a structured list of proposed changes for human review
        const changes = (p as any).changes;
        if (!Array.isArray(changes) || changes.length === 0) {
          throw new Error('changes array is required with at least one proposed change');
        }

        const proposals: Array<{
          filePath: string;
          changeType: 'create' | 'modify' | 'delete';
          description: string;
          diff?: string;
          newContent?: string;
          lineRange?: { start: number; end: number };
        }> = [];

        for (const change of changes) {
          const filePath = String(change.filePath || '').trim();
          if (!filePath) {
            throw new Error('Each change must have a filePath');
          }

          const changeType = change.changeType || 'modify';
          if (!['create', 'modify', 'delete'].includes(changeType)) {
            throw new Error(`Invalid changeType: ${changeType}. Must be create, modify, or delete`);
          }

          proposals.push({
            filePath,
            changeType: changeType as 'create' | 'modify' | 'delete',
            description: String(change.description || 'No description provided'),
            diff: change.diff ? String(change.diff) : undefined,
            newContent: change.newContent ? String(change.newContent) : undefined,
            lineRange: change.lineRange
              ? {
                  start: Number(change.lineRange.start || 1),
                  end: Number(change.lineRange.end || change.lineRange.start || 1),
                }
              : undefined,
          });
        }

        return {
          status: 'proposed',
          totalChanges: proposals.length,
          message: `Proposed ${proposals.length} change(s). Review and use apply_diff or create_file to apply.`,
          proposals,
          instructions: [
            'Review each proposed change carefully.',
            'Use create_file with overwrite=true to apply new files.',
            'Use apply_diff with dryRun=false to apply modifications.',
            'No changes have been applied - this is a preview only.',
          ],
        };
      }
      case 'mcp_connect': {
        const serverName = this.resolveMcpServerName(allowMcpServers, (p as any).serverName);
        if (!serverName) throw new Error('serverName is required');
        if (!allowMcpServers.includes(serverName)) {
          throw new Error(`MCP server '${serverName}' not allowed`);
        }
        await this.deps.mcpClient.connect(serverName);
        return {
          connected: true,
          serverName,
          tools: this.deps.mcpClient.getTools(serverName).map((t) => t.name),
        };
      }
      case 'mcp_list_tools': {
        const serverName = this.resolveMcpServerName(allowMcpServers, (p as any).serverName);
        if (!serverName) throw new Error('serverName is required');
        if (!allowMcpServers.includes(serverName)) {
          throw new Error(`MCP server '${serverName}' not allowed`);
        }
        if (!this.deps.mcpClient.isConnected(serverName)) {
          await this.deps.mcpClient.connect(serverName);
        }
        const tools = this.deps.mcpClient.getTools(serverName).map((t: any) => {
          const schema = t?.inputSchema || {};
          const props =
            schema?.properties && typeof schema.properties === 'object'
              ? Object.keys(schema.properties)
              : [];
          const req = Array.isArray(schema?.required) ? schema.required : [];
          return {
            name: t.name,
            description: t.description,
            required: req,
            properties: props,
            additionalProperties: schema.additionalProperties !== false,
          };
        });
        return { serverName, tools };
      }
      case 'mcp_generate_cheatsheet': {
        const serverName = String((p as any).serverName || '').trim();
        const filePath = String((p as any).filePath || '').trim();
        const toolNames = (p as any).toolNames ?? (p as any).tools ?? undefined;
        const includeAliases = (p as any).includeAliases !== false;

        if (!serverName) throw new Error('serverName is required');
        if (!filePath) throw new Error('filePath is required');
        if (!allowMcpServers.includes(serverName)) {
          throw new Error(`MCP server '${serverName}' not allowed`);
        }

        if (!this.deps.mcpClient.isConnected(serverName)) {
          await this.deps.mcpClient.connect(serverName);
        }

        this.assertWriteAllowed(filePath);

        const all = this.deps.mcpClient.getTools(serverName);
        const wanted =
          Array.isArray(toolNames) && toolNames.length > 0
            ? new Set(toolNames.map((t: any) => String(t).trim()).filter(Boolean))
            : null;
        const picked = wanted ? all.filter((t: any) => wanted.has(t.name)) : all;

        const aliasCandidates: Record<string, string[]> = {
          url: ['uri', 'href', 'URL', 'address', 'target'],
          function: ['fn', 'script', 'code', 'source'],
          filePath: ['path', 'outputPath'],
          fullPage: ['full'],
          uid: ['pageIdx', 'pageId', 'id', 'idx'],
        };

        const toolsOut: Record<string, unknown> = {};
        for (const t of picked as any[]) {
          const schema = t?.inputSchema || {};
          const props =
            schema?.properties && typeof schema.properties === 'object'
              ? Object.keys(schema.properties)
              : [];
          const req = Array.isArray(schema?.required) ? schema.required : [];
          const optional = props.filter((k) => !req.includes(k));

          const aliases: Record<string, string[]> = {};
          if (includeAliases) {
            for (const key of props) {
              const cands = aliasCandidates[key];
              if (cands && cands.length) aliases[key] = cands;
            }
          }

          toolsOut[t.name] = {
            description: t.description,
            required: req,
            optional,
            properties: props,
            aliases,
          };
        }

        const payload = {
          serverName,
          generatedAt: new Date().toISOString(),
          tools: toolsOut,
        };

        const content = JSON.stringify(payload, null, 2);
        await this.deps.editTools.createFile(filePath, content, { overwrite: true });
        return { serverName, filePath, toolCount: picked.length };
      }
      case 'mcp_call': {
        const serverName = this.resolveMcpServerName(allowMcpServers, (p as any).serverName);
        if (!serverName) throw new Error('serverName is required');
        const toolNameRaw = String((p as any).toolName || '');
        const argumentsObj = ((p as any).arguments ||
          (p as any).args ||
          (p as any).parameters ||
          (p as any).toolArgs ||
          (p as any).params ||
          {}) as Record<string, unknown>;

        if (
          this.getContext().readOnly &&
          this.isReadOnlyBlockedMcpCall(serverName, toolNameRaw, argumentsObj)
        ) {
          return {
            blocked: true,
            readOnly: true,
            actionType: 'mcp_call',
            serverName,
            toolName: toolNameRaw,
            reason: 'readOnly mode is active - mutating MCP tool calls are not allowed',
          };
        }

        const localServerName = 'mcp-local-llm';
        const localAllowed = allowMcpServers.includes(localServerName);

        // V17: Local tool priority check - prevent misrouting local-only tools to external servers.
        // Addresses QA feedback: "agent_task tried to call model_info on context7 instead of local".
        const isLocalAgentOnlyTool = (AGENT_ONLY_TOOLS as readonly string[]).includes(toolNameRaw);
        if (isLocalAgentOnlyTool && serverName !== localServerName && localAllowed) {
          debug.info(
            'agent',
            `Redirecting agentOnly tool '${toolNameRaw}' from '${serverName}' to '${localServerName}'`
          );
          const localToolName = this.resolveMcpToolName(localServerName, toolNameRaw);
          const localArgs = this.normalizeMcpToolArgs(localServerName, localToolName, argumentsObj);
          const localResult = await this.deps.mcpClient.callTool(
            localServerName,
            localToolName,
            localArgs
          );
          if (!localResult.success)
            throw new Error(localResult.error || 'Local MCP tool call failed');
          return localResult;
        }

        if (!allowMcpServers.includes(serverName)) {
          throw new Error(`MCP server '${serverName}' not allowed`);
        }

        if (!this.deps.mcpClient.isConnected(serverName)) {
          await this.deps.mcpClient.connect(serverName);
        }

        const toolName = this.resolveMcpToolName(serverName, toolNameRaw);
        const normalizedArgs = this.normalizeMcpToolArgs(serverName, toolName, argumentsObj);

        if (
          this.getContext().readOnly &&
          this.isReadOnlyBlockedMcpCall(serverName, toolName, normalizedArgs)
        ) {
          return {
            blocked: true,
            readOnly: true,
            actionType: 'mcp_call',
            serverName,
            toolName,
            reason: 'readOnly mode is active - mutating MCP tool calls are not allowed',
          };
        }

        // If the tool does not exist on the chosen server but exists locally, redirect to local.
        // This avoids LLM hallucinations like "call search on context7" when search is a local tool.
        if (serverName !== localServerName && localAllowed) {
          const serverToolNames = this.deps.mcpClient.getTools(serverName).map((t) => t.name);
          if (!serverToolNames.includes(toolName)) {
            const localToolName = this.resolveMcpToolName(localServerName, toolNameRaw);
            const localToolNames = this.deps.mcpClient.getTools(localServerName).map((t) => t.name);
            if (localToolNames.includes(localToolName)) {
              debug.info(
                'agent',
                `Redirecting tool '${toolNameRaw}' from '${serverName}' to '${localServerName}' (not found on '${serverName}')`
              );
              const localArgs = this.normalizeMcpToolArgs(
                localServerName,
                localToolName,
                argumentsObj
              );
              const localResult = await this.deps.mcpClient.callTool(
                localServerName,
                localToolName,
                localArgs
              );
              if (!localResult.success)
                throw new Error(localResult.error || 'Local MCP tool call failed');
              return localResult;
            }
          }
        }

        // Best-effort normalize common alias fields for chrome-devtools take_screenshot output path.
        if (serverName === 'chrome-devtools' && toolName === 'take_screenshot') {
          const anyArgs: any = { ...normalizedArgs };
          const filePathRaw =
            anyArgs.filePath ??
            anyArgs.outputPath ??
            anyArgs.path ??
            anyArgs.save_to ??
            anyArgs.saveTo;

          let desiredDestAbs: string | null = null;
          if (typeof filePathRaw === 'string' && filePathRaw.trim()) {
            desiredDestAbs = this.resolveWorkspaceFilePath(filePathRaw.trim());
            this.assertArtifactWriteAllowed(desiredDestAbs);
            this.ensureDirForFile(desiredDestAbs);
            anyArgs.filePath = desiredDestAbs;
            delete anyArgs.outputPath;
            delete anyArgs.path;
            delete anyArgs.save_to;
            delete anyArgs.saveTo;
          }

          let res = await this.deps.mcpClient.callTool(serverName, toolName, anyArgs);
          if (!res.success) {
            const errText = String(res.error || '');
            const looksLikeWriteFailure = /ENOENT|EACCES|EPERM|mkdir|not allowed|destination/i.test(
              errText
            );
            if (desiredDestAbs && looksLikeWriteFailure) {
              // Retry without filePath and then copy the temp artifact into workspace.
              const retryArgs = { ...anyArgs };
              delete (retryArgs as any).filePath;
              res = await this.deps.mcpClient.callTool(serverName, toolName, retryArgs);
            }
          }
          if (!res.success) throw new Error(res.error || 'MCP tool call failed');

          // If the MCP tool did not write to the requested path, try to copy from its temp artifact.
          const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
          const src = this.extractFirstPath(text);

          if (src) {
            // If no destination was provided, still persist the temp artifact into workspace for usability.
            if (!desiredDestAbs) {
              const ext = (/\.(png|jpg|jpeg|webp)$/i.exec(src)?.[0] || '.png').toLowerCase();
              desiredDestAbs = this.resolveWorkspaceFilePath(
                `.mcp_cache/agent_scenarios/${Date.now()}${ext}`
              );
              this.assertArtifactWriteAllowed(desiredDestAbs);
            }

            if (desiredDestAbs && !existsSync(desiredDestAbs)) {
              try {
                this.safeCopyTempArtifactToWorkspace(src, desiredDestAbs);
                return { ...res, copiedFrom: src, filePath: normalizeSlashes(desiredDestAbs) };
              } catch {
                // ignore copy failures
              }
            }
          }

          return res;
        }

        const res = await this.deps.mcpClient.callTool(serverName, toolName, normalizedArgs);
        if (!res.success) throw new Error(res.error || 'MCP tool call failed');
        return res;
      }
      case 'done':
        return { done: true, result: (p as any).result };
    }
  }

  private resolveMcpToolName(serverName: string, requested: string): string {
    const req = String(requested || '').trim();
    if (!req) throw new Error('toolName is required');

    const toolNames = this.deps.mcpClient.getTools(serverName).map((t) => t.name);
    if (toolNames.includes(req)) return req;

    const norm = (s: string) => s.toLowerCase().replace(/[\s-]/g, '_');
    const canon = (s: string) => norm(s).replace(/_/g, '');
    const reqNorm = norm(req);
    const reqCanon = canon(req);

    const aliases: Record<string, string> = {
      open: 'new_page',
      open_page: 'new_page',
      openpage: 'new_page',
      open_url: 'navigate_page',
      openurl: 'navigate_page',
      newpage: 'new_page',
      navigate: 'navigate_page',
      goto: 'navigate_page',
      go_to: 'navigate_page',
      screenshot: 'take_screenshot',
      takescreenshot: 'take_screenshot',
      snapshot: 'take_snapshot',
      takesnapshot: 'take_snapshot',
    };

    const aliasHit = aliases[reqNorm] || aliases[reqCanon];
    if (aliasHit && toolNames.includes(aliasHit)) return aliasHit;

    for (const t of toolNames) {
      if (canon(t) === reqCanon) return t;
    }

    // Last resort: keep original (will fail with a clear error downstream).
    return req;
  }

  private resolveMcpServerName(allowMcpServers: string[], provided: unknown): string {
    const raw = typeof provided === 'string' ? provided.trim() : '';
    if (!raw) {
      return allowMcpServers.length === 1 ? allowMcpServers[0] : '';
    }
    if (allowMcpServers.includes(raw)) return raw;

    const norm = (s: string) => s.toLowerCase().replace(/[\s_]/g, '-').replace(/-+/g, '-');
    const needle = norm(raw);
    const hit = allowMcpServers.find((s) => norm(s) === needle);
    if (hit) return hit;

    // If only one server is allowed for this run, treat any non-empty value as that server.
    return allowMcpServers.length === 1 ? allowMcpServers[0] : '';
  }

  private normalizeMcpToolArgs(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ) {
    const a: any = { ...(args || {}) };
    if (serverName !== 'chrome-devtools') return a;

    if ((toolName === 'new_page' || toolName === 'navigate_page') && a.url === undefined) {
      const url = a.uri ?? a.href ?? a.URL ?? a.address ?? a.target;
      if (url !== undefined && url !== null) a.url = String(url).trim();
    }
    // For navigate_page, if URL is provided but type is missing, default to 'url'
    if (toolName === 'navigate_page' && a.url && !a.type) {
      a.type = 'url';
    }
    delete a.uri;
    delete a.href;
    delete a.URL;
    delete a.address;
    delete a.target;

    if (toolName === 'evaluate_script' && a.function === undefined) {
      const fn = a.fn ?? a.script ?? a.code ?? a.source;
      if (fn !== undefined && fn !== null) a.function = String(fn).trim();
    }
    delete a.fn;
    delete a.script;
    delete a.code;
    delete a.source;

    if (toolName === 'take_screenshot') {
      if (a.path && a.filePath === undefined) a.filePath = a.path;
      if (a.outputPath && a.filePath === undefined) a.filePath = a.outputPath;
      if (a.save_to && a.filePath === undefined) a.filePath = a.save_to;
      if (a.saveTo && a.filePath === undefined) a.filePath = a.saveTo;
      if (a.full && a.fullPage === undefined) a.fullPage = a.full;
      delete a.path;
      delete a.outputPath;
      delete a.full;
      delete a.save_to;
      delete a.saveTo;
    }

    return a;
  }

  /**
   * Black-box V4: Auto-generate AGENTS.md if it doesn't exist
   * Creates a minimal, static (no LLM) AGENTS.md in .mcp-local-llm/
   * to provide project context for agent tasks automatically.
   *
   * Only creates if file is completely missing - preserves user edits.
   */
  private async ensureAgentsMdExists(contextRoot: string): Promise<void> {
    const agentsMdPath = join(contextRoot, '.mcp-local-llm', 'AGENTS.md');

    // Also check root-level AGENTS.md - if user has one there, don't auto-generate
    const rootAgentsMd = join(contextRoot, 'AGENTS.md');

    if (existsSync(agentsMdPath) || existsSync(rootAgentsMd)) {
      // File already exists somewhere, don't overwrite
      return;
    }

    // Only auto-generate if llmEnhancedTools is available
    if (!this.deps.llmEnhancedTools) {
      return;
    }

    try {
      // Use static generation (useLlm: false) for speed - this is a preflight check
      await this.deps.llmEnhancedTools.generateAgentsMd(contextRoot, {
        useLlm: false,
        overwrite: false, // Never overwrite existing
      });

      if (process.env.DEBUG_AGENTS_MD === '1') {
        process.stderr.write(`[agent] Auto-generated .mcp-local-llm/AGENTS.md for context\n`);
      }
    } catch (error) {
      // Don't fail agent task if auto-gen fails - it's just a nice-to-have
      if (process.env.DEBUG_AGENTS_MD === '1') {
        process.stderr.write(`[agent] Failed to auto-generate AGENTS.md: ${error}\n`);
      }
    }
  }

  private async tryFastPath(
    task: string,
    input: {
      contextRoot: string;
      effectiveOptions: AgentTaskResult['effectiveOptions'];
      emit: (event: AgentProgressEvent) => void;
    }
  ): Promise<AgentTaskResult | null> {
    if (!this.getContext().readOnly) return null;

    const text = String(task || '').trim();
    if (!text) return null;
    const lower = text.toLowerCase();

    const build = (spec: {
      kind: string;
      title: string;
      description: string;
      targets: string[];
      output: unknown;
      summary: string;
    }): AgentTaskResult => {
      const subtaskId = 't1';
      const stepId = 's1';

      input.emit({ type: 'plan_generated', subtasks: 1, steps: 1 });
      input.emit({ type: 'subtask_start', subtaskId, title: spec.title });
      input.emit({
        type: 'step_start',
        subtaskId,
        stepId,
        title: spec.title,
        index: 1,
        total: 1,
      });
      input.emit({ type: 'action', subtaskId, stepId, actionType: 'fast_path', ok: true });

      const truncatedOutput = this.truncateOutput(spec.output);
      const plan: AgentTaskResult['plan'] = {
        subtasks: [
          {
            id: subtaskId,
            title: spec.title,
            task: text,
            steps: [
              {
                id: stepId,
                title: spec.title,
                description: spec.description,
                targets: spec.targets,
              },
            ],
          },
        ],
      };

      const execution: AgentTaskResult['execution'] = [
        {
          subtaskId,
          stepId,
          status: 'completed',
          autoCompleted: false,
          actions: [
            {
              actionType: 'fast_path',
              params: { kind: spec.kind },
              ok: true,
              output: truncatedOutput,
            },
            {
              actionType: 'done',
              params: { result: spec.summary },
              ok: true,
              output: spec.summary,
            },
          ],
        },
      ];

      input.emit({ type: 'action', subtaskId, stepId, actionType: 'done', ok: true });
      input.emit({ type: 'step_end', subtaskId, stepId, status: 'completed' });
      input.emit({ type: 'task_end', success: true });

      const metrics = {
        plannedSteps: 1,
        executedSteps: 1,
        completedSteps: 1,
        failedSteps: 0,
        skippedSteps: 0,
        okActions: 2,
        failedActions: 0,
      };

      const notes = [
        `fastPath: ${spec.kind}`,
        `metrics: plannedSteps=1 executedSteps=1 completedSteps=1 failedSteps=0 skippedSteps=0 okActions=2 failedActions=0`,
      ];

      return {
        success: true,
        partial: false,
        task: text,
        contextRoot: input.contextRoot,
        effectiveOptions: input.effectiveOptions,
        plan,
        execution,
        final: { summary: spec.summary, notes, metrics } as any,
      };
    };

    // Fast-path: list + count TypeScript files in src/
    if (
      lower.includes('src') &&
      (lower.includes('list') || lower.includes('show')) &&
      (lower.includes('.ts') || lower.includes('typescript')) &&
      lower.includes('file') &&
      (lower.includes('count') || lower.includes('how many') || lower.includes('number of'))
    ) {
      try {
        this.throwIfAborted('fastPath.list_ts_files');
        const ft = this.deps.fileTools as any;
        const snap =
          typeof ft?.manifestSnapshotAsync === 'function'
            ? await ft.manifestSnapshotAsync('src', { extensions: ['.ts'] })
            : ft.manifestSnapshot('src', { extensions: ['.ts'] });
        const files = Array.isArray(snap?.files)
          ? (snap.files as any[]).map(
              (f: any) => `src/${String(f?.relativePath || '').replace(/\\/g, '/')}`
            )
          : [];
        const count = typeof snap?.totalFiles === 'number' ? snap.totalFiles : files.length;
        const truncated = Boolean(snap?.truncated) || files.length > 200;
        const payload = { root: 'src', count, files: files.slice(0, 200), truncated };
        const summary = `Found ${count} .ts files under src/.${truncated ? ' (truncated list)' : ''}`;
        return build({
          kind: 'list_ts_files_in_src',
          title: 'List TypeScript files',
          description: 'List all .ts files under src and count them.',
          targets: ['src/**/*.ts'],
          output: payload,
          summary,
        });
      } catch {
        return null;
      }
    }

    // Fast-path: count source files by top-level directory (common IDE evaluation task)
    if (
      lower.includes('file') &&
      (lower.includes('count') || lower.includes('how many') || lower.includes('number of')) &&
      (lower.includes('source') || lower.includes('code')) &&
      (lower.includes('by directory') ||
        lower.includes('per directory') ||
        lower.includes('by folder') ||
        lower.includes('per folder') ||
        (lower.includes('directory') && (lower.includes('by ') || lower.includes('per '))) ||
        lower.includes('directories') ||
        lower.includes('folders'))
    ) {
      try {
        this.throwIfAborted('fastPath.count_source_files_by_directory');

        const sourceExtensions = [
          '.ts',
          '.tsx',
          '.js',
          '.jsx',
          '.mjs',
          '.cjs',
          '.py',
          '.go',
          '.rs',
          '.java',
          '.cs',
          '.cpp',
          '.c',
          '.h',
          '.hpp',
          '.rb',
          '.php',
          '.kt',
          '.swift',
        ];

        const root = input.contextRoot;
        const listing = this.deps.fileTools.listDirectory(root, 2000);
        const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', '__pycache__']);

        const byDirectory = new Map<string, number>();
        let total = 0;

        // Root-level files (limited by listDirectory maxEntries) + top-level directories
        for (const entry of listing.entries) {
          if (entry.type === 'directory') {
            if (entry.name.startsWith('.')) continue;
            if (skipDirs.has(entry.name)) continue;
            this.throwIfAborted(`fastPath.count_source_files_by_directory:${entry.name}`);
            const dirAbs = resolve(root, entry.name);
            const snap = await this.deps.fileTools.manifestSnapshotAsync(dirAbs, {
              extensions: sourceExtensions,
              maxDepth: 25,
              includeHidden: false,
            });
            const count = typeof snap.totalFiles === 'number' ? snap.totalFiles : 0;
            byDirectory.set(entry.name, count);
            total += count;
            continue;
          }

          // Root-level file
          const lowerName = entry.name.toLowerCase();
          const isSource = sourceExtensions.some((ext) => lowerName.endsWith(ext));
          if (isSource) {
            byDirectory.set('.', (byDirectory.get('.') || 0) + 1);
            total += 1;
          }
        }

        const rows = [...byDirectory.entries()]
          .map(([dir, count]) => ({ dir, count }))
          .sort((a, b) => b.count - a.count);

        const payload = {
          root,
          total,
          byDirectory: rows.slice(0, 50),
          truncated: rows.length > 50,
          extensions: sourceExtensions,
        };

        const top = rows
          .slice(0, 6)
          .map((r) => `${r.dir}=${r.count}`)
          .join(', ');
        const summary = `Source files by top-level directory (total=${total}): ${top}${
          rows.length > 6 ? ', …' : ''
        }`;

        return build({
          kind: 'count_source_files_by_directory',
          title: 'Count source files by directory',
          description:
            'Count common source-code file types grouped by top-level directory (fast-path, no LLM).',
          targets: ['.'],
          output: payload,
          summary,
        });
      } catch {
        return null;
      }
    }

    // Fast-path: parse package.json dependencies
    if (lower.includes('package.json') && lower.includes('dependenc')) {
      try {
        this.throwIfAborted('fastPath.package_json');
        const file = this.deps.fileTools.readFile('package.json', 200_000);
        const pkg = JSON.parse(String((file as any).content || '{}'));
        const deps =
          pkg && pkg.dependencies && typeof pkg.dependencies === 'object'
            ? Object.keys(pkg.dependencies).sort()
            : [];
        const devDeps =
          pkg && pkg.devDependencies && typeof pkg.devDependencies === 'object'
            ? Object.keys(pkg.devDependencies).sort()
            : [];
        const payload = { dependencies: deps, devDependencies: devDeps };
        const summary = `package.json dependencies: ${deps.length} deps, ${devDeps.length} devDependencies.`;
        return build({
          kind: 'package_json_dependencies',
          title: 'List package dependencies',
          description: 'Parse package.json and list dependencies.',
          targets: ['package.json'],
          output: payload,
          summary,
        });
      } catch {
        return null;
      }
    }

    // Fast-path: codebase structure snapshot
    if (
      lower.includes('structure') &&
      (lower.includes('codebase') || lower.includes('repo') || lower.includes('repository'))
    ) {
      try {
        this.throwIfAborted('fastPath.codebase_structure');
        const ft = this.deps.fileTools as any;
        const snap =
          typeof ft?.manifestSnapshotAsync === 'function'
            ? await ft.manifestSnapshotAsync('.', { maxDepth: 4, includeHidden: false })
            : ft.manifestSnapshot('.', { maxDepth: 4, includeHidden: false });
        const languageBreakdown =
          snap?.languageBreakdown && typeof snap.languageBreakdown === 'object'
            ? (snap.languageBreakdown as Record<string, { count: number; bytes: number }>)
            : {};
        const topLangs = Object.entries(languageBreakdown)
          .sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0))
          .slice(0, 6)
          .map(([lang, v]) => `${lang}:${v.count}`);
        const payload = {
          totalFiles: snap?.totalFiles,
          totalDirectories: snap?.totalDirectories,
          totalBytes: snap?.totalBytes,
          topLanguages: topLangs,
          truncated: Boolean(snap?.truncated),
        };
        const summary = `Codebase snapshot: ${payload.totalFiles ?? 0} files, ${payload.totalDirectories ?? 0} dirs.`;
        return build({
          kind: 'codebase_structure_snapshot',
          title: 'Summarize codebase structure',
          description: 'Snapshot the workspace structure (depth-limited) and summarize key stats.',
          targets: ['.'],
          output: payload,
          summary,
        });
      } catch {
        return null;
      }
    }

    return null;
  }

  async runTask(task: string, options: AgentTaskOptions): Promise<AgentTaskResult> {
    const contextRoot = options.contextRoot;

    // Plan 5: Agent Limit Optimization (updated V18 based on QA_feedback_7.md)
    // Increased defaults based on LLM feedback about tasks auto-completing due to limit exhaustion
    // Previous: maxSubtasks=6, maxSteps=18, maxActionsPerStep=6 (total: 6*18*6 = 648 actions max)
    // V14: maxSubtasks=8, maxSteps=25, maxActionsPerStep=8 (total: 8*25*8 = 1600 actions max)
    // V15: maxActionsPerStep increased 8→12 per feedback_6 (GPT-5, Gemini, Raptor, Claude all flagged 8 as too restrictive)
    // V16: maxSteps increased 25→50 per QA_feedback_1.md (all 7 LLMs requested higher default)
    // V17: maxActionsPerStep increased 12→15 per QA_feedback_6.md analysis (all testers hit limits on standard tasks)
    // V18: maxActionsPerStep increased 15→20 per QA_feedback_7.md (still hitting limits on file exploration tasks)
    // V19: maxActionsPerStep increased 20→30 per QA_feedback_12.md (multi-step flows still hitting limits)
    // Note: maxSteps=-1 or "unlimited" supported when queue is empty (no concurrent tasks)
    // New: maxSubtasks=8, maxSteps=50, maxActionsPerStep=100 (total: 8*50*100 = 40000 actions max)
    const maxSubtasks = options.maxSubtasks ?? 8;
    const maxSteps = options.maxSteps ?? 50;
    const maxActionsPerStep = options.maxActionsPerStep ?? 100;
    const allowMcpServers = options.allowMcpServers ?? this.deps.mcpClient.getConfiguredServers();
    const inferredReadOnly = options.readOnly === undefined && inferReadOnlyFromTaskText(task);
    const readOnly = options.readOnly === true || inferredReadOnly;
    const autoConnectMcp = options.autoConnectMcp ?? false;
    const allowedActions = options.allowedActions?.length
      ? options.allowedActions.map((a) => String(a).trim()).filter(Boolean)
      : undefined;

    const writeAllowlistPaths =
      options.writeAllowlistPaths?.map((p) => normalizeSlashes(String(p).trim())).filter(Boolean) ||
      null;
    const controller = new AbortController();
    const externalSignal = options.signal;
    const timeoutMs =
      typeof options.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;
    const deadlineTs = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutHandle =
      timeoutMs !== undefined ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;

    const runContext: AgentRunContext = {
      readOnly,
      writeAllowlistPaths,
      signal: controller.signal,
      deadlineTs,
    };
    const effectiveOptions: AgentTaskResult['effectiveOptions'] = {
      readOnly,
      inferredReadOnly,
      autoConnectMcp,
      maxSubtasks,
      maxSteps,
      maxActionsPerStep,
      allowMcpServers,
      allowedActions,
      writeAllowlistPaths,
    };

    const emit = (event: AgentProgressEvent) => {
      try {
        options.onProgress?.(event);
      } catch {
        // Intentionally empty - progress callback errors should not fail task
      }
    };

    let plan: AgentTaskResult['plan'] = { subtasks: [] };
    const execution: AgentTaskResult['execution'] = [];

    try {
      return await this.runContext.run(runContext, async () => {
        try {
          const observations: unknown[] = [];
          const resultCache = new AgentResultCache();

          // V12: Clear file read history at task start (fresh per-task tracking)
          this.taskFileReadHistory.clear();

          emit({ type: 'task_start', task });

          // Black-box V4: Auto-generate AGENTS.md if missing
          // This ensures agent tasks always have project context available
          await this.ensureAgentsMdExists(contextRoot);

          // Fast-path common read-only queries to avoid unnecessary LLM/tool churn.
          if (readOnly) {
            const fast = await this.tryFastPath(task, {
              contextRoot,
              effectiveOptions,
              emit,
            });
            if (fast) return fast;
          }

          this.throwIfAborted('runTask');

          // Always connect to MCP servers if autoConnectMcp is enabled
          if (autoConnectMcp && allowMcpServers.length > 0) {
            for (const serverName of allowMcpServers) {
              try {
                this.throwIfAborted('mcp_connect');
                await this.deps.mcpClient.connect(serverName);
                const tools = this.deps.mcpClient.getTools(serverName);
                observations.push({
                  type: 'mcp_server_connected',
                  serverName,
                  toolCount: tools.length,
                  tools: tools.map((t) => ({ name: t.name, description: t.description })),
                });
              } catch (e) {
                observations.push({
                  type: 'mcp_server_connect_failed',
                  serverName,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }

          const catalogAll = this.toolCatalog(contextRoot, allowMcpServers);
          const catalog = readOnly
            ? {
                ...catalogAll,
                tools: catalogAll.tools.filter(
                  (t) =>
                    t.actionType !== 'apply_diff' &&
                    t.actionType !== 'create_file' &&
                    t.actionType !== 'write_json_file' &&
                    t.actionType !== 'mcp_generate_cheatsheet' &&
                    t.actionType !== 'generate_api_inventory'
                ),
              }
            : catalogAll;
          const allowed = allowedActions?.length
            ? new Set(allowedActions.map((s) => String(s).trim()))
            : null;
          const catalogFiltered = allowed
            ? {
                ...catalog,
                tools: catalog.tools.filter(
                  (t) => allowed.has(t.actionType) || t.actionType === 'done'
                ),
              }
            : catalog;

          const allowedActionTypes = Array.from(
            new Set(catalogFiltered.tools.map((t) => t.actionType))
          );
          const writeConstraint = (() => {
            if (!writeAllowlistPaths || writeAllowlistPaths.length === 0) return '';
            const allFileLike = writeAllowlistPaths.every(isLikelyFilePath);
            const verb = allFileLike ? 'write to these exact paths' : 'write under';
            return `Write constraint: You may ONLY ${verb}: ${writeAllowlistPaths.join(', ')}.`;
          })();
          const constraintsText =
            `Allowed action types: ${allowedActionTypes.join(', ') || '(none)'}. ` +
            `Allowed MCP servers: ${catalogFiltered.allowMcpServers.join(', ') || '(none)'}. ` +
            (readOnly ? 'Read-only mode is ON. ' : '') +
            (writeConstraint ? writeConstraint : '');

          // Check semantic memory for context
          const semanticMemory = getSemanticMemory();
          let semanticContext = '';
          if (semanticMemory.getStats().enabled) {
            const results = await semanticMemory.search(task, 3);
            if (results.length > 0) {
              semanticContext =
                'Relevant code from semantic memory:\n' +
                results
                  .map(
                    (r) =>
                      `- ${r.chunk.filePath} (${r.chunk.lineRange.join('-')}): ${r.chunk.content.substring(0, 200).replace(/\n/g, ' ')}...`
                  )
                  .join('\n');
              if (process.env.DEBUG_SEMANTIC_MEMORY === '1') {
                process.stderr.write(`[agent] Found ${results.length} semantic matches for task\n`);
              }
            }
          }

          // Load project context and AGENTS.md for prompt injection
          const projectContext = buildProjectContextPrompt(contextRoot);
          const agentsMdContent = readAgentsMd(contextRoot);
          if (process.env.DEBUG_PROJECT_CONTEXT === '1') {
            if (projectContext) {
              process.stderr.write(
                `[agent] Injecting project context (${projectContext.length} chars)\n`
              );
            }
            if (agentsMdContent) {
              process.stderr.write(
                `[agent] Injecting AGENTS.md content (${agentsMdContent.length} chars)\n`
              );
            }
          }

          // Check plan memory for similar task patterns
          const planMemory = getPlanMemory();
          const cachedPlan = planMemory.findSimilar(task);

          if (cachedPlan) {
            // Reuse cached plan skeleton
            if (process.env.DEBUG_PLAN_MEMORY === '1') {
              process.stderr.write(`[agent] Using cached plan template\n`);
            }
            plan = {
              subtasks: cachedPlan.planSkeleton.subtasks.map((st, i) => ({
                id: `t${i + 1}`,
                title: st.title,
                task: st.task,
                steps: st.stepTitles.map((title, j) => ({
                  id: `s${j + 1}`,
                  title,
                  description: title,
                  targets: [],
                })),
              })),
            };
          } else {
            // Generate new plan via LLM
            const subtasks = await this.decompose(
              task,
              maxSubtasks,
              constraintsText,
              semanticContext,
              projectContext,
              agentsMdContent
            );

            plan = {
              subtasks: await Promise.all(
                subtasks.map(async (st) => ({
                  ...st,
                  steps: await this.planSteps(
                    st,
                    contextRoot,
                    maxSteps,
                    constraintsText,
                    semanticContext,
                    projectContext,
                    agentsMdContent
                  ),
                }))
              ),
            };
          }

          // Always execute the plan (unless dryRun is true)

          // dryRun mode: return success with plan only, no execution
          if (options.dryRun) {
            emit({
              type: 'plan_generated',
              subtasks: plan.subtasks.length,
              steps: plan.subtasks.reduce((sum, st) => sum + st.steps.length, 0),
            });
            emit({ type: 'task_end', success: true });
            return {
              success: true,
              task,
              contextRoot,
              effectiveOptions: { ...effectiveOptions, dryRun: true },
              plan,
              execution: [],
              final: {
                summary: `[DRY RUN] Plan generated with ${plan.subtasks.length} subtask(s). No actions executed.`,
                notes: ['Dry run mode - plan only, no execution'],
              },
            };
          }

          const totalSteps = plan.subtasks.reduce((sum, st) => sum + st.steps.length, 0);
          emit({ type: 'plan_generated', subtasks: plan.subtasks.length, steps: totalSteps });
          let completedStepsSoFar = 0;
          const total = Math.max(1, totalSteps);
          let autoCompletedSteps = 0;

          for (const st of plan.subtasks) {
            this.throwIfAborted('runTask.subtask');
            emit({ type: 'subtask_start', subtaskId: st.id, title: st.title });
            for (const step of st.steps) {
              this.throwIfAborted('runTask.step');
              // Trim observations to prevent unbounded memory growth (at start of each step)
              this.trimObservations(observations, 50);

              const stepActions: AgentTaskResult['execution'][number]['actions'] = [];
              let status: AgentTaskResult['execution'][number]['status'] = 'failed';
              let autoCompleted = false;

              emit({
                type: 'step_start',
                subtaskId: st.id,
                stepId: step.id,
                title: step.title,
                index: completedStepsSoFar + 1,
                total,
              });

              for (let i = 0; i < maxActionsPerStep; i++) {
                this.throwIfAborted('runTask.actionLoop');
                // Mid-step trim if observations growing too large (safety net for action-heavy steps)
                if (observations.length > 60) {
                  this.trimObservations(observations, 50);
                }

                // V12: Hard loop detection: if we've made 5+ identical consecutive actions, force completion
                // V19 (QA_feedback_7+8): Relaxed from 2→5 to allow legitimate iterative patterns
                // (e.g., reading multiple related files in sequence for comparison)
                const loopCheck = this.detectActionLoop(observations);
                if (loopCheck && i >= 5) {
                  const msg = `Auto-completing step due to detected action loop after ${i} actions. Results from previous search_repo calls contain the data - process them to produce the final output.`;
                  stepActions.push({
                    actionType: 'done',
                    params: { result: msg },
                    ok: true,
                    output: msg,
                  });
                  observations.push({
                    subtaskId: st.id,
                    stepId: step.id,
                    action: 'done',
                    output: msg,
                    auto: true,
                  });
                  status = 'completed';
                  autoCompleted = true;
                  autoCompletedSteps += 1;
                  break;
                }

                let next: z.infer<typeof NextActionSchema>;
                try {
                  next = await this.chooseNextAction({
                    task,
                    contextRoot,
                    subtask: st,
                    step,
                    observations,
                    allowMcpServers,
                    readOnly,
                    remainingActions: maxActionsPerStep - i,
                    allowedActions,
                  });
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  // PLAN A: Emit action trace for failed action
                  this.emitActionTrace(st.id, step.id, 'agent_error', { ok: false, error: msg });
                  stepActions.push({
                    actionType: 'agent_error',
                    params: {},
                    ok: false,
                    error: msg,
                  });
                  observations.push({
                    subtaskId: st.id,
                    stepId: step.id,
                    action: 'agent_error',
                    error: msg,
                  });
                  emit({
                    type: 'action',
                    subtaskId: st.id,
                    stepId: step.id,
                    actionType: 'agent_error',
                    ok: false,
                  });
                  status = 'failed';
                  break;
                }

                // Guardrail: some local models try to answer from memory and immediately return `done`.
                // If the step looks like it requires an action (search/read/mcp), require at least one action attempt first.
                if (
                  next.actionType === 'done' &&
                  stepActions.filter((a) => a.actionType !== 'done').length === 0
                ) {
                  const hintText = `${step.title} ${step.description}`.toLowerCase();
                  const stepLikelyNeedsAction =
                    /\b(search|grep|find|read|open|navigate|browse|screenshot|connect|mcp|tool)\b/i.test(
                      hintText
                    );
                  const taskLikelyNeedsAction =
                    /\b(audit|repo|repository|search|grep|find|scan|read|locate|verify|mcp|tool)\b/i.test(
                      task.toLowerCase()
                    );
                  const anyNonDoneAttempt = observations.some(
                    (o) =>
                      typeof o === 'object' &&
                      o !== null &&
                      'action' in o &&
                      typeof (o as any).action === 'string' &&
                      String((o as any).action) !== 'done'
                  );
                  if (stepLikelyNeedsAction) {
                    const msg =
                      "Refusing premature 'done' before attempting at least one tool action for this step.";
                    stepActions.push({
                      actionType: 'done',
                      params: next.params,
                      ok: false,
                      error: msg,
                    });
                    observations.push({
                      subtaskId: st.id,
                      stepId: step.id,
                      action: 'done',
                      error: msg,
                    });
                    continue;
                  }

                  if (taskLikelyNeedsAction && !anyNonDoneAttempt) {
                    const msg =
                      "Refusing premature 'done' before attempting at least one tool action for this task.";
                    stepActions.push({
                      actionType: 'done',
                      params: next.params,
                      ok: false,
                      error: msg,
                    });
                    observations.push({
                      subtaskId: st.id,
                      stepId: step.id,
                      action: 'done',
                      error: msg,
                    });
                    continue;
                  }
                }

                if (next.actionType === 'done') {
                  if (
                    typeof (next.params as any)?.result === 'string' &&
                    ((next.params as any).result as string).length > 800
                  ) {
                    (next.params as any).result =
                      ((next.params as any).result as string).slice(0, 800) + '...';
                  }

                  const nonDone = stepActions.filter((a) => a.actionType !== 'done');
                  const hadAnyNonDone = nonDone.length > 0;
                  const hadOkNonDone = nonDone.some((a) => a.ok);
                  const canComplete = !hadAnyNonDone || hadOkNonDone;
                  const doneError = canComplete
                    ? undefined
                    : 'Step ended without any successful actions.';

                  stepActions.push({
                    actionType: 'done',
                    params: next.params,
                    ok: canComplete,
                    output: next.params?.result,
                    error: doneError,
                  });
                  status = canComplete ? 'completed' : 'failed';
                  break;
                }

                if (
                  readOnly &&
                  (next.actionType === 'apply_diff' ||
                    next.actionType === 'create_file' ||
                    next.actionType === 'write_json_file' ||
                    next.actionType === 'mcp_generate_cheatsheet' ||
                    next.actionType === 'generate_api_inventory')
                ) {
                  const msg = `Read-only mode: action '${next.actionType}' is not allowed`;
                  stepActions.push({
                    actionType: next.actionType,
                    params: next.params,
                    ok: false,
                    error: msg,
                  });
                  observations.push({
                    subtaskId: st.id,
                    stepId: step.id,
                    action: next.actionType,
                    error: msg,
                  });
                  emit({
                    type: 'action',
                    subtaskId: st.id,
                    stepId: step.id,
                    actionType: next.actionType,
                    ok: false,
                  });
                  continue;
                }

                if (allowedActions && !allowedActions.includes(next.actionType)) {
                  const msg = `Action '${next.actionType}' is not allowed by allowedActions`;
                  stepActions.push({
                    actionType: next.actionType,
                    params: next.params,
                    ok: false,
                    error: msg,
                  });
                  observations.push({
                    subtaskId: st.id,
                    stepId: step.id,
                    action: next.actionType,
                    error: msg,
                  });
                  emit({
                    type: 'action',
                    subtaskId: st.id,
                    stepId: step.id,
                    actionType: next.actionType,
                    ok: false,
                  });
                  continue;
                }

                if (next.actionType === 'mcp_connect') {
                  const sn = String((next.params as any)?.serverName || '').trim();
                  if (sn && this.deps.mcpClient.isConnected(sn)) {
                    const msg = `MCP server '${sn}' is already connected; choose a different action.`;
                    stepActions.push({
                      actionType: next.actionType,
                      params: next.params,
                      ok: false,
                      error: msg,
                    });
                    observations.push({
                      subtaskId: st.id,
                      stepId: step.id,
                      action: next.actionType,
                      error: msg,
                    });
                    emit({
                      type: 'action',
                      subtaskId: st.id,
                      stepId: step.id,
                      actionType: next.actionType,
                      ok: false,
                    });
                    continue;
                  }
                }

                try {
                  this.throwIfAborted(`execute:${next.actionType}`);
                  const _actionStartMs = Date.now();

                  // Check result cache for read-only actions
                  const cachedResult = resultCache.get(
                    next.actionType,
                    next.params as Record<string, unknown>
                  );
                  let output: unknown;

                  if (cachedResult !== null) {
                    output = cachedResult;
                    this.emitActionTrace(st.id, step.id, next.actionType, {
                      ok: true,
                      durationMs: 0,
                    });
                    if (process.env.DEBUG_AGENT_CACHE === '1') {
                      process.stderr.write(`[agent] Cache hit for ${next.actionType}\n`);
                    }
                  } else {
                    output = await this.executeAction(next, contextRoot, allowMcpServers);
                    // Store in cache for future use within this run
                    resultCache.set(
                      next.actionType,
                      next.params as Record<string, unknown>,
                      output
                    );
                    this.emitActionTrace(st.id, step.id, next.actionType, {
                      ok: true,
                      durationMs: Date.now() - _actionStartMs,
                    });
                  }
                  const truncated = this.truncateOutput(output);
                  stepActions.push({
                    actionType: next.actionType,
                    params: next.params,
                    ok: true,
                    output: truncated,
                  });
                  observations.push({
                    subtaskId: st.id,
                    stepId: step.id,
                    action: next.actionType,
                    params: next.params, // Include params for loop detection
                    output: truncated,
                  });
                  emit({
                    type: 'action',
                    subtaskId: st.id,
                    stepId: step.id,
                    actionType: next.actionType,
                    ok: true,
                  });
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  // PLAN A: Emit action trace for failed action
                  this.emitActionTrace(st.id, step.id, next.actionType, { ok: false, error: msg });
                  stepActions.push({
                    actionType: next.actionType,
                    params: next.params,
                    ok: false,
                    error: msg,
                  });
                  observations.push({
                    subtaskId: st.id,
                    stepId: step.id,
                    action: next.actionType,
                    error: msg,
                  });
                  emit({
                    type: 'action',
                    subtaskId: st.id,
                    stepId: step.id,
                    actionType: next.actionType,
                    ok: false,
                  });
                }
              }

              // If the model never returns `done` but all actions succeeded, auto-complete the step to avoid
              // systematic "all steps failed" outcomes caused by action-budget exhaustion.
              if (status === 'failed' && stepActions.length > 0 && stepActions.every((a) => a.ok)) {
                const msg = `Auto-completed step after reaching action limit (${maxActionsPerStep}).`;
                stepActions.push({
                  actionType: 'done',
                  params: { result: msg },
                  ok: true,
                  output: msg,
                });
                observations.push({
                  subtaskId: st.id,
                  stepId: step.id,
                  action: 'done',
                  output: msg,
                  auto: true,
                });
                status = 'completed';
                autoCompleted = true;
                autoCompletedSteps += 1;
              }

              execution.push({
                subtaskId: st.id,
                stepId: step.id,
                status,
                autoCompleted,
                actions: stepActions,
              });
              emit({ type: 'step_end', subtaskId: st.id, stepId: step.id, status });
              completedStepsSoFar++;
            }
          }

          let finalObj: { summary: string; notes?: string[] };
          finalObj = this.buildDeterministicSummary({ task, plan, execution });

          const plannedSteps = plan.subtasks.reduce((sum, st) => sum + st.steps.length, 0);
          const executedSteps = execution.length;
          const completedSteps = execution.filter((e) => e.status === 'completed').length;
          const failedSteps = execution.filter((e) => e.status === 'failed').length;
          const skippedSteps = execution.filter((e) => e.status === 'skipped').length;
          const allActions = execution.flatMap((e) => e.actions || []);
          const okActions = allActions.filter((a) => a.ok).length;
          const failedActions = allActions.filter((a) => !a.ok).length;
          let overallSuccess = failedSteps === 0;
          const partial = executedSteps < plannedSteps;

          const notes = Array.isArray(finalObj.notes) ? [...finalObj.notes] : [];
          notes.push(
            `metrics: plannedSteps=${plannedSteps} executedSteps=${executedSteps} completedSteps=${completedSteps} failedSteps=${failedSteps} skippedSteps=${skippedSteps} okActions=${okActions} failedActions=${failedActions}`
          );
          if (autoCompletedSteps > 0) {
            notes.push(
              `Some steps were auto-completed (autoCompletedSteps=${autoCompletedSteps}).`
            );
          }
          if (failedSteps > 0 || failedActions > 0) {
            notes.push(
              'Some steps/actions failed; review execution for details (do not trust artifact claims unless verified).'
            );
          }

          finalObj = {
            ...finalObj,
            notes,
            metrics: {
              plannedSteps,
              executedSteps,
              completedSteps,
              failedSteps,
              skippedSteps,
              autoCompletedSteps,
              okActions,
              failedActions,
            },
          } as any;

          // V17: Enhanced partial result summary with status indicators
          // Addresses QA feedback: "agent_task auto-completes without prominently surfacing partial results"
          if (partial && autoCompletedSteps > 0) {
            // Action limit hit - make it very visible
            const prefix = `⚠️ PARTIAL (${completedSteps}/${plannedSteps} steps, hit action limit): `;
            if (!finalObj.summary.startsWith('⚠️')) {
              finalObj.summary = prefix + finalObj.summary;
            }
            // Add continuation guidance
            notes.unshift(
              `🔄 To continue: Call agent_task again with the same task. Use maxSteps=${Math.max(50, plannedSteps)} and maxActionsPerStep=${Math.max(20, maxActionsPerStep + 10)} for more complete execution.`
            );
          } else if (
            !overallSuccess &&
            !/\b(fail|error|denied|partial|could not|unable)\b/i.test(finalObj.summary)
          ) {
            // Error case - soften overly optimistic summaries
            finalObj.summary = `Partial: ${finalObj.summary}`;
          }

          try {
            this.validateDeterministicSummaryOrThrow({
              summary: finalObj.summary,
              plan,
              execution,
            });
          } catch (e) {
            overallSuccess = false;
            const msg = e instanceof Error ? e.message : String(e);
            notes.push(msg);
          }

          emit({ type: 'task_end', success: overallSuccess });

          // Record plan success/failure in plan memory
          const planMemoryForRecord = getPlanMemory();
          if (overallSuccess && !partial) {
            planMemoryForRecord.recordSuccess(task, plan);
          } else if (!overallSuccess) {
            planMemoryForRecord.recordFailure(task);
          }

          // Plan 3: Compute completion intelligence for "Continue" command support
          const completionReason: AgentTaskResult['completionReason'] = !overallSuccess
            ? 'error'
            : executedSteps < plannedSteps
              ? 'step_limit'
              : 'completed';

          // Calculate remaining work for continue support
          const executedStepIds = new Set(execution.map((e) => `${e.subtaskId}:${e.stepId}`));
          const remainingSubtasks: Array<{ id: string; title: string; task: string }> = [];
          const remainingSteps: Array<{
            subtaskId: string;
            stepId: string;
            title: string;
            description: string;
          }> = [];

          for (const st of plan.subtasks) {
            const stepsNotExecuted = st.steps.filter(
              (s) =>
                !executedStepIds.has(`${st.id}:${s.id}`) ||
                execution.find((e) => e.subtaskId === st.id && e.stepId === s.id)?.status !==
                  'completed'
            );
            if (stepsNotExecuted.length > 0) {
              if (stepsNotExecuted.length === st.steps.length) {
                // Entire subtask not started
                remainingSubtasks.push({ id: st.id, title: st.title, task: st.task });
              }
              for (const step of stepsNotExecuted) {
                remainingSteps.push({
                  subtaskId: st.id,
                  stepId: step.id,
                  title: step.title,
                  description: step.description,
                });
              }
            }
          }

          const lastExecution = execution[execution.length - 1];
          const continueAvailable = remainingSteps.length > 0 || remainingSubtasks.length > 0;

          // Get project context for the task
          const smartDefaults = getSmartDefaultsManager();
          smartDefaults.initialize(contextRoot);
          const projectCtx = smartDefaults.getProjectContext(contextRoot);

          return {
            success: overallSuccess,
            partial,
            task,
            contextRoot,
            effectiveOptions,
            plan,
            execution,
            final: finalObj,
            // Plan 3: Completion Intelligence fields
            completionReason,
            continueAvailable,
            continueState: continueAvailable
              ? {
                  remainingSubtasks,
                  remainingSteps,
                  lastCompletedStepId: lastExecution
                    ? `${lastExecution.subtaskId}:${lastExecution.stepId}`
                    : undefined,
                }
              : undefined,
            projectContext: {
              projectType: projectCtx.projectType,
              languages: projectCtx.languages,
              detectedTypes: projectCtx.detectedTypes,
            },
          };
        } catch (error) {
          emit({ type: 'task_end', success: false });

          // Plan 3: Compute remaining work for error case
          const executedStepIds = new Set(execution.map((e) => `${e.subtaskId}:${e.stepId}`));
          const remainingSubtasks: Array<{ id: string; title: string; task: string }> = [];
          const remainingSteps: Array<{
            subtaskId: string;
            stepId: string;
            title: string;
            description: string;
          }> = [];

          for (const st of plan.subtasks) {
            const stepsNotExecuted = st.steps.filter(
              (s) => !executedStepIds.has(`${st.id}:${s.id}`)
            );
            if (stepsNotExecuted.length > 0) {
              if (stepsNotExecuted.length === st.steps.length) {
                remainingSubtasks.push({ id: st.id, title: st.title, task: st.task });
              }
              for (const step of stepsNotExecuted) {
                remainingSteps.push({
                  subtaskId: st.id,
                  stepId: step.id,
                  title: step.title,
                  description: step.description,
                });
              }
            }
          }

          const lastExecution = execution[execution.length - 1];
          const continueAvailable = remainingSteps.length > 0 || remainingSubtasks.length > 0;

          return {
            success: false,
            task,
            contextRoot,
            effectiveOptions,
            plan,
            execution,
            final: this.buildDeterministicSummary({ task, plan, execution }),
            error: error instanceof Error ? error.message : String(error),
            // Plan 3: Completion Intelligence for error case
            completionReason: 'error' as const,
            continueAvailable,
            continueState: continueAvailable
              ? {
                  remainingSubtasks,
                  remainingSteps,
                  lastCompletedStepId: lastExecution
                    ? `${lastExecution.subtaskId}:${lastExecution.stepId}`
                    : undefined,
                }
              : undefined,
          };
        }
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  private buildDeterministicSummary(input: {
    task: string;
    plan: AgentTaskResult['plan'];
    execution: AgentTaskResult['execution'];
  }): { summary: string; notes?: string[]; metrics?: AgentTaskResult['final']['metrics'] } {
    const totalStepsPlanned = input.plan.subtasks.reduce((sum, st) => sum + st.steps.length, 0);
    const totalStepsExecuted = input.execution.length;
    const completedSteps = input.execution.filter((e) => e.status === 'completed').length;
    const failedSteps = input.execution.filter((e) => e.status === 'failed').length;
    const skippedSteps = input.execution.filter((e) => e.status === 'skipped').length;
    const autoCompletedSteps = input.execution.filter((e) => e.autoCompleted === true).length;

    const allActions = input.execution.flatMap((e) => e.actions || []);
    const okActions = allActions.filter((a) => a.ok).length;
    const failedActions = allActions.filter((a) => !a.ok).length;
    const actionTypes = Array.from(new Set(allActions.map((a) => a.actionType))).filter(Boolean);

    const searchPatterns = new Set<string>();
    let searchMatchCount = 0;
    const searchFiles = new Set<string>();
    for (const a of allActions) {
      if (a.actionType !== 'search_repo' || !a.ok) continue;
      const pattern = (a.params as any)?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) searchPatterns.add(pattern.trim());
      const out = a.output;
      if (!out || typeof out !== 'object') continue;
      const totalMatches = (out as any).totalMatches;
      if (typeof totalMatches === 'number') {
        searchMatchCount += totalMatches;
      } else {
        const matches = (out as any).matches;
        if (!Array.isArray(matches)) continue;
        searchMatchCount += matches.length;
        for (const m of matches) {
          const f = (m as any)?.file;
          if (typeof f === 'string' && f.trim()) searchFiles.add(f.replace(/\\/g, '/'));
        }
      }
      const filesWithMatches = (out as any).filesWithMatches;
      if (typeof filesWithMatches === 'number') {
        for (const m of (out as any).matches || []) {
          const f = (m as any)?.file;
          if (typeof f === 'string' && f.trim()) searchFiles.add(f.replace(/\\/g, '/'));
        }
      }
    }

    const filesRead = new Set<string>();
    for (const a of allActions) {
      if (a.actionType !== 'read_file' || !a.ok) continue;
      const out = a.output;
      const p = out && typeof out === 'object' ? (out as any).path : undefined;
      if (typeof p === 'string' && p.trim()) filesRead.add(p.replace(/\\/g, '/'));
    }

    let securityFindings: number | null = null;
    for (const a of allActions) {
      if (a.actionType !== 'security_scan' || !a.ok) continue;
      const out = a.output;
      if (!out || typeof out !== 'object') continue;
      if (typeof (out as any).findingsCount === 'number')
        securityFindings = (out as any).findingsCount;
      else if (Array.isArray((out as any).findings))
        securityFindings = (out as any).findings.length;
    }

    const listFilesRoots: string[] = [];
    let listFilesCount: number | null = null;
    for (const a of allActions) {
      if (a.actionType !== 'list_files' || !a.ok) continue;
      const out = a.output;
      if (!out || typeof out !== 'object') continue;
      const root = (out as any).root;
      if (typeof root === 'string' && root.trim()) listFilesRoots.push(root.replace(/\\/g, '/'));
      if (typeof (out as any).count === 'number') listFilesCount = (out as any).count;
    }

    const uniqListRoots = Array.from(new Set(listFilesRoots)).slice(0, 5);

    // Heuristic: capture any obvious artifact paths mentioned in outputs.
    const artifactPaths: string[] = [];
    for (const a of allActions) {
      const out = a.output;
      const text = typeof out === 'string' ? out : out ? JSON.stringify(out) : '';
      const m =
        /((?:[a-zA-Z]:\\|\/|\.\/)[^"'\r\n]+?\.(?:png|jpg|jpeg|webp|json))/i.exec(text) ||
        /"savedFilePath"\s*:\s*"([^"]+)"/i.exec(text);
      const p = m?.[1];
      if (p) artifactPaths.push(p.replace(/\\/g, '/'));
    }
    const uniqArtifacts = Array.from(new Set(artifactPaths)).slice(0, 10);

    const summaryParts: string[] = [];
    summaryParts.push(
      `${failedSteps === 0 && failedActions === 0 ? 'Completed' : 'Finished'}: ` +
        `${completedSteps}/${totalStepsPlanned} steps completed` +
        (failedSteps ? `, ${failedSteps} failed` : '') +
        (skippedSteps ? `, ${skippedSteps} skipped` : '') +
        `.`
    );
    if (searchMatchCount > 0) {
      const files = Array.from(searchFiles);
      const fileTail = files.slice(0, 8).map((f) => f.split('/').slice(-2).join('/'));
      summaryParts.push(
        `Search found ${searchMatchCount} matches in ${searchFiles.size} files` +
          (fileTail.length ? ` (${fileTail.join(', ')}${files.length > 8 ? ', ...' : ''})` : '') +
          `.`
      );
    } else if (allActions.some((a) => a.actionType === 'search_repo' && a.ok)) {
      summaryParts.push('Search found 0 matches.');
    }
    if (securityFindings !== null)
      summaryParts.push(`Security scan findings: ${securityFindings}.`);
    if (filesRead.size) summaryParts.push(`Files read: ${filesRead.size}.`);
    if (listFilesCount !== null) {
      summaryParts.push(
        `Listed files: ${listFilesCount}` +
          (uniqListRoots.length ? ` (root: ${uniqListRoots.join(', ')})` : '') +
          `.`
      );
    }
    const summary = summaryParts.join(' ');

    const notes: string[] = [];
    if (actionTypes.length) notes.push(`Action types used: ${actionTypes.join(', ')}`);
    if (uniqArtifacts.length) notes.push(`Artifacts: ${uniqArtifacts.join(', ')}`);
    if (searchPatterns.size)
      notes.push(
        `Search patterns: ${Array.from(searchPatterns).slice(0, 6).join(', ')}${searchPatterns.size > 6 ? ', ...' : ''}`
      );
    if (failedSteps > 0 || failedActions > 0)
      notes.push('Some steps/actions failed; inspect execution log for details.');

    return {
      summary,
      notes: notes.length ? notes : undefined,
      metrics: {
        plannedSteps: totalStepsPlanned,
        executedSteps: totalStepsExecuted,
        completedSteps,
        failedSteps,
        skippedSteps,
        autoCompletedSteps,
        okActions,
        failedActions,
      },
    };
  }

  private validateDeterministicSummaryOrThrow(input: {
    summary: string;
    plan: AgentTaskResult['plan'];
    execution: AgentTaskResult['execution'];
  }): void {
    const plannedSteps = input.plan.subtasks.reduce((sum, st) => sum + st.steps.length, 0);
    const completedSteps = input.execution.filter((e) => e.status === 'completed').length;

    const allActions = input.execution.flatMap((e) => e.actions || []);
    let computedSearchMatches = 0;
    const computedSearchFiles = new Set<string>();
    const computedFilesRead = new Set<string>();
    let computedListFilesCount: number | null = null;
    let computedSecurityFindings: number | null = null;

    for (const a of allActions) {
      if (a.actionType === 'search_repo' && a.ok) {
        const out = a.output;
        if (out && typeof out === 'object') {
          const totalMatches = (out as any).totalMatches;
          if (typeof totalMatches === 'number') {
            computedSearchMatches += totalMatches;
          } else {
            const matches = (out as any).matches;
            if (Array.isArray(matches)) computedSearchMatches += matches.length;
          }

          const matches = (out as any).matches;
          if (Array.isArray(matches)) {
            for (const m of matches) {
              const f = (m as any)?.file;
              if (typeof f === 'string' && f.trim()) computedSearchFiles.add(f.replace(/\\/g, '/'));
            }
          }
        }
      }

      if (a.actionType === 'read_file' && a.ok) {
        const out = a.output;
        const p = out && typeof out === 'object' ? (out as any).path : undefined;
        if (typeof p === 'string' && p.trim()) computedFilesRead.add(p.replace(/\\/g, '/'));
      }

      if (a.actionType === 'list_files' && a.ok) {
        const out = a.output;
        if (out && typeof out === 'object' && typeof (out as any).count === 'number') {
          computedListFilesCount = (out as any).count;
        }
      }

      if (a.actionType === 'security_scan' && a.ok) {
        const out = a.output;
        if (out && typeof out === 'object') {
          if (typeof (out as any).findingsCount === 'number')
            computedSecurityFindings = (out as any).findingsCount;
          else if (Array.isArray((out as any).findings))
            computedSecurityFindings = (out as any).findings.length;
        }
      }
    }

    const summary = String(input.summary || '');
    const issues: string[] = [];

    const stepMatch = /(\d+)\s*\/\s*(\d+)\s*steps\s*completed/i.exec(summary);
    if (stepMatch) {
      const sCompleted = parseInt(stepMatch[1], 10);
      const sPlanned = parseInt(stepMatch[2], 10);
      if (sCompleted !== completedSteps || sPlanned !== plannedSteps) {
        issues.push(
          `steps completed mismatch: summary=${sCompleted}/${sPlanned} computed=${completedSteps}/${plannedSteps}`
        );
      }
    }

    const searchNonZero = /Search found\s+(\d+)\s+matches\s+in\s+(\d+)\s+files/i.exec(summary);
    if (searchNonZero) {
      const sMatches = parseInt(searchNonZero[1], 10);
      const sFiles = parseInt(searchNonZero[2], 10);
      if (sMatches !== computedSearchMatches || sFiles !== computedSearchFiles.size) {
        issues.push(
          `search mismatch: summary=${sMatches} matches in ${sFiles} files computed=${computedSearchMatches} matches in ${computedSearchFiles.size} files`
        );
      }
    } else if (/Search found\s+0\s+matches\./i.test(summary)) {
      if (computedSearchMatches !== 0) {
        issues.push(`search mismatch: summary=0 matches computed=${computedSearchMatches} matches`);
      }
    }

    const filesReadMatch = /Files read:\s*(\d+)\./i.exec(summary);
    if (filesReadMatch) {
      const sFilesRead = parseInt(filesReadMatch[1], 10);
      if (sFilesRead !== computedFilesRead.size) {
        issues.push(
          `files read mismatch: summary=${sFilesRead} computed=${computedFilesRead.size}`
        );
      }
    }

    const listedFilesMatch = /Listed files:\s*(\d+)(?:\s*\(|\.)/i.exec(summary);
    if (listedFilesMatch) {
      const sListed = parseInt(listedFilesMatch[1], 10);
      if (computedListFilesCount !== null && sListed !== computedListFilesCount) {
        issues.push(`listed files mismatch: summary=${sListed} computed=${computedListFilesCount}`);
      }
    }

    const secMatch = /Security scan findings:\s*(\d+)\./i.exec(summary);
    if (secMatch) {
      const sFindings = parseInt(secMatch[1], 10);
      if (computedSecurityFindings !== null && sFindings !== computedSecurityFindings) {
        issues.push(
          `security findings mismatch: summary=${sFindings} computed=${computedSecurityFindings}`
        );
      }
    }

    if (issues.length) {
      throw new Error(`Summary validation failed: ${issues.join('; ')}`);
    }
  }

  /**
   * Detect if recent observations show repeated identical actions (loop detection).
   * Returns a warning string if loop detected, empty string otherwise.
   * Enhanced: Now suggests alternative approaches when loops are detected.
   */
  private detectActionLoop(observations: unknown[]): string {
    const recent = observations.slice(-6);
    // V14: Reverted threshold from 2 to 3 based on LLM feedback
    // Feedback: "hit loop limit very quickly (2 actions)", "too aggressive for simple exploration"
    if (recent.length < 3) return '';

    // Extract action signatures from recent observations
    const signatures: string[] = [];
    const actionTypes: string[] = [];
    for (const o of recent) {
      if (!o || typeof o !== 'object') continue;
      const obj = o as any;
      if (typeof obj.action === 'string' && obj.action !== 'done') {
        actionTypes.push(obj.action);
        // Create a signature from action type and key params
        let sig = obj.action;
        if (obj.params && typeof obj.params === 'object') {
          const p = obj.params as any;
          // Include key identifying params in signature (only the ones that define "what" we're searching)
          if (p.pattern) sig += `:pattern=${p.pattern}`;
          if (p.root) sig += `:root=${String(p.root).toLowerCase()}`;
          if (p.path) sig += `:path=${p.path}`;
          // Note: Intentionally NOT including maxMatches/maxResults - varying those is a sign of loop
        }
        signatures.push(sig);
      }
    }

    // V14: Check for repeated identical signatures (3+ in a row = warning)
    // Reverted from 2 to 3 based on LLM feedback about overly aggressive loop detection
    if (signatures.length >= 3) {
      const last3 = signatures.slice(-3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        const actionName = last3[0].split(':')[0];
        const alternatives = this.getSuggestedAlternatives(actionName);
        return (
          `\n🚨 LOOP WARNING: You have called "${actionName}" 3+ times with identical params. ` +
          `THE RESULTS ARE ALREADY IN THE OBSERVATIONS ABOVE - do NOT call this action again!\n\n` +
          `⚠️ CRITICAL: Review the observations carefully. The data you need is already there. ` +
          `Either:\n` +
          `1. Return actionType="done" with your findings summarized\n` +
          `2. Try a DIFFERENT action entirely\n\n` +
          `${alternatives ? `💡 ALTERNATIVE APPROACHES: ${alternatives}\n\n` : ''}` +
          `DO NOT repeat the same action. Aggregate what you have and complete the task.`
        );
      }
    }

    if (actionTypes.length >= 6) {
      const last6Types = actionTypes.slice(-6);
      if (
        last6Types[0] === last6Types[1] &&
        last6Types[1] === last6Types[2] &&
        last6Types[2] === last6Types[3] &&
        last6Types[3] === last6Types[4] &&
        last6Types[4] === last6Types[5]
      ) {
        const actionName = last6Types[0];
        const typeLoopCandidates = new Set(['search_repo', 'mcp_call', 'mcp_list_tools']);
        if (typeLoopCandidates.has(actionName)) {
          const alternatives = this.getSuggestedAlternatives(actionName);
          return (
            `\n🚨 LOOP WARNING: You have called "${actionName}" 6+ times in a row. ` +
            `The results are already available in the observations above.\n\n` +
            `⚠️ CRITICAL: Varying parameters (like maxMatches) does NOT produce different results. ` +
            `The data is the same. You MUST now:\n` +
            `1. Use the results you already have\n` +
            `2. Return actionType="done" with a summary\n\n` +
            `${alternatives ? `💡 ALTERNATIVE APPROACHES: ${alternatives}\n` : ''}`
          );
        }
      }
    }

    return '';
  }

  /**
   * Get suggested alternative approaches when an action is being repeated in a loop.
   * Returns a string with alternatives, or empty string if no alternatives.
   */
  private getSuggestedAlternatives(actionName: string): string {
    const suggestions: Record<string, string> = {
      search_repo:
        'Try "codebase_qa" for natural language questions, or "analyze_file" for specific file analysis.',
      mcp_call:
        'If searching, try using the search tool with different action types (intelligent, structured, gather).',
      read_file:
        'If you need to understand code, try "codebase_qa" or "analyze_file" instead of reading multiple files.',
      read: 'If looking for patterns, try "search_repo" with a more specific pattern.',
    };
    return suggestions[actionName] || '';
  }

  private formatObservationsForPrompt(observations: unknown[]): string {
    // Limit observations to last 6 for prompt, but keep more for context
    const recent = observations.slice(-6);
    if (recent.length === 0) return '(none)';

    const lines: string[] = [];
    for (const o of recent) {
      if (!o || typeof o !== 'object') {
        lines.push(String(o).slice(0, 200));
        continue;
      }
      const obj: any = o;
      if (obj.type === 'mcp_server_connected') {
        const toolNames = Array.isArray(obj.tools)
          ? obj.tools.map((t: any) => t?.name).filter(Boolean)
          : [];
        const preferred = [
          'new_page',
          'navigate_page',
          'take_screenshot',
          'wait_for',
          'list_pages',
          'take_snapshot',
          'evaluate_script',
        ];
        const sorted =
          obj.serverName === 'chrome-devtools'
            ? [
                ...preferred.filter((p: string) => toolNames.includes(p)),
                ...toolNames.filter((t: string) => !preferred.includes(t)),
              ]
            : toolNames;
        lines.push(
          `[mcp_connected] ${obj.serverName} tools=${obj.toolCount ?? toolNames.length} (${sorted.slice(0, 20).join(', ')}${sorted.length > 20 ? ', ...' : ''})`
        );
        continue;
      }
      if (obj.type === 'mcp_server_connect_failed') {
        lines.push(
          `[mcp_connect_failed] ${obj.serverName}: ${String(obj.error || '').slice(0, 150)}`
        );
        continue;
      }
      if (typeof obj.action === 'string') {
        const ok = obj.error ? 'error' : 'ok';
        // Safe JSON.stringify with circular reference protection
        let detail: string;
        if (obj.error) {
          detail = String(obj.error);
        } else if (obj.output !== undefined) {
          // Special handling for search_repo results - show summary not truncated JSON
          if (obj.action === 'search_repo' && obj.output && typeof obj.output === 'object') {
            const out = obj.output as any;
            if (Array.isArray(out.matches)) {
              const matchCount = out.matches.length;
              const uniqueFiles = new Set<string>(
                out.matches.map((m: any) => String(m.file || '')).filter(Boolean)
              );
              const fileList = [...uniqueFiles].slice(0, 8).map((f) => {
                const parts = f.split(/[\\/]/);
                return parts.slice(-2).join('/');
              });
              detail = `Found ${matchCount} matches in ${uniqueFiles.size} files: ${fileList.join(', ')}${uniqueFiles.size > 8 ? '...' : ''}`;
            } else {
              detail = JSON.stringify(out).slice(0, 180);
            }
          } else {
            try {
              detail = JSON.stringify(obj.output);
            } catch {
              detail = '[circular or non-serializable output]';
            }
          }
        } else {
          detail = '';
        }
        // Increase truncation limit to 300 chars for better context
        lines.push(`[action:${obj.action}] ${ok} ${detail.slice(0, 300)}`);
        continue;
      }
      // Fallback compact rendering - limit size with circular protection
      try {
        lines.push(JSON.stringify(obj).slice(0, 200));
      } catch {
        lines.push('[non-serializable observation]');
      }
    }
    return lines.join('\n');
  }

  /**
   * Trim observations array to prevent unbounded growth
   * Keeps the most recent observations while preserving connection info
   */
  private trimObservations(observations: unknown[], maxSize: number = 50): void {
    if (observations.length <= maxSize) return;

    // Keep connection events at the start (they're important context)
    const connectionEvents: unknown[] = [];
    const otherEvents: unknown[] = [];

    for (const obs of observations) {
      if (
        obs &&
        typeof obs === 'object' &&
        ((obs as any).type === 'mcp_server_connected' ||
          (obs as any).type === 'mcp_server_connect_failed')
      ) {
        connectionEvents.push(obs);
      } else {
        otherEvents.push(obs);
      }
    }

    // Calculate how many non-connection events to keep
    // Reserve at least 10 slots for recent events, but cap connection events if needed
    const maxConnectionEvents = Math.min(connectionEvents.length, Math.floor(maxSize * 0.4)); // Max 40% for connections
    const keptConnections = connectionEvents.slice(-maxConnectionEvents);
    const keepOtherCount = Math.max(10, maxSize - keptConnections.length);
    const trimmedOther = otherEvents.slice(-keepOtherCount);

    // Clear and rebuild
    observations.length = 0;
    observations.push(...keptConnections, ...trimmedOther);
  }

  // ============================================
  // CLI Orchestration Context
  // NOTE: This function is used by the CLI orchestrator to provide
  // orchestration context to the LLM when decomposing tasks.
  // ============================================

  buildOrchestrationContext(): string {
    const settings = this.deps.config.getEnvSettings();
    const enabled = settings.advanced?.cliOrchestrationEnabled;
    const backends = settings.advanced?.cliOrchestrationBackends || [];
    const threshold = settings.advanced?.cliScoreThreshold || 7;
    const maxIterations = settings.advanced?.cliMaxIterations || 3;

    if (!enabled || backends.length === 0) {
      return '';
    }

    const backendDescriptions = backends
      .map((id) => {
        if (id === 'opencode-cli') {
          return '- **opencode-cli**: Best for code generation, file creation, structured output. Uses opencode/big-pickle model.';
        }
        if (id === 'copilot-cli') {
          return '- **copilot-cli**: GitHub Copilot CLI for code assistance and generation.';
        }
        return `- **${id}**: CLI tool for task execution`;
      })
      .join('\n');

    return `
## 🤖 CLI Orchestration Mode ENABLED

Available CLI Tools for Complex Tasks:
${backendDescriptions}

### When to Use CLI Orchestration:
- Task requires creating or modifying multiple files
- Task involves code generation or refactoring
- Task complexity exceeds 2 simple steps
- Task needs structured output (JSON, specific formats)

### Orchestration Flow:
1. Complex tasks are decomposed into CLI-executable steps
2. Each step is executed via the appropriate CLI tool
3. After CLI execution, quick verification is performed
4. Final verification is requested from the CLI tool with scoring (1-10)
5. **If verification score < ${threshold}/10**:
   - Plan is updated with corrections
   - Step is retried with updated plan
   - This can repeat up to ${maxIterations} times

### Plan Management:
- Plans are saved to \`.orchestration-plans/\` directory
- Each plan has unique ID and step-by-step progress
- Plans persist across server restarts
- Progress can be reviewed and updated as needed

### Verification Process:
1. **Quick Check (LLM)**: "Is the step complete?" - yes/no
2. **Final Verification (CLI)**: Detailed score (1-10), missing items, suggestions
3. **Iteration**: If score < ${threshold}, update plan and retry

Remember: For complex multi-step tasks, prefer CLI orchestration over using individual tools directly.
`;
  }
}
