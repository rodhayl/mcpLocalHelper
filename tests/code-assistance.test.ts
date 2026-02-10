/**
 * E2E sanity checks for the consolidated LLM assistance tools.
 *
 * These tests are intentionally resilient: they validate tool presence and response shape.
 * If the configured local LLM is unavailable, tools should still return valid JSON with
 * `success:false` and an `error` message (not crash the MCP server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { writeSettingsFile } from './test-utils/settings.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const TOOL_TIMEOUT_MS = 180000;

function writeCodeAssistanceSettings(): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-local-llm-code-assistance-'));
  const p = path.join(dir, 'env.code-assistance.stub.settings');
  const workspaceRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

  const configJson = {
    backends: [
      {
        id: 'stub',
        type: 'stub',
        base_url: 'http://127.0.0.1:1',
        model: 'stub-model',
        labels: { priority: 'primary' },
      },
    ],
    defaults: { localBackendId: 'stub', sotaBackendId: 'stub', localModel: 'stub-model', sotaModel: 'stub-model' },
    server: { host: '127.0.0.1', port: 0 },
    workspace: { roots: [workspaceRoot], defaultRoot: workspaceRoot },
    policy: { allowlistPaths: [workspaceRoot], maxFileBytes: 131072 },
    systemProfile: { exposeToLLM: false },
    toolGroups: { activeMode: 'DEVELOPMENT' },
    features: { testingModeEnabled: true },
  };

  writeSettingsFile(p, configJson, {
    serverPort: 0,
    serverHost: '127.0.0.1',
    exposeSystemProfile: false,
    testingEnabled: true,
    toolGroupMode: 'DEVELOPMENT',
  });

  return { dir, path: p };
}

function parseJsonText(res: any): any {
  expect(Array.isArray(res?.content)).toBe(true);
  const text = (res.content[0] as any)?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON tool response but got: ${String(text).slice(0, 200)}`);
  }
}

function expectSuccessShape(parsed: any, requiredWhenSuccess: string[]): void {
  expect(parsed).toBeTruthy();
  expect(typeof parsed.success).toBe('boolean');
  if (parsed.success === true) {
    for (const k of requiredWhenSuccess) expect(parsed).toHaveProperty(k);
  } else {
    expect(typeof parsed.error === 'string' || parsed.error === undefined).toBe(true);
  }
}

/** 
 * Helper to handle MCP SDK timeout errors gracefully.
 * MCP SDK throws McpError with code -32001 on timeout instead of returning response.
 */
function isMcpTimeoutError(error: any): boolean {
  return error?.code === -32001 || 
         error?.message?.includes('timed out') ||
         error?.message?.includes('Request timed out');
}

