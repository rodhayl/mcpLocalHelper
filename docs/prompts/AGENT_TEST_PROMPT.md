# MCP Local LLM Testing Agent Prompt

> Use this prompt to instruct any AI agent to test all 35 MCP Local LLM tools in a project.

---

## 🤖 THE PROMPT

Copy and paste everything below the line to instruct an agent to test MCP tools:

---

```markdown
# Task: Comprehensive MCP Local LLM Tool Testing

You are a specialized testing agent. Your mission is to systematically test all 35 MCP Local LLM tools in this project, validate results against actual project state, and produce a comprehensive token savings report.

## CRITICAL RULES

1. **DO NOT MODIFY ANY FILES** - You are read-only. Only observe and report.
2. **TEST SEQUENTIALLY** - Run one tool at a time, wait for results.
3. **VALIDATE EVERYTHING** - Every tool output must be verified against actual project state.
4. **ESTIMATE TOKENS** - Calculate token savings for each tool vs traditional approach.
5. **REPORT FAILURES** - Document any tool that fails or returns unexpected results.

## TESTING PROCEDURE

### Phase 1: Environment Verification
1. Confirm MCP Local LLM server is running
2. Confirm local LLM is available (run `model_info` with action: "list")
3. Identify project root path
4. Note project type (TypeScript/JavaScript/Python/Mixed)

### Phase 2: Core Read Tools (4 tools)
Test in order:
1. `file_metadata` - on package.json or equivalent main file
2. `explore_directory` - on src or main source directory
3. `manifest_snapshot` - on project root
4. `cross_file_links` - on main entry point

For each tool:
- Record parameters used
- Record response structure
- Validate against actual project state
- Estimate token savings

### Phase 3: Core Summary Tools (3 tools)
Test in order:
1. `summarize_path` - on source directory (mode: extended)
2. `summarize_repo` - on project root (mode: extended)
3. `aggregate_todos` - on project root (groupBy: priority)

For each tool:
- Verify summary accuracy
- Cross-reference with actual code
- Note any inaccuracies

### Phase 4: Core Chat Tools (2 tools)
Test in order:
1. `llm_chat` - simple math question (2+2) with local backend
2. `codebase_qa` - "What is the main purpose of this project?"

For each tool:
- Verify LLM responds coherently
- For codebase_qa, verify answer matches project purpose

### Phase 5: Planning Tools (2 tools)
Test in order:
1. `validate_syntax` - on main source file
2. `verify_plan` - with sample 2-step plan

For each tool:
- Verify valid files pass validation
- Verify plan verification provides useful feedback

### Phase 6: System Info Tools (2 tools)
Test in order:
1. `system_profile` - with detail: "extended"
2. `model_info` - with action: "list", then "recommend" for code_generation

For each tool:
- Verify system info matches actual hardware
- Verify model list includes available models

### Phase 7: Analysis Extended Tools (6 tools)
Test in order:
1. `analyze_file` - on a main source file (analysisType: full)
2. `structured_search` - search for main function name
3. `intelligent_search` - natural language query about project
4. `index_symbols` - on project root
5. `gather_context` - query about main feature
6. `analyze_impact` - on a changed file

For each tool:
- Verify analysis matches actual code
- Verify search results are accurate
- Verify symbol indexing captures key symbols

### Phase 8: Privacy Tools (3 tools)
Test in order:
1. `secret_scan` - on project root
2. `risk_score` - on sample sensitive content
3. `redaction_preview` - on sample content with fake secrets

For each tool:
- Verify no false positives on legitimate code
- Verify secrets are correctly identified

### Phase 9: Code Quality Tools (4 tools)
Test in order:
1. `local_code_review` - on a main source file
2. `suggest_refactoring` - on same file
3. `analyze_test_gaps` - on project root
4. `generate_tests` - on a utility file

For each tool:
- Verify suggestions are relevant
- Verify test gap analysis matches actual coverage
- Verify generated tests are syntactically valid

### Phase 10: Documentation Tool (1 tool)
Test:
1. `generate_docs` - on a source file (docType: jsdoc)

Verify:
- Documentation format is correct
- All functions are documented

### Phase 11: Edit Safe Tools (2 tools)
Test in order:
1. `suggest_edit` - intent: "improve error handling"
2. `draft_file` - intent: create utility function

For each tool:
- Verify suggestions are relevant
- Verify NO FILES ARE MODIFIED
- Verify draft content is syntactically valid

### Phase 12: Execution Tools (3 tools)
Test in order:
1. `run_linter` - with fix: false
2. `run_formatter` - with check: true
3. `draft_commit_message` - if any staged changes

For each tool:
- Verify commands execute successfully
- Verify check mode doesn't modify files

### Phase 13: Autofix Tools (3 tools) - DRY RUN ONLY
Test in order (ALL WITH dryRun: true):
1. `fix_linter` - difficulty: easy, dryRun: true
2. `fix_syntax` - difficulty: easy, dryRun: true
3. `implement_todos` - difficulty: easy, dryRun: true

For each tool:
- CRITICAL: Always use dryRun: true
- Verify proposed fixes are sensible
- Verify NO FILES ARE MODIFIED

## TOKEN SAVINGS ESTIMATION

For each tool, calculate:
```
Traditional Approach Tokens = (files to read × avg tokens/file) + analysis overhead
MCP Approach Tokens = tool input tokens + tool output tokens
Savings % = ((Traditional - MCP) / Traditional) × 100
```

### Reference Token Costs (approximate):
- Small file (< 100 lines): 500 tokens
- Medium file (100-500 lines): 2,000 tokens
- Large file (500+ lines): 5,000+ tokens
- Directory listing: 200 tokens per 20 items
- Full repo read: 20,000-100,000 tokens

## REPORT FORMAT

After testing all 35 tools, produce this report:

```markdown
# MCP Local LLM Test Report

