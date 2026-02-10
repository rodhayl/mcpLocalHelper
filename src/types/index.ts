import { z } from 'zod';

/**
 * Timing metadata for LLM-heavy operations.
 * Helps LLM consumers understand response latency and plan accordingly.
 */
export const OperationTimingSchema = z.object({
  /** Total duration in milliseconds */
  durationMs: z.number(),
  /** Breakdown of time spent in different phases */
  phases: z
    .object({
      /** Time spent reading/preparing input (ms) */
      preparation: z.number().optional(),
      /** Time spent waiting for LLM response (ms) */
      llmInference: z.number().optional(),
      /** Time spent processing/parsing output (ms) */
      postProcessing: z.number().optional(),
    })
    .optional(),
  /** Human-readable duration string */
  humanReadable: z.string().optional(),
});
export type OperationTiming = z.infer<typeof OperationTimingSchema>;

export const BackendTypeSchema = z.enum([
  'ollama',
  'lmstudio',
  'generic',
  'openrouter',
  'stub',
  'opencode',
  'copilot',
]);
export type BackendType = z.infer<typeof BackendTypeSchema>;

export const BackendKindSchema = z.enum(['local', 'sota']);
export type BackendKind = z.infer<typeof BackendKindSchema>;

export const ProbeResultSchema = z.object({
  available: z.boolean(),
  error: z.string().optional(),
  version: z.string().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  context_length: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  message: ChatMessageSchema,
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// OpenAI-compatible API response types (for adapter type safety)
export interface OpenAIModelData {
  id: string;
  name?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  details?: {
    parameter_size?: string;
  };
  // OpenRouter-specific fields
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

export interface OpenAIModelsResponse {
  object?: string;
  data?: OpenAIModelData[];
}

export interface OpenAIChatChoice {
  index?: number;
  message: ChatMessage;
  finish_reason?: string;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Ollama-specific API response types
export interface OllamaModel {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

export interface OllamaTagsResponse {
  models?: OllamaModel[];
}

export interface OllamaChatResponse {
  model?: string;
  created_at?: string;
  message: ChatMessage;
  done?: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface LlmBackend {
  id: string;
  kind: BackendKind;
  displayName: string;
  probe(): Promise<ProbeResult>;
  listModels(): Promise<ModelInfo[]>;
  invokeChat(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// ============================================
// CLI Tool Types
// ============================================

export interface CliToolResult {
  success: boolean;
  content: string;
  files_modified: string[];
  tools_used: string[];
  error?: string;
}

export interface ValidationResult {
  score: number;
  reasoning: string;
  issues: string[];
  suggestions: string[];
}

export interface CliToolConfig {
  command: string;
  args_template: string[];
  working_dir?: string;
  timeout: number;
  auto_approve: boolean;
  environment?: Record<string, string>;
}

export interface FileChange {
  path: string;
  type: 'created' | 'modified' | 'deleted';
  before_hash?: string;
  after_hash?: string;
}

export interface FileStateSnapshot {
  timestamp: Date;
  files: Map<string, string>;
}

export const BackendConfigSchema = z.object({
  id: z.string(),
  type: BackendTypeSchema,
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  command: z.string().optional(),
  args_template: z.array(z.string()).optional(),
  working_dir: z.string().optional(),
  timeout: z.number().optional(),
  auto_approve: z.boolean().optional(),
  environment: z.record(z.string(), z.string()).optional(),
});
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

// ============================================
// Tool Groups Configuration Types (must be defined before ConfigSchema)
// ============================================

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ToolGroupSchema = z.object({
  description: z.string(),
  tools: z.array(z.string()),
  riskLevel: RiskLevelSchema,
  requiresLocalLLM: z.boolean().optional(),
  requiresBackup: z.boolean().optional(),
  requiresSandbox: z.boolean().optional(),
});
export type ToolGroup = z.infer<typeof ToolGroupSchema>;

export const ToolGroupModeSchema = z.object({
  description: z.string(),
  groups: z.array(z.string()),
});
export type ToolGroupMode = z.infer<typeof ToolGroupModeSchema>;

export const ToolGroupsConfigSchema = z.object({
  activeMode: z.string().optional(),
  enabled: z.array(z.string()).optional(),
  modes: z.record(z.string(), ToolGroupModeSchema).optional(),
  groups: z.record(z.string(), ToolGroupSchema).optional(),
});
export type ToolGroupsConfig = z.infer<typeof ToolGroupsConfigSchema>;

// ============================================
// Tool Orchestration Configuration Types
// ============================================

export const ToolOrchestrationPreferredBackendSchema = z.enum([
  'auto',
  'opencode',
  'copilot',
  'local',
]);
export type ToolOrchestrationPreferredBackend = z.infer<
  typeof ToolOrchestrationPreferredBackendSchema
>;

export const ToolOrchestrationGlobalSettingsSchema = z.object({
  defaultOrchestrationEnabled: z.boolean().default(true),
  defaultPreferredBackend: ToolOrchestrationPreferredBackendSchema.default('auto'),
  defaultFallbackToLocal: z.boolean().default(true),
  defaultQuickMode: z.boolean().default(false),
  /** Pure CLI mode: bypass local LLM entirely, route directly to CLI backend */
  pureCliMode: z.boolean().default(false),
  /** Probe backends once at startup instead of per-call */
  probeOnStartup: z.boolean().default(true),
  /** Skip local LLM initialization when using pure CLI mode */
  skipLocalLlmInit: z.boolean().default(false),
  /** Enable batch execution for multi-step tasks */
  enableBatchExecution: z.boolean().default(true),
});
export type ToolOrchestrationGlobalSettings = z.infer<typeof ToolOrchestrationGlobalSettingsSchema>;

export const ToolOrchestrationToolConfigSchema = z.object({
  orchestrationEnabled: z.boolean().optional(),
  preferredBackend: ToolOrchestrationPreferredBackendSchema.optional(),
  fallbackToLocal: z.boolean().optional(),
  quickMode: z.boolean().optional(),
});
export type ToolOrchestrationToolConfig = z.infer<typeof ToolOrchestrationToolConfigSchema>;

export const ToolOrchestrationConfigSchema = z
  .object({
    globalSettings: ToolOrchestrationGlobalSettingsSchema.optional(),
    toolConfigs: z.record(z.string(), ToolOrchestrationToolConfigSchema).optional(),
  })
  .optional();
export type ToolOrchestrationConfig = z.infer<typeof ToolOrchestrationConfigSchema>;

// ============================================
// MCP Client Configuration Types
// ============================================

export const McpServerConfigSchema = z.object({
  // Type of MCP server connection (currently only stdio is supported)
  type: z.enum(['stdio']).default('stdio'),
  // Command to run the MCP server
  command: z.string(),
  // Arguments to pass to the command
  args: z.array(z.string()).optional(),
  // Environment variables for the server process
  env: z.record(z.string(), z.string()).optional(),
  // Whether to auto-connect on startup
  autoConnect: z.boolean().default(false),
  // Description for documentation
  description: z.string().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServersConfigSchema = z.record(z.string(), McpServerConfigSchema);
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

// ============================================
// Timeouts Configuration Schema
// ============================================

export const TimeoutsConfigSchema = z.object({
  // === Tier Defaults (tools inherit from these) ===
  tierInstant: z.number().default(5000), // 5s - status checks, lookups
  tierScript: z.number().default(30000), // 30s - file/process ops, no LLM
  tierLlmShort: z.number().default(300000), // 5min - single LLM call
  tierLlmLong: z.number().default(900000), // 15min - agent tasks

  // === Backend-Specific ===
  backendListModels: z.number().default(30000), // 30s
  backendChat: z.number().default(600000), // 10min
  backendHealthCheck: z.number().default(30000), // 30s
  backendProbe: z.number().default(10000), // 10s
  backendQuickHealth: z.number().default(2000), // 2s

  // === MCP Client ===
  mcpClientConnect: z.number().default(15000), // 15s
  mcpClientCall: z.number().default(30000), // 30s
  mcpClientLock: z.number().default(30000), // 30s

  // === Agent & Task Queue ===
  agentTaskSync: z.number().default(90000), // 90s (sync mode)
  agentTaskAsync: z.number().default(900000), // 15min (async mode)
  taskQueue: z.number().default(300000), // 5min queue wait
  taskStale: z.number().default(600000), // 10min stale cleanup

  // === Tool-Specific Overrides ===
  toolExecution: z.number().default(60000), // 60s sandbox exec
  toolGit: z.number().default(30000), // 30s git ops

  // === System ===
  httpBase: z.number().default(180000), // 3min HTTP adapter
  serverProbe: z.number().default(5000), // 5s /api/backends
  rateLimitTtl: z.number().default(300000), // 5min client TTL
  llmInflight: z.number().default(60000), // 1min cache TTL
  systemProfileCheck: z.number().default(2000), // 2s model check
  rootsListTimeout: z.number().default(2000), // 2s MCP roots/list
});
export type TimeoutsConfig = z.infer<typeof TimeoutsConfigSchema>;

export const ConfigSchema = z.object({
  backends: z.array(BackendConfigSchema),
  defaults: z.object({
    localBackendId: z.string(),
    sotaBackendId: z.string().optional(),
    localModel: z.string().optional(),
    sotaModel: z.string().optional(),
  }),
  // MCP servers that this LLM can call as a client
  mcpServers: McpServersConfigSchema.optional(),
  workspace: z
    .object({
      roots: z.array(z.string()).default(['.']),
      defaultRoot: z.string().default('.'),
    })
    .optional(),
  policy: z.object({
    allowlistPaths: z.array(z.string()),
    denylistPaths: z.array(z.string()).optional(),
    maxFileBytes: z.number().default(131072), // 128KB
  }),
  systemProfile: z.object({
    exposeToLLM: z.boolean().default(false),
  }),
  features: z
    .object({
      // Testing mode enables SOTA backend configuration
      testingModeEnabled: z.boolean().default(false),
      // OpenRouter API key (set via settings page or env.settings file)
      openRouterApiKey: z.string().optional(),
    })
    .optional(),
  server: z
    .object({
      port: z.number().default(3000),
      host: z.string().default('127.0.0.1'),
      // Concurrency settings
      maxConcurrentAgentTasks: z.number().min(1).max(10).default(2),
      maxConcurrentClients: z.number().min(1).max(20).default(3),
      // Queue timeout for agent tasks (ms)
      agentTaskQueueTimeoutMs: z.number().default(180000), // 180 seconds (3 min) for CLI support
    })
    .optional(),
  toolGroups: ToolGroupsConfigSchema.optional(),
  readEnhancements: z
    .object({
      maxBatchFiles: z.number().default(50),
      maxBatchBytes: z.number().default(262144), // 256KB
      maxLineSpan: z.number().default(2000),
      enableIndexing: z.boolean().default(true),
      indexingLanguages: z.array(z.string()).default(['ts', 'js', 'py', 'md']),
      maxConcurrentReads: z.number().default(8),
    })
    .optional(),
  privacy: z
    .object({
      riskScoreThreshold: z.number().default(0.75),
      secretPatterns: z.string().default('default'),
    })
    .optional(),
  editing: z
    .object({
      enabled: z.boolean().default(true),
      backupEnabled: z.boolean().default(true),
      backupDir: z.string().default('.mcp-backups'),
      requirePreview: z.boolean().default(false),
      maxFileSize: z.number().default(1048576), // 1MB
    })
    .optional(),
  // Tool discovery configuration (HYBRID AUTONOMOUS MAXIMUM)
  toolDiscovery: z
    .object({
      // If true, load all tools upfront (legacy behavior). Default: false = progressive loading
      fullToolList: z.boolean().default(false),
      // Override default core tools (optional)
      coreTools: z.array(z.string()).optional(),
    })
    .optional(),
  // Rate limiter configuration (per-client token bucket algorithm)
  rateLimiter: z
    .object({
      // Set to false to disable rate limiting (useful for testing)
      enabled: z.boolean().default(true),
      // Tokens added per second per client (default: 10)
      tokensPerSecond: z.number().default(10),
      // Maximum tokens a client can accumulate (default: 50)
      bucketSize: z.number().default(50),
      // Maximum tracked clients before cleanup (default: 1000)
      maxClients: z.number().default(1000),
      // Time before inactive client bucket is removed in ms (default: 300000 = 5min)
      clientTtlMs: z.number().default(300000),
    })
    .optional(),
  // Centralized timeout configuration
  timeouts: TimeoutsConfigSchema.optional(),
  // Per-tool orchestration configuration (persisted in env.settings CONFIG_JSON)
  toolOrchestration: ToolOrchestrationConfigSchema,
  // Plan 2: Output density controls
  outputFormat: z
    .object({
      // Default output format for tools
      default: z.enum(['compact', 'dense', 'detailed', 'json']).default('detailed'),
      // Per-tool format overrides
      toolOverrides: z
        .record(z.string(), z.enum(['compact', 'dense', 'detailed', 'json']))
        .optional(),
    })
    .optional(),
  // Plan 3: Proactive warnings configuration
  proactiveWarnings: z
    .object({
      enabled: z.boolean().default(false),
      severityThreshold: z.enum(['critical', 'warning', 'info']).default('warning'),
      scanOnFileOpen: z.boolean().default(true),
      cacheWarnings: z.boolean().default(true),
      cacheTtlMs: z.number().default(300000), // 5 minutes
    })
    .optional(),
  // Plan 4: Smart defaults and filters
  smartDefaults: z
    .object({
      excludePatterns: z
        .array(z.string())
        .default([
          'node_modules/**',
          '.git/**',
          'venv/**',
          '.venv/**',
          '__pycache__/**',
          'dist/**',
          'build/**',
          'coverage/**',
          '.next/**',
          '.nuxt/**',
          '*.min.js',
          '*.min.css',
          '*.map',
          'package-lock.json',
          'yarn.lock',
          'pnpm-lock.yaml',
        ]),
      autoDetectExcludes: z.boolean().default(true),
      includePatterns: z.array(z.string()).optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

// ============================================
// Environment Settings Schema (env.settings file)
// ============================================

export const EnvironmentSettingsSchema = z.object({
  // Production settings (no SOTA - only local LLM)
  production: z.object({
    localBackendId: z.string().default('ollama'),
    localModel: z.string().optional(),
    localBackendUrl: z.string().url().default('http://127.0.0.1:11434'),
  }),
  // Testing settings (both local and SOTA)
  testing: z.object({
    enabled: z.boolean().default(false),
    localBackendId: z.string().default('ollama'),
    localModel: z.string().optional(),
    localBackendUrl: z.string().url().default('http://127.0.0.1:11434'),
    // SOTA can be local or external (openrouter)
    sotaBackendType: z.enum(['local', 'openrouter']).default('local'),
    sotaBackendId: z.string().optional(),
    sotaModel: z.string().optional(),
    sotaBackendUrl: z.string().url().optional(),
    openRouterApiKey: z.string().optional(),
  }),
  // Advanced settings
  advanced: z.object({
    serverPort: z.number().default(3000),
    serverHost: z.string().default('127.0.0.1'),
    exposeSystemProfile: z.boolean().default(false),
    toolGroupMode: z.string().default('DEVELOPMENT'),
    // QA_feedback_9: Embedding model configuration for semantic memory
    embeddingModel: z.string().optional(),
    embeddingBackendUrl: z.string().optional(),
    // QA_feedback_11: Agent task configuration (exposed in settings page)
    agentMaxSteps: z.number().min(1).max(500).default(50),
    agentMaxActionsPerStep: z.number().min(1).max(100).default(100),
    agentMaxSubtasks: z.number().min(1).max(20).default(8),
    agentTimeoutMs: z.number().min(10000).max(3600000).default(300000), // 5 minutes default, max 1 hour
    // CLI Orchestration settings
    // QA_feedback_26012026: Enable CLI orchestration by default with opencode-cli
    cliOrchestrationEnabled: z.boolean().default(true),
    cliOrchestrationBackends: z.array(z.string()).default(['opencode-cli']),
    cliAutoVerify: z.boolean().default(true),
    cliScoreThreshold: z.number().min(1).max(10).default(7),
    cliMaxIterations: z.number().min(1).max(10).default(3),
    // V24: Pure CLI mode for zero LLM overhead
    cliPureMode: z.boolean().default(false),
  }),
});
export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>;

// ============================================
// CLI Orchestration Types
// ============================================

export type OrchestrationStatus = 'planning' | 'executing' | 'verifying' | 'completed' | 'failed';

export interface OrchestrationStep {
  id: string;
  description: string;
  cliBackend: string;
  taskPrompt: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: CliToolResult;
  verification?: VerificationResult;
}

export interface OrchestrationPlan {
  id: string;
  originalTask: string;
  description: string;
  steps: OrchestrationStep[];
  currentStep: number;
  status: OrchestrationStatus;
  score?: number;
  iterations: number;
  createdAt: Date;
  updatedAt: Date;
  threshold: number;
  maxIterations: number;
}

export interface VerificationResult {
  score: number; // 1-10
  reasoning: string; // Explanation of score
  completedAreas: string[]; // What was successfully completed
  missingItems: string[]; // What is still missing
  suggestions: string[]; // Recommendations for improvement
}

/**
 * Timing metrics for orchestration performance analysis
 */
export interface OrchestrationTimingMetrics {
  // LM Studio (orchestration) timings
  llmPlanningMs: number; // Time spent planning/decomposing task
  llmVerificationMs: number; // Time spent on quick verification
  llmFinalVerificationMs: number; // Time spent on final verification
  llmTotalMs: number; // Total LLM time
  llmCallCount: number; // Number of LLM API calls

  // CLI Tool (execution) timings
  cliExecutionMs: number; // Time spent executing via CLI
  cliCallCount: number; // Number of CLI executions
  cliBackendUsed: string; // Which CLI backend was used
  cliModelUsed: string; // Which model the CLI used

  // Overall metrics
  totalMs: number; // Total orchestration time
  stepsExecuted: number; // Number of steps executed
  startTime: string; // ISO timestamp of start
  endTime: string; // ISO timestamp of end
}

export interface OrchestrationResult {
  success: boolean;
  planId: string;
  score: number;
  verification: VerificationResult;
  iterations: number;
  error?: string;
  timing?: OrchestrationTimingMetrics; // Optional timing metrics
}

export interface QuickVerification {
  isComplete: boolean;
  assessment: string;
}

/**
 * Complete tool orchestration state for API responses
 */
export interface ToolOrchestrationState {
  globalSettings: ToolOrchestrationGlobalSettings;
  toolConfigs: Record<string, ToolOrchestrationToolConfig>;
  availableTools: string[];
  orchestrationAvailable: boolean;
  orchestrationBackends: string[];
}

export const SystemProfileSchema = z.object({
  os: z.string(),
  cpu_cores: z.number(),
  ram_gb_bucket: z.enum(['4', '8', '16', '32+']),
  gpu: z
    .object({
      present: z.boolean(),
      vendor: z.enum(['nvidia', 'amd', 'intel', 'other']).optional(),
      vram_gb_bucket: z.enum(['2', '4', '8', '16', '24+']).optional(),
    })
    .optional(),
  disk_free_gb_bucket: z.enum(['50', '100', '250', '500+']),
});
export type SystemProfile = z.infer<typeof SystemProfileSchema>;

export const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  targets: z.array(z.string()),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const VerifyPlanRequestSchema = z.object({
  plan_id: z.string().optional(),
  context_root: z.string(),
  steps: z.array(PlanStepSchema),
  mode: z.enum(['quick', 'deep']).default('quick'),
});
export type VerifyPlanRequest = z.infer<typeof VerifyPlanRequestSchema>;

export const StepVerdictSchema = z.enum(['ok', 'needs_changes', 'blocked']);
export type StepVerdict = z.infer<typeof StepVerdictSchema>;

export const StepResultSchema = z.object({
  id: z.string(),
  status: StepVerdictSchema,
  reasons: z.array(z.string()),
  evidence: z.array(
    z.object({
      path: z.string(),
      summary: z.string(),
      relevant_lines: z.array(z.number()).optional(),
    })
  ),
  suggested_changes: z.array(z.string()).optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const VerifyPlanResponseSchema = z.object({
  plan_id: z.string().optional(),
  overall_verdict: z.enum(['ok', 'needs_changes', 'high_risk']),
  steps: z.array(StepResultSchema),
});
export type VerifyPlanResponse = z.infer<typeof VerifyPlanResponseSchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  redaction: z
    .object({
      mode: z.enum(['default', 'strict']),
      totalReplacements: z.number(),
      byPattern: z.record(z.string(), z.number()),
    })
    .optional(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const DirectoryEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory']),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;

export const DirectoryListSchema = z.object({
  path: z.string(),
  entries: z.array(DirectoryEntrySchema),
});
export type DirectoryList = z.infer<typeof DirectoryListSchema>;

export const GrepMatchSchema = z.object({
  file: z.string(),
  line: z.number(),
  preview: z.string(),
});
export type GrepMatch = z.infer<typeof GrepMatchSchema>;

export const GrepResultSchema = z.object({
  matches: z.array(GrepMatchSchema),
});
export type GrepResult = z.infer<typeof GrepResultSchema>;

/**
 * Provenance source for summary claims.
 * Addresses Black-box feedback for hallucination reduction.
 */
export const SummarySourceSchema = z.object({
  file: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  excerpt: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});
export type SummarySource = z.infer<typeof SummarySourceSchema>;

export const SummarySchema = z.object({
  summary: z.string(),
  tokensUsed: z
    .object({
      input: z.number(),
      output: z.number(),
    })
    .optional(),
  mode: z.enum(['compact', 'extended']),
  components: z.array(z.string()).optional(),
  /** Provenance sources for summary claims (Plan 4: hallucination reduction) */
  sources: z.array(SummarySourceSchema).optional(),
  /** Coverage ratio of files with provenance vs total key files */
  provenanceCoverage: z.number().min(0).max(1).optional(),
  /** V17: Notice for users about special conditions (e.g., pre-flight safety) */
  notice: z.string().optional(),
});
export type Summary = z.infer<typeof SummarySchema>;

// Default tool group definitions
// NOTE: Tools that duplicate VS Code Copilot built-ins have been removed
// VS Code built-ins: #readFile, #editFiles, #createFile, #listDirectory, #textSearch, #runInTerminal, #runTests, #changes
// Removed duplicates: read_file, list_dir, grep_repo, edit_file, edit_file_preview, multi_file_edit, create_file,
//                     apply_diff, apply_diff_preview, git_status, git_diff, git_log, git_commit, execute_script, run_tests
export const DEFAULT_TOOL_GROUPS: Record<string, ToolGroup> = {
  'core.summary': {
    description: 'LLM-based summarization (CONSOLIDATED)',
    tools: ['summarize'], // Replaces: summarize_path, summarize_repo
    riskLevel: 'low',
    requiresLocalLLM: true,
  },
  'core.chat': {
    description: 'Direct LLM chat (unique value)',
    tools: ['llm_chat'],
    riskLevel: 'low',
  },
  planning: {
    description: 'Plan creation and verification (unique value)',
    tools: [
      'verify_plan',
      'agent_task',
      'agent_queue_status',
      'agent_task_result',
      'orchestration',
      'cli_orchestrate',
    ],
    riskLevel: 'low',
    requiresLocalLLM: true,
  },
  'system.info': {
    description: 'System information access',
    tools: ['system_profile', 'model_info', 'mcp_health', 'mcp_debug'],
    riskLevel: 'low',
  },
  'analysis.extended': {
    description: 'Advanced analysis tools (CONSOLIDATED - workspace, search, todos)',
    tools: [
      'workspace', // Replaces: file_metadata, manifest_snapshot, explore_directory
      'cross_file_links',
      'index_symbols',
      'search', // Replaces: intelligent_search, structured_search, gather_context
      'todos', // Replaces: aggregate_todos, implement_todos
      'codebase_qa',
      'analyze_impact',
      'analyze_test_gaps',
    ],
    riskLevel: 'medium',
  },
  privacy: {
    description: 'Privacy and security tools (CONSOLIDATED)',
    tools: ['security'], // Replaces: secret_scan, redaction_preview, risk_score
    riskLevel: 'low',
  },
  'llm.enhanced': {
    description: 'LLM-enhanced analysis tools (CONSOLIDATED)',
    tools: [
      'analyze_file',
      'local_code_review',
      'generate_docs',
      'suggest_refactoring',
      // 'generate_tests' - REMOVED V21 (QA_feedback_8: unreliable output quality)
      'suggest_edit',
      'draft_file',
      'find_and_fix',
      'generate_agents_md',
    ],
    riskLevel: 'medium',
    requiresLocalLLM: true,
  },
  execution: {
    description: 'Code formatting and linting (CONSOLIDATED)',
    tools: ['linter', 'formatter'], // linter replaces: run_linter, fix_linter; formatter replaces: run_formatter, fix_syntax
    riskLevel: 'medium',
    requiresSandbox: true,
  },
  'code.analysis': {
    description: 'Code similarity and duplication detection (CONSOLIDATED)',
    tools: ['find_duplicates', 'code_quality_analyzer'],
    riskLevel: 'low',
  },
  'llm.assistance': {
    description: 'LLM-powered code assistance tools (CONSOLIDATED)',
    tools: [
      'code_helper', // Replaces: mcp_explain_code, mcp_optimize_code, mcp_simplify_code
      'regex_helper', // Replaces: mcp_explain_regex, mcp_generate_regex
      'refactor_helper', // Replaces: mcp_naming_advisor, mcp_extract_function
      'mcp_diff_summarizer',
      'mcp_error_explainer',
      'mcp_translate_code',
      'mcp_plan_implementation',
      'mcp_analyze_complexity',
      'mcp_summarize_logs',
      'mcp_terminal_command',
      'refine_prompt',
    ],
    riskLevel: 'low',
    requiresLocalLLM: true,
  },
  'mcp.client': {
    description: 'Connect to and call tools from external MCP servers (CONSOLIDATED)',
    tools: [
      'mcp_server', // Replaces: mcp_server_connect, mcp_server_disconnect, mcp_server_list_tools, mcp_server_call, mcp_server_status
      'mcp_ask',
    ],
    riskLevel: 'medium',
  },
  'core.discovery': {
    description: 'Tool discovery meta-tool for progressive loading (HYBRID AUTONOMOUS MAXIMUM)',
    tools: ['discover_tools'],
    riskLevel: 'low',
  },
};

// Default mode definitions
// NOTE: Updated to reflect VS Code Copilot bypass strategy
export const DEFAULT_TOOL_MODES: Record<string, ToolGroupMode> = {
  MINIMAL: {
    description: 'Core LLM tools + agent planning',
    groups: ['core.chat', 'core.summary', 'planning'],
  },
  ANALYSIS: {
    description: 'LLM analysis with enhanced tools',
    groups: ['core.summary', 'core.chat', 'planning', 'llm.enhanced', 'system.info'],
  },
  PLANNING: {
    description: 'Add plan verification capabilities',
    groups: ['core.summary', 'core.chat', 'planning', 'system.info'],
  },
  FULL_ANALYSIS: {
    description: 'Full analysis suite with advanced search and indexing',
    groups: [
      'core.summary',
      'core.chat',
      'planning',
      'analysis.extended',
      'privacy',
      'system.info',
      'llm.enhanced',
    ],
  },
  DEVELOPMENT: {
    description: 'All available tools (for development/testing)',
    groups: [
      'core.summary',
      'core.chat',
      'core.discovery',
      'planning',
      'analysis.extended',
      'privacy',
      'system.info',
      'llm.enhanced',
      'execution',
      'code.analysis',
      'llm.assistance',
      'mcp.client',
    ],
  },
};

// Tool Group Status for API responses
export const ToolGroupStatusSchema = z.object({
  activeMode: z.string().nullable(),
  enabledGroups: z.array(z.string()),
  enabledTools: z.array(z.string()),
  availableModes: z.array(z.string()),
  groupDefinitions: z.record(z.string(), ToolGroupSchema),
});
export type ToolGroupStatus = z.infer<typeof ToolGroupStatusSchema>;

// ============================================
// Model Capability Types (Phase 2)
// ============================================

export const ModelCapabilityLevelSchema = z.enum(['basic', 'standard', 'advanced']);
export type ModelCapabilityLevel = z.infer<typeof ModelCapabilityLevelSchema>;

export const ModelCapabilitiesSchema = z.object({
  id: z.string(),
  name: z.string(),
  parameterSize: z.string().nullable(),
  parameterBillions: z.number().nullable(),
  isCodeSpecialized: z.boolean(),
  estimatedCapability: ModelCapabilityLevelSchema,
  recommendedTasks: z.array(z.string()),
  cautionTasks: z.array(z.string()),
  contextLength: z.number().nullable(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

// ============================================
// Enhanced Read Tool Types (Phase 3)
// ============================================

export const ReadSegmentSchema = z.object({
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
});
export type ReadSegment = z.infer<typeof ReadSegmentSchema>;

export const ReadSegmentResultSchema = z.object({
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  content: z.string(),
  truncated: z.boolean(),
  redactionApplied: z.boolean(),
  sha256: z.string().optional(),
  error: z.string().optional(),
});
export type ReadSegmentResult = z.infer<typeof ReadSegmentResultSchema>;

export const BatchReadResultSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
      truncated: z.boolean(),
      sizeBytes: z.number(),
      error: z.string().optional(),
    })
  ),
  aggregateBytes: z.number(),
  capped: z.boolean(),
  omittedFiles: z.array(z.string()),
});
export type BatchReadResult = z.infer<typeof BatchReadResultSchema>;

export const FileMetadataSchema = z.object({
  path: z.string(),
  name: z.string(),
  extension: z.string(),
  sizeBytes: z.number(),
  lineCount: z.number(),
  modifiedAt: z.string(),
  createdAt: z.string(),
  language: z.string().nullable(),
  isReadable: z.boolean(),
});
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

export const ManifestSnapshotSchema = z.object({
  root: z.string(),
  totalFiles: z.number(),
  totalDirectories: z.number(),
  totalBytes: z.number(),
  files: z.array(
    z.object({
      path: z.string(),
      relativePath: z.string(),
      sizeBytes: z.number(),
      language: z.string().nullable(),
    })
  ),
  directories: z.array(z.string()),
  languageBreakdown: z.record(
    z.string(),
    z.object({
      count: z.number(),
      bytes: z.number(),
    })
  ),
  truncated: z.boolean(),
  // V18 (QA_feedback_5): Add explicit counts for truncation transparency
  // Addresses: "Update workspace(snapshot) to explicitly indicate if the file list is truncated"
  truncationInfo: z
    .object({
      filesShowing: z.number(),
      filesTotal: z.number(),
      directoriesShowing: z.number(),
      directoriesTotal: z.number(),
      hint: z.string().optional(),
    })
    .optional(),
});
export type ManifestSnapshot = z.infer<typeof ManifestSnapshotSchema>;

export const GrepV2MatchSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  preview: z.array(z.string()),
  matchedText: z.string(),
});
export type GrepV2Match = z.infer<typeof GrepV2MatchSchema>;

export const GrepV2ResultSchema = z.object({
  matches: z.array(GrepV2MatchSchema),
  totalMatches: z.number(),
  filesSearched: z.number(),
  truncated: z.boolean(),
});
export type GrepV2Result = z.infer<typeof GrepV2ResultSchema>;

// ============================================
// High-Value Tool Types (Phase 4)
// ============================================

export const GatherContextResultSchema = z.object({
  summary: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      relevance: z.enum(['high', 'medium', 'low']),
      summary: z.string(),
      keySnippets: z.array(
        z.object({
          lines: z.string(),
          content: z.string(),
          reason: z.string(),
        })
      ),
    })
  ),
  suggestedQuestions: z.array(z.string()),
  totalTokensEstimate: z.number(),
  compressionRatio: z.number(),
});
export type GatherContextResult = z.infer<typeof GatherContextResultSchema>;

export const SecretScanFindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  type: z.string(),
  file: z.string(),
  line: z.number(),
  preview: z.string(),
  recommendation: z.string(),
});
export type SecretScanFinding = z.infer<typeof SecretScanFindingSchema>;

export const SecretScanResultSchema = z.object({
  findings: z.array(SecretScanFindingSchema),
  statistics: z.object({
    filesScanned: z.number(),
    filesSkipped: z.number().optional(),
    skippedReasons: z.record(z.string(), z.number()).optional(),
    findingsByCategory: z.record(z.string(), z.number()),
    riskScore: z.number(),
    scanDurationMs: z.number().optional(),
    usedFallback: z.boolean().optional(), // V9: Indicate if fallback scan was used
    fallbackReason: z.string().optional(), // V9: Reason for fallback
    coverageGuidance: z
      .object({
        detectedProjectType: z.string(),
        includeProvided: z.boolean(),
        includePatternsUsed: z.array(z.string()),
        recommendedInclude: z.array(z.string()),
        recommendedCommand: z.string(),
        lowCoverageThreshold: z.number().optional(),
      })
      .optional(),
    // F3-005: List of scanned files for transparency
    scannedFiles: z.array(z.string()).optional(),
    note: z.string().optional(),
  }),
  executionId: z.string().optional(),
  timestamp: z.string().optional(),
  // Plan 2 (V4): Zero-Files Security Guard - warnings for edge cases
  warnings: z.array(z.string()).optional(),
});
export type SecretScanResult = z.infer<typeof SecretScanResultSchema>;

export const TodoItemSchema = z.object({
  file: z.string(),
  line: z.number(),
  type: z.enum(['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REFACTOR']),
  content: z.string(),
  context: z.string(),
  suggestedPriority: z.enum(['high', 'medium', 'low']),
  category: z.string(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const AggregateTodosResultSchema = z.object({
  todos: z.array(TodoItemSchema),
  grouped: z.record(z.string(), z.array(TodoItemSchema)),
  summary: z.object({
    total: z.number(),
    byType: z.record(z.string(), z.number()),
    byPriority: z.record(z.string(), z.number()),
    topFiles: z.array(
      z.object({
        file: z.string(),
        count: z.number(),
      })
    ),
  }),
});
export type AggregateTodosResult = z.infer<typeof AggregateTodosResultSchema>;

export const CodebaseQAResultSchema = z.object({
  answer: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  sources: z.array(
    z.object({
      file: z.string(),
      relevantLines: z.object({
        start: z.number(),
        end: z.number(),
      }),
      excerpt: z.string(),
    })
  ),
  relatedQuestions: z.array(z.string()),
});
export type CodebaseQAResult = z.infer<typeof CodebaseQAResultSchema>;

export const TestGapsResultSchema = z.object({
  untestedFiles: z.array(
    z.object({
      file: z.string(),
      complexity: z.enum(['high', 'medium', 'low']),
      reason: z.string(),
      suggestedTests: z.array(z.string()),
    })
  ),
  partiallyTestedFiles: z.array(
    z.object({
      file: z.string(),
      testedFunctions: z.array(z.string()),
      untestedFunctions: z.array(z.string()),
      coverageEstimate: z.number(),
    })
  ),
  coverageSummary: z.object({
    totalSourceFiles: z.number(),
    totalTestFiles: z.number(),
    untestedCount: z.number(),
    partiallyTestedCount: z.number(),
    estimatedCoverage: z.number(),
  }),
  recommendations: z.array(z.string()),
});
export type TestGapsResult = z.infer<typeof TestGapsResultSchema>;

// ============================================
// Symbol Indexing Types (Phase 5)
// ============================================

export const SymbolInfoSchema = z.object({
  name: z.string(),
  type: z.enum(['function', 'class', 'variable', 'type', 'interface', 'enum', 'constant']),
  file: z.string(),
  line: z.number(),
  exported: z.boolean(),
  signature: z.string().optional(),
});
export type SymbolInfo = z.infer<typeof SymbolInfoSchema>;

export const IndexSymbolsResultSchema = z.object({
  indexed: z.number(),
  symbols: z.array(SymbolInfoSchema),
  indexDuration: z.number(),
  languages: z.array(z.string()),
});
export type IndexSymbolsResult = z.infer<typeof IndexSymbolsResultSchema>;

export const ImportInfoSchema = z.object({
  source: z.string(),
  resolvedPath: z.string().nullable(),
  symbols: z.array(z.string()),
  isTypeOnly: z.boolean(),
});
export type ImportInfo = z.infer<typeof ImportInfoSchema>;

export const CrossFileLinksResultSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      imports: z.array(ImportInfoSchema),
      importedBy: z.array(z.string()),
    })
  ),
  graph: z.object({
    nodes: z.array(z.string()),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
      })
    ),
  }),
});
export type CrossFileLinksResult = z.infer<typeof CrossFileLinksResultSchema>;

export const StructuredSearchMatchSchema = z.object({
  file: z.string(),
  symbolName: z.string(),
  symbolType: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  preview: z.string(),
  relevanceScore: z.number(),
});
export type StructuredSearchMatch = z.infer<typeof StructuredSearchMatchSchema>;

export const StructuredSearchResultSchema = z.object({
  matches: z.array(StructuredSearchMatchSchema),
  totalMatches: z.number(),
});
export type StructuredSearchResult = z.infer<typeof StructuredSearchResultSchema>;

// ============================================
// Edit Tool Types (Phase 6)
// ============================================

export const EditOperationSchema = z.enum(['replace', 'insert', 'delete']);
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const EditPreviewResultSchema = z.object({
  diff: z.string(),
  linesAffected: z.number(),
  syntaxValid: z.boolean(),
  warnings: z.array(z.string()),
});
export type EditPreviewResult = z.infer<typeof EditPreviewResultSchema>;

export const EditResultSchema = z.object({
  success: z.boolean(),
  backupPath: z.string().optional(),
  diff: z.string(),
  linesChanged: z.number(),
  error: z.string().optional(),
});
export type EditResult = z.infer<typeof EditResultSchema>;

export const MultiEditResultSchema = z.object({
  success: z.boolean(),
  results: z.array(
    z.object({
      file_path: z.string(),
      success: z.boolean(),
      error: z.string().optional(),
    })
  ),
  rollbackPerformed: z.boolean().optional(),
});
export type MultiEditResult = z.infer<typeof MultiEditResultSchema>;

export const SyntaxValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      line: z.number(),
      column: z.number(),
      message: z.string(),
      severity: z.enum(['error', 'warning']),
    })
  ),
  language: z.string(),
});
export type SyntaxValidationResult = z.infer<typeof SyntaxValidationResultSchema>;

