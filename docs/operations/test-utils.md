# Test Utilities

This directory contains utility scripts for testing and debugging the MCP Local LLM server.

## Available Scripts

### Test Artifact Lifecycle

`npm test` runs via `scripts/run-tests-with-cleanup.js`, which:
- prepares transient test assets before Vitest
- forces orchestration plans for tests into `.tmp/test-orchestration-plans`
- always cleans transient artifacts after the run (success or failure)

Use `npm run cleanup:test-assets` to force cleanup manually.

### verify_fetch.js
Tests connectivity to LM Studio's local API endpoints.

**Usage:**
```bash
node scripts/test-utils/verify_fetch.js
```

**Purpose:**
- Verifies LM Studio is running and accessible
- Tests the `/v1/models` endpoint
- Tests the `/v1/chat/completions` endpoint
- Useful for debugging backend connection issues

**Expected Output:**
```
Checking /models...
/models status: 200
/models count: 5
Checking /chat/completions...
/chat status: 200
/chat response: {...}
```
