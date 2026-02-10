import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';
import { McpServer } from '../src/server/mcp.js';
import { writeSettingsFile } from './test-utils/settings.js';

function createConfig(): Record<string, unknown> {
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
    toolGroups: { enabled: ['*'] },
    rateLimiter: { enabled: false },
  };
}

describe('tool description quality', () => {
  it('keeps descriptions concise, ASCII-safe, and small-model-friendly', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tool-descriptions-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), {
        exposeSystemProfile: true,
      });

      const server = new McpServer(settingsPath);
      const manifest = server.getLocalToolManifest({ includeDisabled: true });

      expect(manifest.length).toBeGreaterThan(0);

      for (const tool of manifest) {
        expect(tool.description.length).toBeLessThanOrEqual(160);
        expect(tool.description).toMatch(/^[\x20-\x7E]+$/);
        expect(tool.description).not.toMatch(/\bWARNING\b/i);
      }

      const search = manifest.find((t) => t.name === 'search');
      expect(search?.description).toContain('root defaults to "."');

      const health = manifest.find((t) => t.name === 'mcp_health');
      expect(health?.description?.toLowerCase()).toContain('healthy when any backend is available');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