// ============================================
// Privacy Tool Types
// ============================================

export const RedactionPreviewResultSchema = z.object({
  totalFindings: z.number(),
  findings: z.array(
    z.object({
      type: z.string(),
      original: z.string(),
      redacted: z.string(),
      line: z.number(),
      column: z.number(),
      context: z.string().optional(),
    })
  ),
  preview: z.string(),
  summary: z.object({
    byType: z.record(z.string(), z.number()),
    linesAffected: z.number(),
  }),
});
export type RedactionPreviewResult = z.infer<typeof RedactionPreviewResultSchema>;

export const RiskScoreResultSchema = z.object({
  score: z.number(),
  riskLevel: z.enum(['critical', 'high', 'medium', 'low', 'minimal']),
  factors: z.array(
    z.object({
      name: z.string(),
      score: z.number(),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      description: z.string(),
    })
  ),
  recommendations: z.array(z.string()),
});
export type RiskScoreResult = z.infer<typeof RiskScoreResultSchema>;

// ============================================
// Impact Analysis Types
// ============================================

export const AnalyzeImpactResultSchema = z.object({
  changedFiles: z.array(z.string()),
  impactedFiles: z.array(
    z.object({
      file: z.string(),
      impactType: z.enum(['direct', 'imported', 'test', 'dependency']),
      reason: z.string(),
    })
  ),
  affectedTests: z.array(z.string()),
  affectedDependencies: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['imports', 'exports', 'calls']),
    })
  ),
  riskLevel: z.enum(['high', 'medium', 'low']),
  suggestions: z.array(z.string()),
});
export type AnalyzeImpactResult = z.infer<typeof AnalyzeImpactResultSchema>;

