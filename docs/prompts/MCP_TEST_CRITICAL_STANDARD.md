# MCP Local LLM — Critical Components Test (Standard, capability-aware)

**Purpose:** Validate the “must work” surfaces (health, discovery, doc compliance, core tools, agent delegation) and explicitly test **advanced server capabilities** (e.g. orchestration, routing) if available. Provide an evidence-rich report a developer can act on.

## Tool Surface Notes
- `verify_plan` is **agent-only**. Use `agent_task` (readOnly or dryRun) to validate plans.
- `generate_tests` is **removed from direct tool surface**. Use `analyze_test_gaps` or `local_code_review` instead.

## Operating Rules
0) One tool call at a time. 1) Read-only (no apply/fix). 2) Prefer scoped roots (`root:"."` or source). 3) Project docs are binding. 4) For every FAIL: include exact args + full error.

## Phase 1 — Health & Discovery
1) `mcp_health` `{}` → record `status`, `backendIssues`, `nextSteps`, and web UI URL.
2) `discover_tools` `{ "list_categories": true }` then `{ "category": "planning" }` and `{ "category": "execution" }`.
3) `workspace` snapshot `{ "mode":"snapshot","path":".","includeHidden":true,"maxDepth":4 }` → locate `README.md` and 2–3 small candidate files.

## Phase 2 — Documentation Compliance
If found, `summarize` the `README.md` (or `AGENTS.md` if present) in `compact` mode and list the top constraints you must follow.

## Phase 3 — Core Tool Surfaces (scoped)
Run each once and record “PASS criteria” in 1 line:
1) `summarize` a key file: `{ "action":"path","path":"<file>","mode":"compact" }`.
2) `search` intelligent **without** root (default-root behavior): `{ "action":"intelligent","query":"tool discovery","maxResults":8,"format":"dense" }`.
3) `search` structured with root: `{ "action":"structured","query":"Server","root":".","targetType":"class","maxResults":10 }` (or search for a common class name like "Manager" or "Service").
4) `analyze_file` on a small file from results: `{ "path":"<file>","analysisType":"full" }`.
5) `security` scan: `{ "action":"scan","root":".","scanType":"both","outputFormat":"summary" }` (or use valid source root).
6) `analyze_test_gaps` on source root: `{ "root":".","testPatterns":["*.test.ts","*.spec.ts"] }`.
7) `agent_task` to verify a small plan (2–3 steps) in read-only mode.

## Phase 4 — Advanced Capability Routing (best-effort)

If the server exposes capabilities like "Tool Orchestration" and you can access the web UI:
1) Open Settings.
2) Pick ONE tool you will re-run (recommend `analyze_file`).
3) Toggle the capability OFF (or set backend to **local**) → re-run tool and capture log evidence (e.g. `[DIRECT-LLM]`).
4) Toggle capability back ON (backend `auto`) and enable **quick mode** (if avail) → re-run and capture log evidence (e.g. `[TOOL-ORCH]`) and check latency.

If you cannot access UI/logs or features are not present, mark this phase SKIP and explain why.

## Phase 5 — Regression Probes
1) Bad root search: `{ "action":"intelligent","query":"x","root":"__does_not_exist__" }`.
2) Invalid enum for security: `{ "action":"nope" }` (if blocked client-side, record SKIP with client error).
3) Invalid file path for analyze_file: `{ "path":"does/not/exist.ts","analysisType":"quality" }`.

## Final Report Template (required)

```markdown
# MCP Critical Test Report

**Date:**
**Model:**
**Backend(s):**
**Server status:**
**Constraints observed:**

## Results
| Phase | Check | PASS/FAIL/SKIP | Evidence (1–3 lines) |
|------:|-------|----------------|-----------------------|
| 1 | health & discovery |  |  |
| 2 | Documentation compliance |  |  |
| 3 | core tools |  |  |
| 4 | capability routing |  |  |
| 5 | regressions/errors |  |  |

## Bugs (actionable)
## BUG-1: <title>
**Repro args:** `{ ... }`
**Expected:**
**Actual:**
**Severity:**
**Notes:**

## Top 5 Fixes (low-cost)
1.
2.
3.
4.
5.
```
