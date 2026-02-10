/**
 * MCP Server & MCP Ask E2E Tests (Consolidated)
 *
 * Covers:
 * - mcp_ask agent-only behavior and validation
 * - mcp_server integration (action validation, aliases)
 * - mcp_server robustness with no external servers
 * - mcp_server argument aliasing and schema handling
 * - screenshot artifact copy behavior
 */

import path from 'path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeSettingsFile } from './test-utils/settings.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function writeAskConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-ask-test-'));
  const p = path.join(dir, 'env.settings');
  const cfg = {
    backends: [
      {
        id: 'stub',
        type: 'stub',
        base_url: 'http://127.0.0.1:1',
        model: 'stub-model',
        labels: { priority: 'primary' },
      },
    ],
    defaults: { localBackendId: 'stub', sotaBackendId: 'stub' },
    server: { host: '127.0.0.1', port: 0 },
    workspace: { roots: ['.'], defaultRoot: '.' },
    policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
    mcpServers: {},
    systemProfile: { exposeToLLM: true },
    toolGroups: { activeMode: 'DEVELOPMENT' },
    toolDiscovery: { fullToolList: true },
    rateLimiter: { enabled: false },
  };
  writeSettingsFile(p, cfg, { serverPort: 0, exposeSystemProfile: true, testingEnabled: true });
  return { dir, path: p };
}

function writeConfigWithFlakyMcpServer(): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-local-llm-mcpservercfg-'));
  const p = path.join(dir, 'env.settings');
  const fixture = path.resolve(__dirname, 'fixtures', 'flaky-mcp-server.cjs').replace(/\\/g, '/');
  const counter = path.join(dir, 'counter.txt').replace(/\\/g, '/');

  const cfg = {
    backends: [{ id: 'stub', type: 'stub', base_url: 'http://127.0.0.1:1', model: 'stub-model' }],
    defaults: { localBackendId: 'stub', sotaBackendId: 'stub' },
    server: { host: '127.0.0.1', port: 0 },
    workspace: { roots: ['.'], defaultRoot: '.' },
    policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
    systemProfile: { exposeToLLM: true },
    toolGroups: { activeMode: 'DEVELOPMENT' },
    mcpServers: {
      flaky: {
        type: 'stdio',
        command: 'node',
        args: [fixture],
        env: { COUNTER_FILE: counter, FAILS: '0' },
        autoConnect: false,
      },
    },
    toolDiscovery: { fullToolList: true },
    rateLimiter: { enabled: false },
  };
  writeFileSync(p, `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n`, 'utf8');
  return { dir, path: p };
}

function writeRobustnessConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-robustness-test-'));
  const p = path.join(dir, 'env.test.settings');
  const repoRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

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
    defaults: {
      localBackendId: 'stub',
      sotaBackendId: 'stub',
    },
    server: {
      host: '127.0.0.1',
      port: 0,
    },
    workspace: {
      roots: [repoRoot],
      defaultRoot: repoRoot,
    },
    policy: {
      allowlistPaths: [repoRoot],
      maxFileBytes: 131072,
    },
    // No external MCP servers configured - simulates fresh install
    mcpServers: {},
    systemProfile: {
      exposeToLLM: true,
    },
    toolGroups: {
      activeMode: 'DEVELOPMENT',
    },
    editing: {
      enabled: true,
      backupEnabled: true,
      backupDir: '.mcp-backups',
      requirePreview: false,
      maxFileSize: 1048576,
    },
    toolDiscovery: {
      fullToolList: true,
    },
    rateLimiter: {
      enabled: false,
    },
  };

  writeSettingsFile(p, configJson, { exposeSystemProfile: true, serverPort: 0, serverHost: '127.0.0.1' });
  return { dir, path: p };
}

