# MCP Local LLM — Edge Cases (v15)

## Goal
Test error handling, boundary conditions, and failure modes to ensure robust behavior.

## Preconditions
- MCP server running
- LLM backend available

---

## Test Group 1: Invalid Input Handling

### Test 1.1: Missing Required Parameters
```json
{ "tool": "analyze_file", "args": {} }
```
**Expected:** Error message mentions "path" is required

### Test 1.2: Wrong Type for Parameter
```json
{ "tool": "search", "args": { "action": "intelligent", "root": 123, "query": "test" } }
```
**Expected:** Error about type mismatch (root should be string)
**Note:** Omitting `root` is allowed; server will default it to the workspace root (`.`). Tests should verify both explicit bad-type errors and omission behavior.

### Test 1.3: Empty String for Required Field
```json
{ "tool": "suggest_edit", "args": { "target_file": "", "instruction": "fix bug" } }
```
**Expected:** Error about empty target_file

### Test 1.4: Invalid Enum Value
```json
{ "tool": "search", "args": { "action": "unknown_action", "root": "." } }
```
**Expected:**
- Error lists valid values: intelligent, structured, filenames, gather
- Hint with example usage

---

## Test Group 2: Path Validation

### Test 2.1: Path Outside Workspace
```json
{ "tool": "analyze_file", "args": { "path": "C:\\Windows\\System32\\config" } }
```
**Expected:** Error: "Outside workspace" or "Access denied"

### Test 2.2: Non-Existent File
```json
{ "tool": "analyze_file", "args": { "path": "does/not/exist.ts" } }
```
**Expected:**
- Error: "File not found"
- Includes resolved path hint
- Suggests verifying path

### Test 2.3: Directory Instead of File
```json
{ "tool": "analyze_file", "args": { "path": "src" } }
```
**Expected:** Error about expecting file, got directory (or attempts directory analysis)

### Test 2.4: Relative Path Resolution
```json
{ "tool": "analyze_file", "args": { "path": "./package.json" } }
```
**Expected:** Resolves correctly, returns analysis (not error)

---

## Test Group 3: Large Input Handling

### Test 3.1: Very Long Query String
```json
{ "tool": "search", "args": { "action": "intelligent", "root": ".", "query": "<1000 char string>" } }
```
**Expected:** Either processes or returns clear "query too long" error

### Test 3.4: generate_tests sanitization
```json
{ "tool": "generate_tests", "args": { "path": "some_small_file.py" } }
```
**Expected:** Generated tests are post-processed to decode common HTML entities, normalize Python import paths, and sanitize class/function names. If `black` is installed, output may be formatted automatically.

### Test 3.2: Large File Analysis
```json
{ "tool": "analyze_file", "args": { "path": "src/server/mcp.ts" } }
```
**Expected:**
- Handles large file (5000+ lines)
- May truncate with clear indication
- Returns meaningful analysis

### Test 3.3: Deep Directory Tree
```json
{ "tool": "workspace", "args": { "mode": "snapshot", "path": ".", "maxDepth": 10 } }
```
**Expected:** Either completes or respects maxDepth limit

---

## Test Group 4: Empty/Null States

### Test 4.1: Empty Directory
```json
{ "tool": "workspace", "args": { "mode": "snapshot", "path": "coverage" } }
```
**Expected:** Returns empty result or "directory empty" (not error)

### Test 4.2: No Search Results
```json
{ "tool": "search", "args": { "action": "filenames", "root": ".", "query": "*.xyz123nonexistent" } }
```
**Expected:** Empty results array (not error)

### Test 4.3: Security Scan No Findings
```json
{ "tool": "security", "args": { "action": "scan", "root": "." } }
```
**Expected:** 
- Returns scan summary
- findings: [] or findings: null
- filesScanned count present

---

## Test Group 5: Timeout/Cancellation

### Test 5.1: Agent Task with Very Short Timeout
```json
{ "tool": "agent_task", "args": { "task": "Analyze all files in detail", "timeoutMs": 1000 } }
```
**Expected:**
- completionReason: "timeout" or partial result
- Does not hang indefinitely

### Test 5.2: Concurrent Tool Calls (if supported)
Run multiple mcp_health calls in parallel.
**Expected:** All return valid responses (queue handles concurrency)

---

## Test Group 6: Tool Discovery Edge Cases

### Test 6.1: Unknown Category
```json
{ "tool": "discover_tools", "args": { "category": "nonexistent_category" } }
```
**Expected:** Empty result or error listing valid categories

### Test 6.2: Capability Search
```json
{ "tool": "discover_tools", "args": { "capability": "generate tests" } }
```
**Expected:** Returns generate_tests tool info

### Test 6.3: Agent-Only Tool Direct Call
```json
{ "tool": "system_profile", "args": {} }
```
**Expected:** 
- Either works (if in expanded tool set)
- Or error explaining tool is agent-only

---

## Test Group 7: Malformed JSON Handling

### Test 7.1: Extra Properties
```json
{ "tool": "mcp_health", "args": { "unknown_param": "value" } }
```
**Expected:** Ignores extra property, returns health (additionalProperties typically allowed)

### Test 7.2: Nested Objects
```json
{ "tool": "search", "args": { "action": "intelligent", "root": ".", "query": { "nested": "object" } } }
```
**Expected:** Error about query type (should be string)

---

## Pass/Fail Summary Template

| Test | Expected Behavior | Actual | Status |
|------|-------------------|--------|--------|
| 1.1 | Missing param error | | |
| 1.2 | Type mismatch error | | |
| 1.3 | Empty string error | | |
| 1.4 | Lists valid enums | | |
| 2.1 | Outside workspace | | |
| 2.2 | File not found | | |
| 2.3 | Directory handling | | |
| 2.4 | Relative path works | | |
| 3.1 | Long query handled | | |
| 3.2 | Large file handled | | |
| 3.3 | Deep tree limited | | |
| 4.1 | Empty dir handled | | |
| 4.2 | No results = [] | | |
| 4.3 | Scan returns summary | | |
| 5.1 | Timeout respected | | |
| 5.2 | Concurrent OK | | |
| 6.1 | Unknown category | | |
| 6.2 | Capability search | | |
| 6.3 | Agent-only handled | | |
| 7.1 | Extra props ignored | | |
| 7.2 | Nested obj rejected | | |

## On Failure
1. Note exact input that caused failure
2. Capture full error response
3. Check if error is clear and actionable
4. File bug if error is cryptic or server crashes
