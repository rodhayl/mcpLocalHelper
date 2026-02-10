/**
 * MCP Agent Task Schema and Validation E2E Tests
 * 
 * Tests for agent_task tool schema discovery, alias handling,
 * and edge cases in argument parsing.
 */

import path from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeSettingsFile } from '../test-utils/settings.js';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function writeTestConfig(): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-agent-schema-test-'));
  const p = path.join(dir, 'env.test.settings');
  const repoRoot = path.resolve(__dirname, '../..').replace(/\\/g, '/');

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
    mcpServers: {},
    systemProfile: {
      exposeToLLM: true,
    },
    toolGroups: {
      activeMode: 'DEVELOPMENT',
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

describe('E2E agent_task schema and validation tests', () => {
  let client: any;
  let tempDir: string | null = null;
  let configPath: string | null = null;

  beforeAll(async () => {
    const cfg = writeTestConfig();
    tempDir = cfg.dir;
    configPath = cfg.path;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../../dist/index.js'), '--settings', configPath],
      env: {
        ...process.env,
        // Keep background tasks bounded so these schema/alias tests stay fast and stable.
        AGENT_TASK_ASYNC_TIMEOUT_MS: '5000',
      },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '../..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'e2e-agent-schema-test', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ============================================
  // Test 1: agent_task tool is discoverable
  // ============================================
  it('agent_task is discoverable in tool list', async () => {
    const res = await client.listTools();
    const tool = res.tools.find((t: any) => t.name === 'agent_task');
    expect(tool).toBeTruthy();
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(20);
  }, 30000);

  // ============================================
  // Test 2: agent_task schema has flattened structure with all variants
  // (Previously used anyOf, now flattened for LLM compatibility - Kimi K2-0905)
  // ============================================
  it('agent_task schema has flattened structure with all input variants supported', async () => {
    const res = await client.listTools();
    const tool = res.tools.find((t: any) => t.name === 'agent_task');
    expect(tool.inputSchema).toBeTruthy();
    expect(tool.inputSchema.type).toBe('object');

    // Schema should NOT have anyOf at top level (for LLM compatibility)
    expect(tool.inputSchema.anyOf).toBeUndefined();
    expect(tool.inputSchema.oneOf).toBeUndefined();

    // Should have properties at top level
    const props = tool.inputSchema.properties;
    expect(props).toBeTruthy();

    // Primary task field
    expect(props.task).toBeTruthy();
    expect(props.task.type).toBe('string');

    // Prompt alias
    expect(props.prompt).toBeTruthy();
    expect(props.prompt.type).toBe('string');

    // Nested options object
    expect(props.options).toBeTruthy();
    expect(props.options.type).toBe('object');
    expect(props.options.properties.readOnly).toBeTruthy();
    expect(props.options.properties.contextRoot).toBeTruthy();

    // NOTE: Top-level aliases (contextRoot, readOnly, async) were REMOVED for schema compression
    // (Hybrid Autonomous Maximum - Layer 1 Schema Compression)
    // They are still supported in the handler for backward compatibility,
    // but are no longer exposed in the schema to reduce context window usage.
    // Verify they are NOT at top level but ARE in options:
    expect(props.contextRoot).toBeFalsy();  // Removed from schema
    expect(props.readOnly).toBeFalsy();     // Removed from schema
    expect(props.options.properties.readOnly).toBeTruthy();  // But available in options
    expect(props.options.properties.contextRoot).toBeTruthy();  // But available in options
  }, 30000);

  // ============================================
  // Test 3: agent_task schema includes examples
  // ============================================
  it('agent_task schema includes usage examples', async () => {
    const res = await client.listTools();
    const tool = res.tools.find((t: any) => t.name === 'agent_task');
    expect(Array.isArray(tool.inputSchema.examples)).toBe(true);
    expect(tool.inputSchema.examples.length).toBeGreaterThan(0);

    // First example should have task
    const firstExample = tool.inputSchema.examples[0];
    expect(firstExample.task).toBeTruthy();
  }, 30000);

  // ============================================
  // Test 4: agent_task accepts task parameter
  // ============================================
  it('agent_task requires task parameter', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        // Missing task parameter
        readOnly: true,
      },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('task');
  }, 30000);

  // ============================================
  // Test 5: agent_task accepts prompt alias for task
  // ============================================
  it('agent_task accepts prompt alias for task', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        prompt: 'List files in workspace. Do not modify anything.',
        readOnly: true,
        maxSteps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
    expect(parsed.effectiveOptions?.readOnly).toBe(true);
    expect(parsed.effectiveOptions?.maxSteps).toBe(1);
  }, 60000);

  // Test 6: agent_task accepts read_only snake_case alias
  // ============================================
  it('agent_task accepts read_only snake_case alias', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Search for README. Do not modify.',
        read_only: true,
        max_steps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
    expect(parsed.effectiveOptions?.readOnly).toBe(true);
    expect(parsed.effectiveOptions?.maxSteps).toBe(1);
  }, 60000);

  // ============================================
  // Test 7: agent_task accepts readOnly option
  // ============================================
  it('agent_task accepts readOnly option', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Check config files. Do not modify.',
        readOnly: true,
        maxSteps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
    expect(parsed.effectiveOptions?.readOnly).toBe(true);
    expect(parsed.effectiveOptions?.maxSteps).toBe(1);
  }, 60000);

  // ============================================
  // Test 8: agent_task accepts nested options shape
  // ============================================
  it('agent_task accepts nested options object', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'List workspace files. Do not modify.',
        options: {
          readOnly: true,
          maxSteps: 1,
          maxSubtasks: 1,
          contextRoot: './',
          async: true,
        },
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
    expect(parsed.effectiveOptions?.readOnly).toBe(true);
    expect(parsed.effectiveOptions?.maxSteps).toBe(1);
    expect(parsed.effectiveOptions?.maxSubtasks).toBe(1);
  }, 60000);

  // ============================================
  // Test 9: agent_task accepts context_root snake_case alias
  // ============================================
  it('agent_task accepts context_root snake_case alias', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'List files. Do not modify.',
        context_root: './',
        readOnly: true,
        max_steps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
  }, 60000);

  // ============================================
  // Test 10: agent_task accepts toolsAllowed alias
  // ============================================
  it('agent_task accepts toolsAllowed alias for allowedActions', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Search for README in workspace. Do not modify.',
        toolsAllowed: ['search_repo', 'read_file', 'done'],
        readOnly: true,
        maxSteps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
  }, 60000);

  // ============================================
  // Test 11: agent_task rejects empty task
  // ============================================
  it('agent_task rejects empty task string', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: '   ',  // Whitespace only
        readOnly: true,
      },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('task');
  }, 30000);

  // ============================================
  // Test 12: agent_task handles readOnly based on task text
  // ============================================
  it('agent_task auto-enables readOnly when task contains "do not modify"', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Audit the codebase for security issues. Do not modify any files.',
        maxSteps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.effectiveOptions?.readOnly).toBe(true);
    expect(parsed.effectiveOptions?.inferredReadOnly).toBe(true);
  }, 60000);

  // ============================================
  // Test 13: agent_task validates contextRoot
  // ============================================
  it('agent_task warns when contextRoot is outside workspace', async () => {
    const outsidePath = path.resolve(tempDir as string, '..', 'outside');
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'List files. Do not modify.',
        contextRoot: outsidePath,
        readOnly: true,
        maxSteps: 1,
        async: true,
      },
    });
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(res.isError).not.toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.async).toBe(true);
    expect(parsed.taskId).toBeTypeOf('string');
    expect(parsed.warnings).toBeInstanceOf(Array);
    expect(parsed.warnings.join('\n')).toMatch(/outside/i);
  }, 60000);
});

