import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { McpClientManager } from '../src/utils/mcp-client.js';

describe('McpClientManager retries', () => {
  it('retries connect to a flaky stdio MCP server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-local-llm-flaky-'));
    try {
      const counterFile = join(dir, 'counter.txt');
      const serverScript = join(__dirname, 'fixtures', 'flaky-mcp-server.cjs');

      process.env.MCP_CLIENT_RETRIES = '5';
      process.env.MCP_CLIENT_RETRY_DELAY_MS = '10';
      process.env.MCP_CLIENT_RETRY_BACKOFF = '1.1';

      const m = new McpClientManager({
        flaky: {
          type: 'stdio',
          command: 'node',
          args: [serverScript],
          env: {
            COUNTER_FILE: counterFile,
            FAILS: '2',
          },
          autoConnect: false,
          description: 'flaky test server',
        },
      });

      await m.connect('flaky');
      expect(m.isConnected('flaky')).toBe(true);

      const tools = m.getTools('flaky');
      expect(tools.some((t) => t.name === 'echo')).toBe(true);

      const res = await m.callTool('flaky', 'echo', { text: 'hello' });
      expect(res.success).toBe(true);
      expect(res.content).toBe('hello');

      const fail = await m.callTool('flaky', 'fail', {});
      expect(fail.success).toBe(false);
      expect(fail.isError).toBe(true);
      expect(String(fail.error || '')).toContain('forced failure');

      await m.disconnectAll();
      expect(m.isConnected('flaky')).toBe(false);
      expect(m.getConnectedServers()).not.toContain('flaky');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
