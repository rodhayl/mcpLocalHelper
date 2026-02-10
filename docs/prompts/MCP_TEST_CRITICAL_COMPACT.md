# MCP Local LLM — Critical Bug Hunt (Compact, ≤6000 chars)

Find **actionable bugs** with clear repro steps and evidence. Assume the server supports **advanced capabilities** (like tool orchestration) if discovered.

## Tool Surface Notes
- `verify_plan` is **agent-only**. Use `agent_task` (readOnly or dryRun) to validate plans.
- `generate_tests` is **removed from direct tool surface**. Use `analyze_test_gaps` or `local_code_review` instead.

## Rules
- Read-only. One tool call at a time.
- Only report **bugs** (crashes, hangs, wrong output, unsafe behavior, inconsistent validation/docs).
- For every bug: exact args + full error + why it matters.

## Minimal High-Coverage Script (run in order)
1) `mcp_health` → record `status`, `backendIssues`, web UI URL (if present).
2) `discover_tools` `{ "list_categories": true }` → record any advanced capabilities (e.g. orchestration).
3) `search` (intelligent) **without** root: `{ "action":"intelligent","query":"project configuration","maxResults":6,"format":"dense" }` → verify default root behavior.
4) `search` with bad root: `{ "action":"intelligent","query":"x","root":"__does_not_exist__" }`.
5) `security` invalid action `{ "action":"nope" }` (if blocked by client-side schema, mark SKIP and include the client error).
6) `security` scan: `{ "action":"scan","root":".","scanType":"both","outputFormat":"summary" }` (or use detected source root).
7) Choose a small real code file and run `analyze_test_gaps` `{ "root":".","testPatterns":["*.test.ts","*.spec.ts"] }`.
8) `agent_task` to verify a tiny plan (2–3 steps) in read-only mode.
9) Optional (only if stable): `agent_task` with a **short** read-only instruction (maxSteps ~10–15) to confirm it doesn’t hang.

## Orchestration/Capability Proof (best-effort)
If you can view server stdout or the web UI:
- Capture any log lines with capability prefixes (e.g. `[TOOL-ORCH]`, `[DIRECT-LLM]`) if present.
If you cannot access logs/UI, write: **EVIDENCE: N/A**.

## Output Format (required)
If you found bugs, list them as:

```markdown
## BUG-1: <title>
**Surface:** tool/health/discovery/orchestration/ui
**Repro (exact args):**
```json
{ ... }
```
**Expected:**
**Actual:**
**Impact:** (why a dev/user cares)
**Severity:** Critical/High/Medium/Low
**Workaround:** (if any)
```

If no bugs found:
`No critical bugs found. Tested: <list tools> (evidence: yes/no).`
