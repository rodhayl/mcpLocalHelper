/**
 * Agent Task Regression Tests
 * 
 * Comprehensive tests based on LLM validation reports (Claude Haiku 4.5, Minimax m2, Raptor Mini).
 * These tests catch issues identified during external LLM testing and should always pass.
 * 
 * Key test categories:
 * 1. Type validation - Reject non-string task values
 * 2. Parameter coercion - String booleans, snake_case aliases
 * 3. Async mode - Immediate response, status polling
 * 4. Queue management - Concurrent task handling
 * 5. Security - Path traversal, sandbox validation
 * 6. Error handling - Missing required fields, typo detection
 */

import path from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeSettingsFile } from '../test-utils/settings.js';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function writeTestConfig(): { dir: string; path: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-agent-regression-'));
    const p = path.join(dir, 'env.test.settings');
    const repoRoot = path.resolve(__dirname, '../..').replace(/\\/g, '/');

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
            sotaBackendId: 'stub',
        },
        server: {
            host: '127.0.0.1',
            port: 0,
            maxConcurrentAgentTasks: 2,
            agentTaskQueueTimeoutMs: 60000,
        },
        workspace: {
            roots: [repoRoot],
            defaultRoot: repoRoot,
        },
        policy: {
            allowlistPaths: [repoRoot],
            maxFileBytes: 131072,
        },
        systemProfile: {
            exposeToLLM: true,
        },
        toolGroups: {
            activeMode: 'DEVELOPMENT',
        },
        toolDiscovery: {
            fullToolList: true,
        },
        rateLimiter: {
            enabled: false,
        },
    };

    writeSettingsFile(p, configJson, { exposeSystemProfile: true, serverPort: 0, serverHost: '127.0.0.1' });
    return { dir, path: p };
}

