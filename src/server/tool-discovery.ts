/**
 * Tool Discovery Manager
 *
 * Implements the Hybrid Autonomous Maximum strategy for reducing context window usage
 * while maintaining full tool capability:
 *
 * - Layer 1: Schema Compression (handled in mcp.ts)
 * - Layer 2: Smart Core Selection (CORE_TOOLS)
 * - Layer 3: discover_tools meta-tool (searchTools, getToolsByCategory)
 * - Layer 4: Progressive Expansion (getRelatedTools, detectIntent)
 * - Layer 5: Agent-Only Tools (full access for agent_task, hidden from direct MCP)
 */

import type { JSONSchema } from './mcp.js';

// Tool definition interface matching mcp.ts
export interface ToolDefinition {
  name: string;
  group: string;
  description: string;
  inputSchema: JSONSchema;
}

/**
 * Core tools that are ALWAYS loaded initially (~1,500-2,000 tokens)
 * Selected based on LLM usage analysis (10+ LLMs tested, December 2024):
 *
 * 1. Universal utility (used in >80% of coding sessions)
 * 2. High-value coding tasks (search, analyze, generate)
 * 3. Gateway to other capabilities (discover_tools)
 *
 * REMOVED FROM CORE based on LLM feedback (December 2024):
 * - llm_chat: LLMs say "I am already an LLM" - moved to discoverable
 *
 * 2025 update (IDE/Vibe Coding):
 * - agent_task is promoted into CORE as the primary delegation mechanism (with agent_task_result polling).
 * - mcp_terminal_command: "I have direct terminal access" - redundant
 * - refine_prompt: "Meta-redundancy" - not coding-related
 *
 * These are still available via discover_tools or direct CallTool.
 */
export const CORE_TOOLS: readonly string[] = [
  // IDE/Vibe Coding: Minimal high-signal tool surface for LLM-driven workflows.
  // The IDE agent should delegate complex/iterative tasks to agent_task.
  // agent_task_result and agent_queue_status moved to AGENT_ONLY:
  //   - agent_task_result: Only needed after async=true; returned taskId guides polling
  //   - agent_queue_status: Overlaps with mcp_health; internal monitoring
  'agent_task', // Primary delegation mechanism - LLM sends task, agent executes
  'mcp_health', // Essential health checks (subsumes queue status when needed)

  // HIGH-VALUE CODING TOOLS (LLMs consistently rate 5/5)
  'search', // Semantic/structured search and context gather
  'analyze_file', // LLM-powered file analysis - quality/security/performance
  'suggest_edit', // Safe edit suggestions without applying changes
  // 'generate_tests' - REMOVED V21 (QA_feedback_8: unreliable output quality)
  'local_code_review', // Privacy-preserving code review
  'security', // Secret scanning - deterministic, fast
  'summarize', // Quick file/repo overviews
  'workspace', // File metadata, directory snapshots, exploration (V11: promoted to core based on feedback)

  // PLANNING - verify_plan removed from Core (too heavy for local LLM, use agent_task instead)

  // DISCOVERY
  'discover_tools', // Meta-tool for finding additional tools on demand
] as const;

/**
 * Agent-only tools - hidden from direct MCP calls in curated mode
 *
 * Based on LLM feedback analysis (10+ LLMs tested, December 2024):
 * These tools are consistently marked as "never used for coding" because they're
 * infrastructure/meta tools that don't help with actual code development.
 *
 * Why hide them:
 * - Saves ~800 context tokens
 * - Reduces tool list clutter (improves LLM tool selection accuracy)
 * - These tools are only needed for debugging/diagnostics, not coding
 *
 * How to access:
 * - Via agent_task: Agent has full access to all tools
 * - Via discover_tools: Expand tool set with category="system" or search
 * - Via config: Set toolDiscovery.fullToolList=true for legacy/full access
 *
 * The agent_task tool has FULL ACCESS to all tools including these.
 */
