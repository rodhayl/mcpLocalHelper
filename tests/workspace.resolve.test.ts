import { describe, it, expect } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { FileTools } from '../src/tools/file.js';
import { EditTools } from '../src/tools/edit.js';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import path from 'path';
import { tmpdir } from 'os';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

describe('resolveWorkspacePath', () => {
  const cfgPath = resolve(process.cwd(), 'tests/config.workspace.test.settings');
  it('resolves relative paths under workspace and rejects traversal/outside', () => {
    const cfg = {
      backends: [],
      defaults: { localBackendId: 'none' },
      workspace: { roots: ['.'], defaultRoot: '.' },
      policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
      systemProfile: { exposeToLLM: false },
    };
    writeFileSync(cfgPath, `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n`, 'utf-8');
    const cm = new ConfigManager(cfgPath);
    const abs = cm.resolveWorkspacePath('README.md');
    expect(abs.endsWith('README.md')).toBe(true);
    const outside = resolve(process.cwd(), '..', 'other', 'file.txt');
    expect(() => cm.resolveWorkspacePath(outside)).toThrow(/Outside workspace/);
    expect(() => cm.resolveWorkspacePath('../secrets.txt')).toThrow(/Outside workspace/);
  });

  it('normalizes leading-slash drive paths on Windows', () => {
    if (process.platform !== 'win32') return;

    const cfg = {
      backends: [],
      defaults: { localBackendId: 'none' },
      workspace: { roots: ['C:\\\\'], defaultRoot: 'C:\\\\' },
      policy: { allowlistPaths: ['C:\\\\'], maxFileBytes: 131072 },
      systemProfile: { exposeToLLM: false },
    };
    writeFileSync(cfgPath, `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n`, 'utf-8');
    const cm = new ConfigManager(cfgPath);

    const p1 = cm.resolveWorkspacePath('/c:/Users');
    expect(p1.toLowerCase(), `p1=${p1}`).toMatch(/^c:[\\/]+users/);
    expect(p1.toLowerCase(), `p1=${p1}`).not.toContain('c:\\\\c:');

    const p2 = cm.resolveWorkspacePath('\\c:\\Users');
    expect(p2.toLowerCase(), `p2=${p2}`).toMatch(/^c:[\\/]+users/);
    expect(p2.toLowerCase(), `p2=${p2}`).not.toContain('c:\\\\c:');
  });

  it('normalizes WORKSPACE_ROOT env var on Windows', () => {
    if (process.platform !== 'win32') return;

    const prev = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = '/c:/Users';

    try {
      const cfg = {
        backends: [],
        defaults: { localBackendId: 'none' },
        workspace: { roots: ['.'], defaultRoot: '.' },
        policy: { allowlistPaths: ['C:\\\\'], maxFileBytes: 131072 },
        systemProfile: { exposeToLLM: false },
      };
      writeFileSync(cfgPath, `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n`, 'utf-8');
      const cm = new ConfigManager(cfgPath);
      const root = cm.getDefaultWorkspaceRoot();

      expect(root.toLowerCase(), `root=${root}`).toMatch(/^c:[\\/]+users/);
      expect(root.toLowerCase(), `root=${root}`).not.toContain('c:\\\\c:');
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = prev;
    }
  });
});

describe('WORKSPACE_ROOT allowlist + cache writes', () => {
  it('allows read/write under WORKSPACE_ROOT even when config is elsewhere (Windows /c:/ style)', () => {
    if (process.platform !== 'win32') return;

    const prev = process.env.WORKSPACE_ROOT;
    const workspaceDir = mkdtempSync(path.join(tmpdir(), 'mcp-wsroot-workspace-'));
    const configDir = mkdtempSync(path.join(tmpdir(), 'mcp-wsroot-config-'));

    try {
      writeFileSync(path.join(workspaceDir, 'README.md'), 'hello', 'utf8');

      const cfgPath2 = path.join(configDir, 'env.test.settings');
      const baseConfig = loadCentralConfigJson();
      const cfg = JSON.parse(JSON.stringify(baseConfig));
      cfg.workspace = { roots: ['.'], defaultRoot: '.' };
      cfg.policy = { ...(cfg.policy || {}), allowlistPaths: ['.'], maxFileBytes: 131072 };
      cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
      cfg.editing = {
        ...(cfg.editing || {}),
        enabled: true,
        backupEnabled: false,
        backupDir: '.mcp-backups',
        requirePreview: false,
        maxFileSize: 1048576,
      };
      writeSettingsFile(cfgPath2, cfg, { exposeSystemProfile: false, testingEnabled: false });

      // Simulate VS Code-style path injection that can include a leading slash drive path.
      const envRoot = workspaceDir
        .replace(/^([A-Za-z]):\\/, (_m, d) => `/${String(d).toLowerCase()}:/`)
        .replace(/\\/g, '/');
      process.env.WORKSPACE_ROOT = envRoot;

      const cm = new ConfigManager(cfgPath2);
      const root = cm.getDefaultWorkspaceRoot();
      expect(root.toLowerCase(), `root=${root}`).not.toContain('c:\\\\c:');
      expect(root.toLowerCase(), `root=${root}`).toContain(workspaceDir.toLowerCase());

      const fileTools = new FileTools(cm);
      const readme = fileTools.readFile('README.md', 1000);
      expect(readme.truncated).toBe(false);
      expect(readme.content).toContain('hello');

      const editTools = new EditTools(cm);
      const keepRel = '.mcp_cache/agent_scenarios/.keep';
      const res = editTools.createFile(keepRel, 'x', { overwrite: true, validateSyntax: false });
      expect(res.success).toBe(true);
      expect(existsSync(path.join(workspaceDir, '.mcp_cache', 'agent_scenarios', '.keep'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = prev;
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

/**
 * Workspace Auto-Detection Tests
 * SKIP REASON: The smart workspace auto-detection from process.cwd() is not fully implemented.
 */
describe.skip('Workspace Auto-Detection', () => {
  it('skipped - cwd auto-detection not implemented', () => {
    // Feature requires implementation of project indicator detection in ConfigManager
  });
});
