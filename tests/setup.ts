/**
 * Vitest Global Setup
 *
 * This file is loaded before all tests via vitest.config.ts setupFiles.
 * It sets up environment variables from the CENTRALIZED configuration.
 *
 * IMPORTANT: All configuration values are read from config files, NOT hardcoded.
 * See tests/test-config.ts for the configuration loader.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getTestConfig } from './test-config.js';
import { probeLmStudio, requireLmStudioForTests } from './test-utils/lmstudio.js';

const repoRoot = path.resolve(__dirname, '..');

function envTrue(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Ensure dist is present and up-to-date for tests that spawn `node dist/index.js`.
// Many suites run via `npx vitest run <file>` (one file per process), so this check must be fast.
const distIndex = path.resolve(repoRoot, 'dist', 'index.js');
const isDistStale = (): boolean => {
  if (!existsSync(distIndex)) return true;
  try {
    const distMtime = statSync(distIndex).mtimeMs;
    const stack = [path.resolve(repoRoot, 'src')];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!/\.(ts|js)$/.test(entry.name)) continue;
          if (statSync(full).mtimeMs > distMtime) return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return true;
  }
  return false;
};

if (existsSync(repoRoot) && isDistStale()) {
  console.log('[SETUP] Building project (dist is missing or stale)...');
  execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
}

// Load centralized test configuration
const testConfig = getTestConfig();

// Force all tests to use centralized automated settings.
// Prefer config/env-automated-tests.settings, with root fallback for compatibility.
const automatedSettingsPath = path.resolve(repoRoot, 'config', 'env-automated-tests.settings');
const automatedSettingsCompatPath = path.resolve(repoRoot, 'env-automated-tests.settings');
if (existsSync(automatedSettingsPath)) {
  process.env.MCP_LOCAL_LLM_SETTINGS_PATH = automatedSettingsPath;
} else if (existsSync(automatedSettingsCompatPath)) {
  process.env.MCP_LOCAL_LLM_SETTINGS_PATH = automatedSettingsCompatPath;
} else {
  // Fallback for local dev: repo-root env.settings (should still contain CONFIG_JSON).
  process.env.MCP_LOCAL_LLM_SETTINGS_PATH = path.resolve(repoRoot, 'env.settings');
}

// Standardize the live LLM backend/model for the entire test run.
// Values are READ FROM CONFIG FILES, not hardcoded.
process.env.MCP_LOCAL_LLM_BACKEND_ID = testConfig.localBackendId;
process.env.MCP_LOCAL_LLM_MODEL = testConfig.localModel;
process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL =
  process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || testConfig.lmStudioBaseUrl;

// Enable SOTA backend role for tests (mapped via env-automated-tests.settings).
process.env.TESTING_MODE_ENABLED = 'true';

const runLmStudioTests =
  envTrue('VITEST_RUN_LMSTUDIO_TESTS') ||
  envTrue('MCP_RUN_LMSTUDIO_TESTS') ||
  requireLmStudioForTests();

/**
 * Check if CLI orchestration is available (OpenCode or Copilot CLI)
 */
async function checkCliOrchestrationReady(): Promise<{ ready: boolean; backend: string }> {
  const cliEnabled = envTrue('CLI_ORCHESTRATION_ENABLED');
  if (!cliEnabled) return { ready: false, backend: '' };

  const cliBackends = (process.env.CLI_ORCHESTRATION_BACKENDS || '').split(',').map(b => b.trim()).filter(Boolean);
  if (cliBackends.length === 0) return { ready: false, backend: '' };

  const primaryBackend = cliBackends[0];
  const command = primaryBackend === 'copilot-cli' ? 'copilot' : 'opencode';

  try {
    execSync(`${command} --version`, { 
      encoding: 'utf-8', 
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ready: true, backend: primaryBackend };
  } catch {
    return { ready: false, backend: '' };
  }
}

async function configureLmStudioProbeEnv(): Promise<boolean> {
  // V22.1: First check if CLI orchestration is enabled and available
  // When CLI is primary, we don't need LM Studio for tests
  const cliCheck = await checkCliOrchestrationReady();
  if (cliCheck.ready) {
    console.log(`[SETUP] CLI orchestration enabled: using ${cliCheck.backend} as primary backend`);
    process.env.VITEST_LMSTUDIO_REACHABLE = 'true';  // CLI is reachable
    process.env.VITEST_LMSTUDIO_HAS_MODELS = 'true'; // CLI has model access
    process.env.VITEST_LMSTUDIO_INFERENCE_OK = 'true'; // CLI can do inference
    process.env.VITEST_LMSTUDIO_READY = 'true';       // Ready for tests
    process.env.VITEST_CLI_BACKEND = cliCheck.backend;
    return true;
  }

  if (!runLmStudioTests) {
    process.env.VITEST_LMSTUDIO_REACHABLE = 'false';
    process.env.VITEST_LMSTUDIO_HAS_MODELS = 'false';
    process.env.VITEST_LMSTUDIO_INFERENCE_OK = 'false';
    process.env.VITEST_LMSTUDIO_READY = 'false';
    return false;
  }

  // Detect LM Studio availability once and expose deterministic flags.
  // Tests that require a live, loaded model should use these env vars to skip cleanly.
  const probe = await probeLmStudio(testConfig.lmStudioApiBaseUrl, {
    timeoutMs: 15000,
    modelHint: testConfig.localModel,
  });
  process.env.VITEST_LMSTUDIO_REACHABLE = probe.reachable ? 'true' : 'false';
  process.env.VITEST_LMSTUDIO_HAS_MODELS = probe.hasModels ? 'true' : 'false';
  process.env.VITEST_LMSTUDIO_INFERENCE_OK = probe.inferenceOk ? 'true' : 'false';
  process.env.VITEST_LMSTUDIO_READY = probe.ready ? 'true' : 'false';

  if (requireLmStudioForTests() && !probe.ready) {
    throw new Error(
      `[SETUP] LM Studio is required for tests but is not ready at ${testConfig.lmStudioBaseUrl}. ${probe.details || ''}`.trim()
    );
  }

  return probe.ready;
}

await configureLmStudioProbeEnv();
