# MCP Local LLM — Black-Box Evaluation (Compact, ≤6000 chars)

You are evaluating an MCP server as a **black box** on a **small local model** (≤20B, often ≤8B). Produce a report that a developer can use to debug issues.

## Rules
- **Read-only** (no create/modify/delete files).
- **One tool call at a time**.
- **Prefer 8–10 total tool calls**.
- For failures, include **exact JSON args + full error**.

## Tool Surface Notes
- `verify_plan` is **agent-only**. Use `agent_task` (readOnly or dryRun) to validate plans.
- `generate_tests` is **removed from direct tool surface**. Use `analyze_test_gaps` or `local_code_review` instead.

## Test Script (execute in order)
1) `mcp_health` → record: `status`, any `backendIssues`, any `nextSteps`, and any web UI URL.
2) `discover_tools` with `{ "list_categories": true }` → record categories and any mention of orchestration/settings.
3) `workspace` snapshot: `{ "mode":"snapshot","path":".","includeHidden":true,"maxDepth":3 }` → find key config files or `README.md`.
4) If a documentation file exists (e.g. `README.md` or `AGENTS.md`), `summarize` it with `{"action":"path","path":"<doc_path>","mode":"compact"}`.
5) `search` (intelligent) **without** `root`: `{"action":"intelligent","query":"project configuration","maxResults":8,"format":"dense"}` → verify default-root behavior.
6) `search` again with a **bad root**: `{"action":"intelligent","query":"anything","root":"__does_not_exist__"}` → verify validation/error clarity.
7) Pick a **small** real code file from search hits/snapshot (<200 lines) and run `analyze_file` `{"path":"<file>","analysisType":"full"}` → judge hallucination vs evidence.
8) `security` enum validation probe: call with `{"action":"nope"}`. If your client blocks the call, record that and mark **SKIP(client-side validation)**.
9) `security` scan (scoped): `{"action":"scan","root":".","scanType":"both","outputFormat":"summary"}` (or use a detected source folder as root).
10) `analyze_test_gaps` on the source root: `{"root":".","testPatterns":["*.test.ts","*.spec.ts"],"sourcePatterns":["*.ts","*.js"]}`.

## Orchestration Evidence (best-effort)
If you can see server stdout, capture any lines with prefixes like `[TOOL-ORCH:`, `[DIRECT-LLM:`, `[FALLBACK:` during steps 7–10. If you cannot see logs, write **LOGS: N/A**.

## Final Output (required, compact)
- **Environment:** date/time, model, backend(s) from `mcp_health`, constraints.
- **What I tested:** 8–10 bullets.
- **Results table:** Area → PASS/FAIL/SKIP + 1-line note.
- **Top 5 actionable improvements:** low-cost, precise.
