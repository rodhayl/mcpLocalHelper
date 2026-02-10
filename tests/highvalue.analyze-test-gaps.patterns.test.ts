import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { HighValueTools } from '../src/tools/highvalue.js';

const tempDir = path.join(process.cwd(), 'tests', '.tmp-analyze-test-gaps-patterns');

describe('analyze_test_gaps pattern handling', () => {
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('supports path-aware glob patterns for source/test discovery', async () => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    mkdirSync(path.join(tempDir, 'tests'), { recursive: true });

    writeFileSync(
      path.join(tempDir, 'src', 'math.ts'),
      'export function add(a:number,b:number){return a+b;}\n'
    );
    writeFileSync(
      path.join(tempDir, 'tests', 'math.test.ts'),
      "import { add } from '../src/math';\n\ndescribe('add', () => { it('works', () => expect(add(1,2)).toBe(3)); });\n"
    );

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new HighValueTools(config, backendManager);

    const relRoot = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = await tools.analyzeTestGaps(relRoot, {
      sourcePatterns: ['src/**/*.ts'],
      testPatterns: ['tests/**/*.test.ts'],
    });

    expect(result.coverageSummary.totalSourceFiles).toBe(1);
    expect(result.coverageSummary.totalTestFiles).toBe(1);
  });

  it('includes Python files in default source/test pattern detection', async () => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    mkdirSync(path.join(tempDir, 'tests'), { recursive: true });

    writeFileSync(path.join(tempDir, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    writeFileSync(
      path.join(tempDir, 'tests', 'test_calc.py'),
      'from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n'
    );

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new HighValueTools(config, backendManager);

    const relRoot = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = await tools.analyzeTestGaps(relRoot);

    expect(result.coverageSummary.totalSourceFiles).toBeGreaterThanOrEqual(1);
    expect(result.coverageSummary.totalTestFiles).toBeGreaterThanOrEqual(1);
  });
});
