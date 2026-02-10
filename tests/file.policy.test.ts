import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { FileTools } from '../src/tools/file.js';
import { resolve, join } from 'path';
import path from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

describe('Policy allowlist/denylist', () => {
  it('should allow paths within allowlist', () => {
    const cm = new ConfigManager();
    const srcRoot = resolve(process.cwd(), 'src');
    const srcSecretsRoot = resolve(process.cwd(), 'src/secrets');
    cm.getConfig().policy.allowlistPaths = [srcRoot];
    cm.getConfig().policy.denylistPaths = [srcSecretsRoot];
    const allowedPath = resolve(process.cwd(), 'src/index.ts');
    expect(cm.isPathAllowed(allowedPath)).toBe(true);
  });

  it('should deny paths within denylist', () => {
    const cm = new ConfigManager();
    const srcRoot = resolve(process.cwd(), 'src');
    const srcSecretsRoot = resolve(process.cwd(), 'src/secrets');
    cm.getConfig().policy.allowlistPaths = [srcRoot];
    cm.getConfig().policy.denylistPaths = [srcSecretsRoot];
    const deniedPath = resolve(process.cwd(), 'src/secrets/.env');
    expect(cm.isPathAllowed(deniedPath)).toBe(false);
  });

  it('should deny paths outside allowlist', () => {
    const cm = new ConfigManager();
    const srcRoot = resolve(process.cwd(), 'src');
    const srcSecretsRoot = resolve(process.cwd(), 'src/secrets');
    cm.getConfig().policy.allowlistPaths = [srcRoot];
    cm.getConfig().policy.denylistPaths = [srcSecretsRoot];
    const outsidePath = resolve(process.cwd(), 'README.md');
    expect(cm.isPathAllowed(outsidePath)).toBe(false);
  });
});

describe('Policy allowlist boundary checks', () => {
  it('does not treat sibling prefixes as allowed (src vs src2)', () => {
    const cm = new ConfigManager();
    const srcRoot = resolve(process.cwd(), 'src');
    cm.getConfig().policy.allowlistPaths = [srcRoot];
    delete cm.getConfig().policy.denylistPaths;
    const allowed = resolve(process.cwd(), 'src/index.ts');
    const notAllowed = resolve(process.cwd(), 'src2/index.ts');
    expect(cm.isPathAllowed(allowed)).toBe(true);
    expect(cm.isPathAllowed(notAllowed)).toBe(false);
  });
});

describe('Policy normalization for /c:/ style paths (Windows)', () => {
  it('treats /c:/ absolute allowlist paths as the intended drive path', () => {
    if (process.platform !== 'win32') return;

    const allowDir = mkdtempSync(path.join(tmpdir(), 'mcp-allowdir-'));
    const cfgDir = mkdtempSync(path.join(tmpdir(), 'mcp-allowcfg-'));

    try {
      const allowEntry = allowDir
        .replace(/^([A-Za-z]):\\/, (_m, d) => `/${String(d).toLowerCase()}:/`)
        .replace(/\\/g, '/');

      const cfgPath = path.join(cfgDir, 'env.test.settings');
      const baseConfig = loadCentralConfigJson();
      const cfg = JSON.parse(JSON.stringify(baseConfig));
      cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [allowEntry], maxFileBytes: 131072 };
      cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
      writeSettingsFile(cfgPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

      const cm = new ConfigManager(cfgPath);
      const candidate = path.join(allowDir, 'nested', 'file.txt');
      expect(cm.isPathAllowed(candidate)).toBe(true);
      expect(cm.getDefaultWorkspaceRoot().toLowerCase()).not.toContain('c:\\\\c:');
    } finally {
      rmSync(allowDir, { recursive: true, force: true });
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });
});

describe('Policy relative path base for config subdirectories', () => {
  it("treats '..' allowlist entries as config-dir-relative, not workspace-root-relative", () => {
    const sandboxDir = mkdtempSync(path.join(tmpdir(), 'mcp-policy-relbase-'));
    const configDir = path.join(sandboxDir, 'config');
    mkdirSync(configDir, { recursive: true });

    try {
      const settingsPath = path.join(configDir, 'env.settings');
      const baseConfig = loadCentralConfigJson();
      const cfg = JSON.parse(JSON.stringify(baseConfig));

      // Canonical config/ layout: '..' should map to repo/workspace root, not its parent.
      cfg.workspace = { roots: ['..'], defaultRoot: '..' };
      cfg.policy = { ...(cfg.policy || {}), allowlistPaths: ['..'], maxFileBytes: 131072 };
      cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
      writeSettingsFile(settingsPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

      const cm = new ConfigManager(settingsPath);
      const workspaceRoot = cm.getDefaultWorkspaceRoot();
      const insidePath = path.join(workspaceRoot, 'inside.txt');
      const parentOfWorkspace = path.resolve(workspaceRoot, '..');
      const outsidePath = path.join(parentOfWorkspace, 'outside.txt');

      expect(cm.isPathAllowed(insidePath)).toBe(true);
      expect(cm.isInsideWorkspace(outsidePath)).toBe(false);
      expect(cm.isPathAllowed(outsidePath)).toBe(false);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

describe('FileTools.manifestSnapshot hidden directory handling', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(() => {
    const base = join(process.cwd(), 'tests', 'tmp');
    mkdirSync(base, { recursive: true });
    tempDir = mkdtempSync(join(base, 'manifest-snapshot-'));
    configPath = join(tempDir, 'env.test.settings');

    const root = tempDir.replace(/\\/g, '/');
    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.workspace = { roots: [root], defaultRoot: root };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [root], maxFileBytes: 65536 };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };

    writeSettingsFile(configPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

    mkdirSync(join(tempDir, '.vscode'), { recursive: true });
    writeFileSync(join(tempDir, '.vscode', 'mcp.json'), '{"servers": []}', 'utf-8');
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('should include .vscode/mcp.json when includeHidden=true', () => {
    const config = new ConfigManager(configPath);
    const tools = new FileTools(config);

    const snapshot = tools.manifestSnapshot(tempDir, { maxDepth: 2, includeHidden: true });
    const rels = snapshot.files.map((f) => String(f.relativePath).replace(/\\/g, '/'));

    expect(rels).toContain('.vscode/mcp.json');
  });
});