// ============================================
// Execution Tool Types
// ============================================

export const ExecutionResultSchema = z.object({
  success: z.boolean(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  duration: z.number(),
  command: z.string(),
  timedOut: z.boolean().optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const TestRunResultSchema = z.object({
  success: z.boolean(),
  totalTests: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  duration: z.number(),
  output: z.string(),
  failedTests: z.array(
    z.object({
      name: z.string(),
      error: z.string(),
      file: z.string().optional(),
    })
  ),
});
export type TestRunResult = z.infer<typeof TestRunResultSchema>;

export const LinterResultSchema = z.object({
  success: z.boolean(),
  errorCount: z.number(),
  warningCount: z.number(),
  fixableCount: z.number(),
  issues: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      column: z.number(),
      severity: z.enum(['error', 'warning']),
      rule: z.string(),
      message: z.string(),
    })
  ),
  output: z.string(),
});
export type LinterResult = z.infer<typeof LinterResultSchema>;

export const FormatterResultSchema = z.object({
  success: z.boolean(),
  filesChecked: z.number(),
  filesChanged: z.number(),
  changedFiles: z.array(z.string()),
  output: z.string(),
});
export type FormatterResult = z.infer<typeof FormatterResultSchema>;

// ============================================
// Git Tool Types
// ============================================

