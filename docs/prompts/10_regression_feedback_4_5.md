# MCP Local LLM — Regression Tests for Feedback 4/5 (v15)

## Goal
Validate that all issues identified in feedback_4.md and feedback_5.md are fixed and regression-tested.

## Preconditions
- MCP server running
- LLM backend available
- Build recent: `npm run build` completed without errors

---

## Test 1: Enum Validation Error Messages
**Issue:** "Invalid enum errors don't list allowed values" (feedback_4, feedback_5)

### Step 1.1: Security tool invalid action
```json
{ "tool": "security", "args": { "action": "nope" } }
```
**Expected:**
- Error message includes "Valid values:" or "Must be one of:"
- Lists: scan, risk, redact (and optionally fix)
- Hint includes example: `{ "action": "scan" }`

### Step 1.2: Search tool invalid action
```json
{ "tool": "search", "args": { "action": "invalid", "root": "." } }
```
**Expected:**
- Error mentions valid actions: intelligent, structured, filenames, gather
- Clear hint with example usage

**Pass Criteria:** Both errors include allowedValues array and helpful hint.

---

## Test 2: Retry/Backoff Logic Exists
**Issue:** "execute_mcp_tool has no retry/backoff behavior" (feedback_4)

### Verification (code inspection):
- File: `src/utils/mcp-client.ts`
- Method: `withRetries()` present with exponential backoff
- Config: `getRetryConfig()` returns retries, delayMs, backoff

### Step 2.1: Run retry test
```bash
npx vitest run tests/mcp-client.retry.test.ts
```
**Expected:** All retry tests pass, including "retries connect to a flaky stdio MCP server"

---

## Test 3: Search Root Defaulting
**Issue:** "search without root silently succeeds instead of returning validation error" (feedback_4, feedback_5)

### Step 3.1: Search with explicit root (should work)
```json
{ "tool": "search", "args": { "action": "intelligent", "query": "TODO", "root": "." } }
```
**Expected:** Returns search results scoped to workspace

### Step 3.2: Search without root (should use default '.')
```json
{ "tool": "search", "args": { "action": "intelligent", "query": "TODO" } }
```
**Expected:** 
+ - Defaults to '.' and returns results (server will use workspace root when `root` is omitted)
+ - No error, results scoped to workspace root

**Pass Criteria:** Both calls return valid results; root defaults to '.' when omitted.

---

## Test 4: Agent Completion Reason Fields
**Issue:** "agent_task doesn't clearly communicate why auto-complete was triggered" (feedback_4, feedback_5)

### Step 4.1: Run agent task that completes normally
```json
{ "tool": "agent_task", "args": { "task": "List the files in the current directory", "readOnly": true, "maxSteps": 3 } }
```
**Expected Response Fields:**
- `completionReason`: "completed" (or "step_limit" if exceeded)
- `continueAvailable`: boolean (true if more steps available)
- `effectiveOptions`: includes maxSteps, maxActionsPerStep values used

### Step 4.2: Verify completion fields in test
```bash
npx vitest run tests/improvement-plans-v5.test.ts -t "Plan 3"
```
**Expected:** All 12 tests pass including:
- "should define completionReason type"
- "should define continueAvailable as boolean"
- "should indicate step_limit when not all steps executed"
- "should indicate action_limit when steps auto-completed"

---

## Test 5: Agent Step/Action Limits (Partial Fix)
**Issue:** "maxActionsPerStep=8 is too low, tasks auto-complete too early" (feedback_4, feedback_5, feedback_6)

### Verification (code inspection):
- File: `src/agent/runner.ts` line ~2904
- Default: `maxActionsPerStep ?? 12` (V15: increased from 8)
- Documentation in `src/server/mcp.ts`: "maxActionsPerStep=12 by default"

### Step 5.1: Verify new default in schema
```json
{ "tool": "discover_tools", "args": { "category": "planning" } }
```
**Expected:** agent_task description includes "maxActionsPerStep=12"

### Step 5.2: Run complex task with default limits
```json
{ "tool": "agent_task", "args": { "task": "Find all TypeScript files and count lines of code", "readOnly": true } }
```
**Expected:**
- Task completes or returns meaningful partial result
- completionReason NOT "action_limit" for simple task
- More headroom before auto-complete triggers
**Note:** Current agent defaults: `maxSteps`=50, `maxActionsPerStep`=20, `maxSubtasks`>=8 — tests should assume these defaults.

---

## Test 6: Generate Tests Syntax Validation
**Issue:** "generate_tests produces Python tests with syntax errors" (feedback_4, feedback_5)

### Step 6.1: Generate tests for small file
```json
{ "tool": "generate_tests", "args": { "path": "vitest.config.ts", "framework": "vitest", "coverage": "basic" } }
```
**Expected:**
- `syntaxValid`: true or false with specific warnings
- If warnings present, they describe specific issues (unbalanced braces, etc.)
- No collapsed `def foo():pass` patterns in Python output

### Step 6.2: Run generate_tests validation tests
```bash
npx vitest run tests/generate-tests.validation.unit.test.ts
```
**Expected:** All heuristic validation tests pass

---

## Test 7: Smart Default Excludes (venv, node_modules)
**Issue:** "Search includes venv/site-packages noise by default" (feedback_5)

### Verification:
- File: `src/utils/smart-defaults.ts`
- `DEFAULT_EXCLUDE_PATTERNS` includes: node_modules/**, venv/**, .venv/**, site-packages/**

### Step 7.1: Run exclude pattern tests
```bash
npx vitest run tests/plan-improvements.test.ts -t "DEFAULT_EXCLUDE_PATTERNS"
```
**Expected:** Tests verify venv, node_modules, __pycache__ are in default excludes

---

## Summary Pass/Fail Matrix

| Test | Issue | Evidence Required | Status |
|------|-------|-------------------|--------|
| 1 | Enum validation | Error includes allowedValues | |
| 2 | Retry/backoff | Test passes, code present | |
| 3 | Search root | Defaults to '.' | |
| 4 | Completion reason | Fields in response | |
| 5 | Action limits | Default 12, not 8 | |
| 6 | Test syntax | Validation present | |
| 7 | Smart excludes | Patterns in defaults | |

## On Failure
1. Note which test failed
2. Capture error output
3. Check relevant source file for implementation
4. File bug with: test number, expected vs actual, file locations