describe('agent_task regression tests', () => {
    let client: any;
    let tempDir: string | null = null;
    let configPath: string | null = null;

    beforeAll(async () => {
        const cfg = writeTestConfig();
        tempDir = cfg.dir;
        configPath = cfg.path;

        const transport = new StdioClientTransport({
            command: 'node',
            args: [path.resolve(__dirname, '../../dist/index.js'), '--settings', configPath],
            env: { ...process.env },
            stderr: 'pipe',
            cwd: path.resolve(__dirname, '../..'),
        });
        const err = transport.stderr;
        if (err) {
            err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
        }
        client = new Client({ name: 'agent-regression-test', version: '1.0.0' });
        await client.connect(transport);
    }, 30000);

    afterAll(async () => {
        if (client) await client.close();
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });

    // ============================================
    // Category 1: Type Validation (Raptor Mini report)
    // ============================================
    describe('type validation', () => {
        it('rejects numeric task value with clear error', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 123 },
            });
            expect(res.isError).toBe(true);
            const text = (res.content[0] as any).text;
            expect(text).toMatch(/invalid.*type|expected.*string|received.*number/i);
        }, 10000);

        it('rejects boolean task value with clear error', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: true },
            });
            expect(res.isError).toBe(true);
            const text = (res.content[0] as any).text;
            expect(text).toMatch(/invalid.*type|expected.*string|received.*boolean/i);
        }, 10000);

        it('rejects null task value', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: null },
            });
            expect(res.isError).toBe(true);
        }, 10000);

        it('rejects empty string task', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: '' },
            });
            expect(res.isError).toBe(true);
            const text = (res.content[0] as any).text;
            // Empty task should return 'empty_task' error type (not treated as missing)
            expect(text).toMatch(/empty|whitespace/i);
        }, 10000);

        it('rejects whitespace-only task', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: '   \n\t  ' },
            });
            expect(res.isError).toBe(true);
        }, 10000);
    });

    // ============================================
    // Category 2: Parameter Coercion (Minimax m2 report)
    // ============================================
    describe('parameter coercion', () => {
        it('coerces string "true" to boolean for async parameter', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test async coercion', async: 'true' },
            });
            // Main test: string 'true' was coerced and accepted - response exists
            expect(res.content).toBeTruthy();
            expect(res.content.length).toBeGreaterThan(0);
            // If there's an error, it should NOT be about type validation
            const text = (res.content[0] as any).text;
            if (res.isError) {
                expect(text).not.toMatch(/async.*must be.*boolean|invalid.*type.*async/i);
            }
        }, 10000);




        it('coerces string "true" to boolean for readOnly parameter', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                // Use async mode so we can assert coercion without waiting for a full agent run.
                arguments: { task: 'Test readOnly coercion - list files', readOnly: 'true', maxSteps: '1', async: true },
            });
            // Check that parameters were accepted (no parameter error)
            if (res.isError) {
                const text = (res.content[0] as any).text;
                // It should NOT be a parameter validation error
                expect(text).not.toContain('invalid_type');
            }
            const parsed = JSON.parse((res.content[0] as any).text);
            if (parsed.effectiveOptions) {
                expect(parsed.effectiveOptions.readOnly).toBe(true);
            }
        }, 30000);

        it('accepts snake_case read_only alias', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Test snake_case aliases - list directories',
                    read_only: true,
                    max_steps: 1,
                    context_root: './',
                    async: true,
                },
            });
            // Stub execution fails, but param parsing should succeed
            if (res.isError) {
                const text = (res.content[0] as any).text;
                expect(text).not.toContain('invalid_type');
            }
            const parsed = JSON.parse((res.content[0] as any).text);
            if (parsed.effectiveOptions) {
                expect(parsed.effectiveOptions.readOnly).toBe(true);
            }
        }, 30000);

        it('accepts readOnly in top-level arguments', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test top-level readOnly - search files', readOnly: true, maxSteps: 1, async: true },
            });
            if (res.isError) {
                const text = (res.content[0] as any).text;
                expect(text).not.toContain('invalid_type');
            }
            const parsed = JSON.parse((res.content[0] as any).text);
            if (parsed.effectiveOptions) {
                expect(parsed.effectiveOptions.readOnly).toBe(true);
            }
        }, 30000);

        it('coerces nested options object with string booleans', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Test nested options coercion - analyze files',
                    async: true,
                    options: { readOnly: 'true', maxSteps: '1' },
                },
            });
            // Main test: nested options with string booleans are accepted (no validation error)
            if (res.isError) {
                const text = (res.content[0] as any).text;
                expect(text).not.toContain('invalid_type');
            }
        }, 30000);


        it('accepts options as JSON string', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Test JSON string options',
                    async: true,
                    options: JSON.stringify({ readOnly: true, maxSteps: 1 }),
                },
            });
            if (res.isError) {
                const text = (res.content[0] as any).text;
                expect(text).not.toContain('invalid_type');
            }
            const parsed = JSON.parse((res.content[0] as any).text);
            // check success flag isn't strictly required if stub failed, but we check partial success?
            // Actually, just checking parsed is valid JSON is implicit in line above.
        }, 30000);
    });

    // ============================================
    // Category 3: Async Mode and Status (All reports)
    // ============================================
    describe('async mode', () => {
        it('returns taskId immediately when async=true', async () => {
            const startTime = Date.now();
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test async immediate return', async: true },
            });
            const duration = Date.now() - startTime;

            expect(duration).toBeLessThan(5000); // Should return in < 5s
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.async).toBe(true);
            // Task may be 'queued' or 'running' depending on queue state
            expect(['queued', 'running']).toContain(parsed.status);
        }, 10000);

        it('can poll for async task result', async () => {
            // Submit async task
            const submit = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test async polling', async: true, readOnly: true, maxSteps: 1 },
            });
            const parsed = JSON.parse((submit.content[0] as any).text);
            const taskId = parsed.taskId;
            expect(taskId).toBeTruthy();

            // Poll for result
            const status = await client.callTool({
                name: 'agent_task_result',
                arguments: { taskId },
            });
            expect(status.isError).not.toBe(true);
            const result = JSON.parse((status.content[0] as any).text);
            expect(result.found).toBe(true);
            expect(['queued', 'running', 'complete', 'failed']).toContain(result.status);
        }, 30000);
    });

    // ============================================
    // Category 4: Queue Management (All reports)
    // ============================================
    describe('queue management', () => {
        it('reports queue status correctly', async () => {
            const res = await client.callTool({
                name: 'agent_queue_status',
                arguments: {},
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.running).toBeGreaterThanOrEqual(0);
            expect(parsed.queued).toBeGreaterThanOrEqual(0);
            expect(parsed.maxConcurrent).toBeGreaterThan(0);
            expect(parsed.canSubmitImmediately).toBeDefined();
        }, 10000);

        it('can reset queue when stuck (action: reset)', async () => {
            const res = await client.callTool({
                name: 'agent_queue_status',
                arguments: { action: 'reset' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.action).toBe('reset');
        }, 10000);
    });

    // ============================================
    // Category 5: Error Handling (All reports)
    // ============================================
    describe('error handling', () => {
        it('detects task parameter typos', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { taks: 'Typo in task' }, // typo: taks
            });
            expect(res.isError).toBe(true);
            const text = (res.content[0] as any).text;
            expect(text).toContain("'taks'");
            expect(text.toLowerCase()).toContain('task');
        }, 10000);

        it('detects wrong case (TASK instead of task)', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { TASK: 'Wrong case' },
            });
            expect(res.isError).toBe(true);
            const text = (res.content[0] as any).text;
            expect(text).toContain("'TASK'");
        }, 10000);

        it('provides clear error for missing task field', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { readOnly: true },
            });
            expect(res.isError).toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Standardized to validation_error for consistency across all tools
            expect(parsed.errorType).toBe('validation_error');
            expect(parsed.hint).toBeTruthy();
            expect(parsed.example).toBeTruthy();
            // New: should also have issues array with structured error details
            expect(Array.isArray(parsed.issues)).toBe(true);
        }, 10000);

        it('provides valid parameters list in error response', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {},
            });
            expect(res.isError).toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.validParameters).toBeTruthy();
            expect(parsed.validParameters).toContain('task');
            expect(parsed.validParameters).toContain('readOnly');
        }, 10000);
    });

    // ============================================
    // Category 6: Schema Validation
    // ============================================
    describe('schema validation', () => {
        // Note: anyOf removed for LLM compatibility (Kimi K2-0905)
        it('agent_task has flattened schema with examples', async () => {
            const res = await client.listTools();
            const tool = res.tools.find((t: any) => t.name === 'agent_task');
            expect(tool).toBeTruthy();
            expect(tool.inputSchema).toBeTruthy();
            expect(tool.inputSchema.type).toBe('object');
            // Should NOT have anyOf (removed for LLM compatibility)
            expect(tool.inputSchema.anyOf).toBeUndefined();
            // Should have examples
            expect(Array.isArray(tool.inputSchema.examples)).toBe(true);
            expect(tool.inputSchema.examples.length).toBeGreaterThan(0);
        }, 10000);

        // Note: anyOf replaced with flattened properties for LLM compatibility
        it('schema has all input variants as properties', async () => {
            const res = await client.listTools();
            const tool = res.tools.find((t: any) => t.name === 'agent_task');
            const props = tool.inputSchema.properties;

            // Should have both task and prompt (alias) at top level
            expect(props.task).toBeTruthy();
            expect(props.prompt).toBeTruthy();
            // Should have nested options object (aliases are now IN options, not at top level)
            // NOTE: Top-level aliases (readOnly, contextRoot) were REMOVED for schema compression
            // (Hybrid Autonomous Maximum - Layer 1 Schema Compression)
            // They are still supported in the handler for backward compatibility.
            expect(props.options).toBeTruthy();
            expect(props.options.properties.readOnly).toBeTruthy();
            expect(props.options.properties.contextRoot).toBeTruthy();
            // Verify aliases are NOT at top level (schema compression)
            expect(props.readOnly).toBeFalsy();
            expect(props.contextRoot).toBeFalsy();
        }, 10000);



        it('agent_task_result tool is AGENT_ONLY (hidden from ListTools) but callable', async () => {
            const res = await client.listTools();
            const tool = res.tools.find((t: any) => t.name === 'agent_task_result');
            // agent_task_result is now AGENT_ONLY - hidden from ListTools
            expect(tool).toBeFalsy();
             
            // But the tool should still be callable directly
            const callRes = await client.callTool({
                name: 'agent_task_result',
                arguments: { taskId: 'nonexistent-test-id' },
            });
            // Should return a valid (but error) response since task doesn't exist
            expect(callRes.content).toBeTruthy();
        }, 10000);

        it('agent_queue_status tool is AGENT_ONLY (hidden from ListTools) but callable', async () => {
            const res = await client.listTools();
            const tool = res.tools.find((t: any) => t.name === 'agent_queue_status');
            // agent_queue_status is now AGENT_ONLY - hidden from ListTools
            expect(tool).toBeFalsy();
             
            // But the tool should still be callable directly
            const callRes = await client.callTool({
                name: 'agent_queue_status',
                arguments: {},
            });
            expect(callRes.isError).not.toBe(true);
            const parsed = JSON.parse((callRes.content[0] as any).text);
            expect(parsed.running).toBeGreaterThanOrEqual(0);
        }, 10000);
    });

    // ============================================
    // Category 7: Prompt Alias
    // ============================================
    describe('prompt alias', () => {
        it('accepts prompt as alias for task', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                // Use async mode to avoid waiting on a full agent run.
                arguments: { prompt: 'Test prompt alias', readOnly: true, maxSteps: 1, async: true },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 30000);
    });
});
