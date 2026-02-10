# MCP Final Test — Production Readiness Prompt

## Purpose
A single, comprehensive prompt to validate **MCP Local LLM** end-to-end:
- Tool discovery + schemas
- Core tool correctness (search/workspace/analyze/security)
- Error handling + parameter validation
- Agent delegation (`agent_task`)
- Optional live-backend E2E smoke (LM Studio)

This prompt is designed for **black-box** evaluation (no repo changes) and produces a **machine-readable report**.

---

## Hard Constraints (Must Follow)
- **Read-only**: do not write, delete, or edit repo files.
- **No git ops**: do not run git commands.
- **No CI assumptions**: treat this as a local/manual run.
- **Single-run determinism**: do not retry indefinitely; if a backend is unstable, record it and continue with other checks.
- **Redaction**: do not print secrets; redact findings in outputs.

---

## Backend Readiness Policy (Important)
Some tools require a live LLM backend (e.g., LM Studio). If the backend is not ready:
- **Record SKIP** for LLM-dependent checks.
- Still complete all **non-LLM** checks.

Definition of **LM Studio “ready”** (OpenAI-compatible):
1) `GET /v1/models` is reachable and returns a non-empty `data[]`
2) `POST /v1/chat/completions` succeeds (proves inference works / a model is actually loaded)

---

## Phase 0 — Identify Capabilities
1) Call `mcp_health`.
  - Capture: `status` (healthy|partial|degraded), `healthy` boolean if present, `uptime`, `queue`, `activeModel/backend`, any `backendIssues`, and any `nextSteps` suggestions.
2) Call `discover_tools`.
   - Capture: number of categories, number of tools, and which tools are marked agent-only.
3) Call `search` with `action="gather"` over the repo root (or default root) to build a minimal context snapshot.
   - Goal: confirm search works and returns stable structure.

**Record:** Tool list, schemas (high-level), and any inconsistencies.

---

## Phase 1 — Core Correctness (Non-LLM)
### 1A) Workspace snapshot
Call `workspace` (snapshot mode if available) on the workspace root:
- Run once with `includeHidden=false`
- Run once with `includeHidden=true`

**Validate:**
- Hidden directories (especially `.vscode/`) become visible only when `includeHidden=true`.
- Output indicates truncation if it can’t list everything.

### 1B) File reading guards
Try reading a clearly invalid path (e.g., `does/not/exist.txt`) using the repo’s read tool (`read_file` or equivalent).

**Validate:**
- Clear error message
- No crash
- Error includes a helpful resolved-path hint (without leaking anything sensitive)

### 1C) Security scan (low false-positive check)
Run `security` with `action="scan"` on a narrow scope (e.g., `src/`), and then on repo root.

**Validate:**
- Reports scanned file counts
- Findings are actionable
- Does **not** flag type hints like `password: string` as secrets

---

## Phase 2 — Search Quality + Parameter Validation
### 2A) Search sanity
Call `search` with:
- `action="intelligent"`, query for entry points (e.g., `McpServer`, `AgentRunner`, `tool discovery`)
- `action="structured"`, query for symbols (e.g., `LmStudioAdapter`)

**Validate:**
- Results contain relevant files
- Root behavior is consistent (defaults to `"."` if omitted)

### 2B) Error handling probes
Perform these invalid-input probes and capture the exact structured error responses:
- `security` with invalid action (e.g., `action="nope"`) → should return clear allowed enum values
- `search` with invalid action (e.g., `action="bad"`) → should return clear allowed enum values
- `analyze_file` (or equivalent) with nonexistent file → should return “file not found”

---

## Phase 3 — LLM-Dependent Tools (Skip if backend not ready)
Only run this phase if backend readiness is confirmed.

### 3A) Summarization and analysis
- `summarize` a small file (e.g., `package.json`) and a directory (e.g., `src/`)
- `analyze_file` on a representative TypeScript file

**Validate:**
- No HTTP 400 “Invalid request format”
- No circuit-breaker churn
- Reasonable latency

### 3B) Test generation
Run `generate_tests` on a small, simple file.

**Validate:**
- Output is syntactically valid, or `syntaxValid` explains issues
- The pipeline decodes common HTML entities and normalizes Python import paths (e.g., `utils/file.py` → `utils.file`).
- Generated Python tests are sanitized for class/function names; if `black` is installed on the host, output may be auto-formatted.

---

## Phase 4 — Agent Delegation (Skip if backend not ready)
Only run this phase if backend readiness is confirmed.

Run `agent_task` with:
- a small task (e.g., “Find where tool schemas are defined and list top 3 files to read next”)
- `readOnly=true`
- allow only safe actions (search/read/analyze)

**Validate:**
- Agent produces an actual multi-step plan
- Tool calls route to correct server (local tools should not be misrouted to external MCP servers)

---

## Reporting (Required)
Return a single JSON object named `final_report` with:

```json
{
  "meta": {
    "date": "YYYY-MM-DD",
    "tester": "<model+tooling>",
    "os": "<windows|linux|mac>",
    "backend": {
      "name": "lmstudio|ollama|other",
      "ready": true,
      "details": "..."
    }
  },
  "tooling": {
    "toolsListed": 0,
    "agentOnlyToolsListed": 0,
    "categories": []
  },
  "results": [
    {
      "area": "workspace snapshot",
      "status": "PASS|FAIL|SKIP",
      "notes": "short",
      "evidence": ["..."]
    }
  ],
  "topIssues": [
    {"severity": "critical|high|medium|low", "issue": "...", "recommendation": "..."}
  ]
}
```

Also include a 5-line executive summary.

---

## PASS/FAIL Guidance
- **PASS**: All non-LLM phases pass; LLM phases pass or SKIP due to backend not ready.
- **FAIL**: Any core tool correctness failure, safety issue, or repeated backend request-format errors when backend is otherwise reachable.