function writeConfigWithScreenshotServer(opts?: { failOnFilePath?: boolean }): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-local-llm-shotcfg-'));
  const p = path.join(dir, 'env.settings');
  const fixture = path.resolve(__dirname, 'fixtures', 'screenshot-mcp-server.cjs').replace(/\\/g, '/');

  const cfg = {
    backends: [{ id: 'stub', type: 'stub', base_url: 'http://127.0.0.1:1', model: 'stub-model' }],
    defaults: { localBackendId: 'stub', sotaBackendId: 'stub' },
    server: { host: '127.0.0.1', port: 0 },
    workspace: { roots: ['.'], defaultRoot: '.' },
    policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
    systemProfile: { exposeToLLM: true },
    toolGroups: { activeMode: 'DEVELOPMENT' },
    mcpServers: {
      shot: {
        type: 'stdio',
        command: 'node',
        args: [fixture],
        ...(opts?.failOnFilePath ? { env: { FAIL_ON_FILEPATH: '1' } } : {}),
        autoConnect: false,
      },
    },
    toolDiscovery: { fullToolList: true },
    rateLimiter: { enabled: false },
  };
  writeFileSync(p, `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n`, 'utf8');
  return { dir, path: p };
}

describe('E2E mcp_ask and mcp_server integration tests', () => {
  let client: any;
  let tempDir: string | null = null;
  let configPath: string | null = null;

  beforeAll(async () => {
    const cfg = writeAskConfig();
    tempDir = cfg.dir;
    configPath = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'e2e-mcp-ask-test', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================
  // Test 1: mcp_ask is agent-only (hidden from ListTools but callable)
  // ============================================
  it('mcp_ask is agent-only (hidden from ListTools but still callable)', async () => {
    const res = await client.listTools();
    const tool = res.tools.find((t: any) => t.name === 'mcp_ask');
    // mcp_ask is in AGENT_ONLY_TOOLS - hidden from ListTools for token efficiency
    expect(tool).toBeUndefined();

    // But the tool IS callable via CallTool
    const callRes = await client.callTool({
      name: 'mcp_ask',
      arguments: {
        serverName: 'test-server',
        task: 'Test task',
      },
    });
    // Should return structured response (even if error because server not configured)
    expect(callRes.content).toBeTruthy();
  }, 30000);

  // ============================================
  // Test 2: mcp_ask requires serverName
  // ============================================
  it('mcp_ask requires serverName parameter', async () => {
    const res = await client.callTool({
      name: 'mcp_ask',
      arguments: {
        task: 'Take a screenshot of google.com',
        // Missing serverName
      },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('serverName');
  }, 30000);

  // ============================================
  // Test 3: mcp_ask requires task
  // ============================================
  it('mcp_ask requires task parameter', async () => {
    const res = await client.callTool({
      name: 'mcp_ask',
      arguments: {
        serverName: 'chrome-devtools',
        // Missing task
      },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('task');
  }, 30000);

  // ============================================
  // Test 4: mcp_ask returns helpful error when server not connected
  // ============================================
  it('mcp_ask returns helpful error when server not connected', async () => {
    const res = await client.callTool({
      name: 'mcp_ask',
      arguments: {
        serverName: 'chrome-devtools',
        task: 'Take a screenshot of google.com',
      },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Not connected');
    expect(parsed.error).toContain('mcp_server');
    expect(parsed.error).toContain('connect');
  }, 30000);

  // ============================================
  // Test 5: mcp_ask accepts preferredTool parameter (via call, not discovery)
  // ============================================
  it('mcp_ask accepts preferredTool parameter', async () => {
    // mcp_ask is agent-only, so we test it via CallTool not ListTools
    const res = await client.callTool({
      name: 'mcp_ask',
      arguments: {
        serverName: 'test-server',
        task: 'Test task',
        preferredTool: 'some_tool', // Optional parameter
      },
    });
    // Should accept the parameter (even if error because server not configured)
    expect(res.content).toBeTruthy();
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false); // Not connected, but accepted the params
  }, 30000);

  // ============================================
  // Test 6: mcp_ask error message includes configured servers list
  // ============================================
  it('mcp_ask error includes list of configured servers', async () => {
    const res = await client.callTool({
      name: 'mcp_ask',
      arguments: {
        serverName: 'non-existent-server',
        task: 'Do something',
      },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    // Should include configuredServers in error response
    expect(parsed).toHaveProperty('configuredServers');
  }, 30000);

  // ============================================
  // Verify all action types are handled
  // ============================================

  it('mcp_server connect action validates serverName', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'connect' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('serverName');
  }, 30000);

  it('mcp_server disconnect action validates serverName', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'disconnect' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('serverName');
  }, 30000);

  it('mcp_server call action validates both serverName and toolName', async () => {
    // Test missing toolName
    const res1 = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'call', serverName: 'some-server' },
    });
    expect(res1.isError).toBe(true);
    const text1 = (res1.content[0] as any).text;
    expect(text1).toContain('toolName');
  }, 30000);

  it('mcp_server list action works without serverName', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'list' },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed).toHaveProperty('configuredServers');
    expect(parsed).toHaveProperty('connectedCount');
  }, 30000);

  it('mcp_server status action returns comprehensive info', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'status' },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed).toHaveProperty('configured');
    expect(parsed).toHaveProperty('connected');
    expect(parsed).toHaveProperty('servers');
    expect(parsed).toHaveProperty('note');
  }, 30000);

  // ============================================
  // Verify argument aliasing works
  // ============================================

  it('mcp_server call accepts arguments alias "args"', async () => {
    // This should fail because server doesn't exist, but validate that args alias is accepted
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'test-server',
        toolName: 'test-tool',
        args: { key: 'value' },
      },
    });
    // Will error because server doesn't exist, but args should be accepted
    expect(res.content).toBeTruthy();
  }, 30000);

  it('mcp_server call accepts arguments alias "parameters"', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'test-server',
        toolName: 'test-tool',
        parameters: { key: 'value' },
      },
    });
    expect(res.content).toBeTruthy();
  }, 30000);

  it('mcp_server call accepts arguments alias "input"', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'test-server',
        toolName: 'test-tool',
        input: { key: 'value' },
      },
    });
    expect(res.content).toBeTruthy();
  }, 30000);

  it('mcp_server call accepts arguments alias "toolArgs"', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'test-server',
        toolName: 'test-tool',
        toolArgs: { key: 'value' },
      },
    });
    expect(res.content).toBeTruthy();
  }, 30000);

  it('mcp_server call accepts arguments alias "params"', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'test-server',
        toolName: 'test-tool',
        params: { key: 'value' },
      },
    });
    expect(res.content).toBeTruthy();
  }, 30000);

  // ============================================
  // Verify includeSchema option
  // ============================================

  it('mcp_server list accepts includeSchema option', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'list', includeSchema: false },
    });
    expect(res.isError).not.toBe(true);
  }, 30000);

  it('mcp_server list accepts include_schema snake_case alias', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'list', include_schema: false },
    });
    expect(res.isError).not.toBe(true);
  }, 30000);
});

