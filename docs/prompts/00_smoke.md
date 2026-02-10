# MCP Local LLM — Smoke Test (v15)

## Goal
Verify the server starts correctly, core tools respond, and basic health checks pass.

## Preconditions
- MCP server running (via `npm start` or stdio transport)
- LLM backend available (LM Studio or Ollama with loaded model)

## Steps

### Step 1: Health Check
```json
{ "tool": "mcp_health", "args": {} }
```
**Expected:**
- Status: includes `status` = "healthy|partial|degraded" (may include `backendIssues` and `nextSteps`)
- Backend info present (provider, baseUrl)
- Queue status: "idle" or "running"
- Cache stats present

### Step 2: Tool Discovery
```json
{ "tool": "discover_tools", "args": { "list_categories": true } }
```
**Expected:**
- Returns 10+ categories
- Includes: code_analysis, security, testing, search, workspace
- No errors

### Step 3: Workspace Snapshot
```json
{ "tool": "workspace", "args": { "mode": "snapshot", "path": ".", "maxDepth": 2 } }
```
**Expected:**
- Returns file tree
- Shows src/, tests/, package.json, README.md
- No errors

### Step 4: Simple File Analysis
```json
{ "tool": "analyze_file", "args": { "path": "package.json", "analysisType": "quality" } }
```
**Expected:**
- Returns analysis with summary
- No hallucinations about non-existent dependencies
- syntaxValid: true or metrics present

### Step 5: Search with Root
```json
{ "tool": "search", "args": { "action": "filenames", "query": "*.ts", "root": "." } }
```
**Expected:**
- Returns list of TypeScript files
- Results scoped to workspace
- No errors
**Note:** `root` is optional and defaults to "./" — test both with and without `root`.

## Pass/Fail Criteria
- **PASS:** All 5 steps return expected responses without errors
- **FAIL:** Any step returns error, hangs >30s, or returns malformed data

## On Failure
1. Capture full error output
2. Check server logs: `npm start` terminal output
3. Verify LLM backend is responding: `curl http://localhost:1234/v1/models`
4. File issue with: step number, error text, server version

## Notes
- This test validates baseline functionality only
- For regression testing, see 10_regression_feedback_4_5.md
- For edge cases, see 30_edge_cases.md