## Project Information
- Project: [name]
- Path: [path]
- Type: [TypeScript/JavaScript/Python/Mixed]
- Date: [date]

## Environment
- MCP Server: [running/not running]
- Local LLM: [model name]
- SOTA Backend: [available/unavailable]

## Test Results Summary
- Tools Tested: [X]/35
- Passed: [X]
- Failed: [X]
- Skipped: [X]

## Detailed Results

### [Tool Name] - [PASS/FAIL]
- Parameters: [JSON]
- Response: [summary]
- Validation: [how verified]
- Token Savings: [X]%

[Repeat for all 35 tools]

## Token Savings Summary

| Category | Tools | Avg Savings |
|----------|-------|-------------|
| Core Read | 4 | [X]% |
| Core Summary | 3 | [X]% |
| Core Chat | 2 | [X]% |
| Planning | 2 | [X]% |
| System Info | 2 | [X]% |
| Analysis Extended | 6 | [X]% |
| Privacy | 3 | Unique |
| Code Quality | 4 | [X]% |
| Documentation | 1 | [X]% |
| Edit Safe | 2 | Time |
| Execution | 3 | Time |
| Autofix | 3 | Time |

**Overall Estimated Token Savings: [X]%**

## Issues Found
[List any tool failures or unexpected behaviors]

## Recommendations
[Any suggestions for improvement]
```

## TOOL QUICK REFERENCE

### Tools That MUST Use dryRun: true
- `fix_linter`
- `fix_syntax`
- `implement_todos`

### Tools That Check But Don't Modify
- `run_linter` (with fix: false)
- `run_formatter` (with check: true)
- `validate_syntax`
- `suggest_edit`
- `draft_file`

### Tools That Are Read-Only
All other tools are inherently read-only.

## BEGIN TESTING

Start by running:
```json
{
  "tool": "model_info",
  "parameters": {"action": "list"}
}
```

Then proceed through all phases systematically.

Remember: NO MODIFICATIONS. VALIDATE EVERYTHING. ESTIMATE TOKENS.
```

---

## 📋 Prompt Summary

This prompt instructs the testing agent to:

1. **Verify environment** - Check MCP server and LLM availability
2. **Test all 35 tools** - Organized by category
3. **Validate results** - Cross-check with actual project state
4. **Estimate token savings** - Compare MCP vs traditional approach
5. **Produce comprehensive report** - Structured output with all results

## 🎯 Expected Outcomes

After running this prompt, the testing agent should produce:

- ✅ Confirmation that all 35 tools work
- ✅ Token savings estimate per tool category
- ✅ Overall token savings percentage
- ✅ Any issues or failures documented
- ✅ Recommendations for improvement

## ⚠️ Important Notes

1. The agent should have access to MCP Local LLM tools
2. The local LLM must be running (Ollama/LM Studio)
3. The agent should NOT modify any files
4. All autofix tools must use dryRun: true

---

*Version: 2.0*
*Compatible with: MCP Local LLM v1.0.0+*
*Tools Covered: 35*
