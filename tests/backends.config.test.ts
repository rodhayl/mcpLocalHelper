import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager, parseEnvSettings } from '../src/config/index.js';
import { writeSettingsFile } from './test-utils/settings.js';

let TEST_DIR = '';
let TEST_SETTINGS_PATH = '';

describe('Backends persistence (settings file)', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'mcp-local-llm-tests-backends-'));
    TEST_SETTINGS_PATH = join(TEST_DIR, 'env.settings');

    const baseConfig = {
      backends: [{ id: 'ollama', type: 'ollama', base_url: 'http://127.0.0.1:11434' }],
      defaults: { localBackendId: 'ollama' },
      policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
      systemProfile: { exposeToLLM: false },
    };

    writeSettingsFile(TEST_SETTINGS_PATH, baseConfig, { serverPort: 0, testingEnabled: true });
  });

  afterEach(() => {
    if (existsSync(TEST_SETTINGS_PATH)) unlinkSync(TEST_SETTINGS_PATH);
    if (TEST_DIR && existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('persists backends into CONFIG_JSON and reloads them', () => {
    const cm1 = new ConfigManager(TEST_SETTINGS_PATH);
    cm1.setBackends([
      { id: 'ollama', type: 'ollama', base_url: 'http://127.0.0.1:11434' },
      { id: 'lmstudio', type: 'lmstudio', base_url: 'http://127.0.0.1:1234' },
      {
        id: 'openrouter',
        type: 'openrouter',
        base_url: 'https://openrouter.ai/api',
        api_key: `sk${'-or-test'}`,
      },
    ]);

    const raw = readFileSync(TEST_SETTINGS_PATH, 'utf-8');
    const sections = parseEnvSettings(raw);
    const json = (sections.config || {}).CONFIG_JSON;
    expect(typeof json).toBe('string');
    const persisted = JSON.parse(json as string) as any;
    expect(Array.isArray(persisted.backends)).toBe(true);
    expect(persisted.backends.find((b: any) => b.id === 'lmstudio')).toBeDefined();
    expect(persisted.backends.find((b: any) => b.id === 'openrouter').api_key).toBe(
      `sk${'-or-test'}`
    );

    const cm2 = new ConfigManager(TEST_SETTINGS_PATH);
    const ids = cm2.getBackends().map((b) => b.id).sort();
    expect(ids).toEqual(['lmstudio', 'ollama', 'openrouter']);
  });
});

