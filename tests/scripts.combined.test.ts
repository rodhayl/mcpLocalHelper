/**
 * Combined Scripts Tests
 * Merged from: scripts/install-bat.regression.test.ts, scripts/postinstall-helpers.test.ts,
 *              scripts/postinstall-integration.test.ts, scripts/run_all_tests_all_py.regression.test.ts
 *
 * Tests for script generation and postinstall functionality:
 * - install.bat postinstall execution
 * - env.settings creation/replacement
 * - run_all_tests_ALL.py consolidated suite references
 */
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { describe, test, it, expect, beforeEach, afterEach } from 'vitest';

const repoRoot = resolve(__dirname, '..');
const normalize = (value: string) => value.replace(/\r\n/g, '\n');

// ============================================
// install.bat Regression Tests
// ============================================

describe('install.bat regression', () => {
  test('install.bat forces postinstall to run after npm install', () => {
    const installBatPath = resolve(repoRoot, 'dist_package', 'install.bat');
    const content = readFileSync(installBatPath, 'utf8');

    expect(content).toContain('Force postinstall to run');
    expect(content).toContain('npm root -g');
    expect(content).toContain('postinstall.js');
    expect(content).toContain('%NPM_GLOBAL_ROOT%\\mcp-local-llm\\postinstall.js');
    expect(content).toContain('pushd "%NPM_GLOBAL_ROOT%\\mcp-local-llm"');

    const npmInstallIndex = content.indexOf('npm install -g');
    const postinstallIndex = content.indexOf('node postinstall.js');
    expect(postinstallIndex).toBeGreaterThan(npmInstallIndex);
    expect(postinstallIndex).toBeGreaterThan(0);
  });
});

// ============================================
// postinstall-helpers Tests
// ============================================

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureDefaultEnvSettings } = require('../scripts/postinstall-helpers.js');

describe('postinstall helpers - ensureDefaultEnvSettings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-postinstall-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates env.settings when missing', () => {
    const source = join(repoRoot, 'env.settings.example');
    const sourceContent = readFileSync(source, 'utf8');

    const result: any = ensureDefaultEnvSettings(tmpDir, source);

    const target = join(tmpDir, '.mcp-local-llm', 'env.settings');
    expect(existsSync(target)).toBe(true);

    const content = readFileSync(target, 'utf8');
    expect(normalize(content)).toBe(normalize(sourceContent));
    expect(result.action).toBe('created');
  });

  it('replaces existing env.settings with canonical example', () => {
    const source = join(repoRoot, 'env.settings.example');
    const sourceContent = readFileSync(source, 'utf8');
    const configDir = join(tmpDir, '.mcp-local-llm');
    mkdirSync(configDir, { recursive: true });

    const initial = '[production]\nLOCAL_BACKEND_ID=ollama\n';
    writeFileSync(join(configDir, 'env.settings'), initial, 'utf8');

    const result: any = ensureDefaultEnvSettings(tmpDir, source);
    expect(result.action).toBe('replaced');

    const target = join(configDir, 'env.settings');
    const content = readFileSync(target, 'utf8');
    expect(normalize(content)).toBe(normalize(sourceContent));
    expect(existsSync(result.backup)).toBe(true);
    expect(readFileSync(result.backup, 'utf8')).toBe(initial);
  });

  it('no-op when existing settings already match canonical example', () => {
    const source = join(repoRoot, 'env.settings.example');
    const sourceContent = readFileSync(source, 'utf8');
    const configDir = join(tmpDir, '.mcp-local-llm');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(configDir, 'env.settings'), sourceContent, 'utf8');

    const result: any = ensureDefaultEnvSettings(tmpDir, source);
    expect(result.action).toBe('noop');
  });
});

// ============================================
// postinstall Integration Tests
// ============================================

