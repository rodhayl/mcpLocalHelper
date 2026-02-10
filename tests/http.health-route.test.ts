import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { HttpServer } from '../src/server/http.js';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

describe('HttpServer health route mounting', () => {
  let sandboxDir: string;
  let configPath: string;
  let app: any;

  beforeAll(() => {
    sandboxDir = mkdtempSync(path.join(tmpdir(), 'mcp-http-health-'));
    configPath = path.join(sandboxDir, 'env.test.settings');

    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    const repoRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

    cfg.workspace = { roots: [repoRoot], defaultRoot: repoRoot };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [repoRoot], maxFileBytes: 131072 };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };

    writeSettingsFile(configPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getConfig().backends);
    const server = new HttpServer(config, backendManager);
    app = (server as any).app;
  });

  afterAll(() => {
    if (sandboxDir) {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('serves health at /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('does not expose duplicate /health/health endpoint', async () => {
    const res = await request(app).get('/health/health');
    expect(res.status).toBe(404);
  });
});

