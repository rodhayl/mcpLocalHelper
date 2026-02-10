import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';
import { McpServer } from '../src/server/mcp.js';
import { writeSettingsFile } from './test-utils/settings.js';
import { getDebugLogger } from '../src/utils/debug-logger.js';

function createConfig(): Record<string, unknown> {
  const repoRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');
  return {
    backends: [
      {
        id: 'lmstudio',
        type: 'lmstudio',
        base_url: 'http://127.0.0.1:1234',
        model: 'local-model',
        labels: { priority: 'primary' },
      },
      {
        id: 'ollama',
        type: 'ollama',
        base_url: 'http://127.0.0.1:11434',
        model: 'llama3.2',
        labels: { priority: 'secondary' },
      },
    ],
    defaults: {
      localBackendId: 'lmstudio',
      sotaBackendId: 'lmstudio',
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
    toolGroups: { enabled: ['system.info', 'core.summary'] },
    rateLimiter: { enabled: false },
  };
}

describe('mcp_health payload backend visibility', () => {
  it('returns a non-empty dense payload for quick health checks', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-health-payload-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      (server as any).backendManager.probeAll = async () =>
        new Map([
          ['lmstudio', { available: true, models: ['local-model'] }],
          ['ollama', { available: false, error: 'Connection refused' }],
        ]);

      const res = await server.executeTool('mcp_health', { includeDetails: false, format: 'dense' });
      expect(res.isError).not.toBe(true);

      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
      expect(parsed.message).toBe('healthy');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves unavailable backend details during partial outages', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-health-payload-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      (server as any).backendManager.probeAll = async () =>
        new Map([
          ['lmstudio', { available: true, models: ['local-model'] }],
          ['ollama', { available: false, error: 'Connection refused' }],
        ]);

      const res = await server.executeTool('mcp_health', { includeDetails: true });
      expect(res.isError).not.toBe(true);

      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(parsed.status).toBe('healthy');
      expect(parsed.healthy).toBe(true);
      expect(parsed.availableBackends).toEqual(['lmstudio']);
      expect(parsed.unavailableBackends).toEqual(['ollama: Connection refused']);
      expect(Array.isArray(parsed.llmBackend?.backends)).toBe(true);
      expect(parsed.llmBackend.backends.map((b: any) => b.id)).toEqual(['lmstudio']);
      expect(parsed.warning).toBeUndefined();
      expect(parsed.backendIssues).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns remediation guidance only when all backends are down', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-health-payload-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      (server as any).backendManager.probeAll = async () =>
        new Map([
          ['lmstudio', { available: false, error: 'Connection refused' }],
          ['ollama', { available: false, error: 'Connection refused' }],
        ]);

      const res = await server.executeTool('mcp_health', { includeDetails: true });
      expect(res.isError).not.toBe(true);

      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(parsed.status).toBe('degraded');
      expect(parsed.healthy).toBe(false);
      expect(parsed.availableBackends).toEqual([]);
      expect(parsed.unavailableBackends.length).toBeGreaterThan(0);
      expect(parsed.warning).toContain('No LLM backends available');
      expect(Array.isArray(parsed.backendIssues)).toBe(true);
      expect(Array.isArray(parsed.nextSteps)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('omits stack traces from mcp_health debug recentErrors summary', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-health-payload-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      (server as any).backendManager.probeAll = async () =>
        new Map([
          ['lmstudio', { available: true, models: ['local-model'] }],
          ['ollama', { available: false, error: 'Connection refused' }],
        ]);

      const logger = getDebugLogger();
      logger.clear();
      logger.error('mcp', 'Synthetic mcp_health summary error');

      const res = await server.executeTool('mcp_health', { includeDetails: true, format: 'detailed' });
      expect(res.isError).not.toBe(true);

      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      const recentErrors = parsed.debug?.recentErrors ?? [];
      expect(Array.isArray(recentErrors)).toBe(true);
      expect(recentErrors.length).toBeGreaterThan(0);
      for (const err of recentErrors) {
        expect(err.stack).toBeUndefined();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
