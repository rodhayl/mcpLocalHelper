# MCP Local LLM - API Reference

## Overview

MCP Local LLM is a Model Context Protocol server that provides LLM-enhanced development tools. This document provides a focused API reference for the core MCP surface and key tools. For the full tool inventory, see docs/TOOL_VISIBILITY_TIERS.md and src/server/mcp.ts.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MCP Client (VS Code, etc.)                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Local LLM Server                        │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Rate Limiter │  │ Task Queue   │  │ Tool Discovery        │  │
│  │ (per-client) │  │ (concurrent) │  │ (progressive loading) │  │
│  └─────────────┘  └──────────────┘  └───────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Tool Groups                            │ │
│  │  ┌─────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐          │ │
│  │  │ Core    │ │ Search │ │ Security│ │ LLM      │  ...     │ │
│  │  │ Tools   │ │ Tools  │ │ Tools   │ │ Enhanced │          │ │
│  │  └─────────┘ └────────┘ └─────────┘ └──────────┘          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                │                                 │
│                                ▼                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Backend Manager                          │ │
│  │  ┌──────────┐  ┌────────┐  ┌───────────┐  ┌───────────┐   │ │
│  │  │ LM Studio│  │ Ollama │  │ OpenRouter │  │ Generic   │   │ │
│  │  │ Adapter  │  │ Adapter│  │ Adapter    │  │ OpenAI    │   │ │
│  │  └──────────┘  └────────┘  └───────────┘  └───────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Tool Categories

### Core Tools (Always Available)

| Tool | Description |
|------|-------------|
| `agent_task` | Autonomous multi-step task execution |
| `mcp_health` | Server health and diagnostics |
| `search` | Semantic code search (intelligent/structured/gather) |
| `analyze_file` | LLM-powered file analysis |
| `suggest_edit` | Safe edit suggestions |
| `local_code_review` | Privacy-preserving code review |
| `security` | Secret scanning and risk assessment |
| `summarize` | File/repo summarization |
| `workspace` | Workspace metadata and exploration |
| `discover_tools` | Find additional tools by category |

### Discoverable Tools (Via `discover_tools`)

Access these by calling `discover_tools` with the appropriate category:

- **code_analysis**: `find_duplicates`, `code_quality_analyzer`, `analyze_file`, `code_helper`, `mcp_analyze_complexity`
- **security**: `security`, `local_code_review`, `analyze_impact`
- **testing**: `analyze_test_gaps`
- **documentation**: `generate_docs`, `mcp_diff_summarizer`, `summarize`, `generate_agents_md`
- **refactoring**: `suggest_refactoring`, `refactor_helper`, `suggest_edit`, `draft_file`, `find_and_fix`
- **planning**: `agent_task`, `mcp_plan_implementation`, `cli_orchestrate`
- **search**: `search`, `codebase_qa`, `todos`, `index_symbols`, `cross_file_links`
- **llm_assistance**: `code_helper`, `regex_helper`, `refactor_helper`, `mcp_error_explainer`, `mcp_translate_code`, `mcp_summarize_logs`
- **execution**: `linter`, `formatter`
- **workspace**: `workspace`, `analyze_file`
- **system**: `mcp_health`

## Error Codes

All errors follow a consistent format:

```json
{
  "error": true,
  "code": "ERROR_CODE",
  "message": "Human-readable message",
  "statusCode": 400,
  "retryable": false,
  "timestamp": "2024-12-31T12:00:00.000Z",
  "context": { "additional": "info" }
}
```

