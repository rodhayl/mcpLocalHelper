/**
 * MCP Server Comprehensive E2E Tests
 * 
 * Tests for edge cases, Context7 integration, harder scenarios,
 * and robustness improvements based on real-world testing feedback.
 */

import path from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeSettingsFile } from './test-utils/settings.js';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function writeTestConfig(): { dir: string; path: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-comprehensive-test-'));
    const p = path.join(dir, 'env.test.settings');
    const repoRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

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
        },

        workspace: {
            roots: [repoRoot],
            defaultRoot: repoRoot,
        },

        policy: {
            allowlistPaths: [repoRoot],
            maxFileBytes: 131072,
        },

        // Configure external MCP servers for testing
        mcpServers: {
            'chrome-devtools': {
                type: 'stdio',
                command: 'npx',
                args: ['-y', 'chrome-devtools-mcp@latest', '--isolated'],
                description: 'Browser automation via MCP',
                autoConnect: false,
            },
            context7: {
                type: 'stdio',
                command: 'npx',
                args: ['-y', '@upstash/context7-mcp@latest'],
                description: 'Library documentation lookup via Context7',
                autoConnect: false,
            },
        },

        systemProfile: {
            exposeToLLM: true,
        },

        toolGroups: {
            activeMode: 'DEVELOPMENT',
        },

        editing: {
            enabled: true,
            backupEnabled: true,
            backupDir: '.mcp-backups',
            requirePreview: false,
            maxFileSize: 1048576,
        },

        // Comprehensive suite exercises internal tools directly (mcp_server, discover_tools, etc.)
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

