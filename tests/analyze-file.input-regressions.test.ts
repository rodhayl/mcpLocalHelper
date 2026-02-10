import path from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '../src/server/mcp.js';
import { writeSettingsFile } from './test-utils/settings.js';

function createConfig(workspaceRoot: string): Record<string, unknown> {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/');
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
      roots: [normalizedRoot],
      defaultRoot: normalizedRoot,
    },
    policy: {
      allowlistPaths: [normalizedRoot],
      maxFileBytes: 131072,
    },
    mcpServers: {},
    systemProfile: { exposeToLLM: true },
    toolGroups: { enabled: ['llm.enhanced'] },
    rateLimiter: { enabled: false },
  };
}

describe('analyze_file input regressions', () => {
  it('accepts analysisType="detailed" by mapping to full', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analyze-file-alias-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeFileSync(path.join(tempDir, 'sample.ts'), 'export const x = 1;\n', 'utf-8');
      writeSettingsFile(settingsPath, createConfig(tempDir), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      const analyzeFileMock = vi.fn().mockResolvedValue({
        path: path.join(tempDir, 'sample.ts'),
        language: 'typescript',
        analysis: 'ok',
        issues: [],
        suggestions: [],
        metrics: { lineCount: 1, sizeBytes: 19, functionCount: 0, classCount: 0 },
        analysisType: 'full',
      });
      (server as any).llmEnhancedTools.analyzeFile = analyzeFileMock;

      const res = await server.executeTool('analyze_file', {
        path: 'sample.ts',
        analysisType: 'detailed',
      });

      expect(res.isError).not.toBe(true);
      expect(analyzeFileMock).toHaveBeenCalledTimes(1);
      expect(analyzeFileMock).toHaveBeenCalledWith(
        'sample.ts',
        expect.objectContaining({ analysisType: 'full' })
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns actionable guidance when analyze_file receives a directory path', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analyze-file-dir-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
      writeSettingsFile(settingsPath, createConfig(tempDir), { exposeSystemProfile: true });

      const server = new McpServer(settingsPath);
      const res = await server.executeTool('analyze_file', {
        path: 'src',
        analysisType: 'full',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      expect(String(parsed.message)).toMatch(/not a file/i);
      expect(String(parsed.message)).toMatch(/workspace|search|filenames/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not leak absolute paths in analyze_file missing-file errors', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'analyze-file-privacy-'));
    const settingsPath = path.join(tempDir, 'env.test.settings');

    try {
      writeSettingsFile(settingsPath, createConfig(tempDir), { exposeSystemProfile: true });
      const server = new McpServer(settingsPath);

      const res = await server.executeTool('analyze_file', {
        path: 'missing.ts',
        analysisType: 'full',
      });

      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content?.[0]?.text || '{}');
      const message = String(parsed.message ?? '');

      expect(message).toMatch(/File not found/i);
      // Do not expose absolute local paths (e.g. C:\\Users\\... or /home/user/...)
      expect(message).not.toMatch(/[A-Za-z]:\\\\/);
      expect(message).not.toMatch(/Resolved to:/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