export const AGENT_ONLY_TOOLS: readonly string[] = [
  // Direct chat is redundant for a tool-calling IDE LLM; prefer agent_task.
  // The server still uses LlmChatTool internally for LLM-enhanced tools and agent_task planning.
  'llm_chat',

  // Async task orchestration (only needed when agent_task returns taskId)
  // LLMs can call these if needed, but they're hidden to reduce tool list clutter
  'agent_task_result', // Poll for async task result - only useful after async=true
  'agent_queue_status', // Queue monitoring - overlaps with mcp_health

  // MCP server management - only useful for agent_task workflows
  // External LLMs don't need to manage MCP connections directly
  'mcp_server', // Connect/disconnect/list external MCP servers - agent_task only
  'mcp_ask', // LLM-assisted external MCP calls - agent_task only

  // Infrastructure tools (rarely needed by tool-calling LLMs)
  'system_profile', // Hardware info - usually not needed for coding tasks
  'model_info', // Model metadata - mostly advisory
  'mcp_debug', // Debug logs - keep out of the default tool list

  // Meta/redundant tools (LLMs say "I already have this capability")
  'mcp_terminal_command', // LLMs have native terminal access
  'refine_prompt', // Meta-redundancy - not coding-related

  // Hidden alias tools (kept for compatibility, not exposed in ListTools)
  'read_file', // Alias of analyze_file - prefer VS Code #readFile

  // QA_feedback_26012026: verify_plan is too heavy for local LLMs, use agent_task instead
  'verify_plan', // Plan verification - only via agent_task (requires multiple LLM calls)
] as const;

/**
 * Agent-only tools that remain directly callable in curated mode.
 *
 * Rationale: some MCP client integrations only allow calling tools they can
 * see/track, and async `agent_task` needs a reliable polling surface.
 * These tools stay hidden from ListTools to reduce clutter, but remain callable
 * by name for advanced clients and compatibility.
 */
export const AGENT_ONLY_DIRECT_CALL_TOOLS: readonly string[] = [
  'agent_task_result',
  'agent_queue_status',
] as const;

/**
 * Tool categories for browsing
 *
 * NOTE: Agent-only tools are intentionally excluded from these categories.
 * They are accessible via agent_task but should not appear in discover_tools results
 * to avoid confusion for IDE LLMs that cannot directly call them.
 *
 * Agent-only tools (hidden from categories):
 * - llm_chat, agent_task_result, agent_queue_status
 * - mcp_server, mcp_ask
 * - system_profile, model_info, mcp_debug
 * - mcp_terminal_command, refine_prompt
 * - read_file, verify_plan
 */
export const TOOL_CATEGORIES = {
  code_analysis: {
    description: 'Code quality, duplicates, and complexity checks',
    tools: [
      'find_duplicates',
      'code_quality_analyzer',
      'analyze_file',
      'code_helper',
      'mcp_analyze_complexity',
    ],
  },
  security: {
    description: 'Secrets, vulnerability scanning, and risk analysis',
    tools: ['security', 'local_code_review', 'analyze_impact'],
  },
  testing: {
    description: 'Test coverage and missing-test analysis',
    // generate_tests removed V21 (QA_feedback_8: unreliable output quality)
    tools: ['analyze_test_gaps'],
  },
  documentation: {
    description: 'Docs generation and concise code summaries',
    tools: ['generate_docs', 'mcp_diff_summarizer', 'summarize', 'generate_agents_md'],
  },
  refactoring: {
    description: 'Refactoring, extraction, and naming suggestions',
    tools: ['suggest_refactoring', 'refactor_helper', 'suggest_edit', 'draft_file', 'find_and_fix'],
  },
  planning: {
    description: 'Planning, orchestration, and autonomous task execution',
    // agent_queue_status, agent_task_result, and verify_plan are agent-only (hidden)
    // verify_plan is too heavy for local LLMs - use agent_task for plan verification
    tools: ['agent_task', 'orchestration', 'mcp_plan_implementation', 'cli_orchestrate'],
  },
  search: {
    description: 'Search code, symbols, TODOs, and links',
    tools: ['search', 'codebase_qa', 'todos', 'index_symbols', 'cross_file_links'],
  },
  llm_assistance: {
    description: 'LLM assistance for explanation, regex, and diagnostics',
    tools: [
      'code_helper',
      'regex_helper',
      'refactor_helper',
      'mcp_error_explainer',
      'mcp_translate_code',
      'mcp_summarize_logs',
    ],
  },
  execution: {
    description: 'Linting, formatting, and syntax validation',
    tools: ['linter', 'formatter'],
  },
  workspace: {
    description: 'Workspace metadata, snapshots, and exploration',
    tools: ['workspace', 'analyze_file'],
  },
  system: {
    description: 'Health and system diagnostics',
    // system_profile and model_info are agent-only (hidden)
    tools: ['mcp_health'],
  },
  // NOTE: 'mcp' category removed - mcp_server and mcp_ask are agent-only
  // They are accessible via agent_task with allowMcpServers option
} as const;

