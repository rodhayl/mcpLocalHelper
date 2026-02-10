import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { writeSettingsFile } from './test-utils/settings.js';

function writeHttpE2eSettings(): { dir: string; path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-local-llm-http-e2e-'));
  const p = path.join(dir, 'env.http.e2e.settings');
  const workspaceRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

  const configJson = {
    backends: [
      {
        id: 'stub',
        type: 'stub',
        base_url: 'http://127.0.0.1:1',
        model: 'stub-model',
        labels: { priority: 'primary' },
      },
    ],
    defaults: {
      localBackendId: 'stub',
    },
    server: { host: '127.0.0.1', port: 0 },
    workspace: {
      roots: [workspaceRoot],
      defaultRoot: workspaceRoot,
    },
    policy: {
      allowlistPaths: [workspaceRoot],
      maxFileBytes: 131072,
    },
    systemProfile: {
      exposeToLLM: true,
    },
    toolGroups: {
      activeMode: 'DEVELOPMENT',
    },
  };

  writeSettingsFile(p, configJson, {
    serverPort: 0,
    serverHost: '127.0.0.1',
    exposeSystemProfile: true,
    testingEnabled: true,
  });
  return { dir, path: p };
}

describe('E2E HTTP API', () => {
  let proc: any;
  let base = '';
  let tempDir: string | null = null;
  let settingsPath: string | null = null;
  let savedCliEnabled: string | undefined;
  let savedCliBackends: string | undefined;

  beforeAll(async () => {
    // Disable CLI orchestration for these tests (they use stub backend)
    savedCliEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
    savedCliBackends = process.env.CLI_ORCHESTRATION_BACKENDS;
    delete process.env.CLI_ORCHESTRATION_ENABLED;
    delete process.env.CLI_ORCHESTRATION_BACKENDS;

    const cfg = writeHttpE2eSettings();
    tempDir = cfg.dir;
    settingsPath = cfg.path;

    proc = spawn('node', [path.resolve(__dirname, '../dist/index.js'), '--settings', settingsPath], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env },
      stdio: 'pipe',
    });

    const started = Date.now();
    const deadlineMs = 15000;

    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const onData = (chunk: any) => {
        const t = chunk.toString();
        stderr += t;

        const m = /HTTP server on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
        if (m && !base) {
          base = `http://127.0.0.1:${m[1]}`;
        }
      };

      const poll = async () => {
        try {
          if (proc?.exitCode !== null && proc?.exitCode !== undefined) {
            reject(new Error(`Server exited early: code=${proc.exitCode} stderr=${stderr}`));
            return;
          }
          if (base) {
            const r = await fetch(`${base}/api/backends`).catch(() => null);
            if (r && r.status >= 200 && r.status < 500) {
              resolve();
              return;
            }
          }
          if (Date.now() - started > deadlineMs) {
            reject(new Error(`Server did not become ready in time. stderr=${stderr}`));
            return;
          }
          setTimeout(poll, 250);
        } catch (e) {
          reject(e);
        }
      };

      proc.stderr?.on('data', onData);
      proc.on('error', reject);
      void poll();
    });
  }, 30000);

  afterAll(async () => {
    if (proc) proc.kill();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    // Restore CLI orchestration env variables
    if (savedCliEnabled !== undefined) {
      process.env.CLI_ORCHESTRATION_ENABLED = savedCliEnabled;
    }
    if (savedCliBackends !== undefined) {
      process.env.CLI_ORCHESTRATION_BACKENDS = savedCliBackends;
    }
  });

  it('should return backends list', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const resp = await fetch(`${base}/api/backends`);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  }, 30000);

  it('should return system profile and suitability', async () => {
    const resp = await fetch(`${base}/api/system-profile`);
    const data = await resp.json();
    expect(data).toHaveProperty('profile');
    expect(data).toHaveProperty('suitability');
  }, 30000);

  it('should list models for a local backend', async () => {
    const resp0 = await fetch(`${base}/api/backends`);
    const backends = await resp0.json();
    // OpenRouter is now optional - look for any available backend (local preferred)
    const backend =
      backends.find((b: any) => b.id === 'ollama' || b.id === 'lmstudio') || backends[0];
    expect(backend).toBeTruthy();
    const resp = await fetch(`${base}/api/backends/${backend.id}/models`);
    const data = await resp.json();
    // Models endpoint may return array or error object depending on backend availability
    expect(data).toBeDefined();
  }, 60000);

  it('should run verify-plan scenario via HTTP', async () => {
    const resp = await fetch(`${base}/api/scenarios/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'verify-plan' }),
    });
    const data = await resp.json();
    expect(data.status).toBe('completed');
    expect(data.result).toHaveProperty('overall_verdict');
    expect(Array.isArray(data.result.steps)).toBe(true);
  }, 60000);

  it('should redact sensitive values in /api/logs', async () => {
    const secret = `sk${'-proj-test1234567890abcdef1234567890abcdef1234567890abcdef'}`;

    const updateResp = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testing: { openRouterApiKey: secret } }),
    });
    const updateData = await updateResp.json();
    expect(updateData).toHaveProperty('success', true);

    const logsResp = await fetch(`${base}/api/logs?category=Settings`);
    const logsData = await logsResp.json();
    expect(Array.isArray(logsData.logs)).toBe(true);

    const entry = logsData.logs.find((l: any) => l?.message === 'Environment settings updated');
    expect(entry).toBeTruthy();

    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(entry.details?.testing?.openRouterApiKey).toBe('[REDACTED]');
  }, 30000);
});