describe('E2E mcp_server supports parameters/input aliases', () => {
  let client: any;
  let tempDir: string | null = null;
  let configPath: string | null = null;

  beforeAll(async () => {
    const cfg = writeConfigWithFlakyMcpServer();
    tempDir = cfg.dir;
    configPath = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'e2e-mcp-server-params', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes tool args when provided in parameters', async () => {
    // list with serverName should auto-connect and include schemas
    const list = await client.callTool({ name: 'mcp_server', arguments: { action: 'list', serverName: 'flaky' } });
    expect(list.isError).not.toBe(true);
    const listParsed = JSON.parse((list.content[0] as any).text);
    expect(listParsed.connected).toBe(true);
    expect(Array.isArray(listParsed.tools)).toBe(true);
    expect(listParsed.tools.some((t: any) => t.name === 'echo')).toBe(true);

    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'flaky',
        toolName: 'echo',
        parameters: { text: 'hello' },
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('hello');
  }, 30000);

  it('supports list includeSchema=false to reduce payload', async () => {
    const list = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'list', serverName: 'flaky', includeSchema: false },
    });
    expect(list.isError).not.toBe(true);
    const parsed = JSON.parse((list.content[0] as any).text);
    expect(parsed.connected).toBe(true);
    const echo = parsed.tools.find((t: any) => t.name === 'echo');
    expect(echo).toBeTruthy();
    expect(echo.inputSchema).toBeUndefined();
  }, 30000);

  it('passes tool args when provided in input', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'flaky',
        toolName: 'echo',
        input: { text: 'world' },
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('world');
  }, 30000);

  it('passes tool args when provided in toolArgs', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'flaky',
        toolName: 'echo',
        toolArgs: { text: 'toolargs' },
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('toolargs');
  }, 30000);

  it('passes tool args when provided in params', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'flaky',
        toolName: 'echo',
        params: { text: 'params' },
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('params');
  }, 30000);

  it('unwraps nested args objects', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'flaky',
        toolName: 'echo',
        toolArgs: { args: { text: 'nested' } },
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('nested');
  }, 30000);

  it('strips unknown args when tool schema is strict', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'flaky',
        toolName: 'echo',
        parameters: { text: 'sanitized', timeout: 123 },
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('sanitized');
    expect(parsed.meta?.strippedArgs?.includes('timeout')).toBe(true);
  }, 30000);
});

