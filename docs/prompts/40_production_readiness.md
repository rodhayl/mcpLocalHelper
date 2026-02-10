# MCP Local LLM — Production Readiness Checklist (v15)

## Goal
Verify the server is ready for production deployment with deterministic, reproducible tests.

## Preconditions
- Fresh clone of repository
- Node.js 18+ installed
- npm packages installed: `npm install`
- Build completed: `npm run build`
- LLM backend running (LM Studio or Ollama with loaded model)

---

## Phase 1: Build & Static Analysis

### Step 1.1: Clean Build
```bash
npm run build
```
**Expected:** Exit code 0, no errors

### Step 1.2: Lint Check
```bash
npm run lint
```
**Expected:** Exit code 0, no errors (warnings acceptable)
- status: one of "healthy", "partial", or "degraded" (may include `backendIssues` and `nextSteps` fields)
- uptime: > 0
- queue.status: "idle" or "running"
- backends present
```
**Expected:** Exit code 0, no type errors

---

## Phase 2: Unit & Integration Tests
**Note:** `root` is optional and defaults to workspace root (`.`) when omitted.

### Step 2.1: Full Test Suite
```bash

**Note:** Current runtime defaults: `maxSteps`=50, `maxActionsPerStep`=20. Tests and documentation should assume these updated defaults.
**Expected:**
- All tests pass (or known skipped tests documented)
- No test timeouts
- Exit code 0

### Step 2.2: Critical Subsystem Tests
```bash
npx vitest run tests/validation-improvements.test.ts
npx vitest run tests/mcp-client.retry.test.ts
npx vitest run tests/improvement-plans-v5.test.ts -t "Plan 3"
npx vitest run tests/plan-improvements.test.ts -t "DEFAULT_EXCLUDE_PATTERNS"
```
**Expected:** All pass

---

## Phase 3: Server Startup

### Step 3.1: Start Server
```bash
npm start
```
**Expected:**
- Server starts without errors
- Logs show: "MCP server started" or similar
- No unhandled exceptions

### Step 3.2: Health Check
```json
{ "tool": "mcp_health", "args": { "detail": "detailed" } }
```
**Expected:**
- status: "healthy"
- uptime: > 0
- queue.status: "idle" or "running"
- backends present

---

## Phase 4: Core Tool Functionality

### Step 4.1: Tool Discovery
```json
{ "tool": "discover_tools", "args": { "list_categories": true } }
```
**Expected:** Returns 10+ categories with tools

### Step 4.2: Workspace Snapshot
```json
{ "tool": "workspace", "args": { "mode": "snapshot", "path": "." } }
```
**Expected:** Returns file tree

### Step 4.3: Search
```json
{ "tool": "search", "args": { "action": "filenames", "root": ".", "query": "*.ts" } }
```
**Expected:** Returns TypeScript files

### Step 4.4: File Analysis
```json
{ "tool": "analyze_file", "args": { "path": "package.json" } }
```
**Expected:** Returns analysis without errors

### Step 4.5: Security Scan
```json
{ "tool": "security", "args": { "action": "scan", "root": "." } }
```
**Expected:** Returns scan results (0 findings expected for this repo)

---

## Phase 5: Error Handling

### Step 5.1: Invalid Enum
```json
{ "tool": "security", "args": { "action": "invalid" } }
```
**Expected:** Error includes "Valid values:" list

### Step 5.2: Missing Required Param
```json
{ "tool": "analyze_file", "args": {} }
```
**Expected:** Error mentions "path" is required

### Step 5.3: Invalid Path
```json
{ "tool": "analyze_file", "args": { "path": "nonexistent.xyz" } }
```
**Expected:** Clear "File not found" error

---

## Phase 6: Agent Task

### Step 6.1: Simple Agent Task
```json
{ "tool": "agent_task", "args": { "task": "List files in src/", "readOnly": true, "maxSteps": 3 } }
```
**Expected:**
- Returns result (partial or complete)
- completionReason present
- No hang or timeout

### Step 6.2: Verify Limits
Check response contains:
- effectiveOptions.maxActionsPerStep: 12 (or specified value)
- effectiveOptions.maxSteps: specified or default 25

---

## Phase 7: Performance Baseline

### Step 7.1: Health Check Latency
```json
{ "tool": "mcp_health", "args": {} }
```
**Expected:** Response in <100ms

### Step 7.2: Tool Discovery Latency
```json
{ "tool": "discover_tools", "args": { "list_categories": true } }
```
**Expected:** Response in <500ms

### Step 7.3: File Analysis Latency
```json
{ "tool": "analyze_file", "args": { "path": "package.json" } }
```
**Expected:** Response in <30s (LLM-dependent)

---

## Phase 8: Configuration

### Step 8.1: Config File Present
Check `env.settings` exists (or `env.settings.example` used)

### Step 8.2: Workspace Path
Verify server respects `allowedPaths` configuration (if set)

### Step 8.3: LLM Backend
Verify `backend.provider` matches running LLM (lmstudio/ollama)

---

## Release Gate Checklist

| Category | Check | Status |
|----------|-------|--------|
| **Build** | `npm run build` passes | ☐ |
| **Lint** | `npm run lint` passes | ☐ |
| **Types** | `npx tsc --noEmit` passes | ☐ |
| **Tests** | `npm test` all pass | ☐ |
| **Startup** | Server starts without errors | ☐ |
| **Health** | mcp_health returns healthy | ☐ |
| **Discovery** | discover_tools works | ☐ |
| **Workspace** | workspace snapshot works | ☐ |
| **Search** | search returns results | ☐ |
| **Analysis** | analyze_file works | ☐ |
| **Security** | security scan works | ☐ |
| **Errors** | Invalid inputs return clear errors | ☐ |
| **Agent** | agent_task completes | ☐ |
| **Performance** | Health <100ms, discovery <500ms | ☐ |

## Deployment Notes

### Required Configuration
- `env.settings` with backend settings
- LLM backend (LM Studio or Ollama) running
- Model loaded and accessible

### Optional Configuration
- `allowedPaths`: Restrict workspace access
- `toolDiscovery.fullToolList`: Enable all tools (default: curated)
- `mcpConnectors`: External MCP server connections

### Known Limitations
- LLM response time varies with model size and hardware
- Cache hit rate depends on query diversity
- Agent tasks may time out for very complex requests
- generate_tests output may need minor syntax fixes for complex files

## On Failure
1. Check server logs for errors
2. Verify LLM backend is responding
3. Run individual test suites to isolate issue
4. Check configuration files for typos
5. File issue with: phase number, exact error, system info