/**
 * Tool relationships for progressive expansion
 * When tool A is used, consider adding tool B
 */
export const TOOL_RELATIONSHIPS: Record<string, string[]> = {
  // Code analysis flow
  code_helper: ['refactor_helper', 'suggest_refactoring'],
  find_duplicates: ['code_quality_analyzer', 'suggest_refactoring'],
  analyze_file: ['local_code_review', 'suggest_edit'],

  // Security flow
  security: ['local_code_review', 'analyze_impact'],
  local_code_review: ['suggest_edit', 'security'],

  // Testing flow - generate_tests removed V21
  analyze_test_gaps: ['analyze_file', 'local_code_review'],

  // Documentation flow
  generate_docs: ['summarize', 'mcp_diff_summarizer'],
  summarize: ['analyze_file', 'generate_docs'],
  generate_agents_md: ['generate_docs', 'summarize'],

  // Refactoring flow
  suggest_refactoring: ['refactor_helper', 'suggest_edit'],
  refactor_helper: ['suggest_refactoring', 'code_helper'],
  suggest_edit: ['draft_file', 'suggest_refactoring'],

  // Planning flow
  agent_task: ['agent_queue_status', 'agent_task_result', 'verify_plan'],
  verify_plan: ['agent_task', 'mcp_plan_implementation'],

  // Search flow
  search: ['codebase_qa', 'todos', 'index_symbols'],
  codebase_qa: ['search', 'analyze_file'],
  todos: ['search', 'code_quality_analyzer'],

  // MCP flow
  mcp_server: ['mcp_ask'],
  mcp_ask: ['mcp_server'],

  // LLM assistance flow
  mcp_error_explainer: ['code_helper', 'analyze_file'],
  regex_helper: ['code_helper'],
};

/**
 * Intent keywords for automatic tool expansion
 */
export const INTENT_KEYWORDS: Record<string, string[]> = {
  code_analysis: ['quality', 'duplicate', 'complexity', 'smell', 'analyze code', 'code review'],
  security: ['security', 'vulnerability', 'secret', 'risk', 'audit', 'scan'],
  testing: ['test', 'coverage', 'gap', 'unittest', 'spec', 'assertion'],
  documentation: ['doc', 'document', 'readme', 'jsdoc', 'comment', 'explain'],
  refactoring: ['refactor', 'rename', 'extract', 'simplify', 'clean', 'improve'],
  planning: ['plan', 'implement', 'feature', 'step', 'task', 'workflow'],
  search: ['find', 'search', 'todo', 'fixme', 'symbol', 'reference'],
};

/**
 * Black-box V3/V18: Tool examples with minimal valid request/response payloads.
 * These help small local models understand how to call tools correctly.
 *
 * V18: Enhanced examples with multiple action variations for complex tools.
 */
