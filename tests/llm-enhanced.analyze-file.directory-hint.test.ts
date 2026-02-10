import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';

const TEST_DIR = resolve('tests/tmp/llm-enhanced-directory-hint');

describe('analyze_file directory guidance', () => {
  let tools: LlmEnhancedTools;

  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(join(TEST_DIR, 'src', 'nested'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'src', 'example.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(
      join(TEST_DIR, 'src', 'nested', 'helper.py'),
      'def helper():\n  return 1\n',
      'utf-8'
    );

    const config = new ConfigManager();
    config.setDynamicWorkspaceRoots([TEST_DIR]);
    const backendManager = new BackendManager(config.getConfig().backends);
    tools = new LlmEnhancedTools(config, backendManager);
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns candidate file suggestions when path is a directory', async () => {
    await expect(tools.analyzeFile('src')).rejects.toThrow(/Try one of these files/i);
    await expect(tools.analyzeFile('src')).rejects.toThrow(/src\/example\.ts|example\.ts/i);
  });
});
