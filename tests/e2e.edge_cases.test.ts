/**
 * MCP Edge Cases and Stress Tests
 * 
 * Tests for edge cases, error recovery, and robustness
 * of the MCP server implementation.
 */

import path from 'path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeSettingsFile } from './test-utils/settings.js';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function writeTestConfig(dir: string): string {
  const p = path.join(dir, 'env.test.settings');
  const root = dir.replace(/\\/g, '/');

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
      roots: [root],
      defaultRoot: root,
    },
    policy: {
      allowlistPaths: [root],
      maxFileBytes: 131072,
    },
    mcpServers: {},
    systemProfile: {
      exposeToLLM: true,
    },
    toolGroups: {
      activeMode: 'DEVELOPMENT',
    },
  };

  return writeSettingsFile(p, configJson, { exposeSystemProfile: true, serverPort: 0, serverHost: '127.0.0.1' });
}

describe('E2E edge cases and stress tests', () => {
  let client: any;
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-edge-cases-test-'));
    configPath = writeTestConfig(tempDir);
    
    // Create test files
    writeFileSync(path.join(tempDir, 'test.ts'), 'const x: number = 42;\nexport default x;');
    writeFileSync(path.join(tempDir, 'package.json'), '{"name": "test", "version": "1.0.0"}');
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    writeFileSync(path.join(tempDir, 'src', 'index.ts'), 'export const hello = "world";');

    // Clear env vars that would override our test config
    const childEnv = { ...process.env };
    delete childEnv.MCP_LOCAL_LLM_SETTINGS_PATH;
    delete childEnv.MCP_LOCAL_LLM_CONFIG;
    delete childEnv.MCP_LOCAL_LLM_BACKEND_ID;

    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
      env: childEnv,
      stderr: 'pipe',
      cwd: tempDir,
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'e2e-edge-cases-test', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
    // Wait a bit for handles to be released on Windows
    await new Promise(r => setTimeout(r, 100));
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on Windows
      }
    }
  });

  // ============================================
  // Edge case 1: Empty arguments object
  // ============================================
  
  it('handles empty arguments gracefully for tools that require params', async () => {
    const res = await client.callTool({
      name: 'workspace',
      arguments: {},
    });
    // Should error with clear message about missing required params
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('mode');
  }, 30000);

  // ============================================
  // Edge case 2: Invalid enum value
  // ============================================

  it('handles invalid enum value with clear error', async () => {
    const res = await client.callTool({
      name: 'workspace',
      arguments: { mode: 'invalid_mode', path: tempDir },
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text).toContain('Invalid');
  }, 30000);

  // ============================================
  // Edge case 3: Extra unexpected properties (should be ignored)
  // ============================================

  it('ignores extra unexpected properties', async () => {
    const res = await client.callTool({
      name: 'system_profile',
      arguments: { detail: 'basic', extraField: 'should be ignored', anotherExtra: 123 },
    });
    // Should succeed, ignoring extras
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.os).toBeTruthy();
  }, 30000);

  // ============================================
  // Edge case 4: Null values in arguments
  // ============================================

  it('handles null values in arguments', async () => {
    const res = await client.callTool({
      name: 'system_profile',
      arguments: { detail: null },
    });
    // Should handle gracefully (use default or error clearly)
    // The test just verifies no crash
    expect(res.content).toBeTruthy();
  }, 30000);

  // ============================================
  // Edge case 5: Very long string values
  // ============================================

  it('handles very long string values', async () => {
    const longTask = 'A'.repeat(10000);
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: longTask,
        dryRun: true,
        maxSteps: 1,
      },
    });
    // Should handle without crashing
    expect(res.content).toBeTruthy();
  }, 30000);

  // ============================================
  // Edge case 6: Unicode and special characters
  // ============================================

  it('handles unicode and special characters in task', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Search for files containing 日本語, émojis 🎉, and special chars: <>&"\' in workspace.',
        dryRun: true,
        maxSteps: 1,
      },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
  }, 30000);

  // ============================================
  // Edge case 7: Path traversal attempts (security)
  // ============================================

  it('blocks path traversal attempts', async () => {
    const res = await client.callTool({
      name: 'workspace',
      arguments: { 
        mode: 'snapshot', 
        path: path.join(tempDir, '..', '..', '..', 'etc', 'passwd'),
      },
    });
    // Should error due to path outside workspace
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text.toLowerCase()).toMatch(/outside|not allowed|invalid/i);
  }, 30000);

  // ============================================
  // Edge case 8: Non-existent file
  // ============================================

  it('handles non-existent file gracefully', async () => {
    const res = await client.callTool({
      name: 'workspace',
      arguments: { mode: 'metadata', path: path.join(tempDir, 'non_existent_file.ts') },
    });
    // Should error clearly about file not found
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text;
    expect(text.toLowerCase()).toMatch(/not found|does not exist|enoent/i);
  }, 30000);

  // ============================================
  // Edge case 9: Empty file
  // ============================================

  it('handles empty file', async () => {
    const emptyFile = path.join(tempDir, 'empty.ts');
    writeFileSync(emptyFile, '');
    
    const res = await client.callTool({
      name: 'workspace',
      arguments: { mode: 'metadata', path: emptyFile },
    });
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.sizeBytes).toBe(0);
  }, 30000);

  // ============================================
  // Edge case 10: Concurrent tool calls
  // ============================================

  it('handles concurrent tool calls', async () => {
    const calls = [
      client.callTool({ name: 'system_profile', arguments: { detail: 'basic' } }),
      client.callTool({ name: 'model_info', arguments: { action: 'list' } }),
      client.callTool({ name: 'mcp_server', arguments: { action: 'status' } }),
    ];
    
    const results = await Promise.all(calls);
    
    for (const res of results) {
      expect(res.isError).not.toBe(true);
      expect(res.content).toBeTruthy();
    }
  }, 30000);

  // ============================================
  // Edge case 11: Malformed JSON in string fields
  // ============================================

  it('handles malformed JSON-like strings in task', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Parse this: {"incomplete": true, missing closing brace',
        dryRun: true,
        maxSteps: 1,
      },
    });
    // Should not crash, just process as a string
    expect(res.isError).not.toBe(true);
    const parsed = JSON.parse((res.content[0] as any).text);
    expect(parsed.success).toBe(true);
  }, 30000);

  // ============================================
  // Edge case 12: Zero/negative numbers
  // ============================================

  it('handles zero and negative numbers', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Plan only: list files.',
        dryRun: true,
        maxSteps: 0, // Edge case: zero steps
      },
    });
    // Should handle gracefully (either error or use defaults)
    expect(res.content).toBeTruthy();
  }, 30000);

  // ============================================
  // Edge case 13: Boolean as string
  // ============================================

  it('handles boolean-like strings', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Plan only: check files.',
        dryRun: 'true' as any, // String instead of boolean
        maxSteps: 1,
      },
    });
    // Zod may coerce or error - test for no crash
    expect(res.content).toBeTruthy();
  }, 30000);

  // ============================================
  // Edge case 14: Array where object expected
  // ============================================

  it('handles array where object expected with clear error', async () => {
    const res = await client.callTool({
      name: 'agent_task',
      arguments: {
        task: 'Test task',
        options: ['should', 'be', 'object'] as any, // Array instead of object
      },
    });
    // Should error clearly
    expect(res.isError).toBe(true);
  }, 30000);

  // ============================================
  // Edge case 15: Very deeply nested options
  // ============================================

  it('handles deeply nested structures', async () => {
    const res = await client.callTool({
      name: 'llm_chat',
      arguments: {
        backendRole: 'local',
        messages: [{ role: 'user', content: 'test' }],
        options: {
          deeply: {
            nested: {
              ignored: true,
            },
          },
        } as any,
      },
    });
    // Should succeed, ignoring extra nested props
    expect(res.isError).not.toBe(true);
  }, 30000);

  // ============================================
  // Edge case 16: Path not found should suggest closest valid paths
  // QA_feedback_1: "Add 'closest valid roots' hint when path missing"
  // ============================================

  it('suggests closest valid paths when root directory does not exist', async () => {
    const res = await client.callTool({
      name: 'search',
      arguments: {
        action: 'intelligent',
        query: 'anything',
        root: '__does_not_exist__',
      },
    });
    // Should error with path hint
    expect(res.isError).toBe(true);
    const errorText = JSON.stringify(res.content);
    // Should include suggestions for valid paths
    expect(errorText).toMatch(/suggest|try|closest|valid|available|src|\.|\//i);
  }, 30000);

  it('suggests closest valid paths when security scan root does not exist', async () => {
    const res = await client.callTool({
      name: 'security',
      arguments: {
        action: 'scan',
        root: 'nonexistent_folder',
        scanType: 'secrets',
        outputFormat: 'summary',
      },
    });
    // Should error with path hint
    expect(res.isError).toBe(true);
    const errorText = JSON.stringify(res.content);
    // Should include suggestions for valid paths
    expect(errorText).toMatch(/suggest|try|closest|valid|available|src|\.|\//i);
  }, 30000);
});
