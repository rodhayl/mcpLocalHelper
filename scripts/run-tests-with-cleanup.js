#!/usr/bin/env node
/**
 * Runs test preparation, Vitest, and cleanup in a single flow so cleanup
 * always executes even when tests fail.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const testOrchestrationPlansDir = path.join(repoRoot, '.tmp', 'test-orchestration-plans');

function runNodeScript(scriptRelativePath, env = process.env) {
  const scriptPath = path.join(repoRoot, scriptRelativePath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });
  if (typeof result.status === 'number') {
    return result.status;
  }
  console.error(`[run-tests-with-cleanup] failed to run ${scriptRelativePath}`);
  return 1;
}

function resolveVitestCommand(extraArgs) {
  const localVitestMjs = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (require('node:fs').existsSync(localVitestMjs)) {
    return {
      command: process.execPath,
      args: [localVitestMjs, 'run', ...extraArgs],
    };
  }

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return {
    command: npxCmd,
    args: ['vitest', 'run', ...extraArgs],
  };
}

function runVitest(extraArgs, env = process.env) {
  const { command, args } = resolveVitestCommand(extraArgs);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });
  if (typeof result.status === 'number') {
    return result.status;
  }
  console.error('[run-tests-with-cleanup] vitest execution failed');
  return 1;
}

function main() {
  const extraArgs = process.argv.slice(2);
  const testEnv = {
    ...process.env,
    MCP_ORCHESTRATION_PLANS_DIR: testOrchestrationPlansDir,
  };
  let exitCode = 0;

  const prepCode = runNodeScript('scripts/prepare-test-assets.js');
  if (prepCode !== 0) {
    exitCode = prepCode;
  } else {
    exitCode = runVitest(extraArgs, testEnv);
  }

  const cleanupCode = runNodeScript('scripts/cleanup-test-assets.js');
  if (cleanupCode !== 0) {
    process.exit(cleanupCode);
  }

  process.exit(exitCode);
}

main();