export const GitStatusResultSchema = z.object({
  success: z.boolean(),
  isRepository: z.boolean(),
  branch: z.string().nullable(),
  staged: z.array(
    z.object({
      file: z.string(),
      status: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'ignored']),
      staged: z.boolean(),
    })
  ),
  unstaged: z.array(
    z.object({
      file: z.string(),
      status: z.enum(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'ignored']),
      staged: z.boolean(),
    })
  ),
  untracked: z.array(z.string()),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  error: z.string().optional(),
});
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>;

export const GitDiffResultSchema = z.object({
  success: z.boolean(),
  diff: z.string(),
  files: z.array(z.string()),
  additions: z.number(),
  deletions: z.number(),
  error: z.string().optional(),
});
export type GitDiffResult = z.infer<typeof GitDiffResultSchema>;

export const GitLogEntrySchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  author: z.string(),
  email: z.string(),
  date: z.string(),
  subject: z.string(),
  body: z.string(),
});
export type GitLogEntry = z.infer<typeof GitLogEntrySchema>;

export const GitLogResultSchema = z.object({
  success: z.boolean(),
  entries: z.array(GitLogEntrySchema),
  totalCount: z.number().optional(),
  error: z.string().optional(),
});
export type GitLogResult = z.infer<typeof GitLogResultSchema>;