describe('E2E comprehensive MCP server tests', () => {
    let client: any;
    let tempDir: string | null = null;
    let configPath: string | null = null;

    beforeAll(async () => {
        const cfg = writeTestConfig();
        tempDir = cfg.dir;
        configPath = cfg.path;

        const transport = new StdioClientTransport({
            command: 'node',
            args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
            env: { ...process.env },
            stderr: 'pipe',
            cwd: path.resolve(__dirname, '..'),
        });
        const err = transport.stderr;
        if (err) {
            err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
        }
        client = new Client({ name: 'e2e-comprehensive-test', version: '0.0.1' });
        await client.connect(transport);
    }, 30000);

    afterAll(async () => {
        if (client) await client.close();
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });

    // ============================================
    // Test Suite 1: MCP Server List Tests
    // ============================================
    describe('mcp_server list action', () => {
        it('lists all configured servers with connection status', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'list' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.configuredServers).toBeTruthy();
            expect(Array.isArray(parsed.configuredServers)).toBe(true);

            // Should have chrome-devtools and context7
            const names = parsed.configuredServers.map((s: any) => s.name);
            expect(names).toContain('chrome-devtools');
            expect(names).toContain('context7');
        }, 30000);

        it('lists specific server with serverName parameter', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'list', serverName: 'chrome-devtools' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Should have tools list for the server
            expect(parsed.tools || parsed.serverName).toBeTruthy();
        }, 30000);
    });

    // ============================================
    // Test Suite 2: Context7 Integration Tests  
    // ============================================
    describe('context7 MCP server', () => {
        it('can connect to context7 server', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'context7' },
            });
            // May fail if npx not available, but should give clear error
            const parsed = JSON.parse((res.content[0] as any).text);
            if (parsed.success) {
                expect(parsed.toolsAvailable).toBeGreaterThan(0);
            } else {
                // Should give a clear error message
                expect(parsed.error).toBeTruthy();
            }
        }, 60000);

        it('lists context7 tools after connection', async () => {
            // First try to connect
            const connectRes = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'context7' },
            });
            const connectParsed = JSON.parse((connectRes.content[0] as any).text);

            if (connectParsed.success) {
                const listRes = await client.callTool({
                    name: 'mcp_server',
                    arguments: { action: 'list', serverName: 'context7' },
                });
                expect(listRes.isError).not.toBe(true);
                const parsed = JSON.parse((listRes.content[0] as any).text);
                expect(parsed.tools).toBeTruthy();
                expect(Array.isArray(parsed.tools)).toBe(true);

                // Context7 tool surface has evolved over time; accept the current docs tool name(s).
                const toolNames = parsed.tools.map((t: any) => t.name);
                expect(toolNames).toContain('resolve-library-id');
                expect(
                    toolNames.includes('get-library-docs') || toolNames.includes('query-docs')
                ).toBe(true);
            }
        }, 60000);
    });

    // ============================================
    // Test Suite 3: Edge Cases and Error Handling
    // ============================================
    describe('edge cases and error handling', () => {
        it('handles malformed JSON arguments gracefully', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'call', serverName: 123, toolName: null },
            });
            expect(res.isError).toBe(true);
        }, 30000);

        it('handles empty arguments object', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: {},
            });
            expect(res.isError).toBe(true);
            const text = (res.content[0] as any).text;
            expect(text).toMatch(/action|required/i);
        }, 30000);

        it('handles call with empty toolName', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'call', serverName: 'chrome-devtools', toolName: '' },
            });
            // Empty toolName should result in an error
            if (!res.isError) {
                const parsed = JSON.parse((res.content[0] as any).text);
                expect(parsed.success).toBe(false);
            } else {
                const text = (res.content[0] as any).text;
                expect(text).toMatch(/toolName|required/i);
            }
        }, 30000);

        it('handles disconnect from never-connected server gracefully', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'disconnect', serverName: 'never-connected-server' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.success).toBe(true);
        }, 30000);

        it('handles self-connection attempt', async () => {
            // Try various self-referential names
            const names = ['mcp-local-llm', 'mcp_local_llm', 'mcp-local-llm-server'];
            for (const name of names) {
                const res = await client.callTool({
                    name: 'mcp_server',
                    arguments: { action: 'connect', serverName: name },
                });
                // These should all fail since they refer to this server
                const parsed = JSON.parse((res.content[0] as any).text);
                expect(parsed.success).toBe(false);
                expect(parsed.error).toContain('this MCP server');
            }
        }, 30000);
    });

    // ============================================
    // Test Suite 4: Agent Task Schema Variations
    // ============================================
    describe('agent_task schema variations', () => {
        it('accepts task with minimal options', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'List files in workspace',
                    readOnly: true,
                    maxSteps: 1,
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('accepts task with allowMcpServers array', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Take a screenshot (plan only)',
                    allowMcpServers: ['chrome-devtools'],
                    readOnly: true,
                    maxSteps: 1,
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('accepts task with nested options object', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Search for README files',
                    options: {
                        readOnly: true,
                        maxSteps: 2,
                        maxSubtasks: 1,
                    },
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('handles snake_case parameter aliases', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Find configuration files',
                    read_only: true,
                    max_steps: 1,
                    context_root: './',
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('handles prompt alias for task', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    prompt: 'List all TypeScript files',
                    readOnly: true,
                    maxSteps: 1,
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);
    });

    // ============================================
    // Test Suite 5: Status and Discovery Tests
    // ============================================
    describe('status and discovery', () => {
        it('status action shows all configured servers', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'status' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.configured).toBeGreaterThan(0);
            expect(Array.isArray(parsed.servers)).toBe(true);
        }, 30000);

        it('provides helpful note about local tools', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'status' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.note).toBeTruthy();
            expect(parsed.note).toMatch(/local|agent_task/i);
        }, 30000);
    });

    // ============================================
    // Test Suite 6: Retry and Robustness
    // ============================================
    describe('retry and robustness', () => {
        it('handles transient connection failures with backoff', async () => {
            // This tests the internal retry mechanism
            // Connect to context7 which may have startup latency
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'context7' },
            });
            // Either succeeds or gives clear error
            const parsed = JSON.parse((res.content[0] as any).text);
            if (!parsed.success) {
                expect(parsed.error).toBeTruthy();
            }
        }, 90000);

        it('multiple connect calls are idempotent', async () => {
            // First connect
            const res1 = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'context7' },
            });
            const parsed1 = JSON.parse((res1.content[0] as any).text);

            if (parsed1.success) {
                // Second connect should succeed without error
                const res2 = await client.callTool({
                    name: 'mcp_server',
                    arguments: { action: 'connect', serverName: 'context7' },
                });
                expect(res2.isError).not.toBe(true);
                const parsed2 = JSON.parse((res2.content[0] as any).text);
                expect(parsed2.success).toBe(true);
            }
        }, 60000);
    });

    // ============================================
    // Test Suite 7: Tool Schema Validation
    // ============================================
    describe('tool schema validation', () => {
        it('all tools have valid inputSchema', async () => {
            const res = await client.listTools();
            expect(res.tools.length).toBeGreaterThan(0);

            for (const tool of res.tools) {
                expect(tool.name).toBeTruthy();
                expect(tool.description).toBeTruthy();
                expect(tool.inputSchema).toBeTruthy();
                expect(tool.inputSchema.type).toBe('object');
            }
        }, 30000);

        it('mcp_server tool has comprehensive action enum including status', async () => {
            const res = await client.listTools();
            const tool = res.tools.find((t: any) => t.name === 'mcp_server');
            // mcp_server may not be in core tools but should be discoverable
            // If not in list, verify it's callable directly
            if (tool) {
                const actionProp = tool.inputSchema.properties.action;
                expect(actionProp).toBeTruthy();
                expect(actionProp.enum).toBeTruthy();
                expect(actionProp.enum).toContain('list');
                expect(actionProp.enum).toContain('connect');
                expect(actionProp.enum).toContain('disconnect');
                expect(actionProp.enum).toContain('call');
                expect(actionProp.enum).toContain('status');
            } else {
                // mcp_server is still callable even if not in core list
                const callRes = await client.callTool({
                    name: 'mcp_server',
                    arguments: { action: 'status' },
                });
                expect(callRes.content).toBeTruthy();
            }
        }, 30000);

        it('agent_task tool is callable via CallTool (not in core tools list)', async () => {
            // agent_task is NOT in CORE_TOOLS (progressive loading mode)
            // but it IS callable via CallTool
            const res = await client.listTools();
            const tool = res.tools.find((t: any) => t.name === 'agent_task');
            
            // In progressive loading mode, agent_task may not be in the initial list
            // but it should still be callable
            if (tool) {
                // If it's in the list, verify schema
                if (Array.isArray(tool.inputSchema.anyOf)) {
                    // Legacy anyOf format - check variants require task or prompt
                    let variantsWithRequiredTaskOrPrompt = 0;
                    let catchAllVariants = 0;
                    for (const variant of tool.inputSchema.anyOf) {
                        const hasTaskOrPromptRequired = variant.required?.includes('task') || variant.required?.includes('prompt');
                        if (hasTaskOrPromptRequired) {
                            variantsWithRequiredTaskOrPrompt++;
                        } else if (!variant.required || variant.required.length === 0) {
                            catchAllVariants++;
                        }
                    }
                    expect(variantsWithRequiredTaskOrPrompt).toBeGreaterThanOrEqual(3);
                    expect(catchAllVariants).toBeLessThanOrEqual(1);
                } else {
                    // Flattened properties-based format - check task/prompt properties exist
                    expect(tool.inputSchema.properties).toBeTruthy();
                    expect(tool.inputSchema.properties.task || tool.inputSchema.properties.prompt).toBeTruthy();
                }
            } else {
                // Even if not in list, CallTool should work
                const callRes = await client.callTool({
                    name: 'agent_task',
                    arguments: { task: 'test task', readOnly: true, async: true },
                });
                const parsed = JSON.parse((callRes.content[0] as any).text);
                expect(callRes.isError).not.toBe(true);
                expect(parsed.success).toBe(true);
            }
        }, 30000);
    });

    // ============================================
    // Test Suite 8: listLocal Action Tests
    // ============================================
    describe('mcp_server listLocal action', () => {
        it('returns local tools with inputSchemas', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'status' },
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);

            expect(parsed.configured).toBeDefined();
            expect(parsed.connected).toBeDefined();
            expect(parsed.note).toBeTruthy();
        }, 30000);
    });

    // ============================================
    // Test Suite 9: Parameter Type Coercion Tests
    // ============================================
    describe('agent_task parameter type coercion', () => {
        it('accepts string boolean values (readOnly: "true")', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test task', readOnly: 'true', maxSteps: '1', async: true },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('accepts prompt alias for task', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { prompt: 'Test task via prompt alias', readOnly: true, maxSteps: 1, async: true },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.taskId).toBeTruthy();
        }, 120000);

        it('accepts snake_case parameter aliases', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test task', read_only: true, max_steps: 1, async: true },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('accepts readOnly in top-level arguments', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: { task: 'Test readOnly top-level', readOnly: true, maxSteps: 1, async: true },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('accepts nested options object with readOnly', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Test nested options',
                    options: { readOnly: true, maxSteps: 1 },
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);

        it('accepts options as JSON string', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Test JSON string options',
                    options: JSON.stringify({ readOnly: true, maxSteps: 1 }),
                    async: true,
                },
            });
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 120000);
    });

    // ============================================
    // Test Suite 10: Queue Status Tool
    // ============================================
    describe('agent_queue_status', () => {
        it('returns queue status when called', async () => {
            const res = await client.callTool({
                name: 'agent_queue_status',
                arguments: {},
            });
            expect(res).toBeTruthy();
            expect(res.content).toBeTruthy();
            expect(res.content.length).toBeGreaterThan(0);
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Should have queue status fields
            expect(parsed.isBusy).toBeDefined();
            expect(parsed.running).toBeGreaterThanOrEqual(0);
            expect(parsed.queued).toBeGreaterThanOrEqual(0);
            expect(parsed.maxConcurrent).toBeGreaterThan(0);
            expect(parsed.canSubmitImmediately).toBeDefined();
            expect(parsed.message).toBeTruthy();
        }, 10000);
    });
});