export const TOOL_EXAMPLES: Record<
  string,
  {
    request: Record<string, unknown>;
    description: string;
    variations?: Array<{ request: Record<string, unknown>; description: string }>;
  }
> = {
  // Core tools
  search: {
    request: { action: 'intelligent', query: 'authentication service' },
    description: 'Search code or filenames. root is optional and defaults to ".".',
    variations: [
      {
        request: { action: 'intelligent', query: 'error handling', root: 'src', maxResults: 10 },
        description: 'Natural language search in src/',
      },
      {
        request: { action: 'structured', query: 'UserService', root: 'src', targetType: 'class' },
        description: 'Find class symbols by name',
      },
      {
        request: { action: 'filenames', query: 'config', includeHidden: false },
        description: 'Find files by name/path pattern',
      },
      {
        request: { action: 'gather', query: 'authentication flow', path: 'src', maxFiles: 5 },
        description: 'Collect context files for a topic',
      },
    ],
  },
  analyze_file: {
    request: { path: 'src/main.ts', analysisType: 'quality', includeContent: false },
    description: 'Analyze one file. Keep includeContent=false unless you need raw content.',
    variations: [
      {
        request: { path: 'src/auth.ts', analysisType: 'security', includeContent: false },
        description: 'Security-focused analysis',
      },
      {
        request: {
          path: 'src/utils.ts',
          question: 'What does this file export?',
          includeContent: false,
        },
        description: 'Targeted question over one file',
      },
      {
        request: { path: 'README.md', analysisType: 'documentation', includeContent: true },
        description: 'Include raw content only when needed',
      },
    ],
  },
  // generate_tests is intentionally NOT a core tool, but remains supported.
  // Keep an example here because small models learn call-shapes from TOOL_EXAMPLES.
  generate_tests: {
    request: { path: 'src/main.ts', framework: 'vitest', coverage: 'basic' },
    description: 'Generate test skeletons. Prefer agent_task + review for higher reliability.',
    variations: [
      {
        request: { path: 'src/utils/helpers.py', framework: 'pytest', coverage: 'basic' },
        description: 'Pytest example',
      },
      {
        request: { path: 'src/api/client.ts', framework: 'vitest', coverage: 'comprehensive' },
        description: 'Higher coverage example',
      },
    ],
  },
  agent_task: {
    request: {
      task: 'Find all TypeScript files and count total lines',
      readOnly: true,
      maxSteps: 50,
      maxActionsPerStep: 100,
    },
    description:
      'Autonomous multi-step execution. Use readOnly for analysis and async for long tasks.',
    variations: [
      {
        request: {
          task: 'Search for TODO comments and summarize by priority',
          readOnly: true,
          maxSteps: 30,
        },
        description: 'Read-only analysis flow',
      },
      {
        request: {
          task: 'Refactor function X to async/await',
          readOnly: false,
          maxSteps: 20,
          allowedActions: ['read_file', 'write_file', 'done'],
        },
        description: 'Constrained write flow',
      },
      {
        request: { task: 'Comprehensive codebase audit', readOnly: true, maxSteps: -1 },
        description: 'Unlimited steps (queue must be empty)',
      },
    ],
  },
  security: {
    request: { action: 'scan', root: 'src', include: ['*.ts', '*.js'] },
    description:
      'Security actions: scan, risk, redact, fix. scan can return coverage guidance with recommended include globs.',
    variations: [
      {
        request: { action: 'risk', content: 'API_KEY=abc123', context: 'config' },
        description: 'Risk score for inline content',
      },
      {
        request: { action: 'redact', content: 'token=secret', showContext: false },
        description: 'Redaction preview for inline content',
      },
    ],
  },
  summarize: {
    request: { action: 'path', path: 'src/', mode: 'compact' },
    description: 'Summarize file/directory/repo. Actions: path, repo.',
    variations: [
      {
        request: { action: 'repo', root: '.', mode: 'extended' },
        description: 'Detailed repository summary',
      },
    ],
  },
  suggest_edit: {
    request: { file_path: 'src/main.ts', intent: 'add error handling' },
    description: 'Get edit suggestions for one file; apply is optional.',
  },
  local_code_review: {
    request: { paths: ['src/main.ts'], focus: 'security' },
    description: 'Review code for issues. Focus: security, performance, style, comprehensive.',
  },
  mcp_health: {
    request: { includeDetails: true },
    description: 'Health diagnostics. Healthy when at least one backend is available.',
  },
  discover_tools: {
    request: { category: 'testing' },
    description: 'Browse tools by category/capability with optional examples.',
    variations: [
      {
        request: { capability: 'find duplicate code' },
        description: 'Search by capability description',
      },
      { request: { list_categories: true }, description: 'List all available categories' },
    ],
  },
  // Discoverable tools
  todos: {
    request: { action: 'find', root: 'src' },
    description: 'Find or implement TODO/FIXME markers. Actions: find|implement.',
  },
  generate_docs: {
    request: { path: 'src/main.ts', docType: 'jsdoc' },
    description: 'Generate docs. Types: jsdoc, readme, api, usage-examples.',
  },
  linter: {
    request: { action: 'run', files: ['src/'] },
    description: 'Run linter or apply lint fixes. Actions: run|fix|validate.',
  },
  codebase_qa: {
    request: { question: 'How does authentication work?', root: '.' },
    description: 'Ask codebase questions using local context.',
  },
};