export const GitCommitResultSchema = z.object({
  success: z.boolean(),
  hash: z.string().optional(),
  message: z.string().optional(),
  filesChanged: z.number().optional(),
  insertions: z.number().optional(),
  deletions: z.number().optional(),
  error: z.string().optional(),
});
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>;

// ============================================
// Edit Tool Result Types
// ============================================

export const ApplyDiffResultSchema = z.object({
  success: z.boolean(),
  hunksApplied: z.number(),
  hunksRejected: z.number(),
  conflicts: z.array(z.string()),
  backupPath: z.string().optional(),
  error: z.string().optional(),
});
export type ApplyDiffResult = z.infer<typeof ApplyDiffResultSchema>;

export const CreateFileResultSchema = z.object({
  success: z.boolean(),
  path: z.string().optional(),
  size: z.number().optional(),
  backupPath: z.string().optional(),
  error: z.string().optional(),
  syntaxErrors: z
    .array(
      z.object({
        line: z.number(),
        column: z.number(),
        message: z.string(),
        severity: z.enum(['error', 'warning']),
      })
    )
    .optional(),
});
export type CreateFileResult = z.infer<typeof CreateFileResultSchema>;

// ============================================
// LLM-Enhanced Tool Types (VS Code Bypass)
// ============================================

export const AnalyzeFileResultSchema = z.object({
  path: z.string(),
  // V17: content is now optional (default: not included to save context)
  content: z.string().optional(),
  truncated: z.boolean(),
  redaction: z
    .object({
      mode: z.enum(['default', 'strict']),
      totalReplacements: z.number(),
      byPattern: z.record(z.string(), z.number()),
    })
    .optional(),
  language: z.string(),
  analysis: z.string(),
  issues: z.array(
    z.object({
      type: z.string(),
      line: z.number().optional(),
      message: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
    })
  ),
  suggestions: z.array(z.string()),
  metrics: z.record(z.string(), z.number()),
  question: z.string().optional(),
  analysisType: z.enum(['quality', 'security', 'performance', 'documentation', 'full']),
  /** Timing metadata for LLM-heavy operations */
  timing: OperationTimingSchema.optional(),
});
export type AnalyzeFileResult = z.infer<typeof AnalyzeFileResultSchema>;

