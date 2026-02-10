/**
 * Combined System Tests
 * Merged from: system.test.ts, system_profile.disabled.e2e.test.ts
 *
 * Tests:
 * - SystemProfiler functionality
 * - system_profile disabled behavior (E2E)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { SystemProfiler } from '../src/utils/system.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// ============================================
// SystemProfiler Tests
// ============================================

describe('SystemProfiler', () => {
  it('should get system profile', async () => {
    const profiler = new SystemProfiler();
    const profile = await profiler.getSystemProfile();

    expect(profile).toHaveProperty('os');
    expect(profile).toHaveProperty('cpu_cores');
    expect(profile).toHaveProperty('ram_gb_bucket');
    expect(profile).toHaveProperty('disk_free_gb_bucket');

    expect(typeof profile.os).toBe('string');
    expect(typeof profile.cpu_cores).toBe('number');
    expect(typeof profile.ram_gb_bucket).toBe('string');
    expect(typeof profile.disk_free_gb_bucket).toBe('string');
  }, 30000);

  it('should bucket RAM correctly', async () => {
    const profiler = new SystemProfiler();
    const profile = await profiler.getSystemProfile();

    expect(['4', '8', '16', '32+']).toContain(profile.ram_gb_bucket);
  }, 30000);

  it('should provide model suitability recommendations', async () => {
    const profiler = new SystemProfiler();
    const profile = await profiler.getSystemProfile();
    const suitability = profiler.getModelSuitability(profile);

    expect(suitability).toHaveProperty('recommended');
    expect(suitability).toHaveProperty('heavy');
    expect(suitability).toHaveProperty('notRecommended');

    expect(Array.isArray(suitability.recommended)).toBe(true);
    expect(Array.isArray(suitability.heavy)).toBe(true);
    expect(Array.isArray(suitability.notRecommended)).toBe(true);
  }, 30000);
});

// ============================================
// system_profile Disabled Behavior (E2E)
// ============================================

describe('system_profile disabled behavior (E2E)', () => {
  let client: any;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.resolve(__dirname, '../dist/index.js')],
      env: { ...process.env },
      stderr: 'pipe',
      cwd: path.resolve(__dirname, '..'),
    });
    const err = transport.stderr;
    if (err) {
      err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
    }
    client = new Client({ name: 'disabled-test', version: '0.0.1' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it('should return an error when calling system_profile', async () => {
    const res = await client.callTool({ name: 'system_profile', arguments: { detail: 'basic' } });
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as any).text || '';
    expect(text.toLowerCase()).toContain('disabled');
  }, 60000);
});