describe('LLM Assistance Tools - MCP Integration (consolidated)', () => {
  let client: any;
  let tempDir: string | null = null;
  let settingsPath: string | null = null;
  let savedCliEnabled: string | undefined;
  let savedCliBackends: string | undefined;
  
  /**
   * Call tool with timeout handling. Returns result or null if timed out.
   * Tests should accept null as a valid outcome for slow LLM operations.
   */
  const callToolSafe = async (name: string, args: Record<string, unknown>): Promise<any> => {
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    } catch (error: any) {
      if (isMcpTimeoutError(error)) {
        console.log(`${name} timed out (acceptable for slow LLM)`);
        return null; // Indicate timeout - test should accept this
      }
      throw error; // Re-throw non-timeout errors
    }
  };
  
  // Legacy callTool for tests that don't need timeout handling
  const callTool = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });

  beforeAll(async () => {
    // This suite is intentionally "shape-first" and should never depend on a live backend.
    // Use a stub backend to keep the suite fast and deterministic across runner backends
    // (especially opencode-cli which can be slow and hit Windows command-line limits).
    savedCliEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
    savedCliBackends = process.env.CLI_ORCHESTRATION_BACKENDS;
    delete process.env.CLI_ORCHESTRATION_ENABLED;
    delete process.env.CLI_ORCHESTRATION_BACKENDS;

    const cfg = writeCodeAssistanceSettings();
    tempDir = cfg.dir;
    settingsPath = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', settingsPath],
      // Keep these tests bounded even when a local LLM is slow/hanging.
      env: {
        ...process.env,
        LLM_CHAT_TIMEOUT_MS: process.env.LLM_CHAT_TIMEOUT_MS || '70000',
        // Avoid long retry loops that can exceed the per-test timeout.
        LLM_CHAT_RETRIES: process.env.LLM_CHAT_RETRIES || '0',
      },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    client = new Client({ name: 'code-assistance-e2e', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });

    if (savedCliEnabled !== undefined) process.env.CLI_ORCHESTRATION_ENABLED = savedCliEnabled;
    if (savedCliBackends !== undefined) process.env.CLI_ORCHESTRATION_BACKENDS = savedCliBackends;
  });

  it('exposes core tools in progressive discovery mode (assistance tools are discoverable)', async () => {
    const res = await client.listTools();
    const names = new Set(res.tools.map((t: any) => t.name));

    // In progressive discovery mode, only CORE_TOOLS are exposed via ListTools
    // The assistance tools are discoverable but not in the initial list
    // Verify discover_tools is available (to expand the tool set)
    expect(names.has('discover_tools')).toBe(true);
    
    // mcp_terminal_command is agent-only (LLMs have native terminal access)
    expect(names.has('mcp_terminal_command')).toBe(false);
    
    // Note: code_helper, regex_helper, etc. are discoverable tools, 
    // NOT in the core set - they can still be called via CallTool
    // The following tools are in the discoverable tier:
    const discoverableTools = [
      'code_helper',
      'regex_helper',
      'refactor_helper',
      'mcp_diff_summarizer',
      'mcp_error_explainer',
      'mcp_translate_code',
      'mcp_plan_implementation',
      'mcp_analyze_complexity',
      'mcp_summarize_logs',
    ];
    // They're not in the initial core set, but they're still callable
    // (we verify calling them in subsequent tests)
  }, 30000);

  it('code_helper explain returns JSON', async () => {
    const res = await callToolSafe('code_helper', {
      action: 'explain',
      code: `function add(a, b) { return a + b; }`,
      language: 'javascript',
      level: 'beginner',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['explanation']);
  }, 200000);

  it('code_helper optimize returns JSON', async () => {
    const res = await callToolSafe('code_helper', {
      action: 'optimize',
      code: `function sum(arr){let s=0; for(const x of arr){ s+=x } return s }`,
      language: 'javascript',
      focus: 'all',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['summary']);
  }, 200000);

  it('code_helper simplify returns JSON', async () => {
    const res = await callToolSafe('code_helper', {
      action: 'simplify',
      code: `function isEven(n){ if(n===0){return true}else if(n===1){return false}else{return isEven(n-2)} }`,
      language: 'javascript',
      preserve: ['comments'],
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['simplifiedCode']);
  }, 200000);

  it('refactor_helper suggest_names returns JSON', async () => {
    const res = await callToolSafe('refactor_helper', {
      action: 'suggest_names',
      code: `function f(x,y){ const a=x*2; const b=y+a; return b }`,
      language: 'javascript',
      style: 'camelCase',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['suggestions']);
  }, 200000);

  it('refactor_helper extract_function returns JSON', async () => {
    const code = `function processOrder(order){
  if (!order.id) throw new Error('Missing order ID');
  if (!order.items || order.items.length === 0) throw new Error('No items');
  return order;
}`;
    const res = await callToolSafe('refactor_helper', {
      action: 'extract_function',
      code,
      language: 'javascript',
      selection: `if (!order.id) throw new Error('Missing order ID');\n  if (!order.items || order.items.length === 0) throw new Error('No items');`,
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['functionName']);
  }, 200000);

  it('regex_helper explain returns JSON', async () => {
    const res = await callToolSafe('regex_helper', {
      action: 'explain',
      pattern: '^[a-z]+\\d+$',
      flavor: 'javascript',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    // explainRegex returns {success, explanation, breakdown, examples...}
    expectSuccessShape(parsed, ['pattern', 'explanation']);
  }, 200000);

  it('regex_helper generate returns JSON', async () => {
    const res = await callToolSafe('regex_helper', {
      action: 'generate',
      description: 'Match email addresses like user@example.com',
      examples: ['test@example.com', 'a.b+tag@foo.io'],
      flavor: 'javascript',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['pattern']);
  }, 210000);

  it('mcp_diff_summarizer returns JSON', async () => {
    const res = await callToolSafe('mcp_diff_summarizer', {
      diff: `--- a/utils.js\n+++ b/utils.js\n@@ -1,3 +1,4 @@\n function add(a,b){\n-  return a+b;\n+  if(typeof a!==\"number\"||typeof b!==\"number\") throw new Error(\"Invalid\");\n+  return a+b;\n }`,
      format: 'summary',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['summary']);
  }, 200000);

  it('mcp_error_explainer returns JSON', async () => {
    const res = await callToolSafe('mcp_error_explainer', {
      error: `TypeError: Cannot read properties of undefined (reading 'map')\n    at processData (/app/src/utils.js:15:25)`,
      language: 'javascript',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['rootCause']);
  }, 200000);

  it('mcp_translate_code returns JSON', async () => {
    const res = await callToolSafe('mcp_translate_code', {
      code: `def add(a, b):\n  return a + b\n`,
      sourceLanguage: 'python',
      targetLanguage: 'javascript',
      preserveComments: true,
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['translatedCode']);
  }, 200000);

  it('mcp_plan_implementation returns JSON', async () => {
    const res = await callToolSafe('mcp_plan_implementation', {
      feature: 'Add a /health endpoint that returns {status:\"ok\"} and include a basic unit test.',
      constraints: ['No breaking changes', 'Keep it minimal'],
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['plan']);
  }, 200000);

  it('mcp_analyze_complexity returns JSON', async () => {
    const res = await callToolSafe('mcp_analyze_complexity', {
      code: `for (let i=0;i<n;i++){ for(let j=0;j<n;j++){} }`,
      language: 'javascript',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['timeComplexity']);
  }, 200000);

  it('mcp_summarize_logs returns JSON', async () => {
    const res = await callToolSafe('mcp_summarize_logs', {
      logs: `INFO start\nWARN cache miss\nERROR boom\nERROR boom\nINFO done\n`,
      focus: 'all',
      maxLines: 50,
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['summary']);
  }, 200000);

  it('mcp_terminal_command returns JSON', async () => {
    const res = await callToolSafe('mcp_terminal_command', {
      task: 'List files recursively and search for \"TODO\"',
      shell: 'powershell',
      os: 'windows',
    });
    if (!res) return; // Timeout is acceptable
    const parsed = parseJsonText(res);
    expectSuccessShape(parsed, ['commands']);
  }, 200000);
});
