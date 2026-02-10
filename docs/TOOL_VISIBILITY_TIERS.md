# Tool Visibility Tiers

## Overview

Based on extensive LLM feedback analysis (10+ different LLMs including Grok, Gemini, Qwen3, GPT-5 Mini, Claude Opus, etc.), the MCP Local LLM server implements a **three-tier tool visibility system** to optimize context window usage while maintaining full capability for complex agent tasks.

## LLM Feedback Summary (December 2024)

After testing with 10+ LLMs, we found consistent patterns:

### Tools LLMs Would Use Immediately (High Value)
- `search` - Semantic search is superior to literal grep
- `analyze_file` - LLM-powered quality/security insights
- `suggest_edit` - Safe edit suggestions without applying changes
- `code_helper` - Code explanation and optimization
- `local_code_review` - Privacy-preserving code review
- `security` - Secret scanning and vulnerability detection
- `summarize` - LLM-powered summaries of files/repos
- `workspace` - Directory snapshots, metadata, and exploration

### Tools LLMs Mark as "Never Use for Coding"
- `system_profile` - Hardware info, not coding-related
- `model_info` - Meta info about models
- `mcp_debug` - Infrastructure debugging
- `agent_queue_status` - Internal queue management
- `agent_task_result` - Async task polling
- `mcp_terminal_command` - "I have direct terminal access" (redundant)
- `refine_prompt` - "Meta-redundancy" (not coding-related)
- `llm_chat` - "I am already an LLM" (but useful for LOCAL privacy-preserving operations)

### Tools LLMs Consider Lower Priority
- `mcp_health` - Useful for server health checks but not direct coding
- `agent_task` - "Complexity overhead" (but useful for multi-file analysis)

## The Problem

LLMs consistently reported that certain tools are **"never used for coding"**:
- `system_profile` - Hardware info, not useful for coding tasks
- `model_info` - Meta info about models, not for coding
- `mcp_health` - Server diagnostics, infrastructure only
- `mcp_debug` - Infrastructure debugging, not for coding
- `agent_queue_status` - Only useful when managing agent_task queue
- `agent_task_result` - Only useful for async agent_task polling
- `mcp_terminal_command` - LLMs have native terminal access
- `refine_prompt` - Not relevant for coding

Exposing these tools wastes context window tokens (~800+ tokens) and clutters the tool list, reducing LLM effectiveness on actual coding tasks.

## Three-Tier Solution

### Tier 1: Core Tools (Always Exposed)
**~1,000 tokens** - High-value tools used in >80% of coding sessions

```typescript
CORE_TOOLS = [
  // PRIMARY ENTRY POINT (LLMs delegate complex work here)
  'agent_task',       // Autonomous agent for multi-step tasks
  'mcp_health',       // Essential health checks
  
  // HIGH-VALUE CODING TOOLS (LLMs consistently rate 5/5)
  'search',           // Semantic code search - superior to grep
  'analyze_file',     // LLM-powered file analysis
  'suggest_edit',     // Safe edit suggestions
  
  // SECURITY & QUALITY (LLMs rate 4-5/5)
  'security',         // Secret scanning
  'local_code_review', // Privacy-preserving code review
  
  // DISCOVERY & DOCUMENTATION
  'summarize',        // Quick file/repo overviews
  'workspace',        // File metadata, directory snapshots, exploration
  'discover_tools',   // Meta-tool for finding more tools
]
```

### Tier 2: Discoverable Tools (Via `discover_tools`)
**~4,000 tokens when expanded** - Available on-demand via categories or search

Categories:
- `code_analysis` - find_duplicates, code_quality_analyzer, analyze_file, code_helper, mcp_analyze_complexity
- `security` - security, local_code_review, analyze_impact
- `testing` - analyze_test_gaps
- `documentation` - generate_docs, mcp_diff_summarizer, summarize, generate_agents_md
- `refactoring` - suggest_refactoring, refactor_helper, suggest_edit, draft_file, find_and_fix
- `planning` - agent_task, mcp_plan_implementation, cli_orchestrate
- `search` - search, codebase_qa, todos, index_symbols, cross_file_links
- `llm_assistance` - code_helper, regex_helper, refactor_helper, mcp_error_explainer, mcp_translate_code, mcp_summarize_logs
- `execution` - linter, formatter
- `workspace` - workspace, analyze_file
- `system` - mcp_health

### Tier 3: Agent-Only Tools (Hidden from MCP, Full Agent Access)
**0 tokens in standard MCP** - Only accessible via `agent_task` workflow or direct CallTool

