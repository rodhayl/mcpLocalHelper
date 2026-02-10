import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { HighValueTools } from '../src/tools/highvalue.js';

const tempDir = path.join(process.cwd(), 'tests', '.tmp-security-low-coverage');

describe('security scan low-coverage fallback', () => {
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should broaden scan when coverage is below threshold', () => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(path.join(tempDir, 'a.ts'), 'const apiKey = "not-a-real-key";\n');
    writeFileSync(path.join(tempDir, 'b.txt'), 'just text\n');
    writeFileSync(path.join(tempDir, 'c.txt'), 'more text\n');

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new HighValueTools(config, backendManager);

    const relRoot = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = tools.secretScan(relRoot, { scanType: 'secrets', outputFormat: 'summary' });

    expect(result.statistics.usedFallback).toBe(true);
    expect(result.statistics.filesScanned).toBeGreaterThan(1);

    const guidance = (result.statistics as any).coverageGuidance;
    expect(guidance).toBeDefined();
    expect(Array.isArray(guidance?.recommendedInclude)).toBe(true);
    expect(guidance?.recommendedInclude?.length).toBeGreaterThan(0);
    expect(
      result.warnings?.some((warning) => warning.includes('Coverage guidance'))
    ).toBe(true);
  });

  it('should provide actionable guidance when zero files are scanned', () => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(path.join(tempDir, '.hidden'), { recursive: true });
    writeFileSync(path.join(tempDir, '.hidden', 'secret.ts'), 'const key = "abc";\n');

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new HighValueTools(config, backendManager);

    const relRoot = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = tools.secretScan(relRoot, {
      scanType: 'secrets',
      outputFormat: 'summary',
      failOnEmpty: false,
      warnOnEmpty: true,
    });

    expect(result.statistics.filesScanned).toBe(0);
    expect(result.warnings?.some((warning) => warning.includes('includeHidden'))).toBe(true);
    expect(
      result.warnings?.some((warning) => warning.includes('security {"action":"scan"'))
    ).toBe(true);
  });

  it('should not leak absolute resolved paths when root does not exist', () => {
    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new HighValueTools(config, backendManager);

    expect(() => tools.secretScan('__missing_security_root__')).toThrowError();

    try {
      tools.secretScan('__missing_security_root__');
      expect(true).toBe(false);
    } catch (error) {
      const message = String((error as Error).message || '');
      expect(message).toMatch(/Path not found/i);
      expect(message).not.toMatch(/Resolved to:/i);
      expect(message).not.toMatch(/[A-Za-z]:\\/);
    }
  });
});