export const ExploreDirectoryResultSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['file', 'directory']),
      path: z.string(),
      size: z.number().optional(),
    })
  ),
  categorized: z.record(z.string(), z.array(z.string())),
  totalFiles: z.number(),
  totalDirectories: z.number(),
  analysis: z.string(),
  purpose: z.string(),
  recommendations: z.array(z.string()),
  keyFiles: z.array(
    z.object({
      path: z.string(),
      description: z.string(),
    })
  ),
  question: z.string().optional(),
});
export type ExploreDirectoryResult = z.infer<typeof ExploreDirectoryResultSchema>;

export const IntelligentSearchResultSchema = z.object({
  query: z.string(),
  intent: z.string().optional(),
  results: z.array(
    z.object({
      file: z.string(),
      relevanceScore: z.number(),
      reason: z.string(),
      matches: z.array(
        z.object({
          line: z.number(),
          preview: z.string(),
        })
      ),
    })
  ),
  totalMatches: z.number(),
  filesSearched: z.number(),
  searchSummary: z.string(),
  suggestedNextSteps: z.array(z.string()),
  /** Whether fallback relaxed search was used (Plan 1: search improvements) */
  usedFallback: z.boolean().optional(),
  /** Index status for transparency */
  indexStatus: z
    .object({
      indexed: z.boolean(),
      lastIndexedAt: z.string().optional(),
      indexedFilesCount: z.number().optional(),
    })
    .optional(),
  /** V12: Diagnostic object when 0 files found to help debug search issues */
  diagnostic: z
    .object({
      resolvedRoot: z.string(),
      queryUsed: z.string(),
      isRegex: z.boolean(),
      filePatternUsed: z.string(),
      fallbackAttempted: z.boolean(),
      suggestions: z.array(z.string()),
    })
    .optional(),
});
export type IntelligentSearchResult = z.infer<typeof IntelligentSearchResultSchema>;