describe('postinstall integration - startup with patched env.settings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mcp-postinstall-e2e-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('packaged env.settings.example matches repository canonical example', () => {
    const packaged = readFileSync(join(repoRoot, 'dist_package', 'env.settings.example'), 'utf8').replace(/\r\n/g, '\n');
    const canonical = readFileSync(join(repoRoot, 'env.settings.example'), 'utf8').replace(/\r\n/g, '\n');
    expect(packaged).toBe(canonical);
  });

  it('postinstall replaces existing env.settings with canonical example', () => {
    const postinstallScript = join(repoRoot, 'dist_package', 'postinstall.js');
    const envExample = join(repoRoot, 'dist_package', 'env.settings.example');
    const exampleContent = readFileSync(envExample, 'utf8').replace(/\r\n/g, '\n');

    const configDir = join(tmpDir, '.mcp-local-llm');
    mkdirSync(configDir, { recursive: true });

    const invalidSettings = `# Old settings file\n[production]\nLOCAL_BACKEND_ID=ollama\n`;
    writeFileSync(join(configDir, 'env.settings'), invalidSettings, 'utf8');

    const mockPackageDir = join(tmpDir, 'mock-package');
    mkdirSync(mockPackageDir, { recursive: true });
    copyFileSync(envExample, join(mockPackageDir, 'env.settings.example'));

    const postinstallCode = readFileSync(postinstallScript, 'utf8')
      .replace('os.homedir()', `"${tmpDir.replace(/\\/g, '\\\\')}"`);

    const tempPostinstall = join(mockPackageDir, 'postinstall-test.js');
    writeFileSync(tempPostinstall, postinstallCode, 'utf8');

    const output = execSync(`node "${tempPostinstall}"`, { cwd: mockPackageDir, encoding: 'utf8' });

    expect(output).toContain('MCP Local LLM Installed Successfully');
    expect(output).toContain('Replaced existing configuration');

    const patchedContent = readFileSync(join(configDir, 'env.settings'), 'utf8');
    expect(patchedContent.replace(/\r\n/g, '\n')).toBe(exampleContent);
  });

  it('postinstall creates env.settings when missing', () => {
    const postinstallScript = join(repoRoot, 'dist_package', 'postinstall.js');
    const envExample = join(repoRoot, 'dist_package', 'env.settings.example');
    const exampleContent = readFileSync(envExample, 'utf8').replace(/\r\n/g, '\n');

    const mockPackageDir = join(tmpDir, 'mock-package');
    mkdirSync(mockPackageDir, { recursive: true });
    copyFileSync(envExample, join(mockPackageDir, 'env.settings.example'));

    const postinstallCode = readFileSync(postinstallScript, 'utf8')
      .replace('os.homedir()', `"${tmpDir.replace(/\\/g, '\\\\')}"`);

    const tempPostinstall = join(mockPackageDir, 'postinstall-test.js');
    writeFileSync(tempPostinstall, postinstallCode, 'utf8');

    const output = execSync(`node "${tempPostinstall}"`, { cwd: mockPackageDir, encoding: 'utf8' });

    expect(output).toContain('Created default configuration');

    const configFile = join(tmpDir, '.mcp-local-llm', 'env.settings');
    expect(existsSync(configFile)).toBe(true);

    const content = readFileSync(configFile, 'utf8');
    expect(content.replace(/\r\n/g, '\n')).toBe(exampleContent);
  });
});

// ============================================
// run_all_tests_ALL.py Regression Tests
// ============================================

describe('run_all_tests_ALL.py regression', () => {
  test('uses consolidated matrix suites', () => {
    const pyPath = resolve(repoRoot, 'run_all_tests_ALL.py');
    const content = readFileSync(pyPath, 'utf8');

    expect(content).toContain('real.analysis-quality.matrix.test.ts');
    expect(content).toContain('real.stress-config.matrix.test.ts');

    const legacyNames = [
      'real.search-analysis.test.ts',
      'real.code-quality.test.ts',
      'real.edge-cases.test.ts',
    ];

    for (const legacyName of legacyNames) {
      expect(content).not.toContain(legacyName);
    }
  });

  test('supports backend selection and benchmarking', () => {
    const pyPath = resolve(repoRoot, 'run_all_tests_ALL.py');
    const content = readFileSync(pyPath, 'utf8');

    expect(content).toContain('--backend');
    expect(content).toContain('--all-backends');
    expect(content).toContain('--benchmarking');
  });

  test('forces env-automated-tests.settings', () => {
    const pyPath = resolve(repoRoot, 'run_all_tests_ALL.py');
    const content = readFileSync(pyPath, 'utf8');
    expect(content).toContain('env-automated-tests.settings');
  });
});
