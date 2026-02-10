import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, { encoding: 'utf8' });
}

describe('Package file generation', () => {
  it('generates a Windows install.bat without batch-breaking sequences', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const generator = path.join(repoRoot, 'scripts', 'generate_package_files.js');

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-local-llm-dist-package-'));

    execFileSync(process.execPath, [generator, outDir], {
      stdio: 'ignore',
      cwd: repoRoot,
    });

    const installBatPath = path.join(outDir, 'install.bat');
    const uninstallBatPath = path.join(outDir, 'uninstall.bat');

    expect(fs.existsSync(installBatPath)).toBe(true);
    expect(fs.existsSync(uninstallBatPath)).toBe(true);

    const installBat = readUtf8(installBatPath);
    const uninstallBat = readUtf8(uninstallBatPath);

    // Regression: JS template literals must not interpret "\n" inside Windows paths.
    // If it happens, we'd see the string split across lines (e.g. "%APPDATA%" then "pm").
    expect(installBat).toContain('set "NPM_BIN=%APPDATA%\\npm"');
    expect(uninstallBat).toContain('set "NPM_BIN=%APPDATA%\\npm"');

    // Ensure backslash+n sequences are preserved (not converted to newlines)
    expect(installBat).toContain('%NPM_BIN%\\node_modules\\mcp-local-llm');
    expect(uninstallBat).toContain('%NPM_BIN%\\node_modules\\mcp-local-llm');

    // Regression: Unescaped parentheses inside IF (...) blocks break cmd.exe parsing.
    // Keep installer help echoes free of '(' and ')' characters.
    expect(installBat).not.toMatch(/^\s*echo.*[()]/gmi);
    // Ensure uninstall script attempts to stop only our Node servers (best-effort)
    expect(uninstallBat).toMatch(/Checking for running MCP server node processes/i);
    expect(uninstallBat).toMatch(/Stop-Process/i);  });
});
