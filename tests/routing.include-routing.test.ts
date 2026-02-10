import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';
import { McpServer } from '../src/server/mcp.js';
import { writeSettingsFile } from './test-utils/settings.js';
import { addRoutingLog, getRoutingLogs } from '../src/orchestration/index.js';

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
    toolGroups: { enabled: ['core.summary', 'privacy'] },
    rateLimiter: { enabled: false },
  };
}

describe('includeRouting metadata', () => {
  it('adds routing metadata for successful tool calls when includeRouting=true', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'routing-include-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), {
        exposeSystemProfile: true,
      });

      const server = new McpServer(settingsPath);
      const res = await server.executeTool('summarize', {
        action: 'path',
        path: 'README.md',
        includeRouting: true,
      });

      expect(res.isError).not.toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(parsed.routing).toBeDefined();
      expect(typeof parsed.routing.mode).toBe('string');
      expect(parsed.routing.success).toBe(true);
      expect(typeof parsed.routing.durationMs).toBe('number');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adds routing metadata for validation errors when includeRouting=true', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'routing-include-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), {
        exposeSystemProfile: true,
      });

      const server = new McpServer(settingsPath);
      const res = await server.executeTool('security', {
        action: 'nope',
        includeRouting: true,
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(parsed.errorType).toBe('invalid_enum');
      expect(parsed.routing).toBeDefined();
      expect(parsed.routing.success).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects new routing entries when log buffer is full', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'routing-include-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(), {
        exposeSystemProfile: true,
      });

      // Fill routing log buffer to capacity (50) so subsequent inserts keep length constant.
      for (let i = 0; i < 60; i++) {
        addRoutingLog({
          toolName: `prefill-${i}`,
          mode: 'orchestration',
          backend: 'opencode-cli',
          success: true,
          durationMs: 1,
        });
      }
      expect(getRoutingLogs().length).toBe(50);

      const server = new McpServer(settingsPath);
      const orchestrationService = (server as any).orchestrationService;
      orchestrationService.getStatus = () => ({
        enabled: true,
        backends: ['opencode-cli'],
        availableBackends: ['opencode-cli'],
        config: { autoVerify: true, scoreThreshold: 7, maxIterations: 3 },
      });
      orchestrationService.orchestrate = async () => ({
        success: true,
        planId: 'test-plan',
        score: 10,
        verification: {
          score: 10,
          reasoning: 'ok',
          completedAreas: [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 1,
        timing: {
          cliExecutionMs: 1,
          cliBackendUsed: 'opencode-cli',
        },
      });

      const res = await server.executeTool('summarize', {
        action: 'path',
        path: 'README.md',
        includeRouting: true,
      });

      expect(res.isError).not.toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(parsed.routing?.mode).toBe('fallback');

      // Top routing entry should be the observed tool mode, not synthetic direct-llm fallback.
      const latest = getRoutingLogs()[0];
      expect(latest?.toolName).toBe('summarize');
      expect(latest?.mode).toBe('fallback');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
