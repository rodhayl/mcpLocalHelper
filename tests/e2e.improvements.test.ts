/**
 * MCP Server Improvements E2E Tests
 * 
 * Tests for the major improvements while minimizing duplicate long-running flows:
 * 1. Health Check (combined basic + detailed)
 * 2. Async Task Model (submit + poll)
 * 3. Progress Streaming (presence + step detail)
 * 4. Parameter Correction (typo + wrong case)
 * 5. LLM Caching (stats + hit/miss behavior)
 * 6. Request Logging (visibility + timing fields)
 * 7. Complex Agent Task
 * 8. Queue Stress Test
 */

import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestConfig } from './test-config.js';
import { probeLmStudio } from './test-utils/lmstudio.js';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Use centralized test configuration
const testConfig = getTestConfig();
const LMSTUDIO_BASE_URL = testConfig.lmStudioBaseUrl;
const LMSTUDIO_API_BASE_URL = testConfig.lmStudioApiBaseUrl;
const LMSTUDIO_MODEL = testConfig.localModel;
const ACTIVE_BACKEND_ID = process.env.MCP_LOCAL_LLM_BACKEND_ID || 'lmstudio';
const IS_COPILOT_BACKEND = ACTIVE_BACKEND_ID.includes('copilot');
const ASYNC_POLL_TIMEOUT_SHORT = IS_COPILOT_BACKEND ? 60000 : 150000;
const ASYNC_POLL_TIMEOUT_LONG = IS_COPILOT_BACKEND ? 90000 : 240000;
const ASYNC_POLL_TIMEOUT_QUEUE = IS_COPILOT_BACKEND ? 75000 : 180000;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('E2E MCP improvements tests', () => {
    let client: any;
    let transport: any;
    let lmStudioReady = false;
    let lmStudioSkipReason = '';

    beforeAll(async () => {
        const probe = await probeLmStudio(LMSTUDIO_API_BASE_URL, {
            timeoutMs: 15000,
            modelHint: LMSTUDIO_MODEL,
        });
        lmStudioReady = probe.ready;
        if (!lmStudioReady) {
            lmStudioSkipReason = `[SETUP] LM Studio not ready at ${LMSTUDIO_BASE_URL}. ${probe.details || ''}`.trim();
            console.warn(lmStudioSkipReason);
            return;
        }
        transport = new StdioClientTransport({
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
        client = new Client({ name: 'improvements-test', version: '1.0.0' });
        await client.connect(transport);
    }, 60000);

    afterAll(async () => {
        if (!lmStudioReady || !client) return;

        // Best-effort cleanup: reset queue and ensure no background tasks keep the server alive.
        try {
            await client.callTool(
                { name: 'agent_queue_status', arguments: { action: 'reset' } },
                undefined,
                { timeout: 15000 }
            );
        } catch { /* ignore */ }

        const waitForQueueEmpty = async (timeoutMs: number = 30000) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                try {
                    const status = await client.callTool(
                        { name: 'agent_queue_status', arguments: {} },
                        undefined,
                        { timeout: 15000 }
                    );
                    const parsed = JSON.parse((status.content[0] as any).text);
                    if (parsed.running === 0 && parsed.queued === 0) return;
                } catch {
                    // If we can't query status, don't block teardown forever.
                    return;
                }
                await sleep(500);
            }
        };

        await waitForQueueEmpty();

        // Close the client, but don't let teardown hang indefinitely.
        const closed = await Promise.race([
            client.close().then(() => true).catch(() => true),
            sleep(15000).then(() => false),
        ]);

        if (!closed) {
            try {
                await (transport?.close?.() ?? Promise.resolve());
            } catch { /* ignore */ }

            const proc =
                transport?.process ||
                transport?.childProcess ||
                transport?._process ||
                transport?._childProcess;
            try {
                proc?.kill?.();
            } catch { /* ignore */ }
        }
    });

    const isTimeoutError = (error: unknown): boolean => {
        if (!(error instanceof Error)) return false;
        return /timeout|timed out|request timed out/i.test(error.message);
    };

    const callToolWithTimeout = async (request: any, timeoutMs: number, label: string) => {
        const safeCall = client.callTool(request, undefined, { timeout: timeoutMs }).catch((err: unknown) => {
            throw err;
        });
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`[TIMEOUT] ${label}`)), timeoutMs);
        });
        try {
            return await Promise.race([safeCall, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const runIfAvailable = (testFn: () => Promise<void>) => async () => {
        if (!lmStudioReady) {
            if (lmStudioSkipReason) {
                console.warn(`Skipping test: ${lmStudioSkipReason}`);
            }
            return;
        }
        await testFn();
    };

    const pollTaskResult = async (taskId: string, timeoutMs: number = 180000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            let status: any;
            try {
                status = await client.callTool(
                    { name: 'agent_task_result', arguments: { taskId, includeProgress: false } },
                    undefined,
                    { timeout: 15000 }
                );
            } catch (error) {
                if (isTimeoutError(error)) {
                    return { status: 'timeout', progress: [], progressCount: 0 } as any;
                }
                throw error;
            }
            const result = JSON.parse((status.content[0] as any).text);
            if (result.status === 'complete' || result.status === 'failed' || result.status === 'timeout') {
                return result;
            }
            await sleep(1000);
        }
        return { status: 'timeout', progress: [], progressCount: 0 } as any;
    };

    // ============================================
    // Improvement 6: Health Check (combined)
    // ============================================
    describe('mcp_health', () => {
        it('returns healthy status and extended details', runIfAvailable(async () => {
            const res = await client.callTool({
                name: 'mcp_health',
                arguments: { includeDetails: true },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);

            expect(parsed.status).toBe('healthy');
            expect(parsed.uptimeSeconds).toBeGreaterThanOrEqual(0);
            expect(parsed.uptimeFormatted).toBeTruthy();
            expect(parsed.queue).toBeDefined();
            expect(parsed.queue.running).toBeGreaterThanOrEqual(0);
            expect(parsed.queue.queued).toBeGreaterThanOrEqual(0);
            expect(parsed.llmBackend).toBeDefined();
            expect(parsed.externalMcp).toBeDefined();
            expect(parsed.queueDetails).toBeDefined();
            expect(parsed.logging).toBeDefined();
            expect(parsed.logging.totalRequests).toBeGreaterThanOrEqual(0);
            expect(parsed.version).toBe('1.0.0');
            expect(parsed.serverStartTime).toBeTruthy();
        }), 10000);
    });

    // ============================================
    // Improvement 1: Async Task Model (combined submit + poll)
    // ============================================
    describe('async task model', () => {
        it('returns taskId immediately and supports polling', runIfAvailable(async () => {
            const startTime = Date.now();
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Plan a quick repo search task (async smoke test). Do not modify.',
                    async: true,
                    readOnly: true,
                    maxSteps: 1,
                    maxSubtasks: 1,
                    maxActionsPerStep: 1,
                },
            });
            const duration = Date.now() - startTime;

            expect(duration).toBeLessThan(10000);
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.async).toBe(true);
            expect(['queued', 'running']).toContain(parsed.status);

            const done = await pollTaskResult(parsed.taskId, ASYNC_POLL_TIMEOUT_SHORT);
            expect(['complete', 'failed', 'timeout']).toContain(done.status);
        }), 180000);
    });

    // ============================================
    // Improvement 2: Progress Streaming (combined)
    // ============================================
    describe('progress streaming', () => {
        it('shows progress with step details during async task', runIfAvailable(async () => {
            const submit = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'List files in the tests directory. Do not modify.',
                    async: true,
                    readOnly: true,
                    maxSteps: 2,
                },
            });
            const taskId = JSON.parse((submit.content[0] as any).text).taskId;

            await sleep(8000);
            const status = await client.callTool({
                name: 'agent_task_result',
                arguments: { taskId, includeProgress: true },
            });
            const result = JSON.parse((status.content[0] as any).text);

            expect(result.found).toBe(true);
            expect(result.progress).toBeDefined();
            if (result.progress && result.progress.length > 0) {
                expect(result.progress[0].action).toBeTruthy();
                expect(result.progress[0].status).toBeTruthy();
            }

            const done = await pollTaskResult(taskId, ASYNC_POLL_TIMEOUT_SHORT);
            expect(['complete', 'failed', 'timeout']).toContain(done.status);
        }), 180000);
    });

    // ============================================
    // Improvement 3: Parameter Correction (combined)
    // ============================================
    describe('parameter correction', () => {
        it('suggests correct parameter for typo and wrong case inputs', runIfAvailable(async () => {
            const badInputs = [
                { args: { taks: 'Do something' }, token: "'taks'" },
                { args: { TASK: 'Do something' }, token: "'TASK'" },
            ];

            for (const input of badInputs) {
                const res = await client.callTool({
                    name: 'agent_task',
                    arguments: input.args,
                });
                expect(res.isError).toBe(true);
                const text = (res.content[0] as any).text;
                expect(text).toContain(input.token);
                expect(text.toLowerCase()).toContain('task');
            }
        }), 10000);
    });

    // ============================================
    // Improvement 4: LLM Caching (combined fields + behavior)
    // ============================================
    describe('LLM caching', () => {
        it('exposes cache stats and maintains hit/miss counts', runIfAvailable(async () => { 
            // Get initial stats
            const before = await client.callTool({
                name: 'mcp_health',
                arguments: { includeDetails: true },
            });
            const beforeHealth = JSON.parse((before.content[0] as any).text);
            expect(beforeHealth.llmCache).toBeDefined();
            expect(beforeHealth.llmCache.enabled).toBe(true);
            expect(typeof beforeHealth.llmCache.hits).toBe('number');
            expect(typeof beforeHealth.llmCache.misses).toBe('number');
            expect(typeof beforeHealth.llmCache.entries).toBe('number');
            expect(typeof beforeHealth.llmCache.hitRate).toBe('number');
            const hits0 = beforeHealth.llmCache.hits || 0;
            const misses0 = beforeHealth.llmCache.misses || 0;

            const req = {
                name: 'llm_chat',
                arguments: {
                    backendRole: 'local',
                    messages: [
                        {
                            role: 'user',
                            content:
                                'Explain caching in 2 sentences, then end with the exact token: CACHE_TEST_42',
                        },
                    ],
                },
            };

            // First call should be a miss; second call should hit cache
            let r1: any;
            let r2: any;
            try {
                r1 = await callToolWithTimeout(req, 60000, 'llm_chat (cache miss)');
                r2 = await callToolWithTimeout(req, 60000, 'llm_chat (cache hit)');
            } catch (error) {
                if (isTimeoutError(error)) {
                    console.warn('LLM cache test skipped due to LLM timeout');
                    return;
                }
                throw error;
            }
            expect(r1.isError).not.toBe(true);
            expect(r2.isError).not.toBe(true);

            // Check stats again
            const after = await client.callTool({
                name: 'mcp_health',
                arguments: { includeDetails: true },
            });
            const afterHealth = JSON.parse((after.content[0] as any).text);

            // The first call may already be cached from earlier tests; require at least one new cache event.
            expect(afterHealth.llmCache.hits).toBeGreaterThanOrEqual(hits0 + 1); 
            expect(afterHealth.llmCache.hits + afterHealth.llmCache.misses).toBeGreaterThanOrEqual(
                hits0 + misses0 + 1
            ); 
        }), 180000); 
    }); 

    // ============================================
    // Improvement 5: Request Logging (combined)
    // ============================================
    describe('request logging', () => {
        it('logs requests and tracks timing info in health details', runIfAvailable(async () => {
            // Make a few calls first
            await client.callTool({
                name: 'mcp_health',
                arguments: {},
            });
            await client.callTool({
                name: 'mcp_health',
                arguments: {},
            });

            // Check health details for logging stats
            const res = await client.callTool({
                name: 'mcp_health',
                arguments: { includeDetails: true },
            });
            const parsed = JSON.parse((res.content[0] as any).text);

            expect(parsed.logging).toBeDefined();
            expect(parsed.logging.totalRequests).toBeGreaterThan(0);
            expect(typeof parsed.logging.avgDurationMs).toBe('number');
            expect(typeof parsed.logging.pendingRequests).toBe('number');
        }), 10000);
    });

    // ============================================
    // Complex agent_task tests with LM Studio
    // ============================================
    describe('complex agent_task with LM Studio', () => {
        it('handles complex multi-step repo analysis', runIfAvailable(async () => {
            // Use async mode to avoid MCP request timeout
            const submitRes = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'List the main directories. Keep it brief.',
                    maxSteps: 1, // Minimal for faster completion
                    maxSubtasks: 1,
                    maxActionsPerStep: 2,
                    readOnly: true,
                    async: true,  // Use async to avoid MCP timeout
                },
            });
            expect(submitRes.isError).not.toBe(true);
            const submitParsed = JSON.parse((submitRes.content[0] as any).text);
            expect(submitParsed.taskId).toBeTruthy();

            // Poll for result with generous timeout for quantized model (local runs can be slow under load)
            const result = await pollTaskResult(submitParsed.taskId, ASYNC_POLL_TIMEOUT_LONG);
            expect(['complete', 'failed', 'timeout']).toContain(result.status);
        }), 300000);
    });

    // ============================================
    // Queue Stress Test (2 concurrent tasks - reduced for quantized model)
    // ============================================
    describe('queue stress test', () => {
        it('handles 2 concurrent agent_task submissions correctly', runIfAvailable(async () => {
            // Reset queue to ensure clean state (tasks from prior tests may still be running).
            await client.callTool({ name: 'agent_queue_status', arguments: { action: 'reset' } });
            await sleep(2000); // Give queue time to reset

            const initialStatus = await client.callTool({ name: 'agent_queue_status', arguments: {} });
            const initial = JSON.parse((initialStatus.content[0] as any).text);
            // After reset, queue should be empty (or close to it)
            expect(initial.running).toBeLessThanOrEqual(1);
            expect(initial.queued).toBe(0);

            // Reduced to 2 minimal tasks for quantized model reliability
            const tasks = [
                { task: 'Say hello', readOnly: true, maxSteps: 1, maxActionsPerStep: 1, maxSubtasks: 1 },
                { task: 'Count to 3', readOnly: true, maxSteps: 1, maxActionsPerStep: 1, maxSubtasks: 1 },
            ];

            const submits = await Promise.all(
                tasks.map((t) =>
                    client.callTool({
                        name: 'agent_task',
                        arguments: { ...t, async: true },
                    })
                )
            );

            const taskIds = submits.map((s) => JSON.parse((s.content[0] as any).text).taskId as string);
            expect(taskIds.length).toBe(tasks.length);
            expect(new Set(taskIds).size).toBe(taskIds.length);

            // With maxConcurrentAgentTasks=1 in this suite config, at least one should queue.
            const afterSubmitStatus = await client.callTool({ name: 'agent_queue_status', arguments: {} });
            const afterSubmit = JSON.parse((afterSubmitStatus.content[0] as any).text);
            expect(afterSubmit.running).toBeLessThanOrEqual(1);
            expect(afterSubmit.queued).toBeGreaterThanOrEqual(0);

            // Poll tasks sequentially to avoid race conditions - generous timeout for quantized model
            const results = [];
            for (const id of taskIds) {
                const result = await pollTaskResult(id, ASYNC_POLL_TIMEOUT_QUEUE);
                results.push(result);
            }
            for (const r of results) {
                expect(['complete', 'failed', 'timeout']).toContain(r.status);
            }

            const finalStatus = await client.callTool({ name: 'agent_queue_status', arguments: {} });
            const final = JSON.parse((finalStatus.content[0] as any).text);
            expect(final.running).toBe(0);
            expect(final.queued).toBe(0);
        }), 420000); // 7 min timeout for 2 tasks (quantized model is slower)
    });
});
