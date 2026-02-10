# MCP Local LLM - Black-Box Evaluation (Standard, orchestration-aware)

**Role:** You are a black-box tester evaluating an MCP server's real-world usefulness and reliability for local LLMs (<=20B / <=8B).

## Scope Rules (strict)
1) One tool call at a time.
2) Read-only only.
3) Focus only on MCP/tool behavior.
4) Do not include repository details in the report.

### Repository Detail Exclusion (required)
Do not report any of the following unless strictly required for a repro argument:
- Repository structure, directory listings, or file inventories.
- README/AGENTS/project-documentation content.
- Code content, code snippets, class/function names, or implementation commentary.
- Any qualitative judgment about the host repository itself.

If a file path is needed to run a tool, use it only as an input artifact and do not describe the file contents in the report.

## Tool Surface Notes
- `verify_plan` is agent-only. Use `agent_task` (`readOnly` or `dryRun`) to validate planning behavior.
- `generate_tests` is removed from direct tool surface. Use `analyze_test_gaps` or `local_code_review` instead.

## What to Test (black box)

### A) Orientation (2-3 calls)
1) `mcp_health` -> record status, backend issues, next steps, and web UI URL if present.
2) `discover_tools` `{ "list_categories": true }` -> record categories and surface coverage.
3) Optional: `workspace` snapshot only to find a safe target path for tool inputs. Do not report repo details.

### B) Core Workflow (5-7 calls)
- `search` once without `root`, once with valid `root`.
- `analyze_file` on one small target file (path only; do not report file internals).
- `security` scan with `scanType:"both"` and `outputFormat:"summary"`.
- `analyze_test_gaps` on source root.
- `agent_task` (`readOnly`) with a tiny 2-3 step plan.

### C) Orchestration Settings (best-effort)
Goal: validate routing behavior (direct vs orchestrated vs fallback), not UI details.

If UI/log access is possible:
1) Toggle orchestration OFF (or force local/direct route), re-run one tool, capture routing evidence.
2) Toggle orchestration ON/auto, re-run same tool, capture routing evidence.

If UI/logs are not accessible, mark orchestration evidence as `N/A`.

### D) Failure-mode probes (2 calls)
1) `search` with bad root: `{ "action":"intelligent", "query":"x", "root":"__does_not_exist__" }`.
2) `security` invalid action: `{ "action":"nope" }` (if blocked client-side, record `SKIP`).

## Final Report (required)
Use this exact template (fill all fields):

```markdown
# MCP Black-Box Report

**Date:**
**Model:**
**Backend(s):** (from mcp_health)
**MCP server status:** healthy/partial/degraded
**Constraints observed:**

## Scope Compliance
- Repository details included: NO
- Evidence limited to MCP/tool behavior: YES

## Tool Calls (chronological)
1. <tool> <args> -> PASS/FAIL (1 line)

## Results Summary
| Area | PASS/FAIL/SKIP | Evidence (1-2 lines) |
|------|----------------|----------------------|
| Discovery and schemas |  |  |
| Search behavior |  |  |
| Analyze behavior |  |  |
| Security behavior |  |  |
| Test-gap behavior |  |  |
| Plan verification |  |  |
| Orchestration routing |  |  |
| Error handling UX |  |  |

## Top Issues (actionable)
1) Symptom -> exact repro args -> expected vs actual -> severity

## Top 5 Low-Cost Improvements
1.
2.
3.
4.
5.
```
