import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliToolAdapter } from '../src/adapters/cli-tool.js';

class TestCliAdapter extends CliToolAdapter {
  readonly id = 'test-cli';
  readonly kind = 'local' as const;
  readonly displayName = 'Test CLI';

  protected getDefaultModel(): string {
    return 'test-model';
  }

  async executeTask(): Promise<any> {
    throw new Error('not used');
  }

  parseOutput(): any {
    throw new Error('not used');
  }

  async run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.execCommand(command, args);
  }
}

describe.skipIf(process.platform !== 'win32')('CliToolAdapter Windows npm shim execution', () => {
  it('execCommand can run an npm-style .cmd shim (without relying on shell)', async () => {
    const originalPath = process.env.PATH || '';
    const root = mkdtempSync(join(tmpdir(), 'mcp-cli-shim-'));

    try {
      // Create a fake npm bin layout:
      // - fakecmd (unix shell shim, not runnable on Windows)
      // - fakecmd.cmd (Windows cmd shim, points to a node script in node_modules)
      writeFileSync(join(root, 'fakecmd'), '#!/bin/sh\necho should-not-run\n', 'utf8');

      const nodeModulesBin = join(root, 'node_modules', 'fakepkg', 'bin');
      mkdirSync(nodeModulesBin, { recursive: true });

      const targetScript = join(nodeModulesBin, 'fakecmd');
      writeFileSync(targetScript, `console.log('shim-ok');\n`, 'utf8');

      const cmdShim = join(root, 'fakecmd.cmd');
      writeFileSync(
        cmdShim,
        [
          '@ECHO off',
          'SETLOCAL',
          'SET dp0=%~dp0',
          'SET \"_prog=node\"',
          '\"%_prog%\"  \"%dp0%\\\\node_modules\\\\fakepkg\\\\bin\\\\fakecmd\" %*',
          '',
        ].join('\r\n'),
        'utf8'
      );

      process.env.PATH = `${root};${originalPath}`;

      const adapter = new TestCliAdapter({
        command: 'fakecmd',
        args_template: [],
        working_dir: root,
        timeout: 10_000,
        auto_approve: true,
      });

      const res = await adapter.run('fakecmd', []);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe('shim-ok');
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

