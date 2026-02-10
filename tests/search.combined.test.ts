/**
 * Search and Grep Combined Tests
 * 
 * Combines grep pattern normalization, search filename fallback, 
 * and structured search path query tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '../src/config/index.js';
import { GrepTools } from '../src/tools/grep.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';
import { SymbolIndexer } from '../src/tools/symbols.js';
import { writeSettingsFile } from './test-utils/settings.js';

describe('GrepTools pattern normalization', () => {
  it('accepts PCRE-style leading inline flags like (?i)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mcp-grep-inline-'));
    try {
      mkdirSync(path.join(root, 'docs'), { recursive: true });
      writeFileSync(path.join(root, 'docs', 'a.md'), 'WebSocket and SSE\n', 'utf8');

      const cfgPath = path.join(root, 'env.grep-inline.settings');
      const rootNorm = root.replace(/\\/g, '/');
      const cfg = {
        backends: [],
        defaults: { localBackendId: 'none' },
        policy: { allowlistPaths: [rootNorm], maxFileBytes: 65536 },
        workspace: { roots: [rootNorm], defaultRoot: rootNorm },
        systemProfile: { exposeToLLM: false },
      };
      writeSettingsFile(cfgPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

      const cm = new ConfigManager(cfgPath);
      const gt = new GrepTools(cm);

      const res = gt.grepRepo(root, '(?i)websocket|sse', 10);
      expect(res.matches.length).toBeGreaterThan(0);
      expect(res.matches[0].file.replace(/\\/g, '/')).toContain('docs/a.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('intelligent search filename fallback', () => {
  const testRoot = resolve('tests/tmp/search-filename-fallback');

  beforeAll(() => {
    mkdirSync(join(testRoot, 'src'), { recursive: true });
    writeFileSync(
      join(testRoot, 'src', 'agents_summary.py'),
      'def generate_report():\n    return "ok"\n',
      'utf-8'
    );
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('finds file matches when query is a filename and content search is empty', async () => {
    const config = new ConfigManager();
    config.setDynamicWorkspaceRoots([testRoot]);
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    const result = await tools.intelligentSearch('.', 'agents_summary.py', {
      maxResults: 5,
      rankByRelevance: false,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.some((r) => r.file.replace(/\\/g, '/').includes('agents_summary.py'))).toBe(true);
  });
});

describe('structured search path query fallback', () => {
  const testRoot = resolve('tests/tmp/structured-search-path');

  beforeAll(() => {
    mkdirSync(join(testRoot, 'src'), { recursive: true });
    writeFileSync(
      join(testRoot, 'src', 'agents_summary.py'),
      'def generate_report():\n    return "ok"\n\nclass ReportBuilder:\n    def build(self):\n        return "done"\n',
      'utf-8'
    );
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns symbols when query is a file path', () => {
    const config = new ConfigManager();
    config.setDynamicWorkspaceRoots([testRoot]);
    const indexer = new SymbolIndexer(config);

    const result = indexer.structuredSearch('.', 'src/agents_summary.py', {
      targetType: 'function',
      languages: ['python'],
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.file.replace(/\\/g, '/').endsWith('agents_summary.py'))).toBe(true);
  });
});
