import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

let mockedHomeDir = '';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => mockedHomeDir,
  };
});

const BASE_CONFIG = {
  backends: [],
  defaults: { localBackendId: 'stub' },
  policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
  systemProfile: { exposeToLLM: false },
};

function writeIniSettings(filePath: string, configJson: unknown): void {
  writeFileSync(filePath, `[config]\nCONFIG_JSON=${JSON.stringify(configJson)}\n`, 'utf-8');
}

async function createConfigManager(): Promise<any> {
  vi.resetModules();
  const mod = await import('../../src/config/index.js');
  return new mod.ConfigManager();
}

describe('Config Discovery Logic', () => {
  const originalEnv = { ...process.env };
  let tempRoot: string;
  let mockCwd: string;
  let mockHome: string;
  let cwdSpy: any;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mcp-config-discovery-'));
    mockCwd = path.join(tempRoot, 'cwd');
    mockHome = path.join(tempRoot, 'home');
    mkdirSync(mockCwd, { recursive: true });
    mkdirSync(mockHome, { recursive: true });

    mockedHomeDir = mockHome;

    process.env = { ...originalEnv };
    delete process.env.MCP_LOCAL_LLM_SETTINGS_PATH;
    delete process.env.MCP_LOCAL_LLM_CONFIG;

    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
  });

  afterEach(() => {
    cwdSpy?.mockRestore?.();
    process.env = { ...originalEnv };
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('prefers MCP_LOCAL_LLM_SETTINGS_PATH when set', async () => {
    const envSettings = path.join(mockCwd, 'env.settings');
    const overrideSettings = path.join(mockCwd, 'override.settings');
    writeIniSettings(envSettings, BASE_CONFIG);
    writeIniSettings(overrideSettings, BASE_CONFIG);

    process.env.MCP_LOCAL_LLM_SETTINGS_PATH = overrideSettings;

    const cm = await createConfigManager();
    expect((cm as any).settingsPath).toBe(overrideSettings);
  });

  it('finds settings in CWD (env.settings)', async () => {
    const cwdSettings = path.join(mockCwd, 'env.settings');
    writeIniSettings(cwdSettings, BASE_CONFIG);

    const cm = await createConfigManager();
    expect((cm as any).settingsPath).toBe(cwdSettings);
  });

  it('prefers config/env.settings over root env.settings when both exist', async () => {
    const rootSettings = path.join(mockCwd, 'env.settings');
    const configDir = path.join(mockCwd, 'config');
    const configSettings = path.join(configDir, 'env.settings');
    mkdirSync(configDir, { recursive: true });
    writeIniSettings(rootSettings, BASE_CONFIG);
    writeIniSettings(configSettings, BASE_CONFIG);

    const cm = await createConfigManager();
    expect((cm as any).settingsPath).toBe(configSettings);
  });

  it('prefers env.settings over env-automated-tests.settings when both exist', async () => {
    const rootSettings = path.join(mockCwd, 'env.settings');
    const configDir = path.join(mockCwd, 'config');
    const configAutomatedSettings = path.join(configDir, 'env-automated-tests.settings');
    mkdirSync(configDir, { recursive: true });
    writeIniSettings(rootSettings, BASE_CONFIG);
    writeIniSettings(configAutomatedSettings, {
      ...BASE_CONFIG,
      defaults: { localBackendId: 'automated' },
    });

    const cm = await createConfigManager();
    expect((cm as any).settingsPath).toBe(rootSettings);
  });

  it('finds settings in Home Directory when CWD has no settings', async () => {
    const homeSettingsDir = path.join(mockHome, '.mcp-local-llm');
    mkdirSync(homeSettingsDir, { recursive: true });
    const homeSettings = path.join(homeSettingsDir, 'env.settings');
    writeIniSettings(homeSettings, BASE_CONFIG);

    const cm = await createConfigManager();
    expect((cm as any).settingsPath).toBe(homeSettings);
  });

  it('finds settings in XDG directory when Home has no settings', async () => {
    const xdgDir = path.join(mockHome, '.config', 'mcp-local-llm');
    mkdirSync(xdgDir, { recursive: true });
    const xdgSettings = path.join(xdgDir, 'env.settings');
    writeIniSettings(xdgSettings, BASE_CONFIG);

    const cm = await createConfigManager();
    expect((cm as any).settingsPath).toBe(xdgSettings);
  });
});
