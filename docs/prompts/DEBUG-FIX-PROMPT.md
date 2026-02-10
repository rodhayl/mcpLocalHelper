# MCP Local LLM - Debug + Fix From Reports Folder

You are a senior maintainer. You will be given one folder path containing Markdown reports with increasing numbering (example: `.../QA_feedback_1.md`, `.../QA_feedback_2.md`, ...). Your job is to debug and fix real issues in this repository, while simplifying code where safe and improving maintainability.

Keep the incoming reports format as-is. Do not require report format changes.

## Input (ONLY EDIT THIS)
- **REPORTS_FOLDER:** `<TEST_PROMPTS/REPORTS/06022026>`

Do not ask for filenames. Discover and read all reports in the folder yourself.

## Hard Rules
- Follow AGENTS.md and repository instructions as binding.
- Use TDD for every code fix: add failing test -> implement fix -> test passes.
- Fix root causes with minimal, clean changes.
- Treat empty/noisy report chunks as ignorable noise, but mention them.
- Complete all analysis tasks from reports, but only ship fixes that are real, reproducible, and in-scope for this repo.

## Scope Guardrails (critical)
- Do not treat external environment issues as repo bugs:
  - missing/unreachable backends (`ollama` not running, CLI missing on PATH, etc.)
  - UI automation limitations
  - client-side validation rejections that never hit server code
- Do not edit files that do not exist in this repository even if reports mention them.
- Do not fix "expected negative-path behavior" as bugs (example: search with invalid root returning path-not-found).
- Do not trust black-box claims about repository code quality until reproduced locally.

## Known Report Shape (must handle)
Reports may arrive as:
- one Markdown file containing multiple quoted `"MCP Black-Box Report"` blocks
- blocks concatenated with `AND`
- mojibake/encoding artifacts (`â†’`, `âœ…`, etc.)
- empty chunks (`''`) mixed with valid feedback

You must robustly parse this and keep useful evidence only.

## Step 1 - Ingest Reports (required)
1) List files in `REPORTS_FOLDER` (non-recursive).
2) Sort by numeric suffix if present (`_12` > `_2`), else lexicographically.
3) Read each report file and extract a structured dataset. For each extracted report chunk, capture:
   - source file
   - environment (model, backend, constraints)
   - tool calls attempted (tool + args + outcome)
   - failures (verbatim error text when available)
   - expected vs actual
   - suspected area (`validation`, `orchestration`, `schema`, `agent loop`, `timeouts`, `security scan coverage`, `test-gen formatting`, etc.)
   - classification:
     - `repo_bug`
     - `environment_or_dependency`
     - `harness_or_prompt_noise`
     - `feature_request`
     - `expected_behavior`

## Step 2 - Consolidate Triage Map (required)
Produce:
- top recurring failures grouped by normalized signature (`tool + error signature + symptom`)
- severity ordering (crash/hang/security regression > wrong behavior > UX/documentation)
- fixability ordering (`in-repo reproducible` first)
- repro matrix with:
  - bugId
  - minimal repro args
  - expected
  - actual
  - number of mentions
  - environments
  - classification
  - confidence (`high`, `medium`, `low`)

## Step 3 - Reproduce Locally (required)
For each high-severity, high-confidence `repo_bug`:
1) Reproduce using exact args (or closest equivalent) in this repo.
2) Capture:
   - failing behavior
   - relevant logs
   - responsible code locations

If not reproducible:
- explain why (missing backend, external repo mismatch, flaky harness, etc.)
- add deterministic simulation test only if it validates in-repo behavior
- otherwise keep as open item (do not force a speculative code change)

## Step 4 - Implement Fixes (required, TDD)
For each bug you fix:
1) Add/extend test in the appropriate suite.
2) Run the single target test file and confirm it fails first.
3) Implement minimal fix.
4) Re-run the target test and confirm pass.
5) Run the smallest relevant broader suite.
6) After all targeted fixes pass individually, run the full test suite once.

## Step 5 - Quality Bar While Editing
- Prefer simpler code over layered patches.
- Remove dead or redundant code introduced by refactors when safe.
- Keep naming and flow explicit and readable.
- Avoid unrelated churn.

## Step 6 - Final Deliverable (required)
Output a single report:

```markdown
# Debug+Fix Report

**Reports folder:** <REPORTS_FOLDER>
**Date:** <timestamp>

## Triage Summary
- Total report files read:
- Total report chunks extracted:
- Reports/chunks ignored (empty/noisy):
- Unique issues found:

## Repro Matrix (Top Issues)
| bugId | tool | repro args | expected | actual | mentions | classification | confidence | status |
|---|---|---|---|---|---:|---|---|---|

## Fixes Shipped
### FIX-1: <title>
- **From reports:** <quote/paraphrase + source file>
- **Why this is real:** <local repro evidence>
- **Root cause:**
- **Change:** <files touched>
- **Test added/updated:**
- **How to verify:** <command>

## Remaining Issues (not fixed)
### OPEN-1: <title>
- **Classification:** <environment_or_dependency | feature_request | non-reproducible | expected_behavior>
- **Why not fixed:**
- **Suggested next step:**

## Evidence Index
- <short excerpt> - <report file>
```

