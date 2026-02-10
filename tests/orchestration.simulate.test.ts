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
    toolGroups: { enabled: ['planning'] },
    rateLimiter: { enabled: false },
  };
}

describe('orchestration simulate action', () => {
  it('provides read-only routing prediction for a tool', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'orchestration-simulate-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      const res = await server.executeTool('orchestration', {
        action: 'simulate',
        toolName: 'analyze_file',
        preferredBackend: 'local',
      });

      expect(res.isError).not.toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');

      expect(parsed.success).toBe(true);
      expect(parsed.action).toBe('simulate');
      expect(parsed.toolName).toBe('analyze_file');
      expect(parsed.predictedMode).toBe('direct-llm');
      expect(String(parsed.reason).length).toBeGreaterThan(0);
      expect(parsed.effectiveConfig?.preferredBackend).toBe('local');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('predicts pure-cli when pureCliMode is enabled with CLI preferred backend', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'orchestration-simulate-pure-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      const cfg = createConfig() as Record<string, unknown>;
      cfg.toolOrchestration = {
        globalSettings: {
          pureCliMode: true,
          defaultPreferredBackend: 'opencode',
          defaultOrchestrationEnabled: true,
        },
      };
      writeSettingsFile(settingsPath, cfg, { exposeSystemProfile: true, testingEnabled: false });

      const server = new McpServer(settingsPath);
      const res = await server.executeTool('orchestration', {
        action: 'simulate',
        toolName: 'analyze_file',
      });

      expect(res.isError).not.toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');

      expect(parsed.success).toBe(true);
      expect(parsed.action).toBe('simulate');
      expect(parsed.toolName).toBe('analyze_file');
      expect(parsed.predictedMode).toBe('pure-cli');
      expect(String(parsed.reason).toLowerCase()).toContain('purecli');
      expect(parsed.effectiveConfig?.preferredBackend).toBe('opencode');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