describe('E2E mcp_server robustness tests', () => {
  let client: any;
  let tempDir: string | null = null;
  let configPath: string | null = null;

  beforeAll(async () => {
    const cfg = writeRobustnessConfig();
    tempDir = cfg.dir;
    configPath = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'e2e-robustness-test', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================
  // Test 1: List action with no configured servers
  // ============================================
  it('list action returns helpful note when no servers configured', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'list' },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.configuredServers).toEqual([]);
    expect(parsed.connectedCount).toBe(0);
    // Should include helpful note
    expect(parsed.note).toBeTruthy();
    expect(parsed.note).toContain('LOCAL tools');
    expect(parsed.note).toContain('agent_task');
  }, 30000);

  // ============================================
  // Test 2: Status action with no configured servers
  // ============================================
  it('status action returns helpful note when no servers configured', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'status' },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.configured).toBe(0);
    expect(parsed.connected).toBe(0);
    expect(parsed.servers).toEqual([]);
    // Should include helpful note about local tools
    expect(parsed.note).toBeTruthy();
    expect(parsed.note).toContain('No external MCP servers configured');
    expect(parsed.note).toContain('Local tools');
  }, 30000);

  // ============================================
  // Test 3: Call action without serverName - generic error
  // ============================================
  it('call action without serverName gives helpful error message', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'call', toolName: 'some_tool' },
    });
    // Should error gracefully with structured error
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    const parsed = JSON.parse(text);
    expect(parsed.success).toBe(false);
    expect(parsed.errorType).toBe('missing_params');
    expect(parsed.message).toContain('serverName');
    expect(parsed.hint).toContain('list');
  }, 30000);

  // ============================================
  // Test 4: Call action trying to call local tool (agent_task) via mcp_server
  // ============================================
  it('call action for agent_task without serverName gives LOCAL tool hint', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'call', toolName: 'agent_task' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('LOCAL tool');
    expect(parsed.hint).toBeTruthy();
    expect(parsed.hint).toContain('mcp_mcp-local-llm_agent_task');
    expect(Array.isArray(parsed.localTools)).toBe(true);
    expect(parsed.localTools).toContain('agent_task');
  }, 30000);

  // ============================================
  // Test 5: Call action trying to call llm_chat via mcp_server
  // ============================================
  it('call action for llm_chat without serverName gives LOCAL tool hint', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'call', toolName: 'llm_chat' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('LOCAL tool');
    expect(parsed.hint).toContain('llm_chat');
  }, 30000);

  // ============================================
  // Test 6: Call action trying to call summarize via mcp_server
  // ============================================
  it('call action for summarize without serverName gives LOCAL tool hint', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'call', toolName: 'summarize' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.localTools).toContain('summarize');
  }, 30000);

  // ============================================
  // Test 7: Connect action for non-existent server
  // ============================================
  it('connect action for non-existent server gives helpful error', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'connect', serverName: 'non-existent-server' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('not found in configuration');
    // Should suggest how to configure
    expect(parsed.error).toMatch(/env\.settings|settings file|MCP_LOCAL_LLM_SETTINGS_PATH/i);
  }, 30000);

  // ============================================
  // Test 8: Connect action trying to connect to self (mcp-local-llm)
  // ============================================
  it('connect action to mcp-local-llm gives clear error', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'connect', serverName: 'mcp-local-llm' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('this MCP server');
  }, 30000);

  // ============================================
  // Test 9: Connect action with mcp_local_llm variant
  // ============================================
  it('connect action to mcp_local_llm variant gives clear error', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'connect', serverName: 'mcp_local_llm' },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('this MCP server');
  }, 30000);

  // ============================================
  // Test 10: Disconnect action for non-connected server (should not error)
  // ============================================
  it('disconnect action for non-connected server is graceful', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'disconnect', serverName: 'never-connected' },
    });
    // Should succeed (disconnect is idempotent)
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
  }, 30000);

  // ============================================
  // Test 11: Unknown action gives clear error
  // ============================================
  it('unknown action gives clear error', async () => {
    const res = await client.callTool({
      name: 'mcp_server',
      arguments: { action: 'unknown_action' as any },
    });
    expect(res.isError).toBe(true);
    // Zod validation should catch this
    const text = (res.content[0] as any).text;
    expect(text).toContain('Invalid');
  }, 30000);
});