export const LocalCodeReviewResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  filesReviewed: z.number(),
  issues: z.array(
    z.object({
      file: z.string(),
      line: z.number().optional(),
      severity: z.string(),
      message: z.string(),
      fix: z.string().optional(),
    })
  ),
  summary: z.string(),
  recommendations: z.array(z.string()),
  overallScore: z.number().optional(),
});
export type LocalCodeReviewResult = z.infer<typeof LocalCodeReviewResultSchema>;

export const GenerateDocsResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  documentation: z.string(),
  docType: z.enum(['jsdoc', 'readme', 'api', 'usage-examples']),
  path: z.string().optional(),
});
export type GenerateDocsResult = z.infer<typeof GenerateDocsResultSchema>;

export const GenerateTestsResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  tests: z.string(),
  framework: z.string(),
  coverage: z.enum(['basic', 'comprehensive', 'edge-cases']),
  testCount: z.number(),
  path: z.string().optional(),
  // Black-box V3: syntaxValid field indicates if generated tests are parseable
  syntaxValid: z.boolean().optional(),
  redaction: z
    .object({
      mode: z.enum(['default', 'strict']),
      totalReplacements: z.number(),
      byPattern: z.record(z.string(), z.number()),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  // V18: Hint for large files suggesting focusFunctions parameter
  largeFileHint: z.string().optional(),
  // V19 (QA_feedback_22012026): Include detected functions for large files
  detectedFunctions: z.array(z.string()).optional(),
});
export type GenerateTestsResult = z.infer<typeof GenerateTestsResultSchema>;

export const DraftCommitMessageResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  message: z.string(),
  style: z.enum(['conventional', 'detailed', 'simple']),
});
export type DraftCommitMessageResult = z.infer<typeof DraftCommitMessageResultSchema>;

export const SuggestRefactoringResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  suggestions: z.array(
    z.object({
      type: z.string(),
      description: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      before: z.string().optional(),
      after: z.string().optional(),
    })
  ),
  summary: z.string(),
  path: z.string().optional(),
});
export type SuggestRefactoringResult = z.infer<typeof SuggestRefactoringResultSchema>;

// Plan 1: suggest_edit - LLM-powered edit suggestions
export const SuggestEditResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  path: z.string(),
  intent: z.string(),
  suggestions: z.array(
    z.object({
      description: z.string(),
      before: z.string().optional(),
      after: z.string(),
      lineRange: z
        .object({
          start: z.number(),
          end: z.number(),
        })
        .optional(),
      confidence: z.enum(['high', 'medium', 'low']),
      explanation: z.string(),
    })
  ),
  summary: z.string(),
});
export type SuggestEditResult = z.infer<typeof SuggestEditResultSchema>;

// Plan 1: draft_file - LLM-powered file generation
export const DraftFileResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  path: z.string(),
  intent: z.string(),
  content: z.string(),
  language: z.string(),
  explanation: z.string(),
  warnings: z.array(z.string()).optional(),
});
export type DraftFileResult = z.infer<typeof DraftFileResultSchema>;

// ============================================
// Auto-Fix Tool Types
// ============================================

// Difficulty levels for filtering fixes
export const FixDifficultySchema = z.enum(['easy', 'medium', 'hard', 'all']);
export type FixDifficulty = z.infer<typeof FixDifficultySchema>;

// Individual fix applied
export const AppliedFixSchema = z.object({
  file: z.string(),
  line: z.number(),
  rule: z.string().optional(),
  difficulty: FixDifficultySchema,
  description: z.string(),
  before: z.string(),
  after: z.string(),
});
export type AppliedFix = z.infer<typeof AppliedFixSchema>;

