# MCP Local LLM — Compact Black-Box Evaluation (v2 - 26012026)

You are evaluating an MCP server as a **black box** on a **small local model** (≤20B, often ≤8B). Produce a report that a developer can use to debug issues.

## Rules
- **Read-only** (no create/modify/delete files).
- **One tool call at a time**.
- **Prefer 12–15 total tool calls**.
- For failures, include **exact JSON args + full error**.

## Tool Surface Notes
- `verify_plan` is **agent-only**. Use `agent_task` (readOnly or dryRun) to validate plans.
- `generate_tests` is **removed from direct tool surface**. Use `analyze_test_gaps` or `local_code_review` instead.

## Test Script (execute in order)

### Phase 1: Health & Discovery (3 calls)
1) `mcp_health` `{"includeDetails":true,"format":"detailed"}` 
   → record: status, backendIssues, availableBackends, **orchestrationEnabled**, **cliOrchestrationEnabled**, webUiUrl

2) `discover_tools` `{"list_categories":true}` 
   → verify categories include planning, security, testing; record if **verify_plan** appears (should be hidden)

3) `workspace` `{"mode":"snapshot","path":".","includeHidden":true,"maxDepth":3}` 
   → find small code file (<200 lines) and any empty directory

### Phase 2: Core Functionality (7 calls)
4) `summarize` doc: `{"action":"path","path":"README.md","mode":"compact"}` (or AGENTS.md)

5) `search` **without root**: `{"action":"intelligent","query":"configuration","maxResults":8}`
   → verify default-root behavior mentioned

6) `search` **empty directory**: `{"action":"intelligent","query":"anything","root":"<empty_dir>"}`
   → **verify: "No searchable files" message, not just "0 matches"**

7) `analyze_file` small file: `{"path":"<file>","analysisType":"full","includeContent":false}`

8) `security` scan: `{"action":"scan","root":".","scanType":"both","outputFormat":"summary"}`

9) `analyze_test_gaps` on source root: `{ "root":".","testPatterns":["*.test.ts","*.spec.ts"],"sourcePatterns":["*.ts","*.js"] }`

### Phase 3: Promoted Tool & Error Handling (3 calls)
11) `agent_task` (readOnly) to verify a tiny plan:
   `{ "task":"Verify this plan: 1) Read file 2) Summarize", "options": { "readOnly": true, "maxSteps": 6 } }`

12) `search` bad root: `{"action":"intelligent","query":"x","root":"__does_not_exist__"}`
    → verify clear path error

13) `security` invalid: `{"action":"nope"}` 
    → verify enum error (SKIP if client-blocked)

### Phase 4: Orchestration (optional, if UI accessible)
14) Fetch `<webUiUrl>/api/settings` → compare cliOrchestrationEnabled with mcp_health
15) If circuit breaker open, call `analyze_file` → look for fallback logs

## Output Template (required)

```markdown
# MCP Black-Box Report v2 (Compact)

**Date:** 
**Model:** 
**Backend(s):** (from mcp_health)
**Status:** healthy/degraded
**Core tools visible:** <count>/10 (verify_plan should be hidden)

## Tool Calls
1. <tool> <args> → PASS/FAIL (1 line)
...

## Results Table
| Test | Result | Notes |
|------|--------|-------|
| mcp_health complete | | Both orchestration flags? |
| discover_tools | | verify_plan hidden? |
| search (no root) | | Default root mentioned? |
| search (empty dir) | | "No searchable files"? |
| analyze_test_gaps | | Reports untested files? |
| agent_task (verify plan) | | Plan feedback returned? |
| Bad input errors | | Clear messages? |
| Fallback behavior | | Tested if CB open? |

## Top Issues
1) Issue → repro → expected vs actual → severity

## Low-Cost Improvements
1.
2.
3.
```