describe('E2E mcp_server take_screenshot copies temp artifact', () => {
  let client: any;
  let tempDir: string | null = null;
  let configPath: string | null = null;

  beforeAll(async () => {
    const cfg = writeConfigWithScreenshotServer();
    tempDir = cfg.dir;
    configPath = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'e2e-mcp-server-shot', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('copies temp screenshot into workspace when filePath is provided', async () => {
    // Auto-connect via list
    const list = await client.callTool({ name: 'mcp_server', arguments: { action: 'list', serverName: 'shot' } });
    expect(list.isError).not.toBe(true);

    const destRel = '.mcp_cache/agent_scenarios/github.png';
    const call = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'shot',
        toolName: 'take_screenshot',
        params: { path: destRel, full: true, pageIdx: 0 },
      },
    });
    expect(call.isError).not.toBe(true);
    const parsed = JSON.parse((call.content[0] as any).text);

    const savedPath = parsed.savedFilePath || destRel;
    const resolved = path.resolve(__dirname, '..', savedPath);
    expect(existsSync(resolved)).toBe(true);
    expect(statSync(resolved).size).toBeGreaterThan(0);
  }, 30000);

  it('accepts save_to alias for destination filePath', async () => {
    const destRel = '.mcp_cache/agent_scenarios/github_save_to.png';
    const call = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'shot',
        toolName: 'take_screenshot',
        toolArgs: { save_to: destRel, full: true },
      },
    });
    expect(call.isError).not.toBe(true);
    const parsed = JSON.parse((call.content[0] as any).text);

    const savedPath = parsed.savedFilePath || destRel;
    const resolved = path.resolve(__dirname, '..', savedPath);
    expect(existsSync(resolved)).toBe(true);
    expect(statSync(resolved).size).toBeGreaterThan(0);
  }, 30000);

  it('persists temp screenshot into workspace when filePath is omitted', async () => {
    const call = await client.callTool({
      name: 'mcp_server',
      arguments: {
        action: 'call',
        serverName: 'shot',
        toolName: 'take_screenshot',
        params: {},
      },
    });
    expect(call.isError).not.toBe(true);
    const parsed = JSON.parse((call.content[0] as any).text);
    expect(typeof parsed.savedFilePath).toBe('string');
    const resolved = path.resolve(__dirname, '..', parsed.savedFilePath);
    expect(existsSync(resolved)).toBe(true);
    expect(statSync(resolved).size).toBeGreaterThan(0);
  }, 30000);

  it('falls back when server refuses workspace filePath', async () => {
    const cfg = writeConfigWithScreenshotServer({ failOnFilePath: true });
    const dir = cfg.dir;
    const p = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', p],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    const c = new Client({ name: 'e2e-mcp-server-shot-fallback', version: '0.0.1' });
    try {
      await c.connect(transport);
      await c.callTool({ name: 'mcp_server', arguments: { action: 'list', serverName: 'shot' } });

      const destRel = '.mcp_cache/agent_scenarios/github_fallback.png';
      const call = await c.callTool({
        name: 'mcp_server',
        arguments: {
          action: 'call',
          serverName: 'shot',
          toolName: 'take_screenshot',
          params: { path: destRel, full: true },
        },
      });
      expect(call.isError).not.toBe(true);
      const parsed = JSON.parse((call.content[0] as any).text);
      expect(typeof parsed.savedFilePath).toBe('string');

      const resolved = path.resolve(__dirname, '..', parsed.savedFilePath);
      expect(existsSync(resolved)).toBe(true);
      expect(statSync(resolved).size).toBeGreaterThan(0);
      expect(parsed.fallback?.retriedWithoutFilePath).toBe(true);
    } finally {
      await c.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
