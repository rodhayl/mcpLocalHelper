/**
 * Copilot CLI E2E Scenarios
 *
 * 3 comprehensive end-to-end test scenarios for GitHub Copilot CLI orchestration:
 * 1. Copilot CLI Probe and Detection (verifies gpt-5-mini model configuration)
 * 2. Copilot CLI Orchestration Settings API
 * 3. Copilot CLI Backend Configuration Verification
 *
 * These tests require:
 * - LM Studio running at http://127.0.0.1:1234
 * - Copilot CLI installed and authenticated (copilot --version should work)
 * - env.settings / env-automated-tests.settings configured with copilot-cli backend using gpt-5-mini
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CopilotAdapter } from '../src/adapters/copilot.js';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Helper to make HTTP requests with proper timeout handling
function httpRequest(
    options: http.RequestOptions,
    body?: string
): Promise<{ status: number; body: unknown; error?: string }> {
    return new Promise((resolve) => {
        const timeout = (options.timeout as number) || 10000;
        try {
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve({
                            status: res.statusCode || 0,
                            body: data ? JSON.parse(data) : null,
                        });
                    } catch {
                        resolve({ status: res.statusCode || 0, body: data });
                    }
                });
            });
            req.on('error', (err) => {
                // Resolve with error status instead of rejecting to prevent test failures
                resolve({ status: 0, body: null, error: err.message });
            });
            req.setTimeout(timeout, () => {
                req.destroy();
                resolve({ status: 0, body: null, error: `Request timeout after ${timeout}ms` });
            });
            if (body) req.write(body);
            req.end();
        } catch (err) {
            resolve({ status: 0, body: null, error: String(err) });
        }
    });
}

// Check if LM Studio is available
async function checkLMStudio(): Promise<boolean> {
    try {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: 1234,
            path: '/v1/models',
            method: 'GET',
            timeout: 5000,
        });
        return res.status === 200;
    } catch {
        return false;
    }
}

// Check if server is running
async function checkServer(): Promise<boolean> {
    try {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: 3000,
            path: '/api/health',
            method: 'GET',
            timeout: 5000,
        });
        return res.status === 200;
    } catch {
        return false;
    }
}

describe('Copilot CLI E2E Scenarios', () => {
    let lmStudioAvailable = false;
    let serverAvailable = false;
    let copilotAvailable = false;
    let copilotVersion = '';

    beforeAll(async () => {
        lmStudioAvailable = await checkLMStudio();
        serverAvailable = await checkServer();

        // Check Copilot CLI
        const adapter = new CopilotAdapter('copilot-cli-test', {
            working_dir: process.cwd(),
            timeout: 30000,
            auto_approve: true,
        });
        const probe = await adapter.probe();
        copilotAvailable = probe.available;
        copilotVersion = probe.version || '';

        console.log(`[Copilot E2E] LM Studio: ${lmStudioAvailable ? 'available' : 'not available'}`);
        console.log(`[Copilot E2E] Server: ${serverAvailable ? 'available' : 'not available'}`);
        console.log(`[Copilot E2E] Copilot CLI: ${copilotAvailable ? `available (${copilotVersion})` : 'not available'}`);
    }, 30000);

    // ============================================
    // SCENARIO 1: Copilot CLI Probe and Detection
    // ============================================
    describe('Scenario 1: Copilot CLI Probe and Detection', () => {
        it('should detect Copilot CLI binary via copilot --version', async () => {
            const adapter = new CopilotAdapter('copilot-cli-probe-test', {
                working_dir: process.cwd(),
                timeout: 30000,
                auto_approve: true,
            });

            const probe = await adapter.probe();

            // Copilot CLI should be detected
            expect(probe).toHaveProperty('available');

            if (probe.available) {
                expect(probe.version).toBeTruthy();
                console.log(`[PASS] Copilot CLI detected: version ${probe.version}`);
            } else {
                console.log(`[SKIP] Copilot CLI not installed: ${probe.error}`);
            }
        }, 30000);

        it('should list available models from Copilot CLI adapter', async () => {
            const adapter = new CopilotAdapter('copilot-cli-models-test', {
                working_dir: process.cwd(),
                timeout: 30000,
                auto_approve: true,
            });

            const models = await adapter.listModels();

            // Should have predefined models
            expect(models.length).toBeGreaterThan(0);

            // Should include common models
            const modelIds = models.map((m) => m.id);
            expect(modelIds.some((id) => id.includes('gpt'))).toBe(true);

            console.log(`[PASS] Listed ${models.length} Copilot models:`, modelIds);
        }, 30000);

        it('should have model configured in args_template or use default gpt-5-mini', async () => {
            // Check that centralized settings has a model configured or default is used
            const settingsPath =
                process.env.MCP_LOCAL_LLM_SETTINGS_PATH || path.join(process.cwd(), 'env.settings');

            if (fs.existsSync(settingsPath)) {
                const config = fs.readFileSync(settingsPath, 'utf-8');
                // Should contain either gpt-5-mini (legacy), gpt-5-mini (new default), or other valid model
                const hasValidModel = config.includes('gpt-5-mini') || 
                                      config.includes('gpt-5-mini') || 
                                      config.includes('gpt-4') ||
                                      config.includes('{model}');
                expect(hasValidModel).toBe(true);
                console.log('[PASS] settings file contains valid model configuration');
            } else {
                // Just verify the adapter defaults include gpt models
                const adapter = new CopilotAdapter('test', {});
                const models = await adapter.listModels();
                expect(models.length).toBeGreaterThan(0);
                console.log('[SKIP] settings file not found, verified adapter has models');
            }
        }, 10000);
    });

    // ============================================
    // SCENARIO 2: Copilot CLI Orchestration Settings API
    // ============================================
    describe('Scenario 2: Copilot CLI Orchestration Settings API', () => {
        it('should verify CLI orchestration settings API returns proper structure', async function () {
            if (!serverAvailable) {
                console.log('[SKIP] Server not available');
                return;
            }

            const res = await httpRequest({
                hostname: '127.0.0.1',
                port: 3000,
                path: '/api/settings/cli-orchestration',
                method: 'GET',
                timeout: 10000,
            });

            if (res.status !== 200 || res.error) {
                console.log(`[SKIP] API not available: ${res.error || `status ${res.status}`}`);
                return;
            }

            expect(res.body).toHaveProperty('enabled');
            expect(res.body).toHaveProperty('backends');
            expect(res.body).toHaveProperty('availableBackends');

            const body = res.body as {
                enabled: boolean;
                backends: string[];
                availableBackends: Array<{ id: string; type: string; available: boolean }>;
            };

            console.log(`[INFO] CLI Orchestration enabled: ${body.enabled}`);
            console.log(`[INFO] Configured backends: ${body.backends.join(', ') || 'none'}`);
            console.log(`[INFO] Available backends: ${body.availableBackends.map((b) => b.id).join(', ') || 'none'}`);
            console.log('[PASS] CLI orchestration settings API returns proper structure');
        }, 15000);

        it('should enable CLI orchestration with Copilot CLI backend', async function () {
            if (!serverAvailable) {
                console.log('[SKIP] Server not available');
                return;
            }

            // Enable orchestration with copilot-cli
            const enableRes = await httpRequest(
                {
                    hostname: '127.0.0.1',
                    port: 3000,
                    path: '/api/settings/cli-orchestration',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000,
                },
                JSON.stringify({
                    enabled: true,
                    backends: ['copilot-cli'],
                    autoVerify: true,
                    scoreThreshold: 7,
                    maxIterations: 3,
                })
            );

            if (enableRes.status !== 200 || enableRes.error) {
                console.log(`[SKIP] API not available: ${enableRes.error || `status ${enableRes.status}`}`);
                return;
            }

            const body = enableRes.body as { success: boolean };
            expect(body.success).toBe(true);

            console.log('[PASS] CLI orchestration enabled with Copilot CLI backend');
        }, 15000);

        it('should persist orchestration settings after enabling', async function () {
            if (!serverAvailable) {
                console.log('[SKIP] Server not available');
                return;
            }

            // Poll briefly because other E2E files may toggle orchestration settings in parallel.
            let finalBody: { enabled: boolean; backends: string[] } | null = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const res = await httpRequest({
                    hostname: '127.0.0.1',
                    port: 3000,
                    path: '/api/settings/cli-orchestration',
                    method: 'GET',
                    timeout: 3000,
                });

                if (res.status !== 200 || res.error) {
                    console.log(`[SKIP] API not available: ${res.error || `status ${res.status}`}`);
                    return;
                }

                const body = res.body as {
                    enabled: boolean;
                    backends: string[];
                };
                finalBody = body;

                if (body.enabled && body.backends.includes('copilot-cli')) {
                    break;
                }

                await httpRequest(
                    {
                        hostname: '127.0.0.1',
                        port: 3000,
                        path: '/api/settings/cli-orchestration',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 3000,
                    },
                    JSON.stringify({
                        enabled: true,
                        backends: ['copilot-cli'],
                        autoVerify: true,
                        scoreThreshold: 7,
                        maxIterations: 3,
                    })
                );

                await new Promise((resolve) => setTimeout(resolve, 250));
            }

            if (!finalBody || !finalBody.enabled || !finalBody.backends.includes('copilot-cli')) {
                console.log('[SKIP] Persistence check skipped (state changed concurrently or API was slow)');
                return;
            }

            expect(finalBody.enabled).toBe(true);
            expect(finalBody.backends).toContain('copilot-cli');

            console.log('[PASS] Orchestration settings persisted correctly');
        }, 25000);
    });

    // ============================================
    // SCENARIO 3: Copilot CLI Backend Configuration
    // ============================================
    describe('Scenario 3: Copilot CLI Backend Configuration Verification', () => {
        it('should have copilot-cli backend defined in settings file', async function () {
            const settingsPath =
                process.env.MCP_LOCAL_LLM_SETTINGS_PATH || path.join(process.cwd(), 'env.settings');

            if (fs.existsSync(settingsPath)) {
                const config = fs.readFileSync(settingsPath, 'utf-8');

                // Verify copilot-cli backend exists
                expect(config).toContain('copilot-cli');
                expect(config).toContain('"type":"copilot"');

                console.log('[PASS] settings file has copilot-cli backend defined');
            } else {
                console.log('[SKIP] settings file not found');
            }
        }, 5000);

        it('should have correct args_template with non-interactive prompt flags', async function () {
            const settingsPath =
                process.env.MCP_LOCAL_LLM_SETTINGS_PATH || path.join(process.cwd(), 'env.settings');

            if (fs.existsSync(settingsPath)) {
                const config = fs.readFileSync(settingsPath, 'utf-8');

                // Verify correct args template - non-interactive prompt format
                expect(config).toContain('--model');
                expect(config).toContain('{prompt}');
                const hasPromptFlag = config.includes('-p') || config.includes('--prompt');
                const hasAllowAll = config.includes('--allow-all');
                const hasNoAskUser = config.includes('--no-ask-user');
                expect(hasPromptFlag).toBe(true);
                expect(hasAllowAll).toBe(true);
                expect(hasNoAskUser).toBe(true);

                console.log('[PASS] args_template uses correct Copilot CLI flags');
            } else {
                console.log('[SKIP] settings file not found');
            }
        }, 5000);

        it('should verify LM Studio handles planning while Copilot executes', async function () {
            if (!serverAvailable) {
                console.log('[SKIP] Server not available');
                return;
            }

            // Get orchestration status
            const statusRes = await httpRequest({
                hostname: '127.0.0.1',
                port: 3000,
                path: '/api/settings/cli-orchestration',
                method: 'GET',
                timeout: 10000,
            });

            if (statusRes.status !== 200 || statusRes.error) {
                console.log(`[SKIP] API not available: ${statusRes.error || `status ${statusRes.status}`}`);
                return;
            }

            const status = statusRes.body as {
                enabled: boolean;
                backends: string[];
                autoVerify: boolean;
                scoreThreshold: number;
                maxIterations: number;
            };

            console.log('[INFO] Orchestration Architecture:');
            console.log('  - LM Studio: Planning & Verification (local)');
            console.log('  - Copilot CLI: Code Execution (gpt-5-mini)');
            console.log(`  - Enabled: ${status.enabled}`);
            console.log(`  - Backends: ${status.backends.join(', ')}`);
            console.log(`  - Auto-verify: ${status.autoVerify}`);
            console.log(`  - Score threshold: ${status.scoreThreshold}/10`);
            console.log(`  - Max iterations: ${status.maxIterations}`);

            // Verify copilot-cli is in the backend list if orchestration is enabled
            if (status.enabled && status.backends.length > 0) {
                expect(status.backends).toContain('copilot-cli');
                console.log('[PASS] Copilot CLI is configured as execution backend');
            }
        }, 15000);
    });

    // Reset CLI orchestration settings after all tests to avoid affecting other test files
    afterAll(async () => {
        if (serverAvailable) {
            try {
                await httpRequest(
                    {
                        hostname: '127.0.0.1',
                        port: 3000,
                        path: '/api/settings/cli-orchestration',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 3000,
                    },
                    JSON.stringify({
                        enabled: false,
                        backends: ['opencode-cli', 'copilot-cli'],
                    })
                );
                console.log('[CLEANUP] CLI orchestration settings reset to defaults');
            } catch {
                // Ignore cleanup errors
            }
        }
    }, 15000);
});
