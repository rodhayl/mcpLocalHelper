import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConfigManager } from '../config/index.js';
import {
  AGENT_ONLY_DIRECT_CALL_TOOLS,
  AGENT_ONLY_TOOLS,
  CORE_TOOLS,
  TOOL_CATEGORIES,
} from './tool-discovery.js';
import { BackendManager } from '../adapters/factory.js';
import { FileTools } from '../tools/file.js';
import { GrepTools } from '../tools/grep.js';
import { LlmChatTool } from '../tools/llm.js';
import { SummarizationTools } from '../tools/summarize.js';
import { VerifyPlanTool } from '../tools/verify.js';
import { ModelInfoTool, handleModelInfoTool } from '../tools/model.js';
import { HighValueTools } from '../tools/highvalue.js';
import { SymbolIndexer } from '../tools/symbols.js';
import { EditTools } from '../tools/edit.js';
import { ExecutionTools } from '../tools/execution.js';
import { LlmEnhancedTools } from '../tools/llm-enhanced.js';
import { CodeAnalysisTools } from '../tools/code-analysis.js';
import { CodeAssistanceTools } from '../tools/code-assistance.js';
import { SystemProfiler } from '../utils/system.js';
import { McpClientManager } from '../utils/mcp-client.js';
import { AgentRunner } from '../agent/runner.js';
import { getAgentTaskQueue } from '../utils/task-queue.js';
import { getAsyncTaskStore } from '../utils/async-task-store.js';
import { getDebugLogger } from '../utils/debug-logger.js';
import { getStructuredParamError } from '../utils/param-suggester.js';
import { inferReadOnlyFromTaskText } from '../utils/task-intent.js';
import {
  validateActionRequiredParams,
  validateAllEnumParams,
} from '../utils/validation-enhanced.js';
import { formatZodValidationError } from '../utils/validation-errors.js';
import { computeMcpHealthFromProbes } from '../utils/mcp-health.js';
import {
  OrchestrationService,
  initOrchestrationService,
  initToolOrchestrationManager,
  getToolOrchestrationManager,
  getRoutingLogs,
  getRoutingStats,
  addRoutingLog,
} from '../orchestration/index.js';
import { mkdirSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { copyFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { z } from 'zod';
import {
  SummarySchema,
  SystemProfileSchema,
  VerifyPlanResponseSchema,
  ChatResponseSchema,
  type OutputFormat,
} from '../types/index.js';
import { formatOutput } from '../utils/output-formatter.js';
import { getSmartDefaultsManager } from '../utils/smart-defaults.js';

// JSON Schema type for MCP tool input schemas
export interface JSONSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
}

// Tool definitions with their group assignments
interface ToolDefinition {
  name: string;
  group: string;
  description: string;
  inputSchema: JSONSchema;
}

// ============================================
// TOOL GROUP MAPPINGS
// Updated for VS Code Copilot Bypass Strategy:
// - Removed tools that duplicate VS Code built-ins
// - Added LLM-enhanced tools that provide unique value
// ============================================
const TOOL_GROUP_MAPPING: Record<string, string> = {
  // core.summary group - LLM-based summarization (CONSOLIDATED)
  summarize: 'core.summary', // Replaces: summarize_path, summarize_repo
  // core.chat group - direct LLM chat (unique value)
  llm_chat: 'core.chat',
  // core.discovery group - meta-tool for finding additional tools
  discover_tools: 'core.discovery',
  // planning group - plan creation and verification (unique value)
  verify_plan: 'planning',
  // system.info group - system information
  system_profile: 'system.info',
  model_info: 'system.info',
  // analysis.extended group - advanced analysis tools (CONSOLIDATED)
  workspace: 'analysis.extended', // Replaces: file_metadata, manifest_snapshot, explore_directory
  cross_file_links: 'analysis.extended',
  index_symbols: 'analysis.extended',
  search: 'analysis.extended', // Replaces: intelligent_search, structured_search, gather_context
  todos: 'analysis.extended', // Replaces: aggregate_todos, implement_todos
  codebase_qa: 'analysis.extended',
  analyze_test_gaps: 'analysis.extended',
  analyze_impact: 'analysis.extended',
  // privacy group - privacy and security tools (CONSOLIDATED)
  security: 'privacy', // Replaces: secret_scan, risk_score, redaction_preview
  // llm.enhanced group - LLM-enhanced analysis tools (CONSOLIDATED)
  analyze_file: 'llm.enhanced',
  local_code_review: 'llm.enhanced',
  generate_docs: 'llm.enhanced',
  suggest_refactoring: 'llm.enhanced',
  // generate_tests - REMOVED (V21 QA_feedback_8: unreliable output quality)
  suggest_edit: 'llm.enhanced',
  draft_file: 'llm.enhanced',
  find_and_fix: 'llm.enhanced', // Plan 1: End-to-end search → analyze → fix workflow
  // execution group - code formatting and linting (CONSOLIDATED)
  linter: 'execution', // Replaces: run_linter, fix_linter
  formatter: 'execution', // Replaces: run_formatter, fix_syntax, validate_syntax
  // code.analysis group - code similarity and duplication detection (CONSOLIDATED)
  find_duplicates: 'code.analysis', // Replaces: duplicate_file_finder, similar_function_finder, duplicate_code_finder
  code_quality_analyzer: 'code.analysis',
  // llm.assistance group - LLM-powered code assistance tools (CONSOLIDATED)
  code_helper: 'llm.assistance', // Replaces: mcp_explain_code, mcp_optimize_code, mcp_simplify_code
  regex_helper: 'llm.assistance', // Replaces: mcp_explain_regex, mcp_generate_regex
  refactor_helper: 'llm.assistance', // Replaces: mcp_naming_advisor, mcp_extract_function
  mcp_diff_summarizer: 'llm.assistance',
  mcp_error_explainer: 'llm.assistance',
  mcp_translate_code: 'llm.assistance',
  mcp_plan_implementation: 'llm.assistance',
  mcp_analyze_complexity: 'llm.assistance',
  mcp_summarize_logs: 'llm.assistance',
  mcp_terminal_command: 'llm.assistance',
  refine_prompt: 'llm.assistance',
  // mcp.client group - connect to and call tools from external MCP servers (CONSOLIDATED)
  mcp_server: 'mcp.client', // Replaces: mcp_server_connect, mcp_server_disconnect, mcp_server_list_tools, mcp_server_call, mcp_server_status
  mcp_ask: 'mcp.client',
  // agent runner
  agent_task: 'planning',
  agent_queue_status: 'planning',
  agent_task_result: 'planning',
  cli_orchestrate: 'planning',
  orchestration: 'planning',
  // health + debug
  mcp_health: 'system.info',
  mcp_debug: 'system.info',
};

// Concise tool descriptions tuned for small models (GPT-5 Mini / Raptor Mini).
// Goals: low token usage, clear scope, and explicit limitations to prevent false issue reports.
const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  summarize:
    'Summarize a file, folder, or repo. Use action=path|repo. Prefer compact mode to keep context small.',
  discover_tools:
    'Find tools by category/capability. Check callable+requiredArgs before invoking. Use include_examples only when needed.',
  llm_chat:
    'Direct chat with local or SOTA backend. Use only when you need raw LLM output outside other tools.',
  system_profile: 'Return host hardware/profile info when enabled by config.',
  model_info: 'List and analyze model capabilities for task fit.',
  mcp_health:
    'Health/diagnostics. Healthy when any backend is available. format=dense gives compact status. includeDetails adds routing/cache stats and redacted errors.',
  mcp_debug: 'Read or clear debug logs. Use for diagnostics, not normal coding flow.',
  verify_plan: 'Verify a structured plan with local LLM. Use for review, not execution.',
  agent_task:
    'Autonomous multi-step task runner. Use readOnly for analysis. Defaults: maxSteps=50, maxActionsPerStep=100; use async for long tasks.',
  agent_queue_status: 'Inspect or reset the agent task queue.',
  agent_task_result: 'Poll async agent_task by taskId and fetch final result/progress.',
  orchestration:
    'Manage CLI orchestration settings. Use simulate for read-only routing prediction; use logs for runtime routing evidence.',
  cli_orchestrate:
    'Execute tasks via OpenCode/Copilot orchestration. Requires orchestration enabled.',
  workspace:
    'Workspace metadata/snapshot/explore helper. Use for quick structure discovery before deeper tools.',
  todos: 'Find or implement TODO/FIXME markers with prioritization options.',
  codebase_qa: 'Answer repo-level questions using indexed context and local LLM.',
  analyze_test_gaps:
    'Estimate missing tests from source/test patterns (requires root). Supports relative-path globs; defaults include TS/JS/PY. Guidance only.',
  analyze_impact:
    'Estimate ripple effects of changed files across dependencies, imports, and tests.',
  index_symbols: 'Build in-memory symbol index for cross-file lookups.',
  cross_file_links: 'Trace import/export links from entry points.',
  security:
    'Security actions: scan, risk, redact, fix. scan may return coverage guidance for narrow scope; use recommended include globs and includeHidden=true.',
  linter: 'Run lints, syntax validation, or LLM-assisted lint fixes.',
  formatter: 'Run formatter or LLM-assisted syntax fixes.',
  analyze_file:
    'LLM analysis for one file. If path is a directory, returns candidate-file hints. includeContent defaults to false.',
  read_file: 'Alias of analyze_file optimized for reading/documentation-style output.',
  search:
    'Unified search (intelligent|structured|gather|filenames). root defaults to "." when omitted.',
  local_code_review:
    'Privacy-preserving code review (security/performance/style/comprehensive). Hidden files require includeHidden=true.',
  generate_docs: 'Generate docs (jsdoc/readme/api/examples) for a file or folder.',
  suggest_refactoring: 'Suggest refactors with tradeoffs and safer alternatives.',
  suggest_edit:
    'Propose targeted code edits from intent. apply=true auto-applies only high-confidence edits.',
  find_and_fix: 'Search -> analyze -> suggest/apply fixes for repeated patterns across files.',
  draft_file: 'Generate a new file draft from intent and local patterns. Does not write files.',
  generate_agents_md:
    'Generate AGENTS.md from project structure. useLlm=false for faster static output.',
  find_duplicates: 'Detect similar files/functions/code spans with similarity thresholds.',
  code_quality_analyzer:
    'Run multi-signal quality checks: duplicates, complexity, smells, security.',
  code_helper: 'Explain, optimize, or simplify code snippets.',
  regex_helper: 'Explain regex or generate regex from natural language.',
  refactor_helper: 'Naming suggestions and extraction hints for selected code.',
  mcp_diff_summarizer: 'Summarize code diffs into concise human-readable changes.',
  mcp_error_explainer: 'Explain stack traces/errors and likely fixes.',
  mcp_translate_code: 'Translate code between languages with structure preservation.',
  mcp_plan_implementation: 'Turn a feature request into concrete implementation steps.',
  mcp_analyze_complexity: 'Estimate Big-O complexity with optional detail.',
  mcp_summarize_logs: 'Condense logs and highlight likely root causes.',
  mcp_terminal_command: 'Generate shell commands from task intent (suggestion only).',
  refine_prompt: 'Rewrite a prompt for clarity/precision with optional style controls.',
  mcp_server: 'Manage external MCP servers and call their tools (connect/list/call/status).',
  mcp_ask: 'Use local LLM to choose and call tools from a connected MCP server.',
};

