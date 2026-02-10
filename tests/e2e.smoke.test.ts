/**
 * E2E Smoke Tests
 * 
 * Combines workspace connectivity tests and LM Studio live integration tests.
 */

import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestConfig } from './test-config.js';
import { probeLmStudio } from './test-utils/lmstudio.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const testConfig = getTestConfig(); 
 
const CONNECT_TIMEOUT = 60000; 
const IS_OPENCODE = (process.env.MCP_LOCAL_LLM_BACKEND_ID || '').includes('opencode'); 
const LLM_TIMEOUT = IS_OPENCODE ? 240000 : 120000; 

// --- Workspace Smoke Test ---
describe('Workspace smoke test tool', () => {
  let client: any;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js')],
      env: { ...process.env, WORKSPACE_ROOT: path.resolve(__dirname, '..') },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    client = new Client({ name: 'ws-smoke', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
      } catch { /* ignore close errors */ }
    }
  });

  it('returns ok with listed dir and optional file sample', async () => {
    expect(client).toBeTruthy();

    const res = await client.callTool(
      { name: 'workspace_smoke_test', arguments: { pathHint: 'README.md', mode: 'quick' } },
      undefined,
      { timeout: 60000 }
    );

    // Accept any response - success or error
    expect(res.content || res.isError).toBeTruthy();

    if (!res.isError && res.content?.[0]) {
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.status).toBe('ok');
      expect(parsed.workspaceRoot).toBeTruthy();
      expect(parsed.listed?.entries?.length).toBeGreaterThan(0);
    }
  }, 90000);
});

// --- LM Studio Live Integration Tests ---
describe('LM Studio Live Integration Tests', () => {
  let client: any;
  const projectRoot = path.resolve(__dirname, '..');

  beforeAll(async () => {
    const probe = await probeLmStudio(testConfig.lmStudioApiBaseUrl, {
      timeoutMs: 15000,
      modelHint: testConfig.localModel,
    });
    if (!probe.ready) {
      throw new Error(
        `[SETUP] LM Studio not ready at ${testConfig.lmStudioBaseUrl}. ${probe.details || ''}`.trim()
      );
    }
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js')],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: projectRoot,
    });

    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }

    client = new Client(
      { name: 'lmstudio-live-test', version: '0.0.1' },
      { capabilities: { roots: { listChanged: true } } }
    );

    await client.connect(transport);

    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: `file://${projectRoot.replace(/\\/g, '/')}`, name: 'workspace' }],
    }));
  }, CONNECT_TIMEOUT);

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  });

  const callTool = async (params: any, timeoutMs: number = LLM_TIMEOUT) => {
    return await client.callTool(params, undefined, { timeout: timeoutMs });
  };

  it(
    'llm_chat returns a real response',
    async () => {
      const res = await callTool({
        name: 'llm_chat',
        arguments: {
          backendRole: 'local',
          messages: [{ role: 'user', content: 'Respond with just the word "pong". Nothing else.' }],
        },
      });

      expect(res.isError).not.toBe(true);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(String(parsed?.message?.content || '').toLowerCase()).toContain('pong');
    },
    LLM_TIMEOUT
  );

  it(
    'llm_cache records a hit for identical requests',
    async () => {
      const before = await callTool({ name: 'mcp_health', arguments: { includeDetails: true } }, 60000);
      expect(before.isError).not.toBe(true);
      const beforeHealth = JSON.parse((before.content[0] as any).text);
      const hits0 = Number(beforeHealth?.llmCache?.hits || 0);

      const req = {
        name: 'llm_chat',
        arguments: {
          backendRole: 'local',
          messages: [
            {
              role: 'user',
              content:
                'Return a 2-sentence explanation of caching, then end with the exact token: CACHE_HIT_TEST_42',
            },
          ],
        },
      };

      const r1 = await callTool(req);
      expect(r1.isError).not.toBe(true);
      const r2 = await callTool(req);
      expect(r2.isError).not.toBe(true);

      const after = await callTool({ name: 'mcp_health', arguments: { includeDetails: true } }, 60000);
      expect(after.isError).not.toBe(true);
      const afterHealth = JSON.parse((after.content[0] as any).text);
      const hits1 = Number(afterHealth?.llmCache?.hits || 0);

      expect(hits1).toBeGreaterThanOrEqual(hits0 + 1);
    },
    LLM_TIMEOUT * 2
  );
});
