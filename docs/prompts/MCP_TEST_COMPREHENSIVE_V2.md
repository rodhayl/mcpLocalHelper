# MCP Local LLM — Comprehensive Black-Box Evaluation (v2 - 26012026)

**Role:** You are a black-box tester evaluating an MCP server's real-world usefulness and reliability for **local LLMs** (≤20B / ≤8B). You are not given internal implementation details.

**Version:** 26012026 - Enhanced with circuit-breaker fallback, orchestration flag validation, empty directory diagnostics, and agent-only plan verification guidance.

## Guardrails
0) One tool call at a time. 1) Read-only. 2) Keep scope tight (prefer `root:"."` or detected source folder). 3) If you find project docs/AGENTS.md, treat them as binding.

## What to Test (15-20 calls total)

### A) Orientation & Health (4 calls)
1) `mcp_health` `{ "includeDetails": true, "format": "detailed" }` → record:
   - `status` (healthy/degraded)
   - `backendIssues` (any circuit breaker state, connection errors)
   - `availableBackends` and `unavailableBackends`
   - **`orchestrationEnabled`** (based on toolGroupMode)
   - **`cliOrchestrationEnabled`** (based on CLI backends)
   - Web UI URL (for settings access)
   - Any `fallback` or `nextSteps` information

2) `discover_tools` `{ "list_categories": true }` → verify:
   - Categories include: planning, security, testing, workspace, search
  - **`verify_plan`** should NOT appear in categories (agent-only; use `agent_task`)
   - Note any orchestration/settings tools mentioned

3) `workspace` snapshot `{ "mode":"snapshot","path":".","includeHidden":true,"maxDepth":4 }` 
   → locate `README.md`/`AGENTS.md` and candidate small code files (<200 lines)

4) **Core tools validation** - count tools in initial ListTools response:
   - Expected: 10 core tools: `agent_task`, `mcp_health`, `search`, `analyze_file`, `suggest_edit`, 
     `local_code_review`, `security`, `summarize`, `workspace`, `discover_tools`
   - If `verify_plan` appears in ListTools, record as FAIL (agent-only)

### B) Day-1 Developer Workflow (8-10 calls)

**Documentation:**
- `summarize` a doc (`README.md` or `AGENTS.md`): `{"action":"path","path":"<doc>","mode":"compact"}`

**Search validation:**
- `search` (intelligent) **without** `root`: `{"action":"intelligent","query":"project configuration","maxResults":8}`
  → Verify response mentions "default root" behavior
  
- `search` with valid `root`: `{"action":"intelligent","query":"main","root":"src","maxResults":10}`
  → Verify scoped search works
  
- **Empty directory test:** `search` on known empty directory (e.g., `pptx_agent` or create one):
  `{"action":"intelligent","query":"anything","root":"<empty_dir>"}`
  → **Expected:** Response says "No searchable files found in '<dir>'" (NOT just "0 matches")

**Code analysis:**
- `analyze_file` small code file: `{"path":"<file>","analysisType":"full","includeContent":false}`
  → Assess for hallucination vs evidence-based analysis

**Security:**
- `security` scan: `{"action":"scan","root":".","scanType":"both","outputFormat":"summary"}`

**Testing coverage validation (generate_tests removed from direct surface):**
- `analyze_test_gaps` on source root: `{"root":".","testPatterns":["*.test.ts","*.spec.ts"],"sourcePatterns":["*.ts","*.js"]}`
  → **Expected:** reports untested/partially tested files
- `local_code_review` on a small file with `focus:"security"` to identify test gaps

**Plan verification (agent-only):**
- `agent_task` (readOnly) to verify a small plan:
  `{ "task":"Verify this plan: 1) Read README.md 2) Summarize contents", "options": { "readOnly": true, "maxSteps": 6 } }`

### C) Orchestration & Fallback Testing (3-5 calls if possible)

**C1) Flag Consistency Check:**
If web UI accessible (from `mcp_health.webUiUrl`):
- Fetch `/api/settings` → record `advanced.cliOrchestrationEnabled`
- Compare with `mcp_health.cliOrchestrationEnabled` → should match
- `orchestrationEnabled` may differ (it's toolGroupMode, not CLI-specific)

**C2) Routing Test (if logs accessible):**
1) Toggle orchestration OFF → call `analyze_file` → look for `[DIRECT-LLM:<tool>]`
2) Toggle orchestration ON → call `analyze_file` → look for `[TOOL-ORCH:<tool>]`

**C3) Fallback Test (if circuit breaker open):**
If `mcp_health` shows any backend circuit breaker open:
- Call `analyze_file`
- **Expected logs:** `[LLM] Circuit breaker open for X, attempting fallback to: Y, Z`
- Verify fallback succeeds or all backends fail gracefully

If you cannot access UI/logs, mark orchestration evidence as **N/A**.

### D) Failure-mode Probes (3 calls)
1) `search` with bad root: `{"action":"intelligent","query":"x","root":"__does_not_exist__"}`
   → Expect clear "path not found" error

2) `security` invalid action: `{"action":"nope"}`
   → Expect clear enum validation error (or SKIP if client-side blocked)

3) Large file test generation failure (covered in B above)

## Final Report (required)

```markdown
# MCP Black-Box Report v2

**Date:**
**Model:**
**Backend(s):** (from mcp_health.availableBackends)
**MCP server status:** healthy/degraded
**Constraints observed:**

## Tool Calls (chronological)
1. <tool> <args> → PASS/FAIL (1 line evidence)
...

## Results Summary
| Area | PASS/FAIL/SKIP | Evidence (1–2 lines) |
|------|----------------|----------------------|
| Discovery & schemas | | |
| Core tools count (10) | | Is verify_plan hidden? |
| Documentation compliance | | AGENTS.md/README.md present? |
| Search (default root) | | Mentions default root? |
| Search (scoped) | | |
| Search (empty dir) | | Says "No searchable files"? |
| Analyze file | | Evidence-based or hallucinated? |
| Security scan | | |
| analyze_test_gaps | | Reports untested files? |
| agent_task (verify plan) | | Plan feedback returned? |
| Orchestration flags | | Both flags present in mcp_health? |
| Orchestration routing | | Routing logs: N/A or captured |
| Fallback behavior | | Fallback attempted/logged? |
| Error handling UX | | Clear errors for bad input? |

## Circuit Breaker Status
- Which backends had open circuit breakers?
- Did fallback work?
- What was the fallback sequence?

## Top Issues (actionable)
1) **Issue:** → **Repro:** exact args → **Expected:** → **Actual:** → **Severity:**
...

## Top 5 Low-Cost Improvements
1.
2.
3.
4.
5.

## Notes
- Any unexpected behavior
- LLM quality observations (hallucination, context handling)
- Performance notes
```