// fix_linter result - LLM-powered linter issue fixing
export const FixLinterResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  difficulty: FixDifficultySchema,
  totalIssuesFound: z.number(),
  issuesFixed: z.number(),
  issuesSkipped: z.number(),
  fixes: z.array(AppliedFixSchema),
  skippedIssues: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      rule: z.string().optional(),
      difficulty: FixDifficultySchema,
      reason: z.string(),
    })
  ),
  filesModified: z.array(z.string()),
  summary: z.string(),
  backupPaths: z.array(z.string()).optional(),
});
export type FixLinterResult = z.infer<typeof FixLinterResultSchema>;

// fix_syntax result - LLM-powered syntax error fixing
export const FixSyntaxResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  difficulty: FixDifficultySchema,
  totalErrorsFound: z.number(),
  errorsFixed: z.number(),
  errorsSkipped: z.number(),
  fixes: z.array(AppliedFixSchema),
  skippedErrors: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      message: z.string(),
      difficulty: FixDifficultySchema,
      reason: z.string(),
    })
  ),
  filesModified: z.array(z.string()),
  summary: z.string(),
  backupPaths: z.array(z.string()).optional(),
});
export type FixSyntaxResult = z.infer<typeof FixSyntaxResultSchema>;

// implement_todos result - LLM-powered TODO implementation
export const ImplementTodosResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  difficulty: FixDifficultySchema,
  totalTodosFound: z.number(),
  todosImplemented: z.number(),
  todosSkipped: z.number(),
  implementations: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      todoType: z.enum(['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REFACTOR']),
      originalTodo: z.string(),
      difficulty: FixDifficultySchema,
      description: z.string(),
      codeAdded: z.string(),
      linesAdded: z.number(),
    })
  ),
  skippedTodos: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      todoType: z.string(),
      content: z.string(),
      difficulty: FixDifficultySchema,
      reason: z.string(),
    })
  ),
  filesModified: z.array(z.string()),
  summary: z.string(),
  backupPaths: z.array(z.string()).optional(),
});
export type ImplementTodosResult = z.infer<typeof ImplementTodosResultSchema>;

// ============================================
// Plan 1: Complete Edit Loop - Find and Fix Tool Types
// ============================================

// Find and Fix result - chains search → analyze → suggest_edit with optional apply
export const FindAndFixResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  query: z.string(),
  intent: z.string(),
  filesAnalyzed: z.number(),
  suggestionsGenerated: z.number(),
  suggestionsApplied: z.number(),
  results: z.array(
    z.object({
      file: z.string(),
      suggestions: z.array(
        z.object({
          description: z.string(),
          before: z.string().optional(),
          after: z.string(),
          lineRange: z
            .object({
              start: z.number(),
              end: z.number(),
            })
            .optional(),
          confidence: z.enum(['high', 'medium', 'low']),
          applied: z.boolean(),
          applyError: z.string().optional(),
        })
      ),
    })
  ),
  summary: z.string(),
  backupPaths: z.array(z.string()).optional(),
});
export type FindAndFixResult = z.infer<typeof FindAndFixResultSchema>;

// Security fix result - auto-generates replacement code for detected secrets
export const SecurityFixResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number(),
      type: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      originalCode: z.string(),
      suggestedFix: z.string(),
      explanation: z.string(),
      applied: z.boolean(),
      applyError: z.string().optional(),
    })
  ),
  totalFindings: z.number(),
  fixesApplied: z.number(),
  summary: z.string(),
  backupPaths: z.array(z.string()).optional(),
});
export type SecurityFixResult = z.infer<typeof SecurityFixResultSchema>;

// ============================================
// Plan 2: Output Density Controls
// ============================================

export const OutputFormatSchema = z.enum(['compact', 'dense', 'detailed', 'json']);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

// Dense output wrapper - strips metadata, keeps only essential fields
export const DenseOutputSchema = z.object({
  // Core fields that are always included
  path: z.string().optional(),
  lineRange: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
  code: z.string().optional(),
  action: z.string().optional(),
  message: z.string().optional(),
  // Array of results in dense format
  results: z
    .array(
      z.object({
        path: z.string().optional(),
        line: z.number().optional(),
        content: z.string().optional(),
      })
    )
    .optional(),
});
export type DenseOutput = z.infer<typeof DenseOutputSchema>;

// ============================================
// Plan 3: Proactive Warnings System
// ============================================

export const WarningSeveritySchema = z.enum(['critical', 'warning', 'info']);
export type WarningSeverity = z.infer<typeof WarningSeveritySchema>;

export const ProactiveWarningSchema = z.object({
  id: z.string(),
  severity: WarningSeveritySchema,
  type: z.string(), // 'secret', 'vulnerability', 'quality', 'performance'
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
  timestamp: z.number(),
});
export type ProactiveWarning = z.infer<typeof ProactiveWarningSchema>;

export const ProactiveWarningsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  severityThreshold: WarningSeveritySchema.default('warning'),
  scanOnFileOpen: z.boolean().default(true),
  cacheWarnings: z.boolean().default(true),
  cacheTtlMs: z.number().default(300000), // 5 minutes
});
export type ProactiveWarningsConfig = z.infer<typeof ProactiveWarningsConfigSchema>;

// ============================================
// Plan 4: Smart Defaults & Filters
// ============================================

export const SmartDefaultsConfigSchema = z.object({
  // Default exclude patterns for searches and scans
  excludePatterns: z
    .array(z.string())
    .default([
      'node_modules/**',
      '.git/**',
      'venv/**',
      '.venv/**',
      '__pycache__/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '.next/**',
      '.nuxt/**',
      '*.min.js',
      '*.min.css',
      '*.map',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ]),
  // Auto-detect and add project-specific excludes
  autoDetectExcludes: z.boolean().default(true),
  // Legacy alias for autoDetectExcludes
  autoDetect: z.boolean().optional(),
  // Include patterns (override excludes)
  includePatterns: z.array(z.string()).optional(),
  // Custom exclude patterns (added to default)
  customExcludePatterns: z.array(z.string()).optional(),
  // Custom include patterns
  customIncludePatterns: z.array(z.string()).optional(),
});
export type SmartDefaultsConfig = z.infer<typeof SmartDefaultsConfigSchema>;

// ============================================
// Plan 5: Tool Contract Standardization
// ============================================

export const ToolContractSchema = z.object({
  name: z.string(),
  version: z.string().default('1.0.0'),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  sideEffects: z.array(z.enum(['read', 'write', 'network', 'process'])).default(['read']),
  timeout: z.number().optional(),
  retryable: z.boolean().default(true),
});
export type ToolContract = z.infer<typeof ToolContractSchema>;

export const ToolContractValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      field: z.string(),
      message: z.string(),
      expected: z.string().optional(),
      received: z.string().optional(),
    })
  ),
  warnings: z.array(
    z.object({
      field: z.string(),
      message: z.string(),
    })
  ),
});
export type ToolContractValidationResult = z.infer<typeof ToolContractValidationResultSchema>;

// Plan V6: generate_agents_md - Generate AGENTS.md from project structure
export const GenerateAgentsMdResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  path: z.string().optional(),
  content: z.string(),
  sections: z.array(
    z.object({
      name: z.string(),
      present: z.boolean(),
    })
  ),
  existedBefore: z.boolean(),
  warnings: z.array(z.string()).optional(),
});
export type GenerateAgentsMdResult = z.infer<typeof GenerateAgentsMdResultSchema>;
