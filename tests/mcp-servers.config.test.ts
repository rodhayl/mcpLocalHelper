import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager, parseEnvSettings } from '../src/config/index.js';
import { writeSettingsFile } from './test-utils/settings.js';

let TEST_DIR = '';
let TEST_SETTINGS_PATH = '';

describe('MCP servers persistence (settings file)', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'mcp-local-llm-tests-mcp-'));
    TEST_SETTINGS_PATH = join(TEST_DIR, 'env.settings');

    const baseConfig = {
      backends: [{ id: 'test-backend', type: 'ollama', base_url: 'http://127.0.0.1:11434' }],
      defaults: { localBackendId: 'test-backend' },
      policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
      systemProfile: { exposeToLLM: false },
    };

    writeSettingsFile(TEST_SETTINGS_PATH, baseConfig, { serverPort: 0, testingEnabled: true });
  });

  afterEach(() => {
    if (existsSync(TEST_SETTINGS_PATH)) unlinkSync(TEST_SETTINGS_PATH);
    if (TEST_DIR && existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('upserts and persists a server', () => {
    const cm = new ConfigManager(TEST_SETTINGS_PATH);
    cm.upsertMcpServer('chrome-devtools', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'],
      autoConnect: false,
      description: 'Browser automation',
    });

    const servers = cm.getMcpServers();
    expect(servers['chrome-devtools']).toBeDefined();
    expect(servers['chrome-devtools'].command).toBe('npx');

    const raw = readFileSync(TEST_SETTINGS_PATH, 'utf-8');
    const sections = parseEnvSettings(raw);
    const persisted = JSON.parse((sections.config || {}).CONFIG_JSON as string) as any;
    expect(persisted.mcpServers).toBeDefined();
    expect(persisted.mcpServers['chrome-devtools'].args).toContain('--isolated');
  });

  it('loads persisted mcpServers on next startup', () => {
    const cm1 = new ConfigManager(TEST_SETTINGS_PATH);
    cm1.setMcpServers({
      chrome: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        autoConnect: true,
      },
    });

    const cm2 = new ConfigManager(TEST_SETTINGS_PATH);
    const servers = cm2.getMcpServers();
    expect(Object.keys(servers)).toEqual(['chrome']);
    expect(servers.chrome.autoConnect).toBe(true);
  });

  it('removes and persists removal', () => {
    const cm = new ConfigManager(TEST_SETTINGS_PATH);
    cm.setMcpServers({
      a: { type: 'stdio', command: 'node', args: [], autoConnect: false },
      b: { type: 'stdio', command: 'npx', args: ['-y', 'x'], autoConnect: false },
    });

    cm.removeMcpServer('a');
    const servers = cm.getMcpServers();
    expect(servers.a).toBeUndefined();
    expect(servers.b).toBeDefined();

    const raw = readFileSync(TEST_SETTINGS_PATH, 'utf-8');
    const sections = parseEnvSettings(raw);
    const persisted = JSON.parse((sections.config || {}).CONFIG_JSON as string) as any;
    expect(persisted.mcpServers.a).toBeUndefined();
    expect(persisted.mcpServers.b).toBeDefined();
  });
});