function normalizeToolDescription(input: string): string {
  return input
    .replace(/\u2192|\u00e2\u2020\u2019/g, '->')
    .replace(/\u2705|\u00e2\u0153\u2026/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class McpServer {
  private server: Server;
  private config: ConfigManager;
  private backendManager: BackendManager;
  private fileTools: FileTools;
  private grepTools: GrepTools;
  private llmChat: LlmChatTool;
  private summarization: SummarizationTools;
  private verifyPlan: VerifyPlanTool;
  private systemProfiler: SystemProfiler;
  private modelInfoTool: ModelInfoTool;
  private highValueTools: HighValueTools;
  private symbolIndexer: SymbolIndexer;
  private editTools: EditTools;
  private executionTools: ExecutionTools;
  private llmEnhancedTools: LlmEnhancedTools;
  private codeAnalysisTools: CodeAnalysisTools;
  private codeAssistanceTools: CodeAssistanceTools;
  private mcpClient: McpClientManager;
  private workspaceInitialized: boolean = false;
  private workspaceInitPromise: Promise<void> | null = null;
  private workspaceInitGeneration = 0;
  private agentRunner: AgentRunner;
  private orchestrationService: OrchestrationService;
  private readonly startedAtMs = Date.now();
  private toolCallTotals: Record<
    string,
    { calls: number; errors: number; totalDurationMs: number; maxDurationMs: number }
  > = {};
  private recentToolCalls: Array<{
    timestamp: string;
    tool: string;
    durationMs: number;
    isError: boolean;
    error?: string;
  }> = [];
  private readonly maxRecentToolCalls = 50;
  private pendingToolCalls = 0;

  constructor(configOrPath?: string | ConfigManager) {
    this.config =
      configOrPath instanceof ConfigManager ? configOrPath : new ConfigManager(configOrPath);
    this.mcpClient = new McpClientManager(this.config.getConfig().mcpServers);
    this.backendManager = new BackendManager(this.config.getConfig().backends);
    this.fileTools = new FileTools(this.config);
    this.grepTools = new GrepTools(this.config);
    this.llmChat = new LlmChatTool(this.backendManager, this.config);
    this.summarization = new SummarizationTools(this.fileTools, this.llmChat);
    this.verifyPlan = new VerifyPlanTool(
      this.fileTools,
      this.grepTools,
      this.llmChat,
      this.summarization
    );
    this.systemProfiler = new SystemProfiler();
    this.modelInfoTool = new ModelInfoTool(this.config, this.backendManager);
    this.highValueTools = new HighValueTools(this.config, this.backendManager);
    this.symbolIndexer = new SymbolIndexer(this.config);
    this.editTools = new EditTools(this.config);
    this.executionTools = new ExecutionTools({
      workspaceRoot: this.config.getDefaultWorkspaceRoot(),
    });
    this.llmEnhancedTools = new LlmEnhancedTools(this.config, this.backendManager);
    this.codeAnalysisTools = new CodeAnalysisTools(this.config);
    this.codeAssistanceTools = new CodeAssistanceTools(this.config, this.backendManager);
    this.agentRunner = new AgentRunner({
      config: this.config,
      llmChat: this.llmChat,
      fileTools: this.fileTools,
      grepTools: this.grepTools,
      summarization: this.summarization,
      editTools: this.editTools,
      mcpClient: this.mcpClient,
      llmEnhancedTools: this.llmEnhancedTools,
      highValueTools: this.highValueTools,
    });

    // Initialize CLI orchestration service
    this.orchestrationService = initOrchestrationService(
      this.config,
      this.llmChat,
      this.backendManager
    );

    // Initialize per-tool orchestration settings from centralized config
    initToolOrchestrationManager(this.config.getToolOrchestrationConfig());

    this.server = new Server(
      {
        name: 'mcp-local-llm-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
      }
    );

    this.setupTools();
    this.setupPrompts();
    this.setupHandlers();
  }

  /**
   * Disconnect all external MCP server connections.
   * Called during graceful shutdown to prevent orphaned child processes.
   */
  public async disconnectAllMcpClients(): Promise<void> {
    try {
      await this.mcpClient.disconnectAll();
    } catch (error) {
      // Log but don't throw - shutdown must complete
      process.stderr.write(`[MCP] Error in disconnectAll: ${error}\n`);
    }
  }

  public refreshExternalServers(): void {
    const newConfig = this.config.getConfig().mcpServers || {};
    const connected = this.mcpClient.getConnectedServers();
    for (const name of connected) {
      if (!(name in newConfig)) {
        void this.mcpClient.disconnect(name);
      }
    }
    this.mcpClient.updateConfig(newConfig);
    void this.mcpClient.autoConnect();
  }

  public refreshBackends(): void {
    this.backendManager = new BackendManager(this.config.getConfig().backends);
    this.llmChat = new LlmChatTool(this.backendManager, this.config);
    this.summarization = new SummarizationTools(this.fileTools, this.llmChat);
    this.verifyPlan = new VerifyPlanTool(
      this.fileTools,
      this.grepTools,
      this.llmChat,
      this.summarization
    );
    this.modelInfoTool = new ModelInfoTool(this.config, this.backendManager);
    this.highValueTools = new HighValueTools(this.config, this.backendManager);
    this.llmEnhancedTools = new LlmEnhancedTools(this.config, this.backendManager);
    this.codeAssistanceTools = new CodeAssistanceTools(this.config, this.backendManager);
    // Keep agent tasks consistent with the refreshed backend/tool instances.
    this.agentRunner = new AgentRunner({
      config: this.config,
      llmChat: this.llmChat,
      fileTools: this.fileTools,
      grepTools: this.grepTools,
      summarization: this.summarization,
      editTools: this.editTools,
      mcpClient: this.mcpClient,
      llmEnhancedTools: this.llmEnhancedTools,
      highValueTools: this.highValueTools,
    });

    // Refresh orchestration service with new backends
    this.orchestrationService = initOrchestrationService(
      this.config,
      this.llmChat,
      this.backendManager
    );

    // Refresh per-tool orchestration settings (in case config changed)
    initToolOrchestrationManager(this.config.getToolOrchestrationConfig());
  }

  /**
   * V10: Build a synthesized answer from agent task results
   * Addresses v6 feedback: "agent_task should summarize findings into a final answer"
   *
   * This extracts key outputs from execution and presents them as a coherent answer,
   * rather than dumping raw execution logs.
   */
  private buildAgentSynthesizedAnswer(
    result: import('../agent/runner.js').AgentTaskResult
  ): string {
    const { task, execution, final } = result;
    const lines: string[] = [];

    // Start with task summary
    lines.push(`## Task: ${task}`);
    lines.push('');
    lines.push(`**Summary**: ${final.summary}`);
    lines.push('');

    // Extract key findings from successful actions
    const keyFindings: string[] = [];
    for (const step of execution) {
      if (step.status !== 'completed') continue;
      for (const action of step.actions) {
        if (!action.ok || action.actionType === 'done') continue;

        // Extract meaningful output from different action types
        const output = action.output;
        if (!output) continue;

        if (action.actionType === 'search_repo' && typeof output === 'object') {
          const o = output as any;
          if (o.matches && Array.isArray(o.matches)) {
            const uniqueFiles = [...new Set(o.matches.map((m: any) => m.file).filter(Boolean))];
            if (uniqueFiles.length > 0) {
              keyFindings.push(
                `Found matches in ${uniqueFiles.length} files: ${uniqueFiles.slice(0, 5).join(', ')}${uniqueFiles.length > 5 ? '...' : ''}`
              );
            }
          }
        } else if (action.actionType === 'read_file' && typeof output === 'object') {
          const o = output as any;
          if (o.path) {
            keyFindings.push(`Read file: ${o.path}`);
          }
        } else if (action.actionType === 'security_scan' && typeof output === 'object') {
          const o = output as any;
          if (o.findings) {
            keyFindings.push(`Security scan: ${o.findings.length} findings`);
          }
        } else if (action.actionType === 'analyze_file' && typeof output === 'object') {
          const o = output as any;
          if (o.analysis && typeof o.analysis === 'string') {
            // Truncate long analysis
            const analysis =
              o.analysis.length > 200 ? o.analysis.slice(0, 200) + '...' : o.analysis;
            keyFindings.push(`Analysis: ${analysis}`);
          }
        } else if (typeof output === 'string' && output.length > 0 && output.length < 500) {
          keyFindings.push(output);
        }
      }
    }

    if (keyFindings.length > 0) {
      lines.push('**Key Findings**:');
      for (const finding of keyFindings.slice(0, 10)) {
        lines.push(`- ${finding}`);
      }
      if (keyFindings.length > 10) {
        lines.push(`- ... and ${keyFindings.length - 10} more findings`);
      }
      lines.push('');
    }

    // Add notes if present
    if (final.notes && final.notes.length > 0) {
      lines.push('**Notes**:');
      for (const note of final.notes.slice(0, 5)) {
        // Skip metrics note (already shown)
        if (note.startsWith('metrics:')) continue;
        lines.push(`- ${note}`);
      }
    }

    return lines.join('\n');
  }

  // ============================================
  // VS CODE COPILOT BYPASS STRATEGY:
  // Only tools that provide UNIQUE VALUE are included.
  // Removed 15 duplicate tools that VS Code Copilot already has.
  // Added 8 LLM-enhanced tools for local AI analysis.
  // ============================================
  private getAllToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      // ============================================
      // Core Summary Tools (CONSOLIDATED)
      // ============================================
      {
        name: 'summarize',
        group: 'core.summary',
        description:
          'Summarize files, directories, or repositories using local LLM. Use action to specify what to summarize.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['path', 'repo'],
              description: 'Action: path (file/directory), repo (entire repository)',
            },
            path: {
              type: 'string',
              description: 'Path to summarize (file or directory, for action=path)',
            },
            root: {
              type: 'string',
              description: 'Root directory for repo summary (for action=repo)',
            },
            mode: {
              type: 'string',
              enum: ['compact', 'extended'],
              description: 'Summary detail level (default: compact)',
            },
          },
          required: ['action'],
        },
      },
      // ============================================
      // Core Discovery Tools
      // ============================================
      {
        name: 'discover_tools',
        group: 'core.discovery',
        description:
          'Find specialized tools beyond core. Response includes enabled, callable, and requiredArgs so clients can call tools correctly.',
        inputSchema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [
                'code_analysis',
                'security',
                'testing',
                'documentation',
                'refactoring',
                'planning',
                'search',
                'llm_assistance',
                'execution',
                'workspace',
                'system',
              ],
              description: 'Browse tools by category',
            },
            capability: {
              type: 'string',
              description:
                'What capability do you need? Examples: "find duplicate code", "generate tests", "analyze security"',
            },
            list_categories: {
              type: 'boolean',
              description: 'Set to true to list all available categories',
            },
            include_examples: {
              type: 'boolean',
              description: 'Include example payloads. Keep false unless examples are needed.',
            },
          },
        },
      },
      // ============================================
      // Core Chat Tools (unique: local/SOTA LLM access)
      // ============================================
      {
        name: 'llm_chat',
        group: 'core.chat',
        description: 'Chat with LLM backend (local or SOTA)',
        inputSchema: {
          type: 'object',
          properties: {
            backendRole: {
              type: 'string',
              enum: ['local', 'sota'],
              description: 'Which backend to use',
            },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
              description: 'Chat messages',
            },
            options: {
              type: 'object',
              properties: {
                model: { type: 'string', description: 'Model to use (optional)' },
                temperature: { type: 'number', description: 'Temperature (optional)' },
                max_tokens: { type: 'number', description: 'Max tokens (optional)' },
              },
            },
          },
          required: ['backendRole', 'messages'],
        },
      },
      // ============================================
      // System Info Tools
      // ============================================
      {
        name: 'system_profile',
        group: 'system.info',
        description: 'Get system hardware profile (if enabled in config)',
        inputSchema: {
          type: 'object',
          properties: {
            detail: {
              type: 'string',
              enum: ['basic', 'extended'],
              description: 'Detail level (optional)',
            },
          },
        },
      },
      {
        name: 'model_info',
        group: 'system.info',
        description: 'Get model capability information and task suitability analysis',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'analyze', 'check_task', 'recommend'],
              description: 'Action to perform',
            },
            backendId: { type: 'string', description: 'Backend ID (optional)' },
            modelId: { type: 'string', description: 'Model ID to analyze' },
            modelName: { type: 'string', description: 'Human-friendly model name (optional)' },
            taskType: { type: 'string', description: 'Task type to check/recommend' },
          },
          required: ['action'],
        },
      },
      {
        name: 'mcp_health',
        group: 'system.info',
        description:
          'Check MCP health. Status is healthy when any backend works; payload lists active backends only.',
        inputSchema: {
          type: 'object',
          properties: {
            includeDetails: {
              type: 'boolean',
              description:
                'Include extended details (cache/queue stats, recent tool calls, routing logs/stats) (default: false)',
            },
            format: {
              type: 'string',
              enum: ['compact', 'dense', 'detailed', 'json'],
              description:
                'Output format: compact (paths only), dense (minimal), detailed (full), json (raw)',
            },
          },
        },
      },
      {
        name: 'mcp_debug',
        group: 'system.info',
        description:
          'Retrieve collected debug logs/errors, view summary, or clear logs. Useful for diagnosing concurrency issues.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['errors', 'logs', 'summary', 'clear'],
              description: 'Action to perform (default: summary)',
            },
            level: {
              type: 'string',
              enum: ['error', 'warn', 'info', 'debug', 'trace'],
              description: 'Filter by log level (logs action)',
            },
            category: {
              type: 'string',
              enum: ['mcp', 'agent', 'queue', 'client', 'server', 'llm', 'general'],
              description: 'Filter by category (logs action)',
            },
            count: { type: 'number', description: 'Max entries to return (default: 20)' },
          },
        },
      },
      // ============================================
      // Planning Tools (unique: LLM-based plan verification)
      // ============================================
      {
        name: 'verify_plan',
        group: 'planning',
        description: 'Verify a multi-step plan using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            plan_id: { type: 'string', description: 'Optional plan identifier' },
            context_root: { type: 'string', description: 'Repository root for context' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  targets: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'title', 'description', 'targets'],
              },
            },
            mode: { type: 'string', enum: ['quick', 'deep'], description: 'Verification mode' },
          },
          required: ['context_root', 'steps', 'mode'],
        },
      },
      {
        name: 'agent_task',
        group: 'planning',
        description:
          'Execute a long task step-by-step using the LOCAL LLM (planning + tool-use). ' +
          '⚠️ WARNING: Complex tasks may take 1-10+ minutes depending on maxSteps and task complexity. ' +
          'LIMITS: maxSteps=50, maxActionsPerStep=100 by default. For complex tasks, increase limits or break into subtasks. ' +
          'May auto-complete if limits reached (check completionReason in result). Use maxSteps=-1 for unlimited when queue is empty. ' +
          'Set useCliOrchestration=true to route execution through CLI tools (OpenCode, Copilot) for code generation tasks. ' +
          'Best practice: first call list_tools and read this tool inputSchema, then supply ONLY the required fields.',
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'High-level task to execute. Required unless "prompt" is provided.',
            },
            prompt: {
              type: 'string',
              description: 'Alias for "task". Use either task or prompt (task takes precedence).',
            },
            options: {
              type: 'object',
              description:
                'Optional execution controls. Top-level aliases (contextRoot, readOnly, async, etc.) also supported for backward compatibility. ' +
                '⚠️ Higher values = longer execution time. Default timeout is 5 minutes.',
              properties: {
                contextRoot: {
                  type: 'string',
                  description: 'Workspace root for file operations. Use forward slashes.',
                },
                maxSubtasks: {
                  type: 'number',
                  description: 'Maximum subtasks (default: 8). Higher = longer time.',
                },
                maxSteps: {
                  type: 'number',
                  description:
                    'Maximum steps per subtask (default: 50). Use -1 for unlimited when queue empty. Higher = longer time.',
                },
                maxActionsPerStep: {
                  type: 'number',
                  description: 'Maximum actions per step (default: 100). Higher = longer time.',
                },
                timeoutMs: {
                  type: 'number',
                  description:
                    'Task timeout in milliseconds (default: 300000 = 5 min, max: 3600000 = 1 hour).',
                },
                allowMcpServers: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Whitelist of external MCP servers the agent may use.',
                },
                allowedActions: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Allowlist of agent actionTypes (e.g., search_repo, read_file, mcp_call).',
                },
                autoConnectMcp: {
                  type: 'boolean',
                  description: 'Pre-connect to MCP servers (default: true).',
                },
                async: {
                  type: 'boolean',
                  description:
                    'Run in background, return taskId (default: false). Use for long tasks.',
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Plan only, no execution (default: false).',
                },
                readOnly: {
                  type: 'boolean',
                  description: 'Block file modifications (default: false).',
                },
                useCliOrchestration: {
                  type: 'boolean',
                  description:
                    'Use CLI orchestration (OpenCode/Copilot) for code generation tasks. Requires CLI orchestration enabled in settings.',
                },
              },
            },
          },
          required: [],
          additionalProperties: true,
          examples: [
            {
              task: 'Using chrome-devtools MCP, open https://github.com and take a full-page screenshot to .mcp_cache/agent_scenarios/github.png.',
              options: { allowMcpServers: ['chrome-devtools'], readOnly: true },
            },
            {
              task: 'Search this repo for references to SSE or websocket MCP connection types and report files.',
              readOnly: true,
            },
            {
              task: 'Create a calculator module with add, subtract, multiply functions',
              useCliOrchestration: true,
            },
          ],
        },
      },
      {
        name: 'agent_queue_status',
        group: 'planning',
        description:
          'Check agent task queue status before submitting agent_task, or force-reset the queue if stuck.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'reset'],
              description:
                'Action to perform. "status" (default) returns queue state. "reset" clears queued/running tasks.',
            },
          },
        },
      },
      {
        name: 'agent_task_result',
        group: 'planning',
        description:
          'Poll for the result of an async agent_task. Use this to check completion and retrieve the result.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'Task ID returned by agent_task when async=true',
            },
            includeProgress: {
              type: 'boolean',
              description: 'Include progress events (default: true)',
            },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'orchestration',
        group: 'planning',
        description:
          'Manage CLI orchestration settings: status, enable/disable, backends, config, probe, read-only simulate, and routing logs.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'status',
                'enable',
                'disable',
                'set_backends',
                'set_config',
                'probe',
                'simulate',
                'logs',
              ],
              description:
                'Action to perform. simulate is read-only and does not change server state.',
            },
            backends: {
              type: 'array',
              items: { type: 'string', enum: ['opencode-cli', 'copilot-cli'] },
              description: 'CLI backends to enable (for action=set_backends)',
            },
            autoVerify: {
              type: 'boolean',
              description: 'Enable automatic verification (for action=set_config)',
            },
            scoreThreshold: {
              type: 'number',
              description: 'Verification score threshold (1-10) (for action=set_config)',
            },
            maxIterations: {
              type: 'number',
              description: 'Max verification iterations (1-10) (for action=set_config)',
            },
            pureMode: {
              type: 'boolean',
              description: 'Enable pure CLI mode (for action=set_config)',
            },
            includeRoutingStats: {
              type: 'boolean',
              description: 'Include routing logs and stats in responses (status/logs)',
            },
            toolName: {
              type: 'string',
              description: 'Tool name to simulate routing for (action=simulate)',
            },
            preferredBackend: {
              type: 'string',
              enum: ['auto', 'opencode', 'copilot', 'local'],
              description: 'Optional backend override for simulation only (action=simulate)',
            },
          },
        },
      },
      {
        name: 'cli_orchestrate',
        group: 'planning',
        description:
          'Execute a complex task using CLI orchestration. Routes execution through CLI tools (OpenCode, Copilot) ' +
          'while using local LLM (LM Studio) for planning and verification. ' +
          'Best for: multi-file operations, code generation, file creation with structured output. ' +
          'Requires CLI orchestration to be enabled in settings.',
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'The task to execute via CLI orchestration',
            },
            contextRoot: {
              type: 'string',
              description: 'Workspace root for file operations (default: current workspace)',
            },
            forceBackend: {
              type: 'string',
              enum: ['opencode-cli', 'copilot-cli'],
              description: 'Force use of a specific CLI backend (optional)',
            },
          },
          required: ['task'],
        },
      },
      // ============================================
      // Analysis Extended Tools (CONSOLIDATED)
      // ============================================
      {
        name: 'workspace',
        group: 'analysis.extended',
        description:
          'Unified workspace analysis: get file metadata, directory snapshots, or explore with LLM. Use mode to select operation. Recommended for discovering project structure before using other tools.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['metadata', 'snapshot', 'explore'],
              description:
                'Mode: metadata (file info), snapshot (directory structure for project overview), explore (LLM-powered exploration)',
            },
            path: {
              type: 'string',
              description: 'File or directory path. Use "." for workspace root.',
            },
            // For snapshot mode
            maxDepth: {
              type: 'number',
              description:
                'Maximum directory depth for snapshot (default: 10, use 2-3 for quick overview)',
            },
            includeHidden: {
              type: 'boolean',
              description:
                'Include hidden files/directories in snapshot (default: false, set true to find AGENTS.md in .mcp-local-llm/)',
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by file extensions (snapshot mode)',
            },
            // For explore mode
            question: {
              type: 'string',
              description: 'Specific question about the directory (explore mode)',
            },
            maxEntries: {
              type: 'number',
              description: 'Maximum entries to analyze (explore mode)',
            },
          },
          required: ['mode', 'path'],
        },
      },
      {
        name: 'todos',
        group: 'analysis.extended',
        description:
          'Unified TODO management: find, categorize, and implement TODOs/FIXMEs. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['find', 'implement'],
              description: 'Action: find (scan and categorize), implement (LLM-powered fixes)',
            },
            root: { type: 'string', description: 'Root directory to scan' },
            // For find action
            groupBy: {
              type: 'string',
              enum: ['file', 'priority', 'category', 'type'],
              description: 'How to group results (find action)',
            },
            includeContext: {
              type: 'boolean',
              description: 'Include surrounding code context (find action)',
            },
            // For implement action
            difficulty: {
              type: 'string',
              enum: ['easy', 'medium', 'hard', 'all'],
              description: 'Difficulty level of TODOs to implement (implement action)',
            },
            todoTypes: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REFACTOR'],
              },
              description: 'Types of TODOs to process (default: TODO, FIXME)',
            },
            dryRun: {
              type: 'boolean',
              description: 'Preview changes without applying (implement action)',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific files to process',
            },
            maxResults: {
              type: 'number',
              description:
                'Maximum TODOs to return/implement (default: 100 for find, 5 for implement)',
            },
          },
          required: ['action', 'root'],
        },
      },
      {
        name: 'codebase_qa',
        group: 'analysis.extended',
        description: 'Answer questions about the codebase using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Question about the codebase' },
            searchScope: {
              type: 'array',
              items: { type: 'string' },
              description: 'Directories to search',
            },
            maxSources: { type: 'number', description: 'Maximum source files (default: 5)' },
          },
          required: ['question'],
        },
      },
      {
        name: 'analyze_test_gaps',
        group: 'analysis.extended',
        description: 'Analyze test coverage gaps and suggest missing tests',
        inputSchema: {
          type: 'object',
          properties: {
            root: { type: 'string', description: 'Root directory to analyze' },
            testPatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Glob patterns for test files (matched against relative paths and file names)',
            },
            sourcePatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Glob patterns for source files (matched against relative paths and file names)',
            },
          },
          required: ['root'],
        },
      },
      {
        name: 'analyze_impact',
        group: 'analysis.extended',
        description: 'Analyze the impact of code changes on the codebase',
        inputSchema: {
          type: 'object',
          properties: {
            changedFiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of changed file paths',
            },
            checkDependencies: { type: 'boolean', description: 'Check dependency impacts' },
            checkTests: { type: 'boolean', description: 'Find affected tests' },
            checkImports: { type: 'boolean', description: 'Trace import relationships' },
          },
          required: ['changedFiles'],
        },
      },
      // ============================================
      // Symbol Indexing Tools (unique: code intelligence)
      // ============================================
      {
        name: 'index_symbols',
        group: 'analysis.extended',
        description: 'Create in-memory index of symbols (functions, classes, types)',
        inputSchema: {
          type: 'object',
          properties: {
            root: { type: 'string', description: 'Root directory to index' },
            languages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Languages to index',
            },
            symbolTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Symbol types to include',
            },
          },
          required: ['root'],
        },
      },
      {
        name: 'cross_file_links',
        group: 'analysis.extended',
        description: 'Analyze import/export relationships starting from entry points',
        inputSchema: {
          type: 'object',
          properties: {
            entryPoints: {
              type: 'array',
              items: { type: 'string' },
              description: 'Starting files to trace imports from',
            },
            depth: { type: 'number', description: 'Maximum depth to follow imports (default: 3)' },
            includeTypes: { type: 'boolean', description: 'Include type-only imports' },
          },
          required: ['entryPoints'],
        },
      },
      // ============================================
      // Privacy/Security Tools (CONSOLIDATED)
      // ============================================
      {
        name: 'security',
        group: 'privacy',
        description:
          'Unified security tool: scan for secrets/vulnerabilities, analyze risk, preview redaction, or auto-fix secrets. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['scan', 'risk', 'redact', 'fix'],
              description:
                'Action: scan (find secrets/vulnerabilities), risk (analyze content risk), redact (preview redaction), fix (auto-fix detected secrets)',
            },
            // For scan/fix actions
            root: {
              type: 'string',
              description:
                'Root directory to scan (action=scan|fix). Must be a directory; use workspace/search to discover valid roots.',
            },
            scanType: {
              type: 'string',
              enum: ['secrets', 'vulnerabilities', 'both'],
              description: 'Type of scan (for action=scan|fix)',
            },
            outputFormat: {
              type: 'string',
              enum: ['summary', 'detailed', 'actionable'],
              description: 'Output format (for action=scan)',
            },
            // NEW: Include/exclude patterns for scan
            include: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Glob patterns to include (e.g., ["**/*.ts","**/*.py"]). If omitted, scan auto-detects project type and applies defaults.',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                'File patterns to exclude from scan (e.g., ["*_test.py", "*.spec.ts"]). Applied after include filter.',
            },
            skipTests: {
              type: 'boolean',
              description:
                'Skip test directories (tests/, test/, __tests__/, spec/) to reduce noise. Default: true',
            },
            includeHidden: {
              type: 'boolean',
              description:
                'Include hidden files/directories (default: false). By default, hidden files and common noise dirs (node_modules, venv, .git) are skipped. Set true to scan hidden files like .env, .secret.',
            },
            failOnEmpty: {
              type: 'boolean',
              description:
                'Fail when zero files are scanned. Default: true in CI, false in local runs.',
            },
            // For fix action
            apply: {
              type: 'boolean',
              description: 'Apply fixes immediately (for action=fix, default: false)',
            },
            // For risk/redact actions
            content: {
              type: 'string',
              description: 'Content to analyze/redact (for action=risk|redact)',
            },
            context: {
              type: 'string',
              enum: ['code', 'config', 'documentation', 'unknown'],
              description: 'Content context type (for action=risk)',
            },
            strictMode: {
              type: 'boolean',
              description: 'Strict mode for risk analysis (for action=risk)',
            },
            showContext: {
              type: 'boolean',
              description: 'Show context around redacted content (for action=redact)',
            },
            contextLines: {
              type: 'number',
              description: 'Number of context lines to show (for action=redact)',
            },
            format: {
              type: 'string',
              enum: ['compact', 'dense', 'detailed', 'json'],
              description:
                'Output format: compact (paths only), dense (minimal), detailed (full), json (raw)',
            },
          },
          required: ['action'],
        },
      },
      // redaction_preview and risk_score CONSOLIDATED into secret_scan with action parameter
      // ============================================
      // Verification Tools - CONSOLIDATED into 'linter' below
      // ============================================
      // validate_syntax removed - consolidated into linter tool
      // ============================================
      // Execution Tools (CONSOLIDATED)
      // ============================================
      {
        name: 'linter',
        group: 'execution',
        description:
          'Unified linting tool: run linter, fix issues with LLM, or validate syntax. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['run', 'fix', 'validate'],
              description:
                'Action: run (check only), fix (LLM-powered fixes), validate (syntax check)',
            },
            // Common options
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific files to process',
            },
            // For run action
            command: { type: 'string', description: 'Custom lint command (for run action)' },
            autoFix: {
              type: 'boolean',
              description: 'Apply linter auto-fixes without LLM (for run action)',
            },
            // For fix action
            difficulty: {
              type: 'string',
              enum: ['easy', 'medium', 'hard', 'all'],
              description: 'LLM fix difficulty level (for fix action)',
            },
            dryRun: {
              type: 'boolean',
              description: 'Preview fixes without applying (for fix action)',
            },
            maxFixes: { type: 'number', description: 'Maximum fixes to apply (for fix action)' },
            // For validate action
            content: {
              type: 'string',
              description: 'Content to validate (for validate action, optional)',
            },
            timeout: { type: 'number', description: 'Timeout in milliseconds' },
          },
        },
      },
      {
        name: 'formatter',
        group: 'execution',
        description:
          'Unified formatting tool: run formatter or fix syntax errors with LLM. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['run', 'fix'],
              description: 'Action: run (format code), fix (LLM-powered syntax fixes)',
            },
            // Common options
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific files to process',
            },
            // For run action
            command: { type: 'string', description: 'Custom format command' },
            check: { type: 'boolean', description: 'Check only, do not modify (for run action)' },
            // For fix action
            difficulty: {
              type: 'string',
              enum: ['easy', 'medium', 'hard', 'all'],
              description: 'LLM fix difficulty (for fix action)',
            },
            dryRun: {
              type: 'boolean',
              description: 'Preview fixes without applying (for fix action)',
            },
            maxFixes: { type: 'number', description: 'Maximum fixes to apply (for fix action)' },
            timeout: { type: 'number', description: 'Timeout in milliseconds' },
          },
        },
      },
      // ============================================
      // LLM-Enhanced Tools (unique: local AI analysis)
      // ============================================
      {
        name: 'analyze_file',
        group: 'llm.enhanced',
        description:
          'Read and analyze a file using local LLM for quality, security, or performance insights. ' +
          'By default, raw file content is NOT included in the response to save context. ' +
          'Set includeContent=true only when you need the raw file content.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'File path to analyze. If a directory is provided, the error includes candidate file hints.',
            },
            analysisType: {
              type: 'string',
              enum: ['quality', 'security', 'performance', 'documentation', 'full'],
              description: 'Type of analysis (default: full)',
            },
            question: { type: 'string', description: 'Specific question about the file' },
            maxBytes: { type: 'number', description: 'Maximum bytes to read' },
            includeContent: {
              type: 'boolean',
              description: 'Include raw file content in response (default: false to save context)',
            },
            format: {
              type: 'string',
              enum: ['compact', 'dense', 'detailed', 'json'],
              description:
                'Output format: compact (paths only), dense (minimal), detailed (full), json (raw)',
            },
          },
          required: ['path'],
        },
      },
      // V16: read_file alias tool (QA_feedback_1.md: Gemini 3 Pro requested this for discoverability)
      // Agents expect a 'read_file' tool - this aliases to analyze_file with documentation focus
      {
        name: 'read_file',
        group: 'llm.enhanced',
        description:
          'Read a file and return its contents with optional analysis. Alias for analyze_file with documentation focus. ' +
          'For simple file reading, use analysisType="documentation". For full analysis, use analyze_file directly.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
            analysisType: {
              type: 'string',
              enum: ['quality', 'security', 'performance', 'documentation', 'full'],
              description: 'Type of analysis (default: documentation for read_file)',
            },
            maxBytes: { type: 'number', description: 'Maximum bytes to read' },
          },
          required: ['path'],
        },
      },
      // explore_directory consolidated into 'workspace' tool above
      {
        name: 'search',
        group: 'llm.enhanced',
        description:
          'Unified search tool: natural language search, symbol-aware search, or context gathering. ' +
          'IMPORTANT: The "root" parameter is OPTIONAL and defaults to "." (current workspace root) when omitted. ' +
          'This allows searches without specifying root. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['intelligent', 'structured', 'gather', 'filenames'],
              description:
                'Action: intelligent (LLM ranking), structured (symbol-aware), gather (collect relevant files), filenames (find files/dirs by name/path)',
            },
            query: { type: 'string', description: 'Search query or context description' },
            root: {
              type: 'string',
              description:
                'OPTIONAL: Root directory to search. Defaults to "." (workspace root) when omitted. ' +
                'Use "." explicitly or specify a subdirectory path like "src/" to narrow scope.',
            },
            // For intelligent action
            filePattern: {
              type: 'string',
              description: 'Filter by file glob pattern (intelligent action)',
            },
            // For structured action
            targetType: {
              type: 'string',
              enum: ['function', 'class', 'variable', 'type', 'interface', 'any'],
              description: 'Filter by symbol type (structured action)',
            },
            languages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Languages to search (structured action)',
            },
            // For gather action
            path: { type: 'string', description: 'Path for context gathering (gather action)' },
            scope: {
              type: 'string',
              enum: ['file', 'directory', 'repo'],
              description: 'Context scope (gather action)',
            },
            strategy: {
              type: 'string',
              enum: ['relevant', 'comprehensive', 'minimal'],
              description: 'Context strategy (gather action)',
            },
            maxFiles: { type: 'number', description: 'Maximum files to analyze (gather action)' },
            maxResults: { type: 'number', description: 'Maximum results (default: 20)' },
            // For filenames action
            includeHidden: {
              type: 'boolean',
              description: 'Include hidden files/directories (filenames action, default: false)',
            },
            includeDirectories: {
              type: 'boolean',
              description:
                'Include directory matches in results (filenames action, default: false)',
            },
            // Include/exclude patterns (applies to all actions)
            includePatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'File patterns to include (e.g., ["*.py", "src/**"]). If set, only matching files are searched.',
            },
            excludePatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'File patterns to exclude (e.g., ["venv/**", "node_modules/**"]). Uses smart defaults if not specified.',
            },
            // Output format control
            format: {
              type: 'string',
              enum: ['compact', 'dense', 'detailed', 'json'],
              description:
                'Output format: compact (paths only), dense (minimal), detailed (full), json (raw)',
            },
            // Deterministic mode
            deterministic: {
              type: 'boolean',
              description:
                'If true, disable LLM ranking for exhaustive exact-match results (slower but complete)',
            },
          },
          required: ['action', 'query'],
        },
      },
      {
        name: 'local_code_review',
        group: 'llm.enhanced',
        description: 'Privacy-preserving code review using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files to review',
            },
            focus: {
              type: 'string',
              enum: ['security', 'performance', 'style', 'comprehensive'],
              description: 'Review focus (default: comprehensive)',
            },
            includeHidden: {
              type: 'boolean',
              description:
                'Include hidden files/directories when collecting review targets (default: false). Hidden files are excluded unless this is true.',
            },
          },
          required: ['paths'],
        },
      },
      {
        name: 'generate_docs',
        group: 'llm.enhanced',
        description: 'Generate documentation for code using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory to document' },
            docType: {
              type: 'string',
              enum: ['jsdoc', 'readme', 'api', 'usage-examples'],
              description: 'Documentation type (default: jsdoc)',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'suggest_refactoring',
        group: 'llm.enhanced',
        description: 'Get refactoring suggestions from local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File to analyze for refactoring' },
          },
          required: ['path'],
        },
      },
      // generate_tests - REMOVED (V21 QA_feedback_8: unreliable output quality)
      // draft_commit_message - REMOVED (Git-related tool per user request)
      // Plan 1: suggest_edit - LLM-powered edit suggestions with optional apply
      {
        name: 'suggest_edit',
        group: 'llm.enhanced',
        description:
          'Get LLM-powered edit suggestions for a file. Local LLM analyzes current code and your intent, then suggests specific edits with explanations. With apply=true, automatically applies high-confidence edits.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The file to suggest edits for',
            },
            intent: {
              type: 'string',
              description: 'What change do you want to make?',
            },
            context: {
              type: 'string',
              description: 'Additional context for the edit (optional)',
            },
            maxSuggestions: {
              type: 'number',
              description: 'Maximum suggestions to return (default: 5)',
            },
            apply: {
              type: 'boolean',
              description:
                'Apply edits automatically if confidence >= minConfidence (default: false)',
            },
            minConfidence: {
              type: 'number',
              description: 'Minimum confidence 0-1 to auto-apply edits (default: 0.8)',
            },
          },
          required: ['file_path', 'intent'],
        },
      },
      // Plan 1: find_and_fix - End-to-end search → analyze → fix workflow
      {
        name: 'find_and_fix',
        group: 'llm.enhanced',
        description:
          'Complete edit loop: search for patterns, analyze files, and generate/apply fixes. Chains search → analyze_file → suggest_edit with optional apply. Ideal for bulk refactoring or fixing patterns across codebase.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Pattern to search for (supports regex)',
            },
            intent: {
              type: 'string',
              description: 'What change/fix should be applied?',
            },
            root: {
              type: 'string',
              description: 'Root directory to limit search (optional)',
            },
            maxFiles: {
              type: 'number',
              description: 'Maximum files to process (default: 10)',
            },
            apply: {
              type: 'boolean',
              description: 'Apply fixes automatically (default: false)',
            },
            minConfidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Minimum confidence to apply fixes (default: high)',
            },
          },
          required: ['pattern', 'intent'],
        },
      },
      // Plan 1: draft_file - LLM-powered file generation
      {
        name: 'draft_file',
        group: 'llm.enhanced',
        description:
          'Generate a new file using local LLM based on your intent and project context. LLM analyzes existing codebase patterns and generates appropriate content. Returns draft for review - does NOT create the file.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Intended file path for the new file',
            },
            intent: {
              type: 'string',
              description: 'What should this file do?',
            },
            similar_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Example files to match style (optional)',
            },
            template: {
              type: 'string',
              description: 'Template or structure to follow (optional)',
            },
          },
          required: ['file_path', 'intent'],
        },
      },
      // Black-box V4: generate_agents_md - Generate AGENTS.md from project structure
      {
        name: 'generate_agents_md',
        group: 'llm.enhanced',
        description:
          'Generate an AGENTS.md file for the project following the agents.md specification. Analyzes project structure (package.json, README, configs) and creates a concise instruction file for AI coding assistants. Use useLlm=false for fast static generation.',
        inputSchema: {
          type: 'object',
          properties: {
            root: {
              type: 'string',
              description: 'Project root directory (default: workspace root)',
            },
            outputPath: {
              type: 'string',
              description: 'Output file path relative to root (default: .mcp-local-llm/AGENTS.md)',
            },
            overwrite: {
              type: 'boolean',
              description: 'Whether to overwrite existing file (default: false)',
            },
            useLlm: {
              type: 'boolean',
              description:
                'Use LLM to enhance content with README insights (default: true). Set false for fast static generation.',
            },
          },
          required: [],
        },
      },
      // ============================================
      // Auto-Fix Tools - fix_linter and fix_syntax consolidated into 'linter' and 'formatter' tools above
      // ============================================
      // ============================================
      // Code Analysis Tools (CONSOLIDATED)
      // ============================================
      {
        name: 'find_duplicates',
        group: 'code.analysis',
        description:
          'Unified tool to find duplicate/similar files, functions, or code spans. Use findType to select what to find.',
        inputSchema: {
          type: 'object',
          properties: {
            findType: {
              type: 'string',
              enum: ['files', 'functions', 'code'],
              description:
                'What to find: files (similar files), functions (similar functions), code (duplicate code spans)',
            },
            // For files
            fileName: {
              type: 'string',
              description: 'For files: name or path of file to find similar files for',
            },
            // For functions
            symbol: {
              type: 'string',
              description: 'For functions: function name to find similar functions for',
            },
            filePath: {
              type: 'string',
              description: 'For functions: file containing the reference function (optional)',
            },
            // For code
            minLines: {
              type: 'number',
              description: 'For code: minimum lines for duplicate (default: 8)',
            },
            // Common options
            minSimilarity: {
              type: 'number',
              description: 'Minimum similarity threshold 0-1 (default: 0.6)',
            },
            maxResults: { type: 'number', description: 'Maximum results to return (default: 25)' },
            includeContent: {
              type: 'boolean',
              description: 'Include content analysis (default: false)',
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'File extensions to scan (default: ts,tsx,js,jsx,py)',
            },
          },
          required: ['findType'],
        },
      },
      {
        name: 'code_quality_analyzer',
        group: 'code.analysis',
        description:
          'Comprehensive code quality analysis including duplicates, complexity, security, and code smells',
        inputSchema: {
          type: 'object',
          properties: {
            rootDir: {
              type: 'string',
              description: 'Root directory to analyze (default: workspace root)',
            },
            minSimilarity: {
              type: 'number',
              description: 'Minimum similarity for duplicate detection (default: 0.85)',
            },
            includeTypes: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['duplicates', 'complexity', 'security', 'dead_code', 'smells'],
              },
              description: 'Types of analysis to include (default: all)',
            },
          },
        },
      },
      // ============================================
      // LLM Assistance Tools (CONSOLIDATED)
      // ============================================
      {
        name: 'code_helper',
        group: 'llm.assistance',
        description:
          'Unified tool for code explanation, optimization, and simplification using local LLM. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['explain', 'optimize', 'simplify'],
              description:
                'Action: explain (code explanation), optimize (performance suggestions), simplify (reduce complexity)',
            },
            code: { type: 'string', description: 'Code snippet to process' },
            language: {
              type: 'string',
              description: 'Programming language (optional, auto-detected)',
            },
            // For explain
            level: {
              type: 'string',
              enum: ['beginner', 'intermediate', 'expert'],
              description: 'For explain: detail level (default: intermediate)',
            },
            // For optimize
            focus: {
              type: 'string',
              enum: ['speed', 'memory', 'readability', 'all'],
              description: 'For optimize: focus area (default: all)',
            },
            // For simplify
            preserve: {
              type: 'array',
              items: { type: 'string' },
              description: 'For simplify: features to preserve (optional)',
            },
          },
          required: ['action', 'code'],
        },
      },
      {
        name: 'regex_helper',
        group: 'llm.assistance',
        description:
          'Unified tool for regex explanation and generation using local LLM. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['explain', 'generate'],
              description: 'Action: explain (explain pattern), generate (create from description)',
            },
            // For explain
            pattern: { type: 'string', description: 'For explain: regex pattern to explain' },
            // For generate
            description: {
              type: 'string',
              description: 'For generate: natural language description of what to match',
            },
            examples: {
              type: 'array',
              items: { type: 'string' },
              description: 'For generate: example strings that should match (optional)',
            },
            flavor: {
              type: 'string',
              enum: ['javascript', 'python', 'pcre', 'auto'],
              description: 'Regex flavor (default: javascript)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'refactor_helper',
        group: 'llm.assistance',
        description:
          'Unified tool for naming suggestions and function extraction using local LLM. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['suggest_names', 'extract_function'],
              description:
                'Action: suggest_names (better variable/function names), extract_function (suggest function extraction)',
            },
            code: { type: 'string', description: 'Code snippet to process' },
            language: { type: 'string', description: 'Programming language (optional)' },
            // For suggest_names
            style: {
              type: 'string',
              enum: ['camelCase', 'snake_case', 'PascalCase', 'auto'],
              description: 'For suggest_names: naming convention (default: auto)',
            },
            // For extract_function
            selection: {
              type: 'string',
              description: 'For extract_function: specific code portion to extract (optional)',
            },
          },
          required: ['action', 'code'],
        },
      },
      {
        name: 'mcp_diff_summarizer',
        group: 'llm.assistance',
        description: 'Explain code diffs/changes in plain English using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            diff: { type: 'string', description: 'Git diff or unified diff content' },
            format: {
              type: 'string',
              enum: ['summary', 'detailed', 'bullet'],
              description: 'Output format (default: summary)',
            },
          },
          required: ['diff'],
        },
      },
      {
        name: 'mcp_error_explainer',
        group: 'llm.assistance',
        description: 'Diagnose and explain runtime errors/stacktraces using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Error message or stacktrace' },
            language: { type: 'string', description: 'Programming language (optional)' },
            context: {
              type: 'string',
              description: 'Additional context about the code (optional)',
            },
          },
          required: ['error'],
        },
      },
      // mcp_naming_advisor - CONSOLIDATED into refactor_helper
      // mcp_extract_function - CONSOLIDATED into refactor_helper
      // mcp_simplify_code - CONSOLIDATED into code_helper
      {
        name: 'mcp_translate_code',
        group: 'llm.assistance',
        description: 'Translate code between programming languages using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Source code to translate' },
            sourceLanguage: { type: 'string', description: 'Source programming language' },
            targetLanguage: { type: 'string', description: 'Target programming language' },
            preserveComments: {
              type: 'boolean',
              description: 'Keep comments in output (default: true)',
            },
          },
          required: ['code', 'sourceLanguage', 'targetLanguage'],
        },
      },
      {
        name: 'mcp_plan_implementation',
        group: 'llm.assistance',
        description: 'Break feature requests into implementation steps using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            feature: { type: 'string', description: 'Feature description or requirement' },
            codebase: {
              type: 'string',
              description: 'Brief description of existing codebase (optional)',
            },
            constraints: {
              type: 'array',
              items: { type: 'string' },
              description: 'Technical constraints (optional)',
            },
          },
          required: ['feature'],
        },
      },
      // mcp_explain_regex - CONSOLIDATED into regex_helper
      // mcp_generate_regex - CONSOLIDATED into regex_helper
      {
        name: 'mcp_analyze_complexity',
        group: 'llm.assistance',
        description: 'Estimate Big-O complexity of code using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code snippet to analyze' },
            language: { type: 'string', description: 'Programming language (optional)' },
            detailed: {
              type: 'boolean',
              description: 'Include detailed breakdown (default: false)',
            },
          },
          required: ['code'],
        },
      },
      {
        name: 'mcp_summarize_logs',
        group: 'llm.assistance',
        description: 'Summarize log output and identify issues using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            logs: { type: 'string', description: 'Log output to summarize' },
            focus: {
              type: 'string',
              enum: ['errors', 'warnings', 'all'],
              description: 'Focus area (default: all)',
            },
            maxLines: { type: 'number', description: 'Maximum lines to process (default: 500)' },
          },
          required: ['logs'],
        },
      },
      {
        name: 'mcp_terminal_command',
        group: 'llm.assistance',
        description: 'Suggest shell commands from natural language description using local LLM',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What you want to accomplish' },
            shell: {
              type: 'string',
              enum: ['bash', 'powershell', 'cmd', 'zsh'],
              description: 'Target shell (default: bash)',
            },
            os: {
              type: 'string',
              enum: ['linux', 'macos', 'windows', 'auto'],
              description: 'Operating system (default: auto)',
            },
          },
          required: ['task'],
        },
      },
      {
        name: 'refine_prompt',
        group: 'llm.assistance',
        description: 'Refine and improve a prompt using the local LLM (JSON output)',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Original prompt to refine' },
            context: { type: 'string', description: 'Optional context about the project/task' },
            style: {
              type: 'string',
              enum: ['concise', 'detailed', 'technical', 'creative'],
              description: 'Refinement style (default: detailed)',
            },
            iterations: {
              type: 'number',
              description: 'Number of refinement passes (default: 1, max: 3)',
            },
          },
          required: ['prompt'],
        },
      },
      // ============================================
      // MCP Client Tools - Connect to and call external MCP servers (CONSOLIDATED)
      // ============================================
      {
        name: 'mcp_server',
        group: 'mcp.client',
        description:
          'Unified MCP server management: connect, disconnect, list tools, call tools, or check status. Use action to select operation.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'connect',
                'disconnect',
                'list',
                'call',
                'status',
                'listLocal',
                'describeTool',
              ],
              description:
                'Action: connect, disconnect, list (external tools), call (external tool), status, listLocal (local tools), describeTool (local tool schema)',
            },
            serverName: { type: 'string', description: 'Name of the MCP server' },
            // For call action
            toolName: { type: 'string', description: 'Name of the tool to call (for call action)' },
            includeSchema: {
              type: 'boolean',
              description: 'Include tool input schemas when listing tools',
            },
            include_schema: { type: 'boolean', description: 'Alias of includeSchema (snake_case)' },
            arguments: {
              type: 'object',
              description: 'Arguments to pass to the tool (for call action)',
            },
            args: { type: 'object', description: 'Alias of arguments (backward compatibility)' },
            parameters: {
              type: 'object',
              description: 'Alias of arguments (common in other MCP wrappers)',
            },
            input: {
              type: 'object',
              description: 'Alias of arguments (common in other MCP wrappers)',
            },
            toolArgs: {
              type: 'object',
              description: 'Alias of arguments (common in some wrappers/UIs)',
            },
            params: {
              type: 'object',
              description: 'Alias of arguments (common in some wrappers/UIs)',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'mcp_ask',
        group: 'mcp.client',
        description:
          'Ask the local LLM to help with a task using connected MCP server tools. The LLM will suggest which tool to use and with what arguments.',
        inputSchema: {
          type: 'object',
          properties: {
            serverName: {
              type: 'string',
              description: 'Name of the connected MCP server to use (e.g., chrome-devtools)',
            },
            task: {
              type: 'string',
              description:
                'Description of what you want to accomplish (e.g., "take a screenshot of google.com")',
            },
            preferredTool: {
              type: 'string',
              description: 'Optional: specific tool to use (e.g., "take_screenshot")',
            },
          },
          required: ['serverName', 'task'],
        },
      },
    ];

    for (const tool of tools) {
      const override = TOOL_DESCRIPTION_OVERRIDES[tool.name];
      tool.description = normalizeToolDescription(override ?? tool.description);
    }

    return tools;
  }

  private getAgentQueue() {
    const serverCfg = this.config.getConfig().server;
    const maxConcurrentTasks = serverCfg?.maxConcurrentAgentTasks ?? 1;
    const queueTimeoutMs = serverCfg?.agentTaskQueueTimeoutMs ?? 300000;
    const staleTaskTimeoutMs = Math.max(600000, queueTimeoutMs * 2);

    return getAgentTaskQueue({
      maxConcurrentTasks,
      queueTimeoutMs,
      staleTaskTimeoutMs,
    });
  }

  private recordToolCall(tool: string, durationMs: number, isError: boolean, error?: string): void {
    const prev = this.toolCallTotals[tool] || {
      calls: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    const next = {
      calls: prev.calls + 1,
      errors: prev.errors + (isError ? 1 : 0),
      totalDurationMs: prev.totalDurationMs + durationMs,
      maxDurationMs: Math.max(prev.maxDurationMs, durationMs),
    };
    this.toolCallTotals[tool] = next;

    this.recentToolCalls.unshift({
      timestamp: new Date().toISOString(),
      tool,
      durationMs,
      isError,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
    if (this.recentToolCalls.length > this.maxRecentToolCalls) {
      this.recentToolCalls = this.recentToolCalls.slice(0, this.maxRecentToolCalls);
    }
  }

  /**
   * Expose local tool schemas for the HTTP UI/API.
   * This is intentionally separate from the MCP listTools capability.
   */
  public getLocalToolManifest(options?: {
    includeDisabled?: boolean;
    includeSchema?: boolean;
  }): Array<{
    name: string;
    group: string;
    description: string;
    enabled: boolean;
    inputSchema?: JSONSchema;
  }> {
    const includeDisabled = options?.includeDisabled === true;
    const includeSchema = options?.includeSchema === true;
    const defs = this.getAllToolDefinitions();

    return defs
      .filter((d) => includeDisabled || this.config.isToolEnabled(d.name))
      .map((d) => ({
        name: d.name,
        group: d.group,
        description: d.description,
        enabled: this.config.isToolEnabled(d.name),
        ...(includeSchema ? { inputSchema: d.inputSchema } : {}),
      }));
  }

  public getLocalToolSchema(toolName: string): {
    found: boolean;
    name?: string;
    group?: string;
    description?: string;
    enabled?: boolean;
    inputSchema?: JSONSchema;
  } {
    const name = String(toolName || '').trim();
    const defs = this.getAllToolDefinitions();
    const tool =
      defs.find((d) => d.name === name) ||
      defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!tool) return { found: false };

    return {
      found: true,
      name: tool.name,
      group: tool.group,
      description: tool.description,
      enabled: this.config.isToolEnabled(tool.name),
      inputSchema: tool.inputSchema,
    };
  }

  // Internal reference for tool execution - set by setupHandlers()
  private _toolExecutor:
    | ((
        name: string,
        args: Record<string, unknown>
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>)
    | null = null;

  /**
   * Execute a tool programmatically (for HTTP API/UI testing).
   * This uses the same logic as the MCP CallTool handler.
   *
   * @param toolName The name of the tool to execute
   * @param args The arguments to pass to the tool
   * @param onProgress Optional progress callback for streaming updates
   * @returns Tool execution result
   */
  public async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    onProgress?: (event: { type: string; message: string; data?: unknown }) => void
  ): Promise<{
    success: boolean;
    content?: Array<{ type: string; text: string }>;
    error?: string;
    isError?: boolean;
  }> {
    if (!this._toolExecutor) {
      return {
        success: false,
        error: 'Tool execution not initialized. Server may not be fully started.',
        isError: true,
      };
    }

    const startTime = Date.now();
    try {
      onProgress?.({ type: 'start', message: `Executing tool: ${toolName}` });

      const result = await this._toolExecutor(toolName, args);
      const durationMs = Date.now() - startTime;

      onProgress?.({
        type: 'complete',
        message: `Tool execution completed in ${durationMs}ms`,
        data: result,
      });

      return {
        success: !result.isError,
        content: result.content,
        isError: result.isError,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      onProgress?.({ type: 'error', message: errorMessage });
      return {
        success: false,
        error: errorMessage,
        isError: true,
      };
    }
  }

  private setupTools() {
    // Get all tool definitions filtered by enabled groups
    const allTools = this.getAllToolDefinitions();
    const enabledTools = this.config.getEnabledTools();

    // Minimal logging for tool setup
    process.stderr.write(
      `[McpServer] Tool groups enabled: ${this.config.getEnabledGroups().join(', ')}\n`
    );
    process.stderr.write(
      `[McpServer] Total tools available: ${allTools.length}, Enabled: ${enabledTools.size}\n`
    );

    // Check for wildcard '*' which means all tools are enabled (backward compatibility)
    const allEnabled = enabledTools.has('*');

    // Agent-only tools set for quick lookup
    const agentOnlySet = new Set(AGENT_ONLY_TOOLS);

    // Core tools set for progressive loading
    const coreToolsSet = new Set(CORE_TOOLS);

    // Check toolDiscovery config for progressive loading
    const toolDiscoveryConfig = this.config.getConfig().toolDiscovery;
    const useFullToolList = toolDiscoveryConfig?.fullToolList ?? false;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools
        .filter((tool) => {
          // Always exclude agent-only tools from ListTools (still callable via CallTool)
          if (agentOnlySet.has(tool.name)) {
            return false;
          }
          // Progressive loading: only show core tools unless fullToolList is true
          if (!useFullToolList && !coreToolsSet.has(tool.name)) {
            return false;
          }
          return allEnabled || enabledTools.has(tool.name);
        })
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }));
  }

  // ============================================
  // MCP PROMPTS (Plan 3)
  // Guided workflows that combine multiple tools
  // Users invoke with /mcp.mcp-local-llm.promptName
  // ============================================
  private setupPrompts() {
    const prompts = [
      {
        name: 'analyze-security',
        description:
          'Run comprehensive security analysis on your codebase. Scans for secrets, vulnerabilities, and security risks using local LLM.',
        arguments: [
          {
            name: 'path',
            description: 'Root path to scan (default: workspace root)',
            required: false,
          },
        ],
      },
      {
        name: 'find-todos',
        description:
          'Find and prioritize all TODOs, FIXMEs, HACKs, and technical debt markers in your codebase.',
        arguments: [
          {
            name: 'path',
            description: 'Root path to scan (default: workspace root)',
            required: false,
          },
          {
            name: 'groupBy',
            description: 'Group results by: file, priority, category, or type',
            required: false,
          },
        ],
      },
      {
        name: 'review-changes',
        description:
          'Use local LLM to review recent code changes. Privacy-preserving code review that never leaves your machine.',
        arguments: [
          {
            name: 'files',
            description: 'Comma-separated list of files to review (default: all changed files)',
            required: false,
          },
          {
            name: 'focus',
            description: 'Review focus: security, performance, style, or comprehensive',
            required: false,
          },
        ],
      },
      {
        name: 'explain-code',
        description:
          'Get detailed explanation of code using local LLM. Includes purpose, structure, and potential issues.',
        arguments: [
          { name: 'path', description: 'File path to explain', required: true },
          { name: 'question', description: 'Specific question about the code', required: false },
        ],
      },
      {
        name: 'generate-tests',
        description:
          'Generate test cases for your code using local LLM. Creates comprehensive tests with edge cases.',
        arguments: [
          { name: 'path', description: 'File path to generate tests for', required: true },
          {
            name: 'framework',
            description: 'Test framework (vitest, jest, pytest, etc.)',
            required: false,
          },
          {
            name: 'coverage',
            description: 'Coverage level: basic, comprehensive, or edge-cases',
            required: false,
          },
        ],
      },
      {
        name: 'suggest-improvements',
        description: 'Get refactoring and improvement suggestions for your code using local LLM.',
        arguments: [
          { name: 'path', description: 'File path to analyze', required: true },
          {
            name: 'focus',
            description: 'Focus area: duplication, complexity, naming, architecture, or all',
            required: false,
          },
        ],
      },
    ];

    // List prompts handler
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: prompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    }));

    // Get prompt handler - returns the prompt messages
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const promptDef = prompts.find((p) => p.name === name);

      if (!promptDef) {
        throw new Error(`Unknown prompt: ${name}`);
      }

      // Build prompt messages based on the prompt type
      switch (name) {
        case 'analyze-security': {
          const path = (args?.path as string) || '.';
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `Run a comprehensive security analysis on the codebase at "${path}". 
                  
Please use these tools in order:
1. Use #mcp.mcp-local-llm.secret_scan to scan for secrets and API keys
2. Use #mcp.mcp-local-llm.risk_score to assess security risks
3. Use #mcp.mcp-local-llm.local_code_review with focus on security

Provide a summary of findings with severity levels and recommendations.`,
                },
              },
            ],
          };
        }

        case 'find-todos': {
          const path = (args?.path as string) || '.';
          const groupBy = (args?.groupBy as string) || 'priority';
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `Find all TODOs, FIXMEs, HACKs, and technical debt in "${path}".

Use #mcp.mcp-local-llm.aggregate_todos with groupBy="${groupBy}" to find all markers.
Then analyze and prioritize them, grouping by urgency and impact.`,
                },
              },
            ],
          };
        }

        case 'review-changes': {
          const files = (args?.files as string) || '';
          const focus = (args?.focus as string) || 'comprehensive';
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `Review code changes using local LLM for privacy.

${files ? `Files to review: ${files}` : 'Review all recently changed files.'}
Focus: ${focus}

Use #mcp.mcp-local-llm.local_code_review with reviewType="${focus}" to perform a privacy-preserving code review.
Provide actionable feedback with specific line references.`,
                },
              },
            ],
          };
        }

        case 'explain-code': {
          const path = args?.path as string;
          const question = (args?.question as string) || '';
          if (!path) {
            throw new Error('Path is required for explain-code prompt');
          }
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `Explain the code in "${path}" using local LLM analysis.

Use #mcp.mcp-local-llm.analyze_file with analysisType="full" to analyze the file.
${question ? `Specific question: ${question}` : 'Explain the purpose, structure, and any potential issues.'}

Provide a clear explanation suitable for understanding and maintaining this code.`,
                },
              },
            ],
          };
        }

        case 'generate-tests': {
          // V21 (QA_feedback_8): generate_tests tool removed due to unreliable output quality
          // Return guidance to use alternative approaches
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `The generate_tests tool has been removed due to quality issues.

Alternative approaches:
1. Use #mcp.mcp-local-llm.analyze_file to understand the code structure
2. Use #mcp.mcp-local-llm.local_code_review to identify test gaps
3. Write tests manually based on the analysis

For automated test generation, consider using the host IDE's testing tools.`,
                },
              },
            ],
          };
        }

        case 'suggest-improvements': {
          const path = args?.path as string;
          const focus = (args?.focus as string) || 'all';
          if (!path) {
            throw new Error('Path is required for suggest-improvements prompt');
          }
          return {
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `Suggest improvements for "${path}" using local LLM.

Use #mcp.mcp-local-llm.suggest_refactoring with focus="${focus}" to analyze the code.
Also use #mcp.mcp-local-llm.analyze_file with analysisType="quality" for additional insights.

Provide specific, actionable suggestions with code examples where helpful.`,
                },
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown prompt: ${name}`);
      }
    });
  }

  private setupHandlers() {
    type RoutingMeta = {
      mode: string;
      backend?: string;
      success: boolean;
      durationMs: number;
      error?: string;
    };

    const resolveRoutingMeta = (
      toolName: string,
      routingHeadBefore:
        | {
            timestamp: string;
            toolName: string;
            mode: string;
            durationMs: number;
          }
        | undefined,
      fallback: RoutingMeta
    ): RoutingMeta => {
      const logs = getRoutingLogs();
      const newEntries = (() => {
        if (!routingHeadBefore) return logs;
        const cursorIndex = logs.findIndex(
          (entry) =>
            entry === routingHeadBefore ||
            (entry.timestamp === routingHeadBefore.timestamp &&
              entry.toolName === routingHeadBefore.toolName &&
              entry.mode === routingHeadBefore.mode &&
              entry.durationMs === routingHeadBefore.durationMs)
        );
        return cursorIndex === -1 ? logs : logs.slice(0, cursorIndex);
      })();

      const observed = newEntries.find((entry) => entry.toolName === toolName);
      if (observed) {
        return {
          mode: observed.mode,
          backend: observed.backend,
          success: observed.success,
          durationMs: observed.durationMs,
          error: observed.error,
        };
      }

      addRoutingLog({
        toolName,
        mode: 'direct-llm',
        backend: fallback.backend,
        success: fallback.success,
        durationMs: fallback.durationMs,
        ...(fallback.error ? { error: fallback.error } : {}),
      });
      return fallback;
    };

    const attachRoutingToResult = (
      result: { content: Array<{ type: string; text: string }>; isError?: boolean },
      routing: RoutingMeta,
      includeRoutingMeta: boolean
    ) => {
      if (!includeRoutingMeta) return result;
      return {
        ...result,
        content: result.content.map((item) => {
          if (item.type !== 'text' || typeof item.text !== 'string') return item;
          try {
            const parsed = JSON.parse(item.text) as Record<string, unknown>;
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return item;
            if (parsed.routing !== undefined) return item;
            const withRouting = {
              ...parsed,
              routing: {
                mode: routing.mode,
                backend: routing.backend ?? null,
                success: routing.success,
                durationMs: routing.durationMs,
              },
            };
            return { ...item, text: JSON.stringify(withRouting, null, 2) };
          } catch {
            return item;
          }
        }),
      };
    };

    // Create the tool executor function that contains all the switch logic
    const toolExecutor = async (
      name: string,
      args: Record<string, unknown>
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }> => {
      // Ensure workspace is initialized from client before processing tool calls
      if (!this.workspaceInitialized) {
        await this.initializeWorkspaceFromClient();
      }

      const startMs = Date.now();
      const includeRoutingMeta = args?.includeRouting === true;
      const routingHeadBefore = includeRoutingMeta ? getRoutingLogs()[0] : undefined;
      this.pendingToolCalls += 1;

      // Check if tool is enabled via tool groups
      if (!this.config.isToolEnabled(name)) {
        const toolGroup = TOOL_GROUP_MAPPING[name] || 'unknown';
        const errorMessage = `Tool '${name}' is disabled.`;
        const result = {
          content: [
            {
              type: 'text',
              text: `Error: Tool '${name}' is disabled. It belongs to the '${toolGroup}' group which is not enabled in the current configuration. Current mode: ${this.config.getConfig().toolGroups?.activeMode || 'DEVELOPMENT'}.`,
            },
          ],
          isError: true,
        };
        const durationMs = Date.now() - startMs;
        this.recordToolCall(name, durationMs, true, errorMessage);
        const routing = resolveRoutingMeta(name, routingHeadBefore, {
          mode: 'direct-llm',
          backend: 'local-llm',
          success: false,
          durationMs,
          error: errorMessage,
        });
        this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
        return attachRoutingToResult(result, routing, includeRoutingMeta);
      }

      // Early enum validation - provides better error messages than zod
      const enumValidationError = validateAllEnumParams(name, args);
      if (enumValidationError) {
        const result = {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(enumValidationError, null, 2),
            },
          ],
          isError: true,
        };
        const durationMs = Date.now() - startMs;
        this.recordToolCall(name, durationMs, true, enumValidationError.message);
        const routing = resolveRoutingMeta(name, routingHeadBefore, {
          mode: 'direct-llm',
          backend: 'local-llm',
          success: false,
          durationMs,
          error: enumValidationError.message,
        });
        this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
        return attachRoutingToResult(result, routing, includeRoutingMeta);
      }

      try {
        const result = await (async () => {
          switch (name) {
            // ============================================
            // Core Summary Tools (CONSOLIDATED)
            // ============================================
            case 'summarize': {
              const schema = z.object({
                action: z.enum(['path', 'repo']),
                path: z.string().optional(),
                root: z.string().optional(),
                mode: z.enum(['compact', 'extended']).optional(),
              });
              const parsed = schema.parse(args);
              let result;
              if (parsed.action === 'path') {
                if (!parsed.path) throw new Error('path is required for action=path');
                result = await this.summarization.summarizePath(
                  parsed.path,
                  parsed.mode || 'compact'
                );
              } else {
                // Default to workspace root for better UX (small models often omit root)
                const root = parsed.root ?? '.';
                result = await this.summarization.summarizeRepo(root, parsed.mode || 'compact');
              }
              return {
                content: [
                  { type: 'text', text: JSON.stringify(SummarySchema.parse(result), null, 2) },
                ],
              };
            }

            // ============================================
            // Core Discovery Tools
            // ============================================
            case 'discover_tools': {
              const schema = z.object({
                category: z
                  .enum([
                    'code_analysis',
                    'security',
                    'testing',
                    'documentation',
                    'refactoring',
                    'planning',
                    'search',
                    'llm_assistance',
                    'execution',
                    'workspace',
                    'system',
                  ])
                  .optional(),
                capability: z.string().optional(),
                list_categories: z.boolean().optional(),
                include_examples: z.boolean().optional(), // V10: Include example payloads
              });
              const parsed = schema.parse(args);

              // V9: Fire-and-forget AGENTS.md auto-generation on tool discovery
              void this.ensureAgentsMdExists();

              // Get all available tools from getAllToolDefinitions
              const allTools = this.getAllToolDefinitions();

              // Define category mappings for discover_tools (exclude agent-only tools)
              const CATEGORY_MAPPINGS: Record<string, string[]> = Object.fromEntries(
                Object.entries(TOOL_CATEGORIES).map(([key, value]) => [key, [...value.tools]])
              );

              // V10: Example payloads for core + discoverable tools (addresses v6 feedback: missing tool schemas)
              const TOOL_EXAMPLES: Record<
                string,
                { description: string; example: Record<string, unknown> }
              > = {
                // Core tools
                search: {
                  description: 'Search code or filenames (root defaults to ".").',
                  example: { action: 'intelligent', query: 'authentication logic', maxResults: 20 },
                },
                analyze_file: {
                  description: 'Analyze one file with optional targeted question.',
                  example: {
                    path: 'src/index.ts',
                    question: 'What is the main purpose?',
                    includeContent: false,
                  },
                },
                suggest_edit: {
                  description: 'Suggest focused edits for one file.',
                  example: { file_path: 'src/utils.ts', intent: 'Add error handling to fetch' },
                },
                // generate_tests - REMOVED (V21 QA_feedback_8: unreliable output quality)
                security: {
                  description:
                    'Security actions: scan, risk, redact, fix. scan returns coverage guidance when scope is narrow.',
                  example: {
                    action: 'scan',
                    root: '.',
                    scanType: 'secrets',
                    include: ['**/*.ts', '**/*.env*'],
                  },
                },
                local_code_review: {
                  description: 'Review one or more files for issues.',
                  example: { paths: ['src/auth.ts'], focus: 'security' },
                },
                summarize: {
                  description: 'Summarize path or repository.',
                  example: { action: 'path', path: 'src/', mode: 'compact' },
                },
                agent_task: {
                  description: 'Autonomous task runner for multi-step work.',
                  example: {
                    task: 'Find TODO comments and summarize',
                    readOnly: true,
                    maxSteps: 5,
                  },
                },
                orchestration: {
                  description: 'Check/update settings or run read-only routing simulation.',
                  example: { action: 'simulate', toolName: 'analyze_file' },
                },
                mcp_health: {
                  description:
                    'Health diagnostics; healthy when any backend works and shows active backends.',
                  example: { includeDetails: true },
                },
                discover_tools: {
                  description: 'Find tools and inspect callable/requiredArgs metadata.',
                  example: { category: 'security', include_examples: true },
                },
                workspace: {
                  description: 'Inspect workspace structure quickly.',
                  example: { mode: 'snapshot', path: '.', maxDepth: 2 },
                },
                // Discoverable tools
                codebase_qa: {
                  description: 'Ask a focused codebase question.',
                  example: { question: 'How does authentication work?', root: '.' },
                },
                todos: {
                  description: 'Find or implement TODO/FIXME markers.',
                  example: { action: 'find', root: '.' },
                },
                find_duplicates: {
                  description: 'Find duplicate/similar files or code spans.',
                  example: { findType: 'code', minSimilarity: 0.8, maxResults: 10 },
                },
                code_helper: {
                  description: 'Explain or optimize a code snippet.',
                  example: { action: 'explain', code: 'const x = arr.reduce((a,b) => a+b, 0)' },
                },
                regex_helper: {
                  description: 'Explain a regex or generate one.',
                  example: {
                    action: 'explain',
                    pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
                  },
                },
                linter: {
                  description: 'Run lint checks or fixes.',
                  example: { action: 'run', files: ['src/'] },
                },
              };

              // Agent-only tools (hidden from discover_tools categories)
              const AGENT_ONLY_TOOL_NAMES = new Set(AGENT_ONLY_TOOLS);
              const AGENT_ONLY_DIRECT_CALL = new Set(AGENT_ONLY_DIRECT_CALL_TOOLS);

              const getRequiredArgs = (inputSchema: JSONSchema | undefined): string[] => {
                const required =
                  inputSchema && typeof inputSchema === 'object'
                    ? (inputSchema as { required?: unknown }).required
                    : undefined;
                if (!Array.isArray(required)) return [];
                return required.filter((v): v is string => typeof v === 'string' && v.length > 0);
              };

              // Helper to get example for a tool
              const getToolWithExample = (t: {
                name: string;
                description: string;
                inputSchema?: JSONSchema;
              }) => {
                const example = TOOL_EXAMPLES[t.name];
                const isAgentOnly = AGENT_ONLY_TOOL_NAMES.has(t.name);
                const directCallAllowed = AGENT_ONLY_DIRECT_CALL.has(t.name);
                const isEnabled = this.config.isToolEnabled(t.name);
                // V17: Add callable and accessMethod fields for clearer LLM guidance
                // Addresses QA feedback: "unclear if tools can be called directly or only via agent_task"
                const result: {
                  name: string;
                  description: string;
                  example?: Record<string, unknown>;
                  agentOnly?: boolean;
                  enabled: boolean;
                  callable: boolean;
                  requiredArgs: string[];
                  accessMethod: 'direct' | 'agent_task';
                  note?: string;
                } = {
                  name: t.name,
                  description: t.description,
                  enabled: isEnabled,
                  callable: isEnabled && (isAgentOnly ? directCallAllowed : true),
                  requiredArgs: getRequiredArgs(t.inputSchema),
                  accessMethod: isAgentOnly && !directCallAllowed ? 'agent_task' : 'direct',
                };
                if (example && parsed.include_examples) {
                  result.example = example.example;
                }
                if (!isEnabled) {
                  const group = TOOL_GROUP_MAPPING[t.name] || 'unknown';
                  result.note = `[DISABLED] Tool group '${group}' is not enabled in the current configuration.`;
                } else if (isAgentOnly) {
                  result.agentOnly = true;
                  result.note = directCallAllowed
                    ? '[AGENT-ONLY] Hidden from ListTools but callable directly by name.'
                    : '[AGENT USE ONLY] Not callable directly. Use agent_task to delegate.';
                }
                return result;
              };

              if (parsed.list_categories) {
                // F3-004: Include per-tool agentOnly metadata in list_categories response
                const toolByName = new Map(allTools.map((t) => [t.name, t] as const));
                const categories = Object.entries(CATEGORY_MAPPINGS).map(([cat, toolNames]) => {
                  const toolsInCategory = toolNames
                    .filter((t) => allTools.some((at) => at.name === t))
                    .filter((t) => !AGENT_ONLY_TOOL_NAMES.has(t))
                    .map((toolName) => {
                      const toolDef = toolByName.get(toolName);
                      if (!toolDef) return null;
                      const metadata = getToolWithExample(toolDef);
                      return {
                        name: toolName,
                        enabled: metadata.enabled,
                        callable: metadata.callable,
                        requiredArgs: metadata.requiredArgs,
                      };
                    })
                    .filter(
                      (
                        tool
                      ): tool is {
                        name: string;
                        enabled: boolean;
                        callable: boolean;
                        requiredArgs: string[];
                      } => tool !== null
                    );
                  return {
                    name: cat,
                    toolCount: toolsInCategory.length,
                    tools: toolsInCategory,
                  };
                });
                return {
                  content: [
                    { type: 'text', text: JSON.stringify({ success: true, categories }, null, 2) },
                  ],
                };
              }

              if (parsed.category) {
                const toolNamesInCategory = CATEGORY_MAPPINGS[parsed.category] || [];
                const tools = allTools
                  .filter((t) => toolNamesInCategory.includes(t.name))
                  .filter((t) => !AGENT_ONLY_TOOL_NAMES.has(t.name))
                  .map((t) => getToolWithExample(t));
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          category: parsed.category,
                          tools,
                          toolCount: tools.length,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              if (parsed.capability) {
                // Word-based keyword search with scoring
                const queryWords = parsed.capability
                  .toLowerCase()
                  .split(/\s+/)
                  .filter((w) => w.length > 2);
                const results: Array<{
                  tool: { name: string; description: string };
                  score: number;
                }> = [];

                for (const t of allTools) {
                  if (AGENT_ONLY_TOOL_NAMES.has(t.name)) continue;
                  let score = 0;
                  const nameLower = t.name.toLowerCase();
                  const descLower = t.description.toLowerCase();

                  // Check for word matches
                  for (const word of queryWords) {
                    if (nameLower.includes(word)) score += 10;
                    if (descLower.includes(word)) score += 5;
                    // Check name parts (e.g., "find_duplicates" -> ["find", "duplicates"])
                    const nameParts = t.name.split('_');
                    for (const part of nameParts) {
                      if (part.toLowerCase().includes(word) || word.includes(part.toLowerCase())) {
                        score += 3;
                      }
                    }
                  }

                  if (score > 0) {
                    results.push({ tool: { name: t.name, description: t.description }, score });
                  }
                }

                // Sort by score and take top results
                const tools = results
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 15)
                  .map((r) => getToolWithExample(r.tool));

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          query: parsed.capability,
                          tools,
                          matchCount: tools.length,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              // V12: No filter - return tool summary with agentOnly metadata for programmatic discovery
              const toolSummary = allTools
                .filter((t) => !AGENT_ONLY_TOOL_NAMES.has(t.name))
                .map((t) => {
                  const isAgentOnly = AGENT_ONLY_TOOL_NAMES.has(t.name);
                  return {
                    name: t.name,
                    description: t.description.split('.')[0] + '.', // First sentence only for brevity
                    agentOnly: isAgentOnly,
                    ...(isAgentOnly ? { note: 'Use agent_task to access' } : {}),
                  };
                });

              // Count by tier
              const agentOnlyCount = AGENT_ONLY_TOOL_NAMES.size;
              const exposedCount = toolSummary.length;

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        success: true,
                        toolCount: toolSummary.length,
                        tiers: {
                          exposed: exposedCount,
                          agentOnly: agentOnlyCount,
                        },
                        tools: toolSummary,
                        usage: {
                          list_categories: 'Set to true to see all categories',
                          category: 'Filter by category (e.g., "security", "testing")',
                          capability: 'Describe what you need (e.g., "find duplicate code")',
                          include_examples: 'Set to true to include example payloads for each tool',
                        },
                        availableCategories: Object.keys(CATEGORY_MAPPINGS),
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            // Backward compatibility aliases
            case 'summarize_path': {
              const schema = z.object({ path: z.string(), mode: z.enum(['compact', 'extended']) });
              const parsed = schema.parse(args);
              const result = await this.summarization.summarizePath(parsed.path, parsed.mode);
              return {
                content: [
                  { type: 'text', text: JSON.stringify(SummarySchema.parse(result), null, 2) },
                ],
              };
            }

            case 'summarize_repo': {
              const schema = z.object({ root: z.string(), mode: z.enum(['compact', 'extended']) });
              const parsed = schema.parse(args);
              const result = await this.summarization.summarizeRepo(parsed.root, parsed.mode);
              return {
                content: [
                  { type: 'text', text: JSON.stringify(SummarySchema.parse(result), null, 2) },
                ],
              };
            }

            // ============================================
            // Core Chat Tools
            // ============================================
            case 'llm_chat': {
              const schema = z.object({
                backendRole: z.enum(['local', 'sota']),
                messages: z.array(
                  z.object({
                    role: z.enum(['system', 'user', 'assistant']),
                    content: z.string(),
                  })
                ),
                options: z
                  .object({
                    model: z.string().optional(),
                    temperature: z.number().min(0).max(2).optional(),
                    max_tokens: z.number().optional(),
                  })
                  .optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmChat.chat(parsed, parsed.backendRole);
              return {
                content: [
                  { type: 'text', text: JSON.stringify(ChatResponseSchema.parse(result), null, 2) },
                ],
              };
            }

            // ============================================
            // System Info Tools
            // ============================================
            case 'system_profile': {
              if (!this.config.getConfig().systemProfile.exposeToLLM) {
                throw new Error('system_profile tool is disabled in configuration');
              }
              const schema = z
                .object({ detail: z.enum(['basic', 'extended']).optional() })
                .optional();
              schema.parse(args);
              const profile = await this.systemProfiler.getSystemProfile();
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(SystemProfileSchema.parse(profile), null, 2),
                  },
                ],
              };
            }

            case 'model_info': {
              const schema = z.object({
                action: z.enum(['list', 'analyze', 'check_task', 'recommend']),
                backendId: z.string().optional(),
                modelId: z.string().optional(),
                modelName: z.string().optional(),
                taskType: z.string().optional(),
              });
              const parsed = schema.parse(args);
              return await handleModelInfoTool(this.modelInfoTool, parsed);
            }

            case 'mcp_health': {
              const schema = z.object({
                includeDetails: z.boolean().optional(),
                format: z.enum(['compact', 'dense', 'detailed', 'json']).optional(),
              });
              const parsed = schema.parse(args);

              // V9: Fire-and-forget AGENTS.md auto-generation on health checks
              void this.ensureAgentsMdExists();

              const queue = this.getAgentQueue();
              const queueStatus = queue.getStatus();

              const uptimeSeconds = process.uptime();
              const formatUptime = (seconds: number): string => {
                const total = Math.max(0, Math.floor(seconds));
                const days = Math.floor(total / 86400);
                const hours = Math.floor((total % 86400) / 3600);
                const minutes = Math.floor((total % 3600) / 60);
                const secs = total % 60;
                const parts: string[] = [];
                if (days) parts.push(`${days}d`);
                if (hours || parts.length) parts.push(`${hours}h`);
                if (minutes || parts.length) parts.push(`${minutes}m`);
                parts.push(`${secs}s`);
                return parts.join(' ');
              };

              const cfg = this.config.getConfig();
              const configuredServers = this.mcpClient.getConfiguredServers();
              const connectedServers = this.mcpClient.getConnectedServers();

              // V16: Extract active model name for mcp_health (QA_feedback_1.md: GPT-5.2 requested this)
              // Allows users to see active model without using agentOnly model_info tool
              const localBackend = Array.isArray(cfg.backends)
                ? cfg.backends.find((b: any) => b.id === cfg.defaults?.localBackendId)
                : null;
              const activeModel =
                (localBackend as any)?.model ?? (localBackend as any)?.id ?? 'unknown';

              // QA_feedback_9: Check model loading status for better error messages
              const probeResults = await this.backendManager.probeAll();
              const healthFromProbes = computeMcpHealthFromProbes({
                probeResults,
                defaultLocalBackendId: cfg.defaults?.localBackendId ?? null,
              });
              const activeBackendIds = new Set(healthFromProbes.workingBackendNames);

              // Check embedding model availability for 'degraded' status
              const envSettings = this.config.getEnvSettings();
              const embeddingModel = envSettings.advanced?.embeddingModel;
              const embeddingBackendUrl =
                envSettings.advanced?.embeddingBackendUrl || 'http://127.0.0.1:1234';
              let embeddingAvailable = true;
              let embeddingError: string | undefined;

              if (embeddingModel) {
                // If embedding model is configured, check if its backend is reachable
                try {
                  const embeddingResponse = await fetch(`${embeddingBackendUrl}/v1/models`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(2000),
                  });
                  embeddingAvailable = embeddingResponse.ok;
                  if (!embeddingAvailable) {
                    embeddingError = `Embedding backend at ${embeddingBackendUrl} returned ${embeddingResponse.status}`;
                  }
                } catch {
                  embeddingAvailable = false;
                  embeddingError = `Embedding backend at ${embeddingBackendUrl} is not reachable`;
                }
              }

              let healthStatus: 'healthy' | 'degraded';
              let modelWarning: string | undefined;
              let nextSteps: string[] | undefined;

              if (healthFromProbes.status === 'degraded') {
                healthStatus = 'degraded';
                modelWarning = healthFromProbes.warning;
                nextSteps = healthFromProbes.nextSteps;
              } else if (embeddingModel && !embeddingAvailable) {
                healthStatus = 'degraded';
                modelWarning =
                  `LLM backend operational (${healthFromProbes.workingBackendNames.join(', ')}). ` +
                  `Semantic memory features unavailable: ${embeddingError}`;
                nextSteps = [
                  'Core LLM tools are fully functional',
                  `To enable semantic memory: ensure embedding model is loaded at ${embeddingBackendUrl}`,
                ];
              } else {
                healthStatus = 'healthy';
              }

              const payload: Record<string, unknown> = {
                success: true,
                status: healthStatus,
                healthy: healthFromProbes.healthy,
                uptime: uptimeSeconds,
                uptimeSeconds,
                uptimeFormatted: formatUptime(uptimeSeconds),
                // V16: Include active model name at top level (QA_feedback_1.md)
                activeModel,
                // QA_feedback_11: Include embedding model status
                embeddingModel: embeddingModel || null,
                embeddingAvailable,
                llmAvailable: healthFromProbes.llmAvailable,
                defaultLocalBackendHealthy: healthFromProbes.defaultLocalBackendHealthy,
                availableBackends: healthFromProbes.workingBackendNames,
                unavailableBackends: healthFromProbes.backendIssues,
                // QA_feedback_9/10: Include model loading warnings and actionable next steps
                ...(modelWarning
                  ? {
                      warning: modelWarning,
                      backendIssues: healthFromProbes.backendIssues,
                      nextSteps,
                    }
                  : {}),
                queue: {
                  running: queueStatus.running,
                  queued: queueStatus.queued,
                  maxConcurrent: queueStatus.maxConcurrent,
                },
                llmBackend: {
                  localBackendId: cfg.defaults?.localBackendId ?? null,
                  sotaBackendId: cfg.defaults?.sotaBackendId ?? null,
                  activeModel, // Also include in llmBackend section for consistency
                  configuredBackendCount: Array.isArray(cfg.backends) ? cfg.backends.length : 0,
                  backends: Array.isArray(cfg.backends)
                    ? cfg.backends
                        .filter((b) => activeBackendIds.has(b.id))
                        .map((b) => ({ id: b.id, type: (b as any).type, model: (b as any).model }))
                    : [],
                },
                externalMcp: {
                  configured: configuredServers,
                  connected: connectedServers,
                  configuredCount: configuredServers.length,
                  connectedCount: connectedServers.length,
                },
                // V19 (QA_feedback_22012026): Expose webUiUrl for orchestration visibility
                // Addresses: "No webUiUrl in mcp_health response" - enables clients to access Web UI
                // Uses cfg.server (from main config) since envSettings doesn't have http field
                webUiUrl: cfg.server?.port
                  ? `http://${cfg.server.host || '127.0.0.1'}:${cfg.server.port}`
                  : null,
                // V20: Orchestration status indicators (QA_feedback_27012026: unified flag)
                // - orchestrationEnabled: true when CLI orchestration is enabled (users care about this)
                // - cliOrchestrationEnabled: deprecated, same as orchestrationEnabled
                // - legacyToolGroupMode: used internally for tool grouping (rarely changed)
                orchestrationEnabled: envSettings.advanced?.cliOrchestrationEnabled ?? false,
                cliOrchestrationEnabled: envSettings.advanced?.cliOrchestrationEnabled ?? false,
                legacyToolGroupMode: envSettings.advanced?.toolGroupMode || 'DEVELOPMENT',
              };

              if (parsed.includeDetails) {
                payload.queueDetails = queueStatus;
                payload.queueStats = queue.getStats();
                payload.llmCache = this.llmChat.getCacheStats();
                payload.llmConcurrency = this.llmChat.getConcurrencyStatus();
                const totals = this.toolCallTotals;
                const aggregate = Object.values(totals).reduce(
                  (acc, v) => {
                    acc.calls += v.calls;
                    acc.errors += v.errors;
                    acc.totalDurationMs += v.totalDurationMs;
                    return acc;
                  },
                  { calls: 0, errors: 0, totalDurationMs: 0 }
                );
                payload.logging = {
                  totalRequests: aggregate.calls,
                  errorRequests: aggregate.errors,
                  avgDurationMs: aggregate.calls ? aggregate.totalDurationMs / aggregate.calls : 0,
                  pendingRequests: this.pendingToolCalls,
                  byTool: totals,
                  recent: this.recentToolCalls,
                };
                // V21 (QA_feedback_8): Add routing logs for orchestration visibility
                // This allows LLMs to verify that orchestration routing is working
                payload.routing = {
                  logs: getRoutingLogs(),
                  stats: getRoutingStats(),
                };
                payload.version = '1.0.0';
                payload.serverStartTime = new Date(this.startedAtMs).toISOString();
                payload.toolCalls = {
                  totals: this.toolCallTotals,
                  recent: this.recentToolCalls,
                };
                try {
                  const debugSummary = getDebugLogger().getSummary();
                  // Keep health responses compact and avoid exposing stack traces in summary payloads.
                  payload.debug = {
                    ...debugSummary,
                    recentErrors: Array.isArray(debugSummary.recentErrors)
                      ? debugSummary.recentErrors.map((entry) => {
                          const e = entry as unknown as { stack?: unknown } & Record<
                            string,
                            unknown
                          >;
                          const withoutStack = Object.fromEntries(
                            Object.entries(e).filter(([key]) => key !== 'stack')
                          );
                          return withoutStack;
                        })
                      : [],
                  };
                } catch {
                  // Ignore debug logger errors
                }
                payload.process = {
                  pid: process.pid,
                  node: process.version,
                  memory: process.memoryUsage(),
                  startedAt: new Date(this.startedAtMs).toISOString(),
                };
              }

              // Apply output format
              const outputFormat = parsed.format as OutputFormat | undefined;
              const formattedResult = formatOutput(payload, outputFormat);

              return {
                content: [
                  {
                    type: 'text',
                    text:
                      typeof formattedResult === 'string'
                        ? formattedResult
                        : JSON.stringify(formattedResult, null, 2),
                  },
                ],
              };
            }

            case 'mcp_debug': {
              const schema = z.object({
                action: z.enum(['errors', 'logs', 'summary', 'clear']).optional(),
                level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional(),
                category: z
                  .enum(['mcp', 'agent', 'queue', 'client', 'server', 'llm', 'general'])
                  .optional(),
                count: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const action = parsed.action || 'summary';
              const count = parsed.count ?? 20;

              const logger = getDebugLogger();

              if (action === 'clear') {
                logger.clear();
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        { success: true, action: 'clear', message: 'Debug logs cleared.' },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              if (action === 'errors') {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        { success: true, action: 'errors', errors: logger.getErrors(count) },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              if (action === 'logs') {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          action: 'logs',
                          logs: logger.getRecentLogs(count, parsed.level, parsed.category),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      { success: true, action: 'summary', summary: logger.getSummary() },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            // ============================================
            // Planning Tools
            // ============================================
            case 'verify_plan': {
              const schema = z.object({
                plan_id: z.string().optional(),
                context_root: z.string(),
                steps: z.array(
                  z.object({
                    id: z.string(),
                    title: z.string(),
                    description: z.string(),
                    targets: z.array(z.string()),
                  })
                ),
                mode: z.enum(['quick', 'deep']),
              });
              const parsed = schema.parse(args);
              const result = await this.verifyPlan.verifyPlan(parsed);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(VerifyPlanResponseSchema.parse(result), null, 2),
                  },
                ],
              };
            }

            case 'agent_task': {
              const rawArgs =
                args && typeof args === 'object' && !Array.isArray(args)
                  ? ({ ...(args as Record<string, unknown>) } as Record<string, unknown>)
                  : ({} as Record<string, unknown>);

              const validTopLevelParams = [
                'task',
                'prompt',
                'description',
                'background',
                'options',
                'contextRoot',
                'context_root',
                'root',
                'maxSubtasks',
                'maxSteps',
                'maxActionsPerStep',
                'allowMcpServers',
                'allowedActions',
                'autoConnectMcp',
                'async',
                'dryRun',
                'readOnly',
                'max_steps',
                'max_actions',
                'dry_run',
                'read_only',
                'planOnly',
                'plan_only',
                'toolsAllowed',
                'tools_allowed',
                'useCliOrchestration',
                'use_cli_orchestration',
              ];

              const structuredParamError = getStructuredParamError(rawArgs, validTopLevelParams);
              if (structuredParamError) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: JSON.stringify(structuredParamError) }],
                };
              }

              const rawTaskValue = rawArgs.task ?? rawArgs.prompt;
              if (rawTaskValue !== undefined && typeof rawTaskValue !== 'string') {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: false,
                        errorType: 'invalid_type',
                        message: `Invalid type for 'task': expected string, received ${typeof rawTaskValue}`,
                        hint: 'Provide a non-empty task string describing what you want to accomplish.',
                        example: { task: 'List all TODO comments in the codebase' },
                        validParameters: validTopLevelParams,
                      }),
                    },
                  ],
                };
              }

              const boolish = z.preprocess((value) => {
                if (typeof value !== 'string') return value;
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true') return true;
                if (normalized === 'false') return false;
                return value;
              }, z.boolean());

              const numberish = z.preprocess((value) => {
                if (typeof value !== 'string') return value;
                const normalized = value.trim();
                if (!normalized) return value;
                const parsed = Number(normalized);
                return Number.isFinite(parsed) ? parsed : value;
              }, z.number());

              const optionsSchema = z.object({
                contextRoot: z.string().optional(),
                maxSubtasks: numberish.optional(),
                maxSteps: numberish.optional(),
                maxActionsPerStep: numberish.optional(),
                timeoutMs: numberish.optional(),
                allowMcpServers: z.array(z.string()).optional(),
                allowedActions: z.array(z.string()).optional(),
                autoConnectMcp: boolish.optional(),
                async: boolish.optional(),
                dryRun: boolish.optional(),
                planOnly: boolish.optional(),
                plan_only: boolish.optional(),
                readOnly: boolish.optional(),
                useCliOrchestration: boolish.optional(),
              });

              const schema = z.object({
                task: z.string().optional(),
                // Common alias: some callers send `prompt` instead of `task`
                prompt: z.string().optional(),
                // Optional metadata (accepted for compatibility; not used by executor)
                description: z.string().optional(),
                background: boolish.optional(),
                options: z
                  .preprocess((value) => {
                    if (typeof value !== 'string') return value;
                    try {
                      return JSON.parse(value) as unknown;
                    } catch {
                      return value;
                    }
                  }, optionsSchema)
                  .optional(),

                // Backward-compatible top-level options
                contextRoot: z.string().optional(),
                context_root: z.string().optional(),
                root: z.string().optional(),
                maxSubtasks: numberish.optional(),
                maxSteps: numberish.optional(),
                maxActionsPerStep: numberish.optional(),
                timeoutMs: numberish.optional(),
                allowMcpServers: z.array(z.string()).optional(),
                allowedActions: z.array(z.string()).optional(),
                autoConnectMcp: boolish.optional(),
                async: boolish.optional(),
                dryRun: boolish.optional(),
                readOnly: boolish.optional(),

                // Common aliases observed in the wild
                max_steps: numberish.optional(),
                max_actions: numberish.optional(),
                timeout_ms: numberish.optional(),
                dry_run: boolish.optional(),
                read_only: boolish.optional(),
                planOnly: boolish.optional(),
                plan_only: boolish.optional(),
                toolsAllowed: z.array(z.string()).optional(),
                tools_allowed: z.array(z.string()).optional(),

                // CLI orchestration option
                useCliOrchestration: boolish.optional(),
                use_cli_orchestration: boolish.optional(),
              });
              const parsed = schema.parse(rawArgs);

              const opt = parsed.options ?? {};

              const task = parsed.task ?? parsed.prompt;
              if (task === undefined) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: false,
                        errorType: 'validation_error',
                        message: "Missing required field: 'task'",
                        hint: 'Provide a non-empty task string describing what you want to accomplish.',
                        example: { task: 'List all TODO comments in the codebase' },
                        validParameters: validTopLevelParams,
                        issues: [
                          {
                            path: 'task',
                            message: 'Required field',
                            code: 'required',
                          },
                        ],
                      }),
                    },
                  ],
                };
              }
              if (!String(task).trim()) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        success: false,
                        errorType: 'empty_task',
                        message: 'Task cannot be empty or whitespace only',
                        hint: 'The task parameter must be a non-empty string.',
                        example: { task: 'Search the repo for TODO comments' },
                        validParameters: validTopLevelParams,
                      }),
                    },
                  ],
                };
              }

              const warnings: string[] = [];
              const contextRootRaw =
                opt.contextRoot ??
                parsed.contextRoot ??
                parsed.context_root ??
                parsed.root ??
                this.config.getDefaultWorkspaceRoot();
              let contextRoot = this.config.getDefaultWorkspaceRoot();
              try {
                contextRoot = this.config.resolveWorkspacePath(String(contextRootRaw));
              } catch {
                warnings.push(
                  `Invalid contextRoot '${String(contextRootRaw)}' (outside workspace). Falling back to default workspace root.`
                );
              }
              const maxSubtasks = opt.maxSubtasks ?? parsed.maxSubtasks;

              // V16: Allow maxSteps up to 100 with warning, support -1 for unlimited when queue is empty
              // QA_feedback_1.md: All 7 testers requested higher default (now 50) and unlimited option
              let maxSteps = opt.maxSteps ?? parsed.maxSteps ?? parsed.max_steps;
              const queue = this.getAgentQueue();
              const queueStatus = queue.getStatus();
              const queueIsEmpty = queueStatus.running === 0 && queueStatus.queued === 0;

              if (maxSteps !== undefined) {
                // Handle "unlimited" as -1 when queue is empty
                if (maxSteps === -1 || maxSteps > 100) {
                  if (queueIsEmpty) {
                    // Allow high/unlimited steps when no other tasks are running
                    const effectiveMax = maxSteps === -1 ? 500 : Math.min(maxSteps, 500);
                    warnings.push(
                      `maxSteps=${maxSteps === -1 ? 'unlimited' : maxSteps} → using ${effectiveMax} (queue is empty, no concurrency risk).`
                    );
                    maxSteps = effectiveMax;
                  } else {
                    warnings.push(
                      `maxSteps capped at 100 (requested: ${maxSteps}) because other tasks are queued. Use maxSteps=-1 when queue is empty for unlimited.`
                    );
                    maxSteps = 100;
                  }
                } else if (maxSteps > 50) {
                  warnings.push(
                    `maxSteps=${maxSteps} may result in longer execution times (default: 50). Consider breaking into smaller tasks if timeouts occur.`
                  );
                }
              }

              const maxActionsPerStep =
                opt.maxActionsPerStep ?? parsed.maxActionsPerStep ?? parsed.max_actions;

              const effectiveMaxSubtasks = maxSubtasks ?? 8;
              const effectiveMaxSteps = maxSteps ?? 50;
              const effectiveMaxActionsPerStep = maxActionsPerStep ?? 100;

              // toolsAllowed is ambiguous; treat as allowedActions if it looks like actionType names, otherwise as allowMcpServers.
              const toolsAllowed = parsed.toolsAllowed ?? parsed.tools_allowed;
              const toolsAllowedLower = (toolsAllowed || []).map((s) => String(s).toLowerCase());
              const looksLikeActions = toolsAllowedLower.some(
                (s) => s.includes('search') || s.includes('read') || s.includes('mcp_')
              );

              const allowMcpServers =
                opt.allowMcpServers ??
                parsed.allowMcpServers ??
                (toolsAllowed && !looksLikeActions ? toolsAllowed : undefined);

              const allowedActions =
                opt.allowedActions ??
                parsed.allowedActions ??
                (toolsAllowed && looksLikeActions ? toolsAllowed : undefined);

              const autoConnectMcp = opt.autoConnectMcp ?? parsed.autoConnectMcp;
              const defaultTimeoutMs =
                this.config.getEnvSettings().advanced?.agentTimeoutMs ?? 300000;
              const timeoutMsRaw =
                opt.timeoutMs ??
                (parsed as any).timeoutMs ??
                (parsed as any).timeout_ms ??
                defaultTimeoutMs;
              const parsedTimeoutMs = Number(timeoutMsRaw);
              const effectiveTimeoutMs = Number.isFinite(parsedTimeoutMs)
                ? Math.max(1000, Math.min(parsedTimeoutMs, 3600000))
                : defaultTimeoutMs;
              const dryRun =
                opt.dryRun ??
                opt.planOnly ??
                opt.plan_only ??
                parsed.dryRun ??
                parsed.dry_run ??
                parsed.planOnly ??
                parsed.plan_only;

              const readOnlyRaw = opt.readOnly ?? parsed.readOnly ?? parsed.read_only;
              const inferredReadOnly =
                readOnlyRaw === undefined && inferReadOnlyFromTaskText(String(task));
              const readOnly = readOnlyRaw !== undefined ? readOnlyRaw : inferredReadOnly;

              // CLI Orchestration option - use CLI tools (OpenCode, Copilot) for execution
              // V21 (QA_feedback_29012026): Default to CLI_ORCHESTRATION_ENABLED setting, not hardcoded false
              // V23: Bypass CLI orchestration for dryRun/planOnly to avoid CLI dependencies in planning mode
              const cliOrchestrationSetting =
                this.config.getEnvSettings().advanced?.cliOrchestrationEnabled ?? false;
              const cliOrchestrationRequested =
                opt.useCliOrchestration ??
                parsed.useCliOrchestration ??
                parsed.use_cli_orchestration ??
                cliOrchestrationSetting;
              // When dryRun is true, bypass CLI orchestration and use local LLM for planning.
              // When readOnly is true, bypass CLI orchestration to prevent writes during execution.
              const useCliOrchestration = dryRun || readOnly ? false : cliOrchestrationRequested;
              if (dryRun && cliOrchestrationRequested) {
                console.log(
                  `[TOOL-ORCH:agent_task] dryRun=true, bypassing CLI orchestration for local LLM planning`
                );
              }
              if (readOnly && cliOrchestrationRequested) {
                warnings.push(
                  'readOnly=true bypasses CLI orchestration to prevent writes during execution.'
                );
              }

              const asyncMode = opt.async ?? parsed.async ?? parsed.background ?? false;
              // Note: queue already declared above for maxSteps unlimited check

              // V22 (QA_feedback_29012026): asyncMode MUST be checked FIRST to ensure immediate return
              // Previously, CLI orchestration blocked synchronously, breaking async behavior
              if (asyncMode) {
                const store = getAsyncTaskStore();
                const taskId = store.createTask(String(task), {
                  contextRoot,
                  maxSubtasks: effectiveMaxSubtasks,
                  maxSteps: effectiveMaxSteps,
                  maxActionsPerStep: effectiveMaxActionsPerStep,
                  allowMcpServers,
                  allowedActions,
                  autoConnectMcp,
                  dryRun,
                  readOnly,
                  inferredReadOnly,
                  timeoutMs: effectiveTimeoutMs,
                });

                const progressHandler = (event: any) => {
                  try {
                    if (!event || typeof event !== 'object') return;
                    const type = String((event as any).type || '');
                    if (!type) return;

                    if (type === 'task_start') {
                      store.addProgress(taskId, {
                        step: 0,
                        action: 'task_start',
                        status: 'running',
                      });
                      return;
                    }
                    if (type === 'plan_generated') {
                      store.addProgress(taskId, {
                        step: 0,
                        action: 'plan_generated',
                        status: 'running',
                        details: `subtasks=${(event as any).subtasks} steps=${(event as any).steps}`,
                      });
                      return;
                    }
                    if (type === 'step_start') {
                      store.addProgress(taskId, {
                        step: Number((event as any).index || 0),
                        totalSteps: (event as any).total ? Number((event as any).total) : undefined,
                        action: `step_start:${String((event as any).title || '')}`.slice(0, 120),
                        status: 'running',
                      });
                      return;
                    }
                    if (type === 'action') {
                      store.addProgress(taskId, {
                        step: 0,
                        action: `action:${String((event as any).actionType || '')}`.slice(0, 120),
                        status: (event as any).ok ? 'done' : 'error',
                      });
                      return;
                    }
                    if (type === 'task_end') {
                      store.addProgress(taskId, {
                        step: 0,
                        action: 'task_end',
                        status: (event as any).success ? 'done' : 'error',
                      });
                      return;
                    }

                    store.addProgress(taskId, {
                      step: 0,
                      action: type.slice(0, 120),
                      status: 'running',
                    });
                  } catch {
                    // Ignore progress tracking errors
                  }
                };

                // Start task in background (don't await), but still run through the queue for concurrency safety.
                // V22.1: CLI orchestration now works in async mode when enabled
                void queue
                  .enqueue(async () => {
                    store.startTask(taskId);

                    // Check if CLI orchestration should be used
                    if (useCliOrchestration) {
                      console.log(
                        `[TOOL-ORCH:agent_task] Routing to CLI orchestration (async) for task: ${String(task).substring(0, 100)}...`
                      );
                      const orchestrationResult = await this.orchestrationService.orchestrate(
                        String(task),
                        {
                          contextRoot,
                        }
                      );

                      // Convert OrchestrationResult to AgentTaskResult-compatible format for async store
                      const agentResult = {
                        success: orchestrationResult.success,
                        task: String(task),
                        contextRoot,
                        effectiveOptions: {
                          readOnly,
                          inferredReadOnly,
                          autoConnectMcp: autoConnectMcp ?? true,
                          maxSubtasks: effectiveMaxSubtasks,
                          maxSteps: effectiveMaxSteps,
                          maxActionsPerStep: effectiveMaxActionsPerStep,
                          allowMcpServers: allowMcpServers || [],
                          allowedActions,
                          writeAllowlistPaths: null,
                          dryRun,
                          timeoutMs: effectiveTimeoutMs,
                        },
                        plan: {
                          subtasks: [],
                        },
                        execution: [],
                        final: {
                          summary:
                            orchestrationResult.verification?.reasoning ||
                            'CLI orchestration completed',
                          notes: [
                            `CLI orchestration mode: ${orchestrationResult.success ? 'success' : 'failed'}`,
                            `Score: ${orchestrationResult.score}/10`,
                            `Plan ID: ${orchestrationResult.planId || 'N/A'}`,
                            ...(orchestrationResult.verification?.completedAreas || []),
                            ...(warnings.length ? warnings : []),
                          ],
                          metrics: {
                            plannedSteps: orchestrationResult.iterations || 1,
                            executedSteps: orchestrationResult.iterations || 1,
                            completedSteps: orchestrationResult.success
                              ? orchestrationResult.iterations || 1
                              : 0,
                            failedSteps: orchestrationResult.success ? 0 : 1,
                            skippedSteps: 0,
                            okActions: orchestrationResult.success ? 1 : 0,
                            failedActions: orchestrationResult.success ? 0 : 1,
                          },
                        },
                        mode: 'cli_orchestration',
                        orchestrationResult,
                      };
                      store.completeTask(taskId, agentResult);
                      return agentResult;
                    }

                    // Standard LM Studio execution
                    const result = await this.agentRunner.runTask(String(task), {
                      contextRoot,
                      maxSubtasks: effectiveMaxSubtasks,
                      maxSteps: effectiveMaxSteps,
                      maxActionsPerStep: effectiveMaxActionsPerStep,
                      allowMcpServers,
                      allowedActions,
                      autoConnectMcp,
                      dryRun,
                      readOnly,
                      timeoutMs: effectiveTimeoutMs,
                      onProgress: progressHandler,
                    });
                    if (warnings.length) {
                      result.final.notes = [...(result.final.notes || []), ...warnings];
                    }
                    store.completeTask(taskId, result);
                    return result;
                  }, `agent_task:${taskId}`)
                  .catch((error) => {
                    store.failTask(taskId, error instanceof Error ? error.message : String(error));
                  });

                const status = queue.getStatus();
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          async: true,
                          taskId,
                          status: 'queued',
                          effectiveOptions: {
                            dryRun: !!dryRun,
                            readOnly,
                            inferredReadOnly,
                            autoConnectMcp: autoConnectMcp ?? true,
                            maxSubtasks: effectiveMaxSubtasks,
                            maxSteps: effectiveMaxSteps,
                            maxActionsPerStep: effectiveMaxActionsPerStep,
                            timeoutMs: effectiveTimeoutMs,
                          },
                          queue: {
                            running: status.running,
                            queued: status.queued,
                            maxConcurrent: status.maxConcurrent,
                            estimatedWaitSeconds: status.estimatedWaitSeconds,
                          },
                          ...(warnings.length ? { warnings } : {}),
                          message:
                            'Task queued for background execution. Use agent_task_result({taskId}) to poll for completion.',
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              // V22: CLI orchestration for SYNC mode (only when useCliOrchestration=true and async=false)
              if (useCliOrchestration) {
                const orchestrationStatus = this.orchestrationService.getStatus();

                if (!orchestrationStatus.enabled) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            success: false,
                            error: 'CLI orchestration requested but not enabled in settings',
                            hint: 'Enable CLI orchestration in settings or via POST /api/settings/cli-orchestration/enable',
                            orchestrationStatus,
                          },
                          null,
                          2
                        ),
                      },
                    ],
                  };
                }

                if (orchestrationStatus.backends.length === 0) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            success: false,
                            error: 'No CLI backends selected for orchestration',
                            hint: 'Select at least one backend (opencode-cli or copilot-cli) in settings',
                            orchestrationStatus,
                          },
                          null,
                          2
                        ),
                      },
                    ],
                  };
                }

                console.log(
                  `[TOOL-ORCH:agent_task] Routing to CLI orchestration (sync) for task: ${String(task).substring(0, 100)}...`
                );

                const orchestrationResult = await this.orchestrationService.orchestrate(
                  String(task),
                  {
                    contextRoot,
                  }
                );

                // V22: Include task field for consistency with standard agent_task response
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          mode: 'cli_orchestration',
                          task: String(task),
                          ...orchestrationResult,
                          orchestrationStatus,
                          ...(warnings.length ? { warnings } : {}),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: !orchestrationResult.success,
                };
              }

              const result = await queue.enqueue(
                async () =>
                  await this.agentRunner.runTask(String(task), {
                    contextRoot,
                    maxSubtasks: effectiveMaxSubtasks,
                    maxSteps: effectiveMaxSteps,
                    maxActionsPerStep: effectiveMaxActionsPerStep,
                    allowMcpServers,
                    allowedActions,
                    autoConnectMcp,
                    dryRun,
                    readOnly,
                    timeoutMs: effectiveTimeoutMs,
                  }),
                'agent_task'
              );

              if (warnings.length) {
                result.final.notes = [...(result.final.notes || []), ...warnings];
              }

              // V10: Build synthesized answer for agent output (addresses v6 feedback)
              // Extract key findings from execution to provide a coherent answer, not just raw logs
              const synthesizedAnswer = this.buildAgentSynthesizedAnswer(result);

              // V10: Restructure output to put answer at top, avoiding duplicate fields
              const { success, task: resultTask, final, ...restResult } = result;
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        // V10: Put synthesized answer at the top for easy consumption
                        answer: synthesizedAnswer,
                        success,
                        task: resultTask,
                        summary: final.summary,
                        // Include metrics at top level for quick assessment
                        metrics: final.metrics,
                        // Keep full details below for those who need them
                        final,
                        ...restResult,
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: success !== true,
              };
            }

            case 'agent_queue_status': {
              const schema = z.object({
                action: z.enum(['status', 'reset']).optional(),
              });
              const parsed = schema.parse(args);
              const action = parsed.action || 'status';
              const queue = this.getAgentQueue();

              if (action === 'reset') {
                const result = queue.forceReset();
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          action: 'reset',
                          clearedRunning: result.clearedRunning,
                          clearedQueued: result.clearedQueued,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              const status = queue.getStatus();
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ success: true, ...status }, null, 2),
                  },
                ],
              };
            }

            case 'agent_task_result': {
              const schema = z.object({
                taskId: z.string(),
                includeProgress: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const store = getAsyncTaskStore();
              const includeProgress = parsed.includeProgress !== false;
              const result = store.getTaskResult(parsed.taskId);

              if (!result.found) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: false,
                          taskId: parsed.taskId,
                          status: 'not_found',
                          found: false,
                          message: `Task ${parsed.taskId} not found.`,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }

              const payload: any = {
                success: true,
                ...result,
              };
              if (!includeProgress) {
                delete payload.progress;
              }

              return {
                content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
                isError: result.status === 'failed' || result.status === 'timeout',
              };
            }

            case 'orchestration': {
              const schema = z.object({
                action: z
                  .enum([
                    'status',
                    'enable',
                    'disable',
                    'set_backends',
                    'set_config',
                    'probe',
                    'simulate',
                    'logs',
                  ])
                  .optional(),
                backends: z.array(z.enum(['opencode-cli', 'copilot-cli'])).optional(),
                autoVerify: z.boolean().optional(),
                scoreThreshold: z.number().min(1).max(10).optional(),
                maxIterations: z.number().min(1).max(10).optional(),
                pureMode: z.boolean().optional(),
                includeRoutingStats: z.boolean().optional(),
                toolName: z.string().optional(),
                preferredBackend: z.enum(['auto', 'opencode', 'copilot', 'local']).optional(),
              });
              const parsed = schema.parse(args);
              const action = parsed.action ?? 'status';

              const applyAdvancedSettings = (updates: {
                cliOrchestrationEnabled?: boolean;
                cliOrchestrationBackends?: string[];
                cliAutoVerify?: boolean;
                cliScoreThreshold?: number;
                cliMaxIterations?: number;
                cliPureMode?: boolean;
              }) => {
                const settings = this.config.getEnvSettings();
                this.config.updateEnvSettings({
                  advanced: {
                    ...settings.advanced,
                    ...updates,
                  },
                });
              };

              const buildStatusPayload = (includeRouting?: boolean) => {
                const settings = this.config.getEnvSettings();
                const status = this.orchestrationService.getStatus();
                const payload: Record<string, unknown> = {
                  success: true,
                  action,
                  status,
                  cliOrchestrationEnabled: settings.advanced?.cliOrchestrationEnabled ?? false,
                  cliOrchestrationBackends: settings.advanced?.cliOrchestrationBackends ?? [],
                  cliAutoVerify: settings.advanced?.cliAutoVerify ?? true,
                  cliScoreThreshold: settings.advanced?.cliScoreThreshold ?? 7,
                  cliMaxIterations: settings.advanced?.cliMaxIterations ?? 3,
                  cliPureMode: settings.advanced?.cliPureMode ?? false,
                };
                if (includeRouting) {
                  payload.routing = {
                    logs: getRoutingLogs(),
                    stats: getRoutingStats(),
                  };
                }
                return payload;
              };

              if (action === 'enable') {
                applyAdvancedSettings({ cliOrchestrationEnabled: true });
                return {
                  content: [{ type: 'text', text: JSON.stringify(buildStatusPayload(), null, 2) }],
                };
              }

              if (action === 'disable') {
                applyAdvancedSettings({ cliOrchestrationEnabled: false });
                return {
                  content: [{ type: 'text', text: JSON.stringify(buildStatusPayload(), null, 2) }],
                };
              }

              if (action === 'set_backends') {
                if (!parsed.backends) {
                  throw new Error('backends is required for action=set_backends');
                }
                applyAdvancedSettings({ cliOrchestrationBackends: parsed.backends });
                return {
                  content: [{ type: 'text', text: JSON.stringify(buildStatusPayload(), null, 2) }],
                };
              }

              if (action === 'set_config') {
                const updates: {
                  cliAutoVerify?: boolean;
                  cliScoreThreshold?: number;
                  cliMaxIterations?: number;
                  cliPureMode?: boolean;
                } = {};
                if (parsed.autoVerify !== undefined) updates.cliAutoVerify = parsed.autoVerify;
                if (parsed.scoreThreshold !== undefined)
                  updates.cliScoreThreshold = parsed.scoreThreshold;
                if (parsed.maxIterations !== undefined)
                  updates.cliMaxIterations = parsed.maxIterations;
                if (parsed.pureMode !== undefined) updates.cliPureMode = parsed.pureMode;

                if (Object.keys(updates).length === 0) {
                  throw new Error(
                    'Provide at least one of autoVerify, scoreThreshold, maxIterations, or pureMode'
                  );
                }

                applyAdvancedSettings(updates);
                return {
                  content: [{ type: 'text', text: JSON.stringify(buildStatusPayload(), null, 2) }],
                };
              }

              if (action === 'probe') {
                const probes = await this.orchestrationService.probeBackends();
                const probePayload = Object.fromEntries(
                  Array.from(probes.entries()).map(([id, result]) => [id, result])
                );
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          action,
                          probes: probePayload,
                          status: this.orchestrationService.getStatus(),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              if (action === 'simulate') {
                if (!parsed.toolName) {
                  throw new Error('toolName is required for action=simulate');
                }

                const manager = getToolOrchestrationManager();
                const baseConfig = manager.getToolConfig(parsed.toolName);
                const effectiveConfig = parsed.preferredBackend
                  ? { ...baseConfig, preferredBackend: parsed.preferredBackend }
                  : baseConfig;
                const globalSettings = manager.getGlobalSettings();
                const status = this.orchestrationService.getStatus();
                const effectivePureCliMode =
                  effectiveConfig.pureCliMode ?? globalSettings.pureCliMode ?? false;

                let predictedMode: 'orchestration' | 'direct-llm' | 'pure-cli' = 'direct-llm';
                let reason = 'Tool routes to direct-llm by default.';

                // Match runtime precedence in ToolOrchestrationManager.execute:
                // pure-cli check runs before direct-llm/orchestration checks.
                if (
                  effectivePureCliMode &&
                  (effectiveConfig.preferredBackend === 'opencode' ||
                    effectiveConfig.preferredBackend === 'copilot')
                ) {
                  predictedMode = 'pure-cli';
                  reason =
                    `pureCliMode is enabled and preferredBackend is ${effectiveConfig.preferredBackend}. ` +
                    'Runtime will bypass local LLM and use direct CLI execution.';
                } else if (!effectiveConfig.orchestrationEnabled) {
                  reason = 'Tool-level orchestration is disabled.';
                } else if (effectiveConfig.preferredBackend === 'local') {
                  reason = 'preferredBackend is local, so direct-llm is selected.';
                } else if (!status.enabled) {
                  reason = 'CLI orchestration is disabled globally.';
                } else if (!Array.isArray(status.backends) || status.backends.length === 0) {
                  reason = 'No CLI orchestration backends are configured.';
                } else {
                  predictedMode = 'orchestration';
                  reason = `CLI orchestration is enabled with backends: ${status.backends.join(', ')}.`;
                }

                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          action,
                          toolName: parsed.toolName,
                          predictedMode,
                          reason,
                          readOnlySafe: true,
                          effectiveConfig: {
                            ...effectiveConfig,
                            pureCliMode: effectivePureCliMode,
                          },
                          orchestrationStatus: status,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }

              if (action === 'logs') {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(buildStatusPayload(true), null, 2),
                    },
                  ],
                };
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(buildStatusPayload(parsed.includeRoutingStats), null, 2),
                  },
                ],
              };
            }

            case 'cli_orchestrate': {
              const schema = z.object({
                task: z.string(),
                contextRoot: z.string().optional(),
                forceBackend: z.enum(['opencode-cli', 'copilot-cli']).optional(),
              });
              const parsed = schema.parse(args);

              // Get orchestration service status
              const status = this.orchestrationService.getStatus();

              if (!status.enabled) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: false,
                          error: 'CLI orchestration is not enabled',
                          hint: 'Enable CLI orchestration in settings (http://localhost:3000) or via API',
                          enableCommand: 'POST /api/settings/cli-orchestration/enable',
                          status,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }

              if (status.backends.length === 0) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: false,
                          error: 'No CLI backends are selected',
                          hint: 'Select at least one backend (opencode-cli or copilot-cli) in settings',
                          availableBackends: status.availableBackends,
                          status,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }

              console.log(
                `[cli_orchestrate] Starting orchestration for task: ${parsed.task.substring(0, 100)}...`
              );

              const result = await this.orchestrationService.orchestrate(parsed.task, {
                contextRoot: parsed.contextRoot,
                forceBackend: parsed.forceBackend,
              });

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        ...result,
                        orchestrationStatus: status,
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: !result.success,
              };
            }

            // ============================================
            // Analysis Extended Tools (CONSOLIDATED)
            // ============================================
            case 'workspace': {
              const schema = z.object({
                mode: z.enum(['metadata', 'snapshot', 'explore']),
                path: z.string(),
                // For snapshot mode
                maxDepth: z.number().optional(),
                includeHidden: z.boolean().optional(),
                extensions: z.array(z.string()).optional(),
                // For explore mode
                question: z.string().optional(),
                maxEntries: z.number().optional(),
              });
              const parsed = schema.parse(args);
              let result;
              switch (parsed.mode) {
                case 'metadata':
                  result = this.fileTools.getFileMetadata(parsed.path);
                  break;
                case 'snapshot':
                  result = this.fileTools.manifestSnapshot(parsed.path, {
                    maxDepth: parsed.maxDepth,
                    includeHidden: parsed.includeHidden,
                    extensions: parsed.extensions,
                  });
                  break;
                case 'explore':
                  result = await this.llmEnhancedTools.exploreDirectory(parsed.path, {
                    question: parsed.question,
                    maxEntries: parsed.maxEntries,
                  });
                  break;
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // Backward compatibility aliases
            case 'file_metadata': {
              const schema = z.object({ path: z.string() });
              const parsed = schema.parse(args);
              const metadata = this.fileTools.getFileMetadata(parsed.path);
              return { content: [{ type: 'text', text: JSON.stringify(metadata, null, 2) }] };
            }

            case 'manifest_snapshot': {
              const schema = z.object({
                root: z.string(),
                maxDepth: z.number().optional(),
                includeHidden: z.boolean().optional(),
                extensions: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              const snapshot = this.fileTools.manifestSnapshot(parsed.root, {
                maxDepth: parsed.maxDepth,
                includeHidden: parsed.includeHidden,
                extensions: parsed.extensions,
              });
              return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
            }

            case 'gather_context': {
              const schema = z.object({
                query: z.string(),
                path: z.string(),
                scope: z.enum(['file', 'directory', 'repo']).optional(),
                maxFiles: z.number().optional(),
                strategy: z.enum(['relevant', 'comprehensive', 'minimal']).optional(),
                includePatterns: z.array(z.string()).optional(),
                excludePatterns: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.highValueTools.gatherContext(parsed.query, parsed.path, {
                scope: parsed.scope,
                maxFiles: parsed.maxFiles,
                strategy: parsed.strategy,
                includePatterns: parsed.includePatterns,
                excludePatterns: parsed.excludePatterns,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // TODOs Tools (CONSOLIDATED)
            // ============================================
            case 'todos': {
              const schema = z.object({
                action: z.enum(['find', 'implement', 'find_and_implement']),
                root: z.string(),
                // For find action
                groupBy: z.enum(['file', 'priority', 'category', 'type']).optional(),
                includeContext: z.boolean().optional(),
                maxResults: z.number().optional(),
                // For implement action
                difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
                todoTypes: z
                  .array(
                    z.enum(['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REFACTOR'])
                  )
                  .optional(),
                maxTodos: z.number().optional(),
                dryRun: z.boolean().optional(),
                files: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              let result;
              if (parsed.action === 'find') {
                result = this.highValueTools.aggregateTodos(parsed.root, {
                  groupBy: parsed.groupBy,
                  includeContext: parsed.includeContext,
                  maxResults: parsed.maxResults,
                });
              } else if (parsed.action === 'implement') {
                result = await this.llmEnhancedTools.implementTodos(parsed.root, {
                  difficulty: parsed.difficulty,
                  todoTypes: parsed.todoTypes,
                  maxTodos: parsed.maxTodos,
                  dryRun: parsed.dryRun,
                  files: parsed.files,
                });
              } else {
                // find_and_implement
                const todos = this.highValueTools.aggregateTodos(parsed.root, {
                  groupBy: parsed.groupBy,
                  includeContext: parsed.includeContext,
                  maxResults: parsed.maxResults,
                });
                const implementation = await this.llmEnhancedTools.implementTodos(parsed.root, {
                  difficulty: parsed.difficulty,
                  todoTypes: parsed.todoTypes,
                  maxTodos: parsed.maxTodos,
                  dryRun: parsed.dryRun,
                  files: parsed.files,
                });
                result = { found: todos, implemented: implementation };
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // Backward compatibility alias
            case 'aggregate_todos': {
              const schema = z.object({
                root: z.string(),
                groupBy: z.enum(['file', 'priority', 'category', 'type']).optional(),
                includeContext: z.boolean().optional(),
                maxResults: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = this.highValueTools.aggregateTodos(parsed.root, {
                groupBy: parsed.groupBy,
                includeContext: parsed.includeContext,
                maxResults: parsed.maxResults,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'codebase_qa': {
              const schema = z.object({
                question: z.string(),
                searchScope: z.array(z.string()).optional(),
                maxSources: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.highValueTools.codebaseQA(parsed.question, {
                searchScope: parsed.searchScope,
                maxSources: parsed.maxSources,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'analyze_test_gaps': {
              const schema = z.object({
                root: z.string(),
                testPatterns: z.array(z.string()).optional(),
                sourcePatterns: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.highValueTools.analyzeTestGaps(parsed.root, {
                testPatterns: parsed.testPatterns,
                sourcePatterns: parsed.sourcePatterns,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'analyze_impact': {
              const schema = z.object({
                changedFiles: z.array(z.string()),
                checkDependencies: z.boolean().optional(),
                checkTests: z.boolean().optional(),
                checkImports: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.highValueTools.analyzeImpact(parsed.changedFiles, {
                checkDependencies: parsed.checkDependencies,
                checkTests: parsed.checkTests,
                checkImports: parsed.checkImports,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Symbol Indexing Tools
            // ============================================
            case 'index_symbols': {
              const schema = z.object({
                root: z.string(),
                languages: z.array(z.string()).optional(),
                symbolTypes: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              const result = this.symbolIndexer.indexSymbols(parsed.root, {
                languages: parsed.languages,
                symbolTypes: parsed.symbolTypes,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'cross_file_links': {
              const schema = z.object({
                entryPoints: z.array(z.string()),
                depth: z.number().optional(),
                includeTypes: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = this.symbolIndexer.crossFileLinks(parsed.entryPoints, {
                depth: parsed.depth,
                includeTypes: parsed.includeTypes,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'structured_search': {
              const schema = z.object({
                root: z.string(),
                query: z.string(),
                targetType: z
                  .enum(['function', 'class', 'variable', 'type', 'interface', 'any'])
                  .optional(),
                languages: z.array(z.string()).optional(),
                maxResults: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = this.symbolIndexer.structuredSearch(parsed.root, parsed.query, {
                targetType: parsed.targetType,
                languages: parsed.languages,
                maxResults: parsed.maxResults,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Privacy/Security Tools (CONSOLIDATED)
            // ============================================
            case 'security': {
              const schema = z.object({
                action: z.enum(['scan', 'risk', 'redact', 'fix']),
                // For scan/fix actions
                root: z.string().optional(),
                scanType: z.enum(['secrets', 'vulnerabilities', 'both']).optional(),
                outputFormat: z.enum(['summary', 'detailed', 'actionable']).optional(),
                // NEW: Include/exclude patterns for scan
                include: z.array(z.string()).optional(),
                exclude: z.array(z.string()).optional(),
                includeHidden: z.boolean().optional(),
                failOnEmpty: z.boolean().optional(),
                // Plan 2 (V4): Zero-Files Security Guard
                warnOnEmpty: z.boolean().optional(),
                minimumFilesExpected: z.number().optional(),
                // For fix action
                apply: z.boolean().optional(),
                // For risk/redact actions
                content: z.string().optional(),
                context: z.enum(['code', 'config', 'documentation', 'unknown']).optional(),
                strictMode: z.boolean().optional(),
                showContext: z.boolean().optional(),
                contextLines: z.number().optional(),
                // Output format
                format: z.enum(['compact', 'dense', 'detailed', 'json']).optional(),
              });
              const parsed = schema.parse(args);
              let result;
              switch (parsed.action) {
                case 'scan':
                  // Default to workspace root for better UX (small models often omit root)
                  result = this.highValueTools.secretScan(parsed.root ?? '.', {
                    scanType: parsed.scanType,
                    outputFormat: parsed.outputFormat,
                    include: parsed.include,
                    exclude: parsed.exclude,
                    includeHidden: parsed.includeHidden,
                    failOnEmpty: parsed.failOnEmpty,
                    warnOnEmpty: parsed.warnOnEmpty,
                    minimumFilesExpected: parsed.minimumFilesExpected,
                  });
                  break;
                case 'fix':
                  result = await this.highValueTools.securityFix(parsed.root ?? '.', {
                    apply: parsed.apply ?? false,
                    scanType: parsed.scanType,
                    includeHidden: parsed.includeHidden,
                  });
                  break;
                case 'risk':
                  if (!parsed.content) throw new Error('content is required for action=risk');
                  result = this.highValueTools.riskScore(parsed.content, {
                    context: parsed.context,
                    strictMode: parsed.strictMode,
                  });
                  break;
                case 'redact':
                  if (!parsed.content) throw new Error('content is required for action=redact');
                  result = this.highValueTools.redactionPreview(parsed.content, {
                    showContext: parsed.showContext,
                    contextLines: parsed.contextLines,
                  });
                  break;
              }
              const outputFormatOpt = parsed.format as OutputFormat | undefined;
              const formattedResult = formatOutput(result, outputFormatOpt);
              return {
                content: [
                  {
                    type: 'text',
                    text:
                      typeof formattedResult === 'string'
                        ? formattedResult
                        : JSON.stringify(formattedResult, null, 2),
                  },
                ],
              };
            }

            // Backward compatibility aliases
            case 'secret_scan': {
              const schema = z.object({
                root: z.string(),
                scanType: z.enum(['secrets', 'vulnerabilities', 'both']).optional(),
                outputFormat: z.enum(['summary', 'detailed', 'actionable']).optional(),
              });
              const parsed = schema.parse(args);
              const result = this.highValueTools.secretScan(parsed.root, {
                scanType: parsed.scanType,
                outputFormat: parsed.outputFormat,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'redaction_preview': {
              const schema = z.object({
                content: z.string(),
                showContext: z.boolean().optional(),
                contextLines: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = this.highValueTools.redactionPreview(parsed.content, {
                showContext: parsed.showContext,
                contextLines: parsed.contextLines,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'risk_score': {
              const schema = z.object({
                content: z.string(),
                context: z.enum(['code', 'config', 'documentation', 'unknown']).optional(),
                strictMode: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = this.highValueTools.riskScore(parsed.content, {
                context: parsed.context,
                strictMode: parsed.strictMode,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Verification Tools
            // ============================================
            case 'validate_syntax': {
              const schema = z.object({
                file_path: z.string(),
                content: z.string().optional(),
              });
              const parsed = schema.parse(args);
              const result = this.editTools.validateSyntax(parsed.file_path, parsed.content);
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Execution Tools (CONSOLIDATED)
            // ============================================
            case 'linter': {
              const schema = z.object({
                action: z.enum(['run', 'fix', 'validate']),
                // For run action
                command: z.string().optional(),
                files: z.array(z.string()).optional(),
                fix: z.boolean().optional(),
                timeout: z.number().optional(),
                // For fix action
                root: z.string().optional(),
                difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
                dryRun: z.boolean().optional(),
                maxFixes: z.number().optional(),
                // For validate action
                content: z.string().optional(),
              });
              const parsed = schema.parse(args);
              let result;
              switch (parsed.action) {
                case 'run':
                  result = await this.executionTools.runLinter({
                    command: parsed.command,
                    files: parsed.files,
                    fix: parsed.fix,
                    timeout: parsed.timeout,
                  });
                  break;
                case 'fix':
                  if (!parsed.root) throw new Error('root is required for action=fix');
                  result = await this.llmEnhancedTools.fixLinter(parsed.root, {
                    difficulty: parsed.difficulty,
                    files: parsed.files,
                    dryRun: parsed.dryRun,
                    maxFixes: parsed.maxFixes,
                  });
                  break;
                case 'validate': {
                  if (!parsed.files || parsed.files.length === 0) {
                    throw new Error('files is required for action=validate');
                  }
                  // Validate each file and collect results
                  const validationResults = parsed.files.map((file) => ({
                    file,
                    ...this.editTools.validateSyntax(file, parsed.content),
                  }));
                  result = {
                    action: 'validate',
                    files: validationResults,
                    allValid: validationResults.every((r) => r.valid),
                  };
                  break;
                }
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // Backward compatibility aliases
            case 'run_linter': {
              const schema = z.object({
                command: z.string().optional(),
                files: z.array(z.string()).optional(),
                fix: z.boolean().optional(),
                timeout: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.executionTools.runLinter({
                command: parsed.command,
                files: parsed.files,
                fix: parsed.fix,
                timeout: parsed.timeout,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'formatter': {
              const schema = z.object({
                action: z.enum(['run', 'fix']),
                files: z.array(z.string()).optional(),
                // For run action
                command: z.string().optional(),
                check: z.boolean().optional(),
                // For fix action
                difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
                dryRun: z.boolean().optional(),
                maxFixes: z.number().optional(),
                timeout: z.number().optional(),
              });
              const parsed = schema.parse(args);
              let result;
              if (parsed.action === 'run') {
                result = await this.executionTools.runFormatter({
                  command: parsed.command,
                  files: parsed.files,
                  check: parsed.check,
                  timeout: parsed.timeout,
                });
              } else {
                // fix action - use fix_syntax via llmEnhancedTools
                if (!parsed.files || parsed.files.length === 0) {
                  throw new Error('files is required for action=fix');
                }
                result = await this.llmEnhancedTools.fixSyntax(parsed.files, {
                  difficulty: parsed.difficulty,
                  dryRun: parsed.dryRun,
                  maxFixes: parsed.maxFixes,
                });
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // Backward compatibility alias
            case 'run_formatter': {
              const schema = z.object({
                command: z.string().optional(),
                files: z.array(z.string()).optional(),
                check: z.boolean().optional(),
                timeout: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.executionTools.runFormatter({
                command: parsed.command,
                files: parsed.files,
                check: parsed.check,
                timeout: parsed.timeout,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // LLM-Enhanced Tools
            // ============================================
            case 'analyze_file': {
              const schema = z.object({
                path: z.string(),
                analysisType: z.preprocess(
                  (value) => (value === 'detailed' ? 'full' : value),
                  z.enum(['quality', 'security', 'performance', 'documentation', 'full']).optional()
                ),
                question: z.string().optional(),
                maxBytes: z.number().optional(),
                includeContent: z.boolean().optional(),
                format: z.enum(['compact', 'dense', 'detailed', 'json']).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.analyzeFile(parsed.path, {
                analysisType: parsed.analysisType,
                question: parsed.question,
                maxBytes: parsed.maxBytes,
                includeContent: parsed.includeContent,
              });
              const outputFormat = parsed.format as OutputFormat | undefined;
              const formattedResult = formatOutput(result, outputFormat);
              return {
                content: [
                  {
                    type: 'text',
                    text:
                      typeof formattedResult === 'string'
                        ? formattedResult
                        : JSON.stringify(formattedResult, null, 2),
                  },
                ],
              };
            }

            // V16: read_file alias tool (QA_feedback_1.md: Gemini 3 Pro requested this)
            case 'read_file': {
              const schema = z.object({
                path: z.string(),
                analysisType: z
                  .enum(['quality', 'security', 'performance', 'documentation', 'full'])
                  .optional(),
                maxBytes: z.number().optional(),
              });
              const parsed = schema.parse(args);
              // Default to documentation analysis for read_file (lighter weight than full)
              // read_file users typically DO want content, so include it
              const result = await this.llmEnhancedTools.analyzeFile(parsed.path, {
                analysisType: parsed.analysisType ?? 'documentation',
                maxBytes: parsed.maxBytes,
                includeContent: true, // read_file users expect content
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'explore_directory': {
              const schema = z.object({
                path: z.string(),
                question: z.string().optional(),
                maxEntries: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.exploreDirectory(parsed.path, {
                question: parsed.question,
                maxEntries: parsed.maxEntries,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Search Tools (CONSOLIDATED)
            // ============================================
            case 'search': {
              // F3-002: Explicit type validation for root parameter before Zod coercion
              if (args && 'root' in args && args.root !== undefined && args.root !== null) {
                if (typeof args.root !== 'string') {
                  return {
                    isError: true,
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            success: false,
                            errorType: 'validation_error',
                            tool: 'search',
                            message: `'root' must be a string path. Received: ${typeof args.root} (${JSON.stringify(args.root)})`,
                            hint: 'Example: { "action": "intelligent", "query": "config", "root": "." }',
                          },
                          null,
                          2
                        ),
                      },
                    ],
                  };
                }
              }

              const schema = z.object({
                action: z.enum(['intelligent', 'structured', 'gather', 'filenames']),
                root: z.string().optional(),
                query: z.string(),
                // For intelligent search
                maxResults: z.number().optional(),
                filePattern: z.string().optional(),
                // For structured search
                targetType: z
                  .enum(['function', 'class', 'variable', 'type', 'interface', 'any'])
                  .optional(),
                languages: z.array(z.string()).optional(),
                // For gather context
                path: z.string().optional(),
                scope: z.enum(['file', 'directory', 'repo']).optional(),
                maxFiles: z.number().optional(),
                strategy: z.enum(['relevant', 'comprehensive', 'minimal']).optional(),
                includePatterns: z.array(z.string()).optional(),
                excludePatterns: z.array(z.string()).optional(),
                // For filenames search
                includeHidden: z.boolean().optional(),
                includeDirectories: z.boolean().optional(),
                // Output format
                format: z.enum(['compact', 'dense', 'detailed', 'json']).optional(),
                // Deterministic mode
                deterministic: z.boolean().optional(),
              });
              const parsed = schema.parse(args);

              // Apply smart defaults for excludePatterns
              const smartDefaults = getSmartDefaultsManager();
              const effectiveExcludePatterns =
                parsed.excludePatterns ?? smartDefaults.getExcludePatterns();

              // V11: Validate action-specific required parameters BEFORE applying defaults
              // This addresses feedback: "search without root silently succeeds" - should return validation error
              const validationError = validateActionRequiredParams(
                'search',
                parsed.action,
                parsed as unknown as Record<string, unknown>
              );
              if (validationError) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: JSON.stringify(validationError, null, 2) }],
                };
              }

              // V14: Default root to '.' if not provided (LLM feedback: common friction point)
              // Previously required root explicitly, but LLMs consistently requested defaulting to workspace
              const effectiveRoot = parsed.root ?? '.';

              // V17: Track if root was auto-defaulted for transparency in response
              const rootWasDefaulted = !parsed.root;

              let result;
              switch (parsed.action) {
                case 'intelligent':
                  result = await this.llmEnhancedTools.intelligentSearch(
                    effectiveRoot,
                    parsed.query,
                    {
                      maxResults: parsed.maxResults,
                      filePattern: parsed.filePattern,
                      rankByRelevance: !(parsed.deterministic ?? false),
                    }
                  );
                  if (parsed.deterministic) (result as any).mode = 'deterministic';
                  break;
                case 'structured':
                  result = this.symbolIndexer.structuredSearch(effectiveRoot, parsed.query, {
                    targetType: parsed.targetType,
                    languages: parsed.languages,
                    maxResults: parsed.maxResults,
                  });
                  break;
                case 'gather':
                  result = await this.highValueTools.gatherContext(parsed.query, parsed.path!, {
                    scope: parsed.scope,
                    maxFiles: parsed.maxFiles,
                    strategy: parsed.strategy,
                    includePatterns: parsed.includePatterns,
                    excludePatterns: effectiveExcludePatterns,
                  });
                  break;
                case 'filenames':
                  result = this.fileTools.findPathsByName(effectiveRoot, parsed.query, {
                    maxResults: parsed.maxResults,
                    includeHidden: parsed.includeHidden,
                    includeDirectories: parsed.includeDirectories,
                    includePatterns: parsed.includePatterns,
                    excludePatterns: effectiveExcludePatterns,
                  });
                  break;
              }

              // V17: Add notice when root was auto-defaulted (addresses QA feedback about transparency)
              if (rootWasDefaulted && result && typeof result === 'object') {
                (result as any).notice =
                  `Root defaulted to '.' (workspace root). Specify 'root' parameter to search a different directory.`;
              }

              // Apply output format
              const outputFormat = parsed.format as OutputFormat | undefined;
              const formattedResult = formatOutput(result, outputFormat);

              return {
                content: [
                  {
                    type: 'text',
                    text:
                      typeof formattedResult === 'string'
                        ? formattedResult
                        : JSON.stringify(formattedResult, null, 2),
                  },
                ],
              };
            }

            // Backward compatibility alias
            case 'intelligent_search': {
              const schema = z.object({
                root: z.string(),
                query: z.string(),
                maxResults: z.number().optional(),
                filePattern: z.string().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.intelligentSearch(
                parsed.root,
                parsed.query,
                {
                  maxResults: parsed.maxResults,
                  filePattern: parsed.filePattern,
                }
              );
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'local_code_review': {
              const schema = z.object({
                paths: z.array(z.string()).min(1),
                focus: z.enum(['security', 'performance', 'style', 'comprehensive']).optional(),
                includeHidden: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.localCodeReview(parsed.paths, {
                reviewType: parsed.focus,
                includeHidden: parsed.includeHidden,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'generate_docs': {
              const schema = z.object({
                path: z.string(),
                docType: z.enum(['jsdoc', 'readme', 'api', 'usage-examples']).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.generateDocs(parsed.path, {
                docType: parsed.docType,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'suggest_refactoring': {
              const schema = z.object({
                path: z.string(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.suggestRefactoring(parsed.path);
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // generate_tests - REMOVED (V21 QA_feedback_8: unreliable output quality)

            case 'suggest_edit': {
              const schema = z.object({
                file_path: z.string(),
                intent: z.string(),
                context: z.string().optional(),
                maxSuggestions: z.number().optional(),
                apply: z.boolean().optional(),
                minConfidence: z.enum(['high', 'medium', 'low']).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.suggestEdit(
                parsed.file_path,
                parsed.intent,
                {
                  context: parsed.context,
                  maxSuggestions: parsed.maxSuggestions,
                  apply: parsed.apply,
                  minConfidence: parsed.minConfidence,
                }
              );
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'find_and_fix': {
              const schema = z.object({
                pattern: z.string(),
                intent: z.string(),
                root: z.string().optional(),
                maxFiles: z.number().optional(),
                apply: z.boolean().optional(),
                minConfidence: z.enum(['high', 'medium', 'low']).optional(),
                dryRun: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.findAndFix(parsed.pattern, parsed.intent, {
                root: parsed.root,
                maxFiles: parsed.maxFiles,
                apply: parsed.apply,
                minConfidence: parsed.minConfidence,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'draft_file': {
              const schema = z.object({
                file_path: z.string(),
                intent: z.string(),
                similar_files: z.array(z.string()).optional(),
                template: z.string().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.draftFile(
                parsed.file_path,
                parsed.intent,
                {
                  similarFiles: parsed.similar_files,
                  template: parsed.template,
                }
              );
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // Black-box V4: generate_agents_md - Generate AGENTS.md from project structure
            case 'generate_agents_md': {
              const schema = z.object({
                root: z.string().optional(),
                outputPath: z.string().optional(),
                overwrite: z.boolean().optional(),
                useLlm: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.generateAgentsMd(parsed.root ?? '.', {
                outputPath: parsed.outputPath,
                overwrite: parsed.overwrite,
                useLlm: parsed.useLlm,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Auto-Fix Tools
            // ============================================
            case 'fix_linter': {
              const schema = z.object({
                root: z.string(),
                difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
                files: z.array(z.string()).optional(),
                dryRun: z.boolean().optional(),
                maxFixes: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.fixLinter(parsed.root, {
                difficulty: parsed.difficulty,
                files: parsed.files,
                dryRun: parsed.dryRun,
                maxFixes: parsed.maxFixes,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'fix_syntax': {
              const schema = z.object({
                paths: z.array(z.string()),
                difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
                dryRun: z.boolean().optional(),
                maxFixes: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.fixSyntax(parsed.paths, {
                difficulty: parsed.difficulty,
                dryRun: parsed.dryRun,
                maxFixes: parsed.maxFixes,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'implement_todos': {
              const schema = z.object({
                root: z.string(),
                difficulty: z.enum(['easy', 'medium', 'hard', 'all']).optional(),
                todoTypes: z
                  .array(
                    z.enum(['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REFACTOR'])
                  )
                  .optional(),
                maxTodos: z.number().optional(),
                dryRun: z.boolean().optional(),
                files: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmEnhancedTools.implementTodos(parsed.root, {
                difficulty: parsed.difficulty,
                todoTypes: parsed.todoTypes,
                maxTodos: parsed.maxTodos,
                dryRun: parsed.dryRun,
                files: parsed.files,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // Code Analysis Tools (CONSOLIDATED)
            // ============================================
            case 'find_duplicates': {
              const schema = z.object({
                findType: z.enum(['files', 'functions', 'code']),
                fileName: z.string().optional(),
                symbol: z.string().optional(),
                filePath: z.string().optional(),
                minLines: z.number().optional(),
                minSimilarity: z.number().optional(),
                maxResults: z.number().optional(),
                includeContent: z.boolean().optional(),
                extensions: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);

              // Route to appropriate method based on findType
              let result;
              switch (parsed.findType) {
                case 'files':
                  if (!parsed.fileName) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            { error: 'fileName is required for findType: files' },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  }
                  result = this.codeAnalysisTools.duplicateFileFinder(parsed.fileName, {
                    maxResults: parsed.maxResults,
                    includeContent: parsed.includeContent,
                  });
                  break;
                case 'functions':
                  result = this.codeAnalysisTools.similarFunctionFinder({
                    symbol: parsed.symbol,
                    filePath: parsed.filePath,
                    minSimilarity: parsed.minSimilarity,
                    maxResults: parsed.maxResults,
                  });
                  break;
                case 'code':
                  result = this.codeAnalysisTools.duplicateCodeFinder({
                    minLines: parsed.minLines,
                    maxReports: parsed.maxResults,
                    extensions: parsed.extensions,
                  });
                  break;
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'code_quality_analyzer': {
              const schema = z.object({
                rootDir: z.string().optional(),
                minSimilarity: z.number().optional(),
                includeTypes: z
                  .array(z.enum(['duplicates', 'complexity', 'security', 'dead_code', 'smells']))
                  .optional(),
              });
              const parsed = schema.parse(args);
              const result = this.codeAnalysisTools.codeQualityAnalyzer({
                rootDir: parsed.rootDir,
                minSimilarity: parsed.minSimilarity,
                includeTypes: parsed.includeTypes,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // LLM Assistance Tools (CONSOLIDATED)
            // ============================================
            case 'code_helper': {
              const schema = z.object({
                action: z.enum(['explain', 'optimize', 'simplify']),
                code: z.string(),
                language: z.string().optional(),
                level: z.enum(['beginner', 'intermediate', 'expert']).optional(),
                focus: z.enum(['speed', 'memory', 'readability', 'all']).optional(),
                preserve: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);

              let result;
              switch (parsed.action) {
                case 'explain': {
                  const depthMap: Record<string, 'brief' | 'detailed' | 'comprehensive'> = {
                    beginner: 'brief',
                    intermediate: 'detailed',
                    expert: 'comprehensive',
                  };
                  result = await this.codeAssistanceTools.explainCode(parsed.code, {
                    language: parsed.language,
                    depth: parsed.level ? depthMap[parsed.level] : undefined,
                  });
                  break;
                }
                case 'optimize': {
                  const focusMap: Record<
                    string,
                    Array<'performance' | 'memory' | 'readability' | 'algorithm'>
                  > = {
                    speed: ['performance', 'algorithm'],
                    memory: ['memory'],
                    readability: ['readability'],
                    all: ['performance', 'memory', 'readability', 'algorithm'],
                  };
                  result = await this.codeAssistanceTools.suggestOptimizations(parsed.code, {
                    language: parsed.language,
                    focusAreas: parsed.focus ? focusMap[parsed.focus] : undefined,
                  });
                  break;
                }
                case 'simplify': {
                  result = await this.codeAssistanceTools.simplifyCode(parsed.code, {
                    language: parsed.language,
                    preserveComments: parsed.preserve?.includes('comments'),
                  });
                  break;
                }
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'regex_helper': {
              const schema = z.object({
                action: z.enum(['explain', 'generate']),
                pattern: z.string().optional(),
                description: z.string().optional(),
                examples: z.array(z.string()).optional(),
                flavor: z.enum(['javascript', 'python', 'pcre', 'auto']).optional(),
              });
              const parsed = schema.parse(args);

              let result;
              switch (parsed.action) {
                case 'explain': {
                  if (!parsed.pattern) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            { error: 'pattern is required for action: explain' },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  }
                  result = await this.codeAssistanceTools.explainRegex(parsed.pattern, {
                    flags: parsed.flavor === 'auto' ? '' : parsed.flavor,
                  });
                  break;
                }
                case 'generate': {
                  if (!parsed.description) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            { error: 'description is required for action: generate' },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  }
                  result = await this.codeAssistanceTools.generateRegex(parsed.description, {
                    examples: parsed.examples,
                    flavor: parsed.flavor === 'auto' ? undefined : parsed.flavor,
                  });
                  break;
                }
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'refactor_helper': {
              const schema = z.object({
                action: z.enum(['suggest_names', 'extract_function']),
                code: z.string(),
                language: z.string().optional(),
                style: z.enum(['camelCase', 'snake_case', 'PascalCase', 'auto']).optional(),
                selection: z.string().optional(),
              });
              const parsed = schema.parse(args);

              let result;
              switch (parsed.action) {
                case 'suggest_names': {
                  result = await this.codeAssistanceTools.suggestNames(parsed.code, {
                    language: parsed.language,
                    style: parsed.style === 'auto' ? undefined : parsed.style,
                  });
                  break;
                }
                case 'extract_function': {
                  result = await this.codeAssistanceTools.extractFunction(
                    parsed.code,
                    parsed.selection || parsed.code,
                    { language: parsed.language }
                  );
                  break;
                }
              }
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'mcp_diff_summarizer': {
              const schema = z.object({
                diff: z.string(),
                format: z.enum(['summary', 'detailed', 'bullet']).optional(),
              });
              const parsed = schema.parse(args);
              // 'format' maps to 'context' in explainDiff - pass format as context
              const result = await this.codeAssistanceTools.explainDiff(parsed.diff, {
                context: parsed.format ? `Output format: ${parsed.format}` : undefined,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'mcp_error_explainer': {
              const schema = z.object({
                error: z.string(),
                language: z.string().optional(),
                context: z.string().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.codeAssistanceTools.explainError(parsed.error, {
                language: parsed.language,
                codeContext: parsed.context,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // mcp_naming_advisor - CONSOLIDATED into refactor_helper
            // mcp_extract_function - CONSOLIDATED into refactor_helper
            // mcp_simplify_code - CONSOLIDATED into code_helper

            case 'mcp_translate_code': {
              const schema = z.object({
                code: z.string(),
                sourceLanguage: z.string(),
                targetLanguage: z.string(),
                preserveComments: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.codeAssistanceTools.translateCode(
                parsed.code,
                parsed.targetLanguage,
                {
                  sourceLanguage: parsed.sourceLanguage,
                  preserveComments: parsed.preserveComments,
                }
              );
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'mcp_plan_implementation': {
              const schema = z.object({
                feature: z.string(),
                codebase: z.string().optional(),
                constraints: z.array(z.string()).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.codeAssistanceTools.planImplementation(parsed.feature, {
                codebaseContext: parsed.codebase,
                constraints: parsed.constraints,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // mcp_explain_regex - CONSOLIDATED into regex_helper
            // mcp_generate_regex - CONSOLIDATED into regex_helper

            case 'mcp_analyze_complexity': {
              const schema = z.object({
                code: z.string(),
                language: z.string().optional(),
                detailed: z.boolean().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.codeAssistanceTools.estimateComplexity(parsed.code, {
                language: parsed.language,
                functionName: parsed.detailed ? 'all' : undefined, // Use 'all' for detailed mode
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'mcp_summarize_logs': {
              const schema = z.object({
                logs: z.string(),
                focus: z.enum(['errors', 'warnings', 'all']).optional(),
                maxLines: z.number().optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.codeAssistanceTools.summarizeLogs(parsed.logs, {
                focusOnErrors: parsed.focus === 'errors' || parsed.focus === 'warnings',
                maxEvents: parsed.maxLines,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'mcp_terminal_command': {
              const schema = z.object({
                task: z.string(),
                shell: z.enum(['bash', 'powershell', 'cmd', 'zsh']).optional(),
                os: z.enum(['linux', 'macos', 'windows', 'auto']).optional(),
              });
              const parsed = schema.parse(args);
              // Map os to platform
              const platformMap: Record<string, 'unix' | 'windows' | 'cross-platform'> = {
                linux: 'unix',
                macos: 'unix',
                windows: 'windows',
                auto: 'cross-platform',
              };
              const result = await this.codeAssistanceTools.suggestCommand(parsed.task, {
                shell: parsed.shell,
                platform: parsed.os ? platformMap[parsed.os] : undefined,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            case 'refine_prompt': {
              const schema = z.object({
                prompt: z.string(),
                context: z.string().optional(),
                style: z.enum(['concise', 'detailed', 'technical', 'creative']).optional(),
                iterations: z.number().min(1).max(3).optional(),
              });
              const parsed = schema.parse(args);
              const result = await this.llmChat.refinePrompt({
                prompt: parsed.prompt,
                context: parsed.context,
                style: parsed.style,
                iterations: parsed.iterations,
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // ============================================
            // MCP Client Tools (CONSOLIDATED)
            // ============================================
            case 'mcp_server': {
              const schema = z.object({
                action: z.enum([
                  'connect',
                  'disconnect',
                  'list',
                  'call',
                  'status',
                  'listLocal',
                  'describeTool',
                ]),
                serverName: z.string().optional(),
                toolName: z.string().optional(),
                // Optional: reduce payload by omitting inputSchema when false
                includeSchema: z.boolean().optional(),
                include_schema: z.boolean().optional(),
                arguments: z.record(z.string(), z.unknown()).optional(),
                // Back-compat: some clients send `args` instead of `arguments`
                args: z.record(z.string(), z.unknown()).optional(),
                // Back-compat: some clients send `parameters` (common in other MCP wrappers)
                parameters: z.record(z.string(), z.unknown()).optional(),
                // Back-compat: some clients send `input`
                input: z.record(z.string(), z.unknown()).optional(),
                // Back-compat: some clients send `toolArgs` (common in some wrappers/UIs)
                toolArgs: z.record(z.string(), z.unknown()).optional(),
                // Back-compat: some clients send `params`
                params: z.record(z.string(), z.unknown()).optional(),
              });
              const parsed = schema.parse(args);

              switch (parsed.action) {
                case 'listLocal': {
                  const includeSchema = parsed.includeSchema ?? parsed.include_schema ?? false;
                  const tools = this.getLocalToolManifest({ includeSchema });
                  return {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({ success: true, tools }, null, 2),
                      },
                    ],
                  };
                }
                case 'describeTool': {
                  if (!parsed.toolName)
                    throw new Error('toolName is required for describeTool action');
                  const described = this.getLocalToolSchema(parsed.toolName);
                  if (!described.found) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              success: false,
                              error: `Tool '${String(parsed.toolName)}' not found.`,
                              toolName: parsed.toolName,
                              availableTools: this.getLocalToolManifest().map((t) => t.name),
                            },
                            null,
                            2
                          ),
                        },
                      ],
                      isError: true,
                    };
                  }
                  return {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({ success: true, ...described }, null, 2),
                      },
                    ],
                  };
                }
                case 'connect': {
                  if (!parsed.serverName)
                    throw new Error('serverName is required for connect action');

                  const requestedName = String(parsed.serverName).trim();
                  const normalized = requestedName.toLowerCase().replace(/_/g, '-');
                  const normalizedCompact = normalized.replace(/-/g, '');
                  const selfNames = new Set([
                    'mcp-local-llm',
                    'mcp-local-llm-server',
                    'mcplocalllm',
                  ]);

                  const cfg = this.mcpClient.getServerConfig(requestedName);
                  const argv1 = (process.argv[1] || '').toLowerCase().replace(/\\/g, '/');
                  const cfgLooksLikeSelf = (() => {
                    if (!cfg) return false;
                    const cmd = (cfg.command || '').toLowerCase();
                    const args = (cfg.args || []).map((a) => String(a).toLowerCase());
                    const joined = args.join(' ');
                    const hasSelfPath =
                      (argv1 && joined.includes(argv1)) ||
                      joined.includes('dist/index.js') ||
                      joined.includes('dist\\index.js') ||
                      joined.includes('src/index.ts') ||
                      joined.includes('src\\index.ts');
                    const hasSelfPkg =
                      joined.includes('mcplocalllm') || joined.includes('mcp-local-llm');
                    const nodeLike =
                      cmd.includes('node') || cmd.includes('npm') || cmd.includes('npx');
                    return nodeLike && (hasSelfPath || hasSelfPkg);
                  })();

                  if (
                    selfNames.has(normalized) ||
                    selfNames.has(normalizedCompact) ||
                    cfgLooksLikeSelf
                  ) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              success: false,
                              error:
                                `Cannot connect to '${requestedName}' because that is (or appears to be) this MCP server. ` +
                                `Use action=list to see external servers, then connect to one of those (e.g., 'chrome-devtools').`,
                              configuredServers: this.mcpClient.getConfiguredServers(),
                            },
                            null,
                            2
                          ),
                        },
                      ],
                      isError: true,
                    };
                  }
                  try {
                    await this.mcpClient.connect(requestedName);
                    const tools = this.mcpClient.getTools(requestedName);
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              success: true,
                              message: `Connected to MCP server '${requestedName}'`,
                              toolsAvailable: tools.length,
                              tools: tools.map((t) => ({
                                name: t.name,
                                description: t.description,
                              })),
                            },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  } catch (error) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              success: false,
                              error: error instanceof Error ? error.message : 'Unknown error',
                              configuredServers: this.mcpClient.getConfiguredServers(),
                            },
                            null,
                            2
                          ),
                        },
                      ],
                      isError: true,
                    };
                  }
                }
                case 'disconnect': {
                  if (!parsed.serverName)
                    throw new Error('serverName is required for disconnect action');

                  const wasConnected = this.mcpClient.isConnected(parsed.serverName);
                  if (wasConnected) {
                    await this.mcpClient.disconnect(parsed.serverName);
                  }

                  return {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            success: true,
                            message: wasConnected
                              ? `Disconnected from MCP server '${parsed.serverName}'`
                              : `MCP server '${parsed.serverName}' was not connected (no-op).`,
                            alreadyDisconnected: !wasConnected,
                            configuredServers: this.mcpClient.getConfiguredServers(),
                          },
                          null,
                          2
                        ),
                      },
                    ],
                  };
                }
                case 'list': {
                  if (parsed.serverName) {
                    if (!this.mcpClient.isConnected(parsed.serverName)) {
                      await this.mcpClient.connect(parsed.serverName);
                    }
                    const tools = this.mcpClient.getTools(parsed.serverName);
                    const includeSchema = parsed.includeSchema ?? parsed.include_schema ?? true;
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              serverName: parsed.serverName,
                              connected: true,
                              tools: tools.map((t) => ({
                                name: t.name,
                                description: t.description,
                                ...(includeSchema ? { inputSchema: t.inputSchema } : {}),
                              })),
                            },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  } else {
                    const configuredServers = this.mcpClient.getConfiguredServers();
                    const serversInfo = configuredServers.map((name) => {
                      const connected = this.mcpClient.isConnected(name);
                      const config = this.mcpClient.getServerConfig(name);
                      return {
                        name,
                        connected,
                        description: config?.description,
                        toolCount: connected ? this.mcpClient.getTools(name).length : null,
                        tools: connected ? this.mcpClient.getTools(name).map((t) => t.name) : null,
                      };
                    });
                    return {
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              configuredServers: serversInfo,
                              connectedCount: serversInfo.filter((s) => s.connected).length,
                              // Help users understand local vs external tools
                              note:
                                configuredServers.length === 0
                                  ? 'No external MCP servers are configured. Tools like agent_task, llm_chat, summarize are LOCAL tools - call them directly (e.g., mcp_mcp-local-llm_agent_task) without using mcp_server.'
                                  : undefined,
                            },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  }
                }
                case 'call': {
                  if (!parsed.serverName) {
                    // Check if the user is trying to call a local tool like agent_task
                    const localTools = [
                      'agent_task',
                      'llm_chat',
                      'verify_plan',
                      'summarize',
                      'search',
                      'workspace',
                      'todos',
                      'security',
                      'mcp_ask',
                    ];
                    const attemptedTool = parsed.toolName || '';
                    if (localTools.includes(attemptedTool)) {
                      return {
                        content: [
                          {
                            type: 'text',
                            text: JSON.stringify(
                              {
                                success: false,
                                error: `Tool '${attemptedTool}' is a LOCAL tool provided by mcp-local-llm server itself.`,
                                hint: `Call it directly: mcp_mcp-local-llm_${attemptedTool}({ ... }) instead of using mcp_server(action='call').`,
                                localTools: localTools,
                                configuredExternalServers: this.mcpClient.getConfiguredServers(),
                              },
                              null,
                              2
                            ),
                          },
                        ],
                        isError: true,
                      };
                    }
                    // Return missing_params error type instead of throwing
                    return {
                      isError: true,
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              success: false,
                              errorType: 'missing_params',
                              message: 'Missing required parameter: serverName',
                              hint: 'Use mcp_server(action="list") to see configured external servers.',
                              example: {
                                action: 'call',
                                serverName: 'your-server',
                                toolName: 'your-tool',
                              },
                            },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  }
                  if (!parsed.toolName) {
                    return {
                      isError: true,
                      content: [
                        {
                          type: 'text',
                          text: JSON.stringify(
                            {
                              success: false,
                              errorType: 'missing_params',
                              message: 'Missing required parameter: toolName',
                              hint: 'Specify the name of the tool you want to call on the external MCP server.',
                              example: {
                                action: 'call',
                                serverName: 'your-server',
                                toolName: 'your-tool',
                              },
                            },
                            null,
                            2
                          ),
                        },
                      ],
                    };
                  }

                  const toolArgs: Record<string, unknown> = (parsed.arguments ||
                    parsed.args ||
                    parsed.parameters ||
                    parsed.input ||
                    parsed.toolArgs ||
                    parsed.params ||
                    {}) as Record<string, unknown>;
                  // Friendly aliasing: some users pass `uri` where the tool expects `url`.
                  if (
                    (parsed.toolName === 'new_page' || parsed.toolName === 'navigate_page') &&
                    toolArgs.url === undefined &&
                    typeof toolArgs.uri === 'string'
                  ) {
                    (toolArgs as any).url = toolArgs.uri;
                    delete (toolArgs as any).uri;
                  }

                  // Additional friendly aliasing for common url field variations
                  if (parsed.toolName === 'new_page' || parsed.toolName === 'navigate_page') {
                    const url =
                      (toolArgs as any).url ??
                      (toolArgs as any).URL ??
                      (toolArgs as any).href ??
                      (toolArgs as any).address;
                    if (toolArgs.url === undefined && typeof url === 'string') {
                      (toolArgs as any).url = url;
                    }
                    delete (toolArgs as any).URL;
                    delete (toolArgs as any).href;
                    delete (toolArgs as any).address;
                  }

                  // take_screenshot: normalize output path aliases to `filePath`
                  if (parsed.toolName === 'take_screenshot') {
                    const fp =
                      (toolArgs as any).filePath ??
                      (toolArgs as any).outputPath ??
                      (toolArgs as any).path ??
                      (toolArgs as any).save_to ??
                      (toolArgs as any).saveTo;
                    if ((toolArgs as any).filePath === undefined && typeof fp === 'string') {
                      (toolArgs as any).filePath = fp;
                    }
                    delete (toolArgs as any).outputPath;
                    delete (toolArgs as any).path;
                    delete (toolArgs as any).save_to;
                    delete (toolArgs as any).saveTo;

                    // Common alias: full -> fullPage
                    if (
                      (toolArgs as any).fullPage === undefined &&
                      typeof (toolArgs as any).full === 'boolean'
                    ) {
                      (toolArgs as any).fullPage = (toolArgs as any).full;
                    }
                    delete (toolArgs as any).full;

                    // Ensure destination directory exists when writing to workspace.
                    const filePath = (toolArgs as any).filePath;
                    if (typeof filePath === 'string' && filePath.trim()) {
                      const normalized = filePath.replace(/\\/g, '/').trim();
                      let abs = normalized;
                      if (!isAbsolute(abs)) {
                        abs = this.config.resolveWorkspacePath(abs);
                      }
                      if (!this.config.isPathAllowed(abs)) {
                        throw new Error(`Screenshot destination is not allowed: ${filePath}`);
                      }
                      mkdirSync(dirname(abs), { recursive: true });
                      (toolArgs as any).filePath = abs;
                    }
                  }

                  // evaluate_script: accept common alias keys
                  if (parsed.toolName === 'evaluate_script') {
                    const fn =
                      (toolArgs as any).function ??
                      (toolArgs as any).fn ??
                      (toolArgs as any).script ??
                      (toolArgs as any).code ??
                      (toolArgs as any).source;
                    if (
                      (toolArgs as any).function === undefined &&
                      (typeof fn === 'string' || typeof fn === 'function')
                    ) {
                      // normalize to a string when provided
                      (toolArgs as any).function = typeof fn === 'string' ? fn : String(fn);
                    }
                    delete (toolArgs as any).fn;
                    delete (toolArgs as any).script;
                    delete (toolArgs as any).code;
                    delete (toolArgs as any).source;
                  }

                  // Some wrappers nest actual args under toolArgs/parameters/input keys; flatten once if needed.
                  if (Object.keys(toolArgs).length === 1) {
                    const onlyKey = Object.keys(toolArgs)[0];
                    const v: any = (toolArgs as any)[onlyKey];
                    if (v && typeof v === 'object' && !Array.isArray(v)) {
                      // If this looks like a redundant nesting (e.g., { toolArgs: {...} }), unwrap it.
                      if (
                        onlyKey === 'toolArgs' ||
                        onlyKey === 'parameters' ||
                        onlyKey === 'input' ||
                        onlyKey === 'arguments' ||
                        onlyKey === 'params' ||
                        onlyKey === 'args'
                      ) {
                        Object.assign(toolArgs, v);
                        delete (toolArgs as any)[onlyKey];
                      }
                    }
                  }

                  const callOnce = async (a: Record<string, unknown>) =>
                    await this.mcpClient.callTool(
                      parsed.serverName as string,
                      parsed.toolName as string,
                      a
                    );

                  let result = await callOnce(toolArgs);

                  // Helpful hint: detect when local tools are being called via external MCP server
                  const LOCAL_TOOLS = [
                    'agent_task',
                    'llm_chat',
                    'verify_plan',
                    'summarize',
                    'search',
                    'workspace',
                    'todos',
                    'security',
                    'mcp_ask',
                    'analyze_file',
                    'draft_file',
                  ];
                  if (LOCAL_TOOLS.includes(parsed.toolName as string) && result.success !== true) {
                    (result as any).hint =
                      `The tool '${parsed.toolName}' is provided by the mcp-local-llm server itself. ` +
                      `Call it directly: mcp_mcp-local-llm_${parsed.toolName}({ ... }) instead of using mcp_server(action=call).`;
                  }

                  // take_screenshot often fails when the remote server refuses to write to the requested filePath.
                  // Fallback: retry without filePath (let it save into temp), then copy the temp artifact into workspace.
                  if (parsed.toolName === 'take_screenshot' && result.success !== true) {
                    const destAbs =
                      typeof (toolArgs as any).filePath === 'string'
                        ? String((toolArgs as any).filePath).trim()
                        : '';

                    const errText =
                      String(result.error || '') ||
                      (typeof result.content === 'string'
                        ? result.content
                        : result.content
                          ? JSON.stringify(result.content)
                          : '');

                    const looksLikeWriteFailure =
                      /ENOENT|EACCES|EPERM|mkdir|not allowed|destination/i.test(errText);

                    if (destAbs && looksLikeWriteFailure) {
                      const retryArgs: Record<string, unknown> = { ...toolArgs };
                      delete (retryArgs as any).filePath;
                      const retry = await callOnce(retryArgs);
                      if (retry.success === true) {
                        result = retry;
                        (result as any).fallback = {
                          reason: 'write_failed',
                          attemptedFilePath: destAbs.replace(/\\/g, '/'),
                          retriedWithoutFilePath: true,
                        };
                      }
                    }
                  }

                  // Improve usability for take_screenshot: confirm saved file and copy temp artifact into workspace when needed.
                  if (parsed.toolName === 'take_screenshot') {
                    const destProvided =
                      typeof (toolArgs as any).filePath === 'string' &&
                      String((toolArgs as any).filePath).trim().length > 0;
                    let destAbs = destProvided ? String((toolArgs as any).filePath) : '';
                    let destOk = destAbs && existsSync(destAbs);

                    const asText =
                      typeof result.content === 'string'
                        ? result.content
                        : result.content
                          ? JSON.stringify(result.content)
                          : '';

                    const m = /([a-zA-Z]:\\[^"'\r\n]+?\.(?:png|jpg|jpeg|webp))/i.exec(asText);
                    const src = m?.[1];

                    // If no destination was provided, still try to persist the temp screenshot into workspace so callers can access it.
                    if (!destProvided && src) {
                      const ext = (
                        /\.(png|jpg|jpeg|webp)$/i.exec(src)?.[0] || '.png'
                      ).toLowerCase();
                      const rel = `.mcp_cache/mcp_artifacts/${parsed.serverName}/${Date.now()}${ext}`;
                      const candidate = this.config.resolveWorkspacePath(rel);
                      if (this.config.isPathAllowed(candidate)) {
                        destAbs = candidate;
                        destOk = existsSync(destAbs);
                      }
                    }

                    if (!destOk && destAbs && src) {
                      const tmp = tmpdir();
                      const srcNorm = resolve(src);
                      const tmpNorm = resolve(tmp);
                      const srcLower = srcNorm.toLowerCase();
                      const tmpLower = tmpNorm.toLowerCase();

                      if (
                        srcLower.startsWith(tmpLower) &&
                        srcLower.includes('chrome-devtools-mcp-') &&
                        /\.(png|jpg|jpeg|webp)$/i.test(srcNorm) &&
                        this.config.isPathAllowed(destAbs)
                      ) {
                        try {
                          mkdirSync(dirname(destAbs), { recursive: true });
                          copyFileSync(srcNorm, destAbs);
                        } catch {
                          // Ignore copy errors - image is optional
                        }
                      }
                    }

                    if (destAbs && existsSync(destAbs)) {
                      try {
                        const st = statSync(destAbs);
                        (result as any).savedFilePath = destAbs.replace(/\\/g, '/');
                        (result as any).savedBytes = st.size;
                      } catch {
                        // Ignore stat errors
                      }
                    }
                  }
                  return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    isError: result.isError,
                  };
                }
                case 'status': {
                  const configuredServers = this.mcpClient.getConfiguredServers();
                  const connectedServers = this.mcpClient.getConnectedServers();
                  const status = {
                    configured: configuredServers.length,
                    connected: connectedServers.length,
                    servers: configuredServers.map((name) => {
                      const connected = this.mcpClient.isConnected(name);
                      const config = this.mcpClient.getServerConfig(name);
                      return {
                        name,
                        connected,
                        description: config?.description,
                        command: config?.command,
                        autoConnect: config?.autoConnect || false,
                        toolCount: connected ? this.mcpClient.getTools(name).length : null,
                      };
                    }),
                    // Helpful note for users who may be confused about local vs external tools
                    note:
                      configuredServers.length === 0
                        ? 'No external MCP servers configured. Local tools (agent_task, llm_chat, etc.) are called directly without mcp_server. To add external servers, edit mcpServers in your settings file (env.settings / env-automated-tests.settings).'
                        : 'External servers listed above. Local tools (agent_task, llm_chat, etc.) are called directly without using mcp_server.',
                  };
                  return {
                    content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
                  };
                }
              }
              throw new Error(`Unknown action: ${parsed.action}`);
            }

            // Backward compatibility aliases
            case 'mcp_server_connect': {
              const schema = z.object({ serverName: z.string() });
              const parsed = schema.parse(args);

              try {
                await this.mcpClient.connect(parsed.serverName);
                const tools = this.mcpClient.getTools(parsed.serverName);
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: true,
                          message: `Connected to MCP server '${parsed.serverName}'`,
                          toolsAvailable: tools.length,
                          tools: tools.map((t) => ({ name: t.name, description: t.description })),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              } catch (error) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: false,
                          error: error instanceof Error ? error.message : 'Unknown error',
                          configuredServers: this.mcpClient.getConfiguredServers(),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
            }

            case 'mcp_server_disconnect': {
              const schema = z.object({ serverName: z.string() });
              const parsed = schema.parse(args);

              await this.mcpClient.disconnect(parsed.serverName);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        success: true,
                        message: `Disconnected from MCP server '${parsed.serverName}'`,
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            case 'mcp_server_list_tools': {
              const schema = z.object({ serverName: z.string().optional() });
              const parsed = schema.parse(args);

              if (parsed.serverName) {
                // List tools for specific server
                if (!this.mcpClient.isConnected(parsed.serverName)) {
                  return {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify(
                          {
                            success: false,
                            error: `Not connected to server '${parsed.serverName}'. Use mcp_server_connect first.`,
                            configuredServers: this.mcpClient.getConfiguredServers(),
                          },
                          null,
                          2
                        ),
                      },
                    ],
                    isError: true,
                  };
                }
                const tools = this.mcpClient.getTools(parsed.serverName);
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          serverName: parsed.serverName,
                          connected: true,
                          tools: tools.map((t) => ({
                            name: t.name,
                            description: t.description,
                            inputSchema: t.inputSchema,
                          })),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              } else {
                // List all configured servers and their status
                const configuredServers = this.mcpClient.getConfiguredServers();
                const serversInfo = configuredServers.map((name) => {
                  const connected = this.mcpClient.isConnected(name);
                  const config = this.mcpClient.getServerConfig(name);
                  return {
                    name,
                    connected,
                    description: config?.description,
                    toolCount: connected ? this.mcpClient.getTools(name).length : null,
                    tools: connected ? this.mcpClient.getTools(name).map((t) => t.name) : null,
                  };
                });
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          configuredServers: serversInfo,
                          connectedCount: serversInfo.filter((s) => s.connected).length,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }
            }

            case 'mcp_server_call': {
              const schema = z.object({
                serverName: z.string(),
                toolName: z.string(),
                arguments: z.record(z.string(), z.unknown()).optional(),
              });
              const parsed = schema.parse(args);

              const result = await this.mcpClient.callTool(
                parsed.serverName,
                parsed.toolName,
                parsed.arguments || {}
              );

              return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: result.isError,
              };
            }

            case 'mcp_server_status': {
              const configuredServers = this.mcpClient.getConfiguredServers();
              const connectedServers = this.mcpClient.getConnectedServers();

              const status = {
                configured: configuredServers.length,
                connected: connectedServers.length,
                servers: configuredServers.map((name) => {
                  const connected = this.mcpClient.isConnected(name);
                  const config = this.mcpClient.getServerConfig(name);
                  return {
                    name,
                    connected,
                    description: config?.description,
                    command: config?.command,
                    autoConnect: config?.autoConnect || false,
                    toolCount: connected ? this.mcpClient.getTools(name).length : null,
                  };
                }),
              };

              return {
                content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
              };
            }

            case 'mcp_ask': {
              const schema = z.object({
                serverName: z.string(),
                task: z.string(),
                preferredTool: z.string().optional(),
              });
              const parsed = schema.parse(args);

              // Check if connected to the server
              if (!this.mcpClient.isConnected(parsed.serverName)) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          success: false,
                          error:
                            `Not connected to server '${parsed.serverName}'. ` +
                            `Use mcp_server({ action: "connect", serverName: "${parsed.serverName}" }) first.`,
                          configuredServers: this.mcpClient.getConfiguredServers(),
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }

              // Get available tools from the connected server
              const tools = this.mcpClient.getTools(parsed.serverName);
              const toolDescriptions = tools
                .map((t) => {
                  const schema = (t as any).inputSchema || {};
                  const props =
                    schema?.properties && typeof schema.properties === 'object'
                      ? Object.keys(schema.properties)
                      : [];
                  const req = Array.isArray(schema?.required) ? schema.required : [];
                  const strict = schema?.additionalProperties === false ? 'strict' : 'flexible';
                  const reqText = req.length ? req.join(', ') : '(none)';
                  const propsText = props.length ? props.join(', ') : '(none)';
                  return `- ${t.name}: ${t.description || 'No description'}\n  required: ${reqText}\n  properties: ${propsText}\n  schema: ${strict}`;
                })
                .join('\n');

              // Build the prompt for the LLM
              const systemPrompt = `You are an assistant that helps users accomplish tasks using MCP tools.

Available tools from the '${parsed.serverName}' MCP server:
${toolDescriptions}

The user wants to accomplish a task. Analyze the task and suggest which tool to use and with what arguments.

Respond in JSON format with:
{
  "suggestedTool": "tool_name",
  "arguments": { /* arguments for the tool */ },
  "explanation": "Brief explanation of why this tool and these arguments",
  "alternativeApproaches": ["other ways to accomplish this if any"]
}

${parsed.preferredTool ? `The user prefers to use the '${parsed.preferredTool}' tool if possible.` : ''}`;

              const userMessage = `Task: ${parsed.task}`;

              // Call the local LLM for suggestions
              const llmResult = await this.llmChat.chat(
                {
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                  ],
                  temperature: 0.3,
                  max_tokens: 1000,
                },
                'local'
              );

              // Try to parse the LLM's response as JSON
              let suggestion;
              try {
                const jsonMatch = llmResult.message.content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  suggestion = JSON.parse(jsonMatch[0]);
                } else {
                  suggestion = { rawResponse: llmResult.message.content };
                }
              } catch {
                suggestion = { rawResponse: llmResult.message.content };
              }

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        success: true,
                        serverName: parsed.serverName,
                        task: parsed.task,
                        suggestion,
                        availableTools: tools.map((t) => t.name),
                        hint: 'Use mcp_server({ action: "call", serverName, toolName, arguments }) to execute the suggested tool.',
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        })();

        const durationMs = Date.now() - startMs;
        const isError = (result as any)?.isError === true;
        this.recordToolCall(name, durationMs, isError);
        const routing = resolveRoutingMeta(name, routingHeadBefore, {
          mode: 'direct-llm',
          backend: 'local-llm',
          success: !isError,
          durationMs,
        });
        return attachRoutingToResult(result, routing, includeRoutingMeta);
      } catch (error) {
        const durationMs = Date.now() - startMs;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.recordToolCall(name, durationMs, true, errorMessage);
        const routing = resolveRoutingMeta(name, routingHeadBefore, {
          mode: 'direct-llm',
          backend: 'local-llm',
          success: false,
          durationMs,
          error: errorMessage,
        });
        try {
          getDebugLogger().error('mcp', `Tool call failed: ${name}`, { error: errorMessage });
        } catch {
          // Ignore logger errors
        }

        // V10: Use formatZodValidationError for Zod validation errors to include allowed values
        // This addresses v6 feedback: "must be equal to one of the allowed values" without showing which values
        const { ZodError } = await import('zod');
        if (error instanceof ZodError) {
          const formattedError = formatZodValidationError(name, error);
          const result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(formattedError, null, 2),
              },
            ],
            isError: true,
          };
          return attachRoutingToResult(result, routing, includeRoutingMeta);
        }

        // Non-Zod errors: return standard error format
        const result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  errorType: 'tool_error',
                  tool: name,
                  message: errorMessage,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
        return attachRoutingToResult(result, routing, includeRoutingMeta);
      } finally {
        this.pendingToolCalls = Math.max(0, this.pendingToolCalls - 1);
      }
    };

    // Store executor for public executeTool() method
    this._toolExecutor = toolExecutor;

    // MCP CallTool handler delegates to the executor
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return toolExecutor(name, args as Record<string, unknown>);
    });
  }

  /**
   * Fetch workspace roots from the MCP client (e.g., VS Code).
   * This uses the standard MCP roots/list capability to get the
   * currently open workspace folders dynamically.
   */
  private async fetchClientRoots(): Promise<string[]> {
    try {
      // Request roots from the client using MCP protocol
      const result = await this.server.listRoots();
      if (result?.roots && result.roots.length > 0) {
        // Convert URIs to file paths
        const roots = result.roots.map((root: { uri: string; name?: string }) => {
          // Handle file:// URIs
          if (root.uri.startsWith('file://')) {
            // file:///C:/path on Windows or file:///path on Unix
            let path = root.uri.slice(7); // Remove 'file://'
            // On Windows, remove leading / before drive letter (e.g., /C:/path -> C:/path)
            if (/^\/[A-Za-z]:/.test(path)) {
              path = path.slice(1);
            }
            // Decode URI components (spaces, special chars)
            return decodeURIComponent(path);
          }
          return root.uri;
        });
        return roots;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Client might not support roots/list - this is OK.
      // "Method not found" is the specific JSON-RPC error when handler is missing.
      if (!msg.includes('Method not found')) {
        process.stderr.write(`[McpServer] Could not fetch roots from client: ${msg}\n`);
      }
    }
    return [];
  }

  /**
   * Initialize workspace from client-provided roots.
   * Called lazily on first tool call or proactively after connection.
   */
  private async initializeWorkspaceFromClient(): Promise<void> {
    if (this.workspaceInitialized) return;
    if (this.workspaceInitPromise) {
      await this.workspaceInitPromise;
      return;
    }

    const init = async (): Promise<void> => {
      // Best-effort and idempotent: don't let a roots/list issue block tool calls.
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = this.workspaceInitGeneration;
        try {
          const roots = await this.fetchClientRoots();
          if (roots.length > 0) {
            // Update config with client-provided roots
            this.config.setDynamicWorkspaceRoots(roots);
            process.stderr.write(
              `[McpServer] Workspace initialized from client: ${roots.join(', ')}\n`
            );

            // Reinitialize tools that depend on workspace root
            this.executionTools = new ExecutionTools({
              workspaceRoot: this.config.getDefaultWorkspaceRoot(),
            });
          } else {
            process.stderr.write(
              `[McpServer] No workspace roots from client, using config defaults\n`
            );
          }

          // If roots changed while we were initializing, run again to apply the latest.
          if (generation !== this.workspaceInitGeneration) {
            this.workspaceInitialized = false;
            continue;
          }

          this.workspaceInitialized = true;
          return;
        } catch (error) {
          process.stderr.write(
            `[McpServer] Workspace initialization failed; using config defaults: ${error instanceof Error ? error.message : String(error)}\n`
          );
          this.workspaceInitialized = true;
          return;
        }
      }

      // If roots keep changing, proceed with the latest applied state to avoid blocking callers.
      this.workspaceInitialized = true;
      process.stderr.write(
        `[McpServer] Workspace initialization kept being invalidated; proceeding with latest roots.\n`
      );
    };

    const promise = init();
    this.workspaceInitPromise = promise;
    try {
      await promise;
    } finally {
      if (this.workspaceInitPromise === promise) {
        this.workspaceInitPromise = null;
      }
    }
  }

  /**
   * V9: Auto-generate AGENTS.md if it doesn't exist
   * Creates a minimal, static (no LLM) AGENTS.md in .mcp-local-llm/
   * Called by mcp_health and discover_tools to ensure project context exists.
   * This is a fire-and-forget operation that doesn't block the caller.
   */
  private async ensureAgentsMdExists(): Promise<void> {
    try {
      const contextRoot = this.config.getDefaultWorkspaceRoot();
      if (!contextRoot) return;

      const agentsMdPath = join(contextRoot, '.mcp-local-llm', 'AGENTS.md');
      const rootAgentsMd = join(contextRoot, 'AGENTS.md');

      // Skip if file already exists somewhere
      if (existsSync(agentsMdPath) || existsSync(rootAgentsMd)) {
        return;
      }

      // Use static generation (useLlm: false) for speed
      await this.llmEnhancedTools.generateAgentsMd(contextRoot, {
        useLlm: false,
        overwrite: false,
      });

      if (process.env.DEBUG_AGENTS_MD === '1') {
        process.stderr.write(`[mcp] Auto-generated .mcp-local-llm/AGENTS.md for context\n`);
      }
    } catch {
      // Fire-and-forget: don't let AGENTS.md generation failure affect tool calls
      if (process.env.DEBUG_AGENTS_MD === '1') {
        process.stderr.write(`[mcp] AGENTS.md auto-generation failed (non-critical)\n`);
      }
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Auto-connect any external MCP servers configured with autoConnect: true
    void this.mcpClient.autoConnect();

    // Listen for workspace root changes from client
    this.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      process.stderr.write(`[McpServer] Workspace roots changed, re-initializing...\n`);
      this.workspaceInitialized = false;
      this.workspaceInitGeneration += 1;
      try {
        await this.initializeWorkspaceFromClient();
      } catch (error) {
        process.stderr.write(
          `[McpServer] Workspace re-initialization failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    });

    // Initialize workspace from client after connection
    // Use setTimeout to allow connection to fully establish
    setTimeout(() => {
      void this.initializeWorkspaceFromClient().catch((error) => {
        process.stderr.write(
          `[McpServer] Workspace initialization (post-connect) failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
    }, 100);

    // Probe backends silently - only report errors
    const probeResults = await this.backendManager.probeAll();
    const unavailable = Array.from(probeResults.entries())
      .filter(([, result]) => !result.available)
      .map(([id, result]) => `${id}: ${result.error || 'unavailable'}`);

    if (unavailable.length > 0) {
      process.stderr.write(`[McpServer] Backend issues: ${unavailable.join('; ')}\n`);
    }
  }
}
