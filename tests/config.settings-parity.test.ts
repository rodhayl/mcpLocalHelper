import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { parseEnvSettings } from '../src/config/index.js';

const ROOT = path.resolve(__dirname, '..');

function loadConfigJson(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, 'utf8');
  const sections = parseEnvSettings(content);
  const configSection = sections.config || sections.CONFIG || {};
  const raw = String(configSection.CONFIG_JSON || '');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('settings parity (config canonical + root compatibility)', () => {
  it('ships both canonical config files and root compatibility files', () => {
    const required = [
      'env.settings.example',
      'env-automated-tests.settings',
      'env-opencode-optimized.settings',
      path.join('config', 'env.settings.example'),
      path.join('config', 'env-automated-tests.settings'),
      path.join('config', 'env-opencode-optimized.settings'),
    ];
    for (const relPath of required) {
      expect(existsSync(path.join(ROOT, relPath))).toBe(true);
    }
  });

  it('uses repo-root workspace defaults for canonical config files in config/', () => {
    const configFile = path.join(ROOT, 'config', 'env-automated-tests.settings');
    const parsed = loadConfigJson(configFile) as {
      workspace?: { roots?: string[]; defaultRoot?: string };
      policy?: { allowlistPaths?: string[] };
    };
    expect(parsed.workspace?.roots).toContain('..');
    expect(parsed.workspace?.defaultRoot).toBe('..');
    expect(parsed.policy?.allowlistPaths).toContain('..');
  });

  it('keeps root compatibility settings rooted at current directory', () => {
    const rootFile = path.join(ROOT, 'env-automated-tests.settings');
    const parsed = loadConfigJson(rootFile) as {
      workspace?: { roots?: string[]; defaultRoot?: string };
    };
    expect(parsed.workspace?.roots).toContain('.');
    expect(parsed.workspace?.defaultRoot).toBe('.');
  });
});
