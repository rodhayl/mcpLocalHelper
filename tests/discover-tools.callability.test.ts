import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';
import { McpServer } from '../src/server/mcp.js';
import { writeSettingsFile } from './test-utils/settings.js';

function createConfigWithLimitedGroups(): Record<string, unknown> {
  const repoRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');
  return {
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
    systemProfile: { exposeToLLM: true },
    toolGroups: { enabled: ['core.discovery', 'core.summary'] },
    rateLimiter: { enabled: false },
  };
}

describe('discover_tools callability metadata', () => {
  it('marks disabled tools as non-callable in category responses', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'discover-callability-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfigWithLimitedGroups(), {
        exposeSystemProfile: true,
      });

      const server = new McpServer(settingsPath);
      const discover = await server.executeTool('discover_tools', { category: 'testing' });

      expect(discover.isError).not.toBe(true);
      const parsed = JSON.parse(discover.content?.[0]?.text || '{}');
      const analyzeGaps = parsed.tools?.find((tool: any) => tool.name === 'analyze_test_gaps');

      expect(analyzeGaps).toBeTruthy();
      expect(analyzeGaps.callable).toBe(false);
      expect(analyzeGaps.enabled).toBe(false);
      expect(Array.isArray(analyzeGaps.requiredArgs)).toBe(true);
      expect(analyzeGaps.requiredArgs).toContain('root');

      const directCall = await server.executeTool('analyze_test_gaps', { root: '.' });
      expect(directCall.isError).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