/**
 * Tool Discovery Manager
 * Manages dynamic tool loading and progressive expansion
 */
export class ToolDiscoveryManager {
  private allTools: ToolDefinition[];
  private toolsByName: Map<string, ToolDefinition>;
  private expandedTools: Set<string>;
  private coreToolNames: string[];

  constructor(allTools: ToolDefinition[], options?: { coreTools?: string[] }) {
    this.allTools = allTools;
    this.toolsByName = new Map(allTools.map((t) => [t.name, t]));

    const requestedCore =
      Array.isArray(options?.coreTools) && options!.coreTools.length > 0 ? options!.coreTools : [];

    const resolvedCore = (requestedCore.length > 0 ? requestedCore : [...CORE_TOOLS]).filter((t) =>
      this.toolsByName.has(t)
    );

    // If the configured core tool list is invalid/empty, fall back to the built-in defaults.
    this.coreToolNames =
      resolvedCore.length > 0
        ? resolvedCore
        : [...CORE_TOOLS].filter((t) => this.toolsByName.has(t));

    this.expandedTools = new Set(this.coreToolNames);
  }

  /**
   * Get names of core tools (always loaded)
   */
  getCoreToolNames(): string[] {
    return [...this.coreToolNames];
  }

  /**
   * Get full tool definitions for core tools
   */
  getCoreTools(): ToolDefinition[] {
    return this.allTools.filter((t) => this.coreToolNames.includes(t.name));
  }

  /**
   * Get currently expanded tool set
   */
  getExpandedToolNames(): string[] {
    return [...this.expandedTools];
  }

  /**
   * Get tool definitions for expanded set
   */
  getExpandedTools(): ToolDefinition[] {
    return this.allTools.filter((t) => this.expandedTools.has(t.name));
  }