```typescript
AGENT_ONLY_TOOLS = [
  // Direct chat is redundant for tool-calling LLMs
  'llm_chat',            // LLMs say "I am already an LLM" - prefer agent_task
  
  // Async task orchestration (only needed after agent_task returns taskId)
  'agent_task_result',   // Async task polling - internal workflow
  'agent_queue_status',  // Queue management - overlaps with mcp_health
  
  // MCP configuration (only useful for agent workflows)
  'mcp_server',          // MCP server connection management
  'mcp_ask',             // Delegating tasks to other MCP servers
  
  // Infrastructure tools (LLMs say "not for coding")
  'system_profile',      // Hardware info - infrastructure
  'model_info',          // Model metadata - infrastructure
  'mcp_debug',           // Debug logs - infrastructure
  
  // Meta/redundant tools (LLMs say "I already have this capability")
  'mcp_terminal_command', // LLMs have native terminal access
  'refine_prompt',       // Meta-redundancy - not coding-related

  // Hidden alias tools (kept for compatibility, not exposed in ListTools)
  'read_file',           // Alias of analyze_file - prefer VS Code #readFile

  // Heavy planning tools (agent-only for performance)
  'verify_plan',         // Plan verification - use agent_task
]
```

## Implementation Details

### ListTools Handler (mcp.ts)
```typescript
// Filters out agent-only tools from MCP exposure
this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools
    .filter((tool) => {
      // Exclude agent-only tools from direct MCP exposure
      if (this.toolDiscoveryManager?.isAgentOnly(tool.name)) {
        return false;
      }
      return allEnabled || enabledTools.has(tool.name);
    })
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));
```

### CallTool Handler (mcp.ts)
**Curated mode (default)**: Only tools in the expanded set can be called directly.
**Full mode** (`toolDiscovery.fullToolList: true`): All tools are callable.

```typescript
// CallTool checks the expanded tool set when in curated mode
const useFullList = toolDiscoveryConfig?.fullToolList ?? false;
if (!useFullList) {
  const expanded = this.toolDiscoveryManager?.getExpandedToolNames() ?? [];
  if (expanded.length > 0 && !expanded.includes(name)) {
    return { isError: true, errorType: 'tool_hidden', ... };
  }
}
// Tool handlers execute normally
```

**How to access agent-only tools:**
1. Use `discover_tools` to expand the tool set first
2. Use `agent_task` to delegate (agent has full tool access)
3. Set `toolDiscovery.fullToolList: true` in config for legacy/full access

### AgentRunner (runner.ts)
Uses `mcp_call` action to invoke MCP tools, which goes through CallTool:
```typescript
case 'mcp_call': {
  // Agents can call ANY tool including agent-only tools
  const result = await mcpClient.callTool(serverName, toolName, args);
}
```

## Token Savings

| Configuration | Tools Exposed | Approx. Tokens |
|--------------|---------------|----------------|
| Before (all 47 tools) | 47 | ~6,900 |
| After - Core Only | 10 | ~1,300 |
| After - Full Progressive | 35 | ~5,200 |

**Savings: ~1,500 tokens** by hiding 12 agent-only tools, plus improved signal-to-noise ratio.

## Testing

### Tool Count Tests (real.base-tools.test.ts)
```typescript
it('should list 35 tools (excluding 12 agent-only infrastructure tools)', async () => {
  const res = await ctx.client.listTools();
  expect(res.tools.length).toBe(35);
  
  // Verify agent-only tools are NOT in the list
  const names = res.tools.map((t) => t.name);
  expect(names).not.toContain('system_profile');
  expect(names).not.toContain('mcp_server');
  expect(names).not.toContain('mcp_ask');
  expect(names).not.toContain('mcp_terminal_command');
  expect(names).not.toContain('refine_prompt');
  // ... etc
});
```

### Agent Access Tests (real.base-tools.test.ts)
```typescript
it('should still allow calling agent-only tools via CallTool', async () => {
  // Agent-only tools are hidden from ListTools but must remain callable
  const profile = await ctx.client.callTool({
    name: 'system_profile',
    arguments: { detail: 'basic' }
  });
  expect(profile.isError).not.toBe(true);
});
```

## Usage Guidelines

### For Direct MCP Calls (VS Code Copilot, etc.)
Use the 35 exposed tools. If you need infrastructure info, use `agent_task`:
```
Use agent_task to check system diagnostics and queue status
```

### For Agent Tasks
Full access to all 47 tools including agent-only:
```typescript
agent_task({
  task: "Check system health and queue status",
  allowedActions: ['mcp_call'],
  allowMcpServers: ['mcp-local-llm']
})
```

## Related Files
- [tool-discovery.ts](../src/server/tool-discovery.ts) - CORE_TOOLS, AGENT_ONLY_TOOLS, categories
- [mcp.ts](../src/server/mcp.ts) - ListTools and CallTool handlers
- [runner.ts](../src/agent/runner.ts) - AgentRunner with mcp_call action
- [real.base-tools.test.ts](../tests/real-mcp/real.base-tools.test.ts) - Visibility tier tests