| Code | Status | Retryable | Description |
|------|--------|-----------|-------------|
| `RATE_LIMIT_EXCEEDED` | 429 | Yes | Client exceeded request quota |
| `TIMEOUT` | 504 | Yes | Operation took too long |
| `BACKEND_UNAVAILABLE` | 503 | Yes | LLM backend not reachable |
| `VALIDATION_ERROR` | 400 | No | Invalid input parameters |
| `PATH_ACCESS_DENIED` | 403 | No | Path outside allowlist |
| `FILE_NOT_FOUND` | 404 | No | Requested file doesn't exist |
| `TOOL_NOT_FOUND` | 404 | No | Tool doesn't exist |
| `TOOL_HIDDEN` | 403 | No | Tool exists but not exposed |
| `QUEUE_FULL` | 503 | Yes | Task queue at capacity |
| `AGENT_TASK_ERROR` | 500 | No | Agent task execution failed |
| `LLM_RESPONSE_ERROR` | 502 | Yes | Invalid LLM response |
| `ABORTED` | 499 | No | Operation cancelled |
| `INTERNAL_ERROR` | 500 | No | Unexpected internal error |

## Tool Reference

### agent_task

Execute autonomous multi-step tasks.

**Parameters:**
```typescript
{
  task: string;           // Task description
  contextRoot?: string;   // Working directory
  maxSubtasks?: number;   // Max subtask count (default: 5)
  maxSteps?: number;      // Max steps per subtask (default: 10)
  readOnly?: boolean;     // Prevent file modifications
  async?: boolean;        // Return taskId for polling
  allowMcpServers?: string[];  // Allowed MCP server connections
}
```

**Example:**
```json
{
  "task": "Analyze the security posture of this codebase",
  "readOnly": true,
  "maxSteps": 5
}
```

### search

Semantic code search with multiple modes.

**Parameters:**
```typescript
{
  action: 'intelligent' | 'structured' | 'gather';
  query: string;          // Search query
  path?: string;          // Directory to search
  options?: {
    maxResults?: number;  // Result limit
    fileTypes?: string[]; // File extensions to include
  };
}
```

**Example:**
```json
{
  "action": "intelligent",
  "query": "authentication middleware",
  "path": "src/"
}
```

### security

Security scanning and risk assessment.

**Parameters:**
```typescript
{
  action: 'scan' | 'risk' | 'redact' | 'fix';
  root?: string;                 // Directory root for scan/fix
  scanType?: 'secrets' | 'vulnerabilities' | 'both';
  include?: string[];            // Optional include globs
  exclude?: string[];            // Optional exclude globs
  includeHidden?: boolean;       // Default false
  failOnEmpty?: boolean;         // Default true in CI, false locally
  content?: string;              // For risk/redact
  apply?: boolean;               // For fix
}
```

**Example:**
```json
{
  "action": "scan",
  "root": "src",
  "scanType": "both"
}
```

**Scan guidance behavior:**
- When scan coverage is low, the result includes `statistics.coverageGuidance`.
- Use `coverageGuidance.recommendedInclude` to rerun with better include patterns.

### summarize

LLM-powered summarization.

**Parameters:**
```typescript
{
  action: 'path' | 'repo';
  path?: string;          // File/directory path (for path action)
}
```

**Example:**
```json
{
  "action": "repo"
}
```

## Rate Limiting

The server implements per-client rate limiting using the token bucket algorithm:

- **Default rate**: 1 request/second per client
- **Burst capacity**: 5 requests
- **Recovery**: Tokens refill continuously

When rate limited, responses include:
- HTTP 429 status code
- `retryAfterMs` field with suggested wait time

## Best Practices

### For LLM Clients

1. **Use progressive discovery**: Start with core tools, expand as needed
2. **Handle rate limits gracefully**: Respect `retryAfterMs` suggestions
3. **Prefer async for long tasks**: Use `async: true` for agent_task
4. **Check health first**: Call `mcp_health` to verify server status

### For Developers

1. **Use typed errors**: Import from `src/utils/errors.ts`
2. **Add comprehensive JSDoc**: Follow existing patterns
3. **Test thoroughly**: Add tests in `tests/` directory
4. **Use rate limiter**: Integrate `getRateLimiter()` for new endpoints

## Configuration

See `env.settings.example` for full configuration reference.

Key settings:
- `backends`: LLM backend configuration
- `mcpServers`: External MCP server connections
- `policy.allowlistPaths`: Allowed file access paths
- `policy.maxFileBytes`: Maximum file read size
- `toolDiscovery.fullToolList`: Enable all tools (disable progressive loading)