  /**
   * Search for tools by natural language capability description
   */
  searchTools(capability: string): ToolDefinition[] {
    const query = capability.toLowerCase();
    const results: Array<{ tool: ToolDefinition; score: number }> = [];

    for (const tool of this.allTools) {
      let score = 0;

      // Check name
      if (tool.name.toLowerCase().includes(query)) {
        score += 10;
      }

      // Check description
      const desc = tool.description.toLowerCase();
      const queryWords = query.split(/\s+/);
      for (const word of queryWords) {
        if (word.length > 2 && desc.includes(word)) {
          score += 3;
        }
      }

      // Check if name words match query
      const nameWords = tool.name.split('_');
      for (const word of nameWords) {
        if (query.includes(word.toLowerCase())) {
          score += 5;
        }
      }

      if (score > 0) {
        results.push({ tool, score });
      }
    }

    // Sort by score and return top matches
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.tool);
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: string): ToolDefinition[] {
    const cat = TOOL_CATEGORIES[category as keyof typeof TOOL_CATEGORIES];
    if (!cat) {
      return [];
    }
    return cat.tools
      .map((name) => this.toolsByName.get(name))
      .filter((t): t is ToolDefinition => t !== undefined);
  }

  /**
   * Get all available categories
   */
  getCategories(): Array<{ name: string; description: string; toolCount: number }> {
    return Object.entries(TOOL_CATEGORIES).map(([name, cat]) => ({
      name,
      description: cat.description,
      toolCount: cat.tools.length,
    }));
  }

  /**
   * Get related tools for expansion
   */
  getRelatedTools(usedTools: string[]): ToolDefinition[] {
    const related = new Set<string>();

    for (const usedTool of usedTools) {
      const relationships = TOOL_RELATIONSHIPS[usedTool];
      if (relationships) {
        for (const relatedTool of relationships) {
          if (!this.expandedTools.has(relatedTool)) {
            related.add(relatedTool);
          }
        }
      }
    }

    return [...related]
      .map((name) => this.toolsByName.get(name))
      .filter((t): t is ToolDefinition => t !== undefined);
  }

  /**
   * Detect intent from request and suggest tools
   */
  detectIntent(request: string): { category: string; tools: ToolDefinition[] }[] {
    const requestLower = request.toLowerCase();
    const matches: { category: string; tools: ToolDefinition[] }[] = [];

    for (const [category, keywords] of Object.entries(INTENT_KEYWORDS)) {
      const matchedKeywords = keywords.filter((k) => requestLower.includes(k));
      if (matchedKeywords.length > 0) {
        matches.push({
          category,
          tools: this.getToolsByCategory(category),
        });
      }
    }

    return matches;
  }

  /**
   * Expand the tool set with new tools
   */
  expandWith(toolNames: string[]): void {
    for (const name of toolNames) {
      if (this.toolsByName.has(name)) {
        this.expandedTools.add(name);
      }
    }
  }

  /**
   * Reset to core tools only
   */
  reset(): void {
    this.expandedTools = new Set(this.coreToolNames);
  }

  /**
   * Check if a tool is currently expanded/available
   */
  isExpanded(toolName: string): boolean {
    return this.expandedTools.has(toolName);
  }

  /**
   * Check if a tool is agent-only (hidden from direct MCP, available to agent_task)
   */
  isAgentOnly(toolName: string): boolean {
    return (AGENT_ONLY_TOOLS as readonly string[]).includes(toolName);
  }

  /**
   * Get names of agent-only tools
   */
  getAgentOnlyToolNames(): string[] {
    return [...AGENT_ONLY_TOOLS];
  }

  /**
   * Get all tools for agent access (includes agent-only tools)
   * This is what agent_task uses - FULL tool access
   */
  getAllToolsForAgent(): ToolDefinition[] {
    return this.allTools;
  }

  /**
   * Get tools available for direct MCP exposure (excludes agent-only tools)
   */
  getDirectlyExposableTools(): ToolDefinition[] {
    return this.allTools.filter((t) => !this.isAgentOnly(t.name));
  }

  /**
   * Get expanded tools excluding agent-only (for MCP ListTools)
   */
  getExpandedToolsForMcp(): ToolDefinition[] {
    return this.allTools.filter((t) => this.expandedTools.has(t.name) && !this.isAgentOnly(t.name));
  }

  /**
   * Get a specific tool by name (regardless of expansion state)
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.toolsByName.get(name);
  }

  /**
   * Get all tools (for fullToolList mode)
   */
  getAllTools(): ToolDefinition[] {
    return this.allTools;
  }
}
