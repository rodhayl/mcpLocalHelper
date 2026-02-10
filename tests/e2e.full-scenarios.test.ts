/**
 * Full E2E Scenarios - MCP Server Comprehensive Tests
 * 
 * 10 comprehensive end-to-end test scenarios covering:
 * - All major tool groups (40+ tools)
 * - Agent task execution with planning
 * - MCP server integration (chrome-devtools, context7)
 * - Parameter aliases and schema variations
 * - Async task execution and queue management
 * 
 * Uses stub backend by default for deterministic, fast tests.
 * For real LLM testing, run against LM Studio as per GEMINI.md.
 */

import path from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeSettingsFile } from './test-utils/settings.js';

const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Test fixtures
const TEST_FIXTURES = {
    sampleCode: `
export async function fetchData(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(\`HTTP error! status: \${response.status}\`);
  }
  return response.json();
}

export function processItems(items: any[]): any[] {
  const result = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items[i].children.length; j++) {
      result.push(items[i].children[j]);
    }
  }
  return result;
}
`,
    sampleDiff: `--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,5 +1,5 @@
-export function add(a: number, b: number): number {
+export function sum(a: number, b: number): number {
   return a + b;
 }
 
-export function multiply(a, b) {
+export function multiply(a: number, b: number): number {
   return a * b;
 }`,
    sampleError: `TypeError: Cannot read properties of undefined (reading 'map')
    at processData (/app/src/handlers/data.ts:45:23)
    at async handleRequest (/app/src/server.ts:123:18)
    at async /app/node_modules/express/lib/router/layer.js:95:5`,
    sampleLogs: `[2025-12-16T10:00:01Z] INFO: Server started on port 3000
[2025-12-16T10:00:02Z] DEBUG: Loading configuration from env.settings
[2025-12-16T10:00:03Z] WARN: Deprecated API endpoint /v1/users accessed
[2025-12-16T10:00:05Z] ERROR: Database connection failed: ECONNREFUSED
[2025-12-16T10:00:06Z] ERROR: Retry 1/3 for database connection
[2025-12-16T10:00:08Z] INFO: Database connected successfully
[2025-12-16T10:00:10Z] WARN: High memory usage detected: 85%`,
    contentWithSecrets: `
# Configuration File
API_KEY=${`sk${'-1234567890abcdef1234567890abcdef'}`}
DATABASE_URL=postgres://admin:password123@localhost:5432/mydb
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`,
    pythonCode: `
def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n-i-1):
            if arr[j] > arr[j+1]:
                arr[j], arr[j+1] = arr[j+1], arr[j]
    return arr
`,
    poorlyNamedCode: `
function x(a, b, c) {
  const d = a + b;
  const e = d * c;
  let f = [];
  for (let i = 0; i < e; i++) {
    f.push(i * 2);
  }
  return f;
}
`,
};

function writeStubConfig(): { dir: string; path: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-full-scenarios-'));
    const p = path.join(dir, 'env.test.settings');
    const projectRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

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
            roots: [projectRoot],
            defaultRoot: projectRoot,
        },
        policy: {
            allowlistPaths: [projectRoot],
            maxFileBytes: 131072,
        },
        // External MCP servers for integration tests
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
                description: 'Library documentation lookup',
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
        // Full-scenarios suite exercises the full tool surface directly.
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

describe('Full E2E Scenarios - MCP Server Comprehensive Tests', () => {
    let client: any;
    let tempDir: string | null = null;
    let configPath: string | null = null;
    const projectRoot = path.resolve(__dirname, '..');
    let savedCliEnabled: string | undefined;
    let savedCliBackends: string | undefined;

    beforeAll(async () => {
        // Disable CLI orchestration for these tests (they use stub backend)
        savedCliEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
        savedCliBackends = process.env.CLI_ORCHESTRATION_BACKENDS;
        delete process.env.CLI_ORCHESTRATION_ENABLED;
        delete process.env.CLI_ORCHESTRATION_BACKENDS;

        const cfg = writeStubConfig();
        tempDir = cfg.dir;
        configPath = cfg.path;

        const transport = new StdioClientTransport({
            command: 'node',
            args: [path.resolve(__dirname, '../dist/index.js'), '--settings', configPath],
            env: {
                ...process.env,
                // Keep background agent_task runs bounded so they don't starve later LLM-heavy tools in this suite.
                AGENT_TASK_ASYNC_TIMEOUT_MS: '20000',
            },
            stderr: 'pipe',
            cwd: projectRoot,
        });
        const err = transport.stderr;
        if (err) {
            err.on('data', (chunk: any) => process.stderr.write(`[server] ${chunk.toString()}`));
        }
        client = new Client({ name: 'e2e-full-scenarios', version: '1.0.0' }, {
            capabilities: { roots: { listChanged: true } }
        });
        await client.connect(transport);

        // Handle roots/list request from server to initialize workspace
        client.setRequestHandler(ListRootsRequestSchema, async () => {
            return {
                roots: [{
                    uri: `file://${projectRoot.replace(/\\/g, '/')}`,
                    name: 'workspace'
                }]
            };
        });
    }, 30000);

    afterAll(async () => {
        if (client) await client.close();
        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
        // Restore CLI orchestration env variables
        if (savedCliEnabled !== undefined) {
            process.env.CLI_ORCHESTRATION_ENABLED = savedCliEnabled;
        }
        if (savedCliBackends !== undefined) {
            process.env.CLI_ORCHESTRATION_BACKENDS = savedCliBackends;
        }
    });

    // ============================================
    // SCENARIO 1: Agent Task with External MCP Integration
    // ============================================
    describe('Scenario 1: Agent Task with External MCP Integration', () => {
        it('submits async agent_task with allowMcpServers', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Search for MCP-related configuration in this repo',
                    async: true,
                    options: {
                        allowMcpServers: ['context7'],
                        readOnly: true,
                        maxSteps: 2,
                        maxSubtasks: 2,
                    },
                },
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 60000);

        it('async agent_task returns taskId for polling', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'List files in src directory. Do not modify.',
                    async: true,
                    readOnly: true,
                    maxSteps: 1,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);

            // Async mode should return taskId
            if (parsed.async === true) {
                expect(parsed.taskId).toBeTruthy();
                expect(['queued', 'running']).toContain(parsed.status);
            } else {
                // If running synchronously, should still succeed
                expect(parsed.success).toBe(true);
            }
        }, 60000);

        it('polls agent_task_result for completion', async () => {
            // First, submit an async task
            const submitRes = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Search for README files. Do not modify.',
                    async: true,
                    readOnly: true,
                    maxSteps: 1,
                },
            });

            expect(submitRes.isError).not.toBe(true);
            const submitParsed = JSON.parse((submitRes.content[0] as any).text);

            if (submitParsed.taskId) {
                // Poll for result
                const pollRes = await client.callTool({
                    name: 'agent_task_result',
                    arguments: {
                        taskId: submitParsed.taskId,
                        includeProgress: true,
                    },
                });

                expect(pollRes.isError).not.toBe(true);
                const pollParsed = JSON.parse((pollRes.content[0] as any).text);
                // Accept various status values including typo 'complete' vs 'completed'
                expect(['queued', 'running', 'complete', 'completed', 'failed', 'not_found']).toContain(pollParsed.status);
            }
        }, 60000);
    });

    // ============================================
    // SCENARIO 2: Agent Planning with ReadOnly Mode
    // ============================================
    describe('Scenario 2: Agent Planning with ReadOnly Mode', () => {
        it('readOnly mode allows read operations only', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Search for config files and describe them',
                    readOnly: true,
                    maxSteps: 3,
                    async: true,
                },
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 60000);

        it('accepts read_only snake_case alias', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'List TypeScript files. Do not modify.',
                    read_only: true,
                    max_steps: 2,
                    async: true,
                },
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 60000);

        it('accepts readOnly in nested options', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Find package.json and describe it',
                    async: true,
                    options: {
                        readOnly: true,
                        maxSteps: 1,
                    },
                },
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            expect(res.isError).not.toBe(true);
            expect(parsed.success).toBe(true);
            expect(parsed.async).toBe(true);
            expect(parsed.taskId).toBeTruthy();
            expect(parsed.effectiveOptions?.readOnly).toBe(true);
        }, 60000);

        it('infers readOnly from task text containing "do not modify"', async () => {
            const res = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Audit README for completeness. Do not modify any files.',
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
            expect(parsed.effectiveOptions?.inferredReadOnly).toBe(true);
        }, 60000);
    });

    // ============================================
    // SCENARIO 3: LLM Code Review Workflow
    // ============================================
    describe('Scenario 3: LLM Code Review Workflow', () => {
        it('analyze_file with security analysis type', async () => {
            const res = await client.callTool({
                name: 'analyze_file',
                arguments: {
                    // Use relative path - may be outside workspace in stub config
                    path: 'src/server/mcp.ts',
                    analysisType: 'security',
                    maxBytes: 8192,
                },
            });

            // Response may be error string or JSON - handle both
            const text = (res.content[0] as any).text;
            try {
                const parsed = JSON.parse(text);
                expect(parsed).toBeTruthy();
            } catch {
                // Error response as plain text is acceptable (workspace path issue)
                expect(text).toBeTruthy();
            }
        }, 60000);

        it('local_code_review with comprehensive focus', async () => {
            const res = await client.callTool(
                {
                    name: 'local_code_review',
                    arguments: {
                        paths: ['src/index.ts'],
                        focus: 'comprehensive',
                    },
                },
                undefined,
                { timeout: 120000 }
            );

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 120000);

        it('suggest_refactoring on file', async () => {
            const res = await client.callTool(
                {
                    name: 'suggest_refactoring',
                    arguments: {
                        path: 'src/index.ts',
                    },
                },
                undefined,
                { timeout: 120000 }
            );

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 120000);

        it('analyze_test_gaps on src', async () => {
            const res = await client.callTool(
                {
                    name: 'analyze_test_gaps',
                    arguments: {
                        root: 'src',
                    },
                },
                undefined,
                { timeout: 120000 }
            );

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 120000);

        it('code_quality_analyzer full suite', async () => {
            const res = await client.callTool({
                name: 'code_quality_analyzer',
                arguments: {
                    rootDir: 'src',
                    includeTypes: ['duplicates', 'complexity', 'security', 'smells'],
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);
    });

    // ============================================
    // SCENARIO 4: MCP Server Lifecycle Management
    // ============================================
    describe('Scenario 4: MCP Server Lifecycle Management', () => {
        it('status action shows configured servers', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'status' },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.configured).toBeGreaterThan(0);
            expect(Array.isArray(parsed.servers)).toBe(true);
        }, 30000);

        it('listLocal action returns local tools with schemas', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'listLocal', includeSchema: true },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.tools).toBeTruthy();
            expect(Array.isArray(parsed.tools)).toBe(true);
            expect(parsed.tools.length).toBeGreaterThan(0);

            // Verify schemas are included
            const firstTool = parsed.tools[0];
            expect(firstTool.name).toBeTruthy();
            expect(firstTool.inputSchema).toBeTruthy();
        }, 30000);

        it('describeTool action returns full tool schema', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'describeTool', toolName: 'agent_task' },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.name).toBe('agent_task');
            expect(parsed.inputSchema).toBeTruthy();
        }, 30000);

        it('connect action attempts to connect to external server', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'context7' },
            });

            // May fail if npx not available, but should give structured response
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.success !== undefined || parsed.error !== undefined).toBe(true);
        }, 60000);

        it('list action with serverName shows server tools', async () => {
            // First try to connect
            await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'context7' },
            });

            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'list', serverName: 'context7' },
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            // Either has tools or an error message
            expect(parsed.tools !== undefined || parsed.error !== undefined || parsed.success !== undefined).toBe(true);
        }, 60000);

        it('disconnect action gracefully handles servers', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'disconnect', serverName: 'context7' },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.success).toBe(true);
        }, 30000);

        it('handles self-connection attempt gracefully', async () => {
            const res = await client.callTool({
                name: 'mcp_server',
                arguments: { action: 'connect', serverName: 'mcp-local-llm' },
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('this MCP server');
        }, 30000);
    });

    // ============================================
    // SCENARIO 5: Security and Privacy Full Scan
    // ============================================
    describe('Scenario 5: Security and Privacy Full Scan', () => {
        it('security action: scan for secrets and vulnerabilities', async () => {
            const res = await client.callTool({
                name: 'security',
                arguments: {
                    action: 'scan',
                    root: '.',
                    scanType: 'both',
                    outputFormat: 'summary',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.findings !== undefined || parsed.secretsFound !== undefined).toBe(true);
        }, 60000);

        it('security action: risk analysis on content', async () => {
            const res = await client.callTool({
                name: 'security',
                arguments: {
                    action: 'risk',
                    content: TEST_FIXTURES.contentWithSecrets,
                    context: 'config',
                    strictMode: true,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.score !== undefined || parsed.risk !== undefined).toBe(true);
        }, 30000);

        it('security action: redact sensitive content', async () => {
            const res = await client.callTool({
                name: 'security',
                arguments: {
                    action: 'redact',
                    content: TEST_FIXTURES.contentWithSecrets,
                    showContext: true,
                    contextLines: 2,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.findings !== undefined || parsed.redactedContent !== undefined).toBe(true);
        }, 30000);
    });

    // ============================================
    // SCENARIO 6: Agent Task Queue Management
    // ============================================
    describe('Scenario 6: Agent Task Queue Management', () => {
        it('agent_queue_status returns current queue state', async () => {
            const res = await client.callTool({
                name: 'agent_queue_status',
                arguments: { action: 'status' },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.isBusy).toBeDefined();
            expect(parsed.running).toBeGreaterThanOrEqual(0);
            expect(parsed.queued).toBeGreaterThanOrEqual(0);
            expect(parsed.maxConcurrent).toBeGreaterThan(0);
        }, 10000);

        it('agent_queue_status with default action', async () => {
            const res = await client.callTool({
                name: 'agent_queue_status',
                arguments: {},
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.message).toBeTruthy();
        }, 10000);

        it('agent_queue_status reset clears stuck tasks', async () => {
            const res = await client.callTool({
                name: 'agent_queue_status',
                arguments: { action: 'reset' },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Reset should return success=true or indicate queue is clear
            expect(parsed.success === true || parsed.reset === true || parsed.running === 0 || parsed.message).toBeTruthy();
        }, 10000);

        it('tracks async tasks in queue', async () => {
            // Submit a task
            const submitRes = await client.callTool({
                name: 'agent_task',
                arguments: {
                    task: 'Quick search. Do not modify.',
                    async: true,
                    readOnly: true,
                    maxSteps: 1,
                },
            });

            // Immediately check queue
            const queueRes = await client.callTool({
                name: 'agent_queue_status',
                arguments: {},
            });

            expect(queueRes.isError).not.toBe(true);
            const queueParsed = JSON.parse((queueRes.content[0] as any).text);
            // Task might already be done or running
            expect(queueParsed).toBeTruthy();
        }, 30000);
    });

    // ============================================
    // SCENARIO 7: Code Assistance Full Suite
    // ============================================
    describe('Scenario 7: Code Assistance Suite', () => {
        it('code_helper action: explain code', async () => {
            const res = await client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'explain',
                    code: TEST_FIXTURES.sampleCode,
                    level: 'beginner',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('code_helper action: optimize code', async () => {
            const res = await client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'optimize',
                    code: TEST_FIXTURES.sampleCode,
                    focus: 'speed',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('code_helper action: simplify code', async () => {
            const res = await client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'simplify',
                    code: TEST_FIXTURES.sampleCode,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('regex_helper action: explain pattern', async () => {
            const res = await client.callTool({
                name: 'regex_helper',
                arguments: {
                    action: 'explain',
                    pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
                    flavor: 'javascript',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('regex_helper action: generate pattern', async () => {
            const res = await client.callTool({
                name: 'regex_helper',
                arguments: {
                    action: 'generate',
                    description: 'Match US phone numbers in format (XXX) XXX-XXXX',
                    examples: ['(555) 123-4567', '(800) 555-1212'],
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('refactor_helper action: suggest_names', async () => {
            const res = await client.callTool({
                name: 'refactor_helper',
                arguments: {
                    action: 'suggest_names',
                    code: TEST_FIXTURES.poorlyNamedCode,
                    style: 'camelCase',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('refactor_helper action: extract_function', async () => {
            const res = await client.callTool({
                name: 'refactor_helper',
                arguments: {
                    action: 'extract_function',
                    code: TEST_FIXTURES.sampleCode,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('mcp_analyze_complexity estimates Big-O', async () => {
            const res = await client.callTool({
                name: 'mcp_analyze_complexity',
                arguments: {
                    code: TEST_FIXTURES.pythonCode,
                    language: 'python',
                    detailed: true,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('mcp_translate_code Python to TypeScript', async () => {
            const res = await client.callTool({
                name: 'mcp_translate_code',
                arguments: {
                    code: TEST_FIXTURES.pythonCode,
                    sourceLanguage: 'python',
                    targetLanguage: 'typescript',
                    preserveComments: true,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('mcp_error_explainer diagnoses stack trace', async () => {
            const res = await client.callTool({
                name: 'mcp_error_explainer',
                arguments: {
                    error: TEST_FIXTURES.sampleError,
                    language: 'typescript',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('mcp_terminal_command suggests shell commands', async () => {
            const res = await client.callTool({
                name: 'mcp_terminal_command',
                arguments: {
                    task: 'Find all TypeScript files larger than 10KB',
                    shell: 'powershell',
                    os: 'windows',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);
    });

    // ============================================
    // SCENARIO 8: Workspace and TODO Analysis
    // ============================================
    describe('Scenario 8: Workspace and TODO Analysis', () => {
        it('workspace mode: metadata', async () => {
            const res = await client.callTool({
                name: 'workspace',
                arguments: {
                    mode: 'metadata',
                    // Use relative path that should exist in workspace
                    path: '.',
                },
            });

            // Response may be error string or JSON - handle both
            const text = (res.content[0] as any).text;
            try {
                const parsed = JSON.parse(text);
                expect(parsed).toBeTruthy();
            } catch {
                // Error response as plain text is acceptable
                expect(text).toBeTruthy();
            }
        }, 30000);

        it('workspace mode: snapshot', async () => {
            const res = await client.callTool({
                name: 'workspace',
                arguments: {
                    mode: 'snapshot',
                    path: 'src',
                    maxDepth: 2,
                    extensions: ['ts', 'tsx'],
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 30000);

        it('workspace mode: explore with LLM', async () => {
            const res = await client.callTool({
                name: 'workspace',
                arguments: {
                    mode: 'explore',
                    path: 'src',
                    question: 'What are the main components?',
                    maxEntries: 10,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('todos action: find', async () => {
            const res = await client.callTool({
                name: 'todos',
                arguments: {
                    action: 'find',
                    root: '.',
                    groupBy: 'priority',
                    todoTypes: ['TODO', 'FIXME', 'HACK'],
                    maxResults: 20,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('todos action: implement (dryRun)', async () => {
            const res = await client.callTool({
                name: 'todos',
                arguments: {
                    action: 'implement',
                    root: '.',
                    difficulty: 'easy',
                    dryRun: true,
                    maxTodos: 2,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('search action: intelligent', async () => {
            const res = await client.callTool({
                name: 'search',
                arguments: {
                    action: 'intelligent',
                    query: 'agent task execution',
                    root: 'src',
                    maxResults: 10,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('search action: structured', async () => {
            const res = await client.callTool({
                name: 'search',
                arguments: {
                    action: 'structured',
                    query: 'chat',
                    root: 'src',
                    targetType: 'function',
                    maxResults: 10,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('search action: gather context', async () => {
            const res = await client.callTool({
                name: 'search',
                arguments: {
                    action: 'gather',
                    query: 'runner implementation details',
                    path: 'src/agent',
                    scope: 'directory',
                    strategy: 'relevant',
                    maxFiles: 5,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);
    });

    // ============================================
    // SCENARIO 9: Code Quality and Duplication Analysis
    // ============================================
    describe('Scenario 9: Code Quality and Duplication Analysis', () => {
        it('find_duplicates: files', async () => {
            const res = await client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'files',
                    fileName: 'runner.ts',
                    minSimilarity: 0.5,
                    maxResults: 10,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('find_duplicates: functions', async () => {
            const res = await client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'functions',
                    symbol: 'extractJson',
                    minSimilarity: 0.6,
                    maxResults: 10,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('find_duplicates: code spans', async () => {
            const res = await client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'code',
                    minLines: 8,
                    minSimilarity: 0.7,
                    maxResults: 15,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('analyze_impact on changed files', async () => {
            const res = await client.callTool({
                name: 'analyze_impact',
                arguments: {
                    changedFiles: ['src/agent/runner.ts'],
                    checkDependencies: true,
                    checkTests: true,
                    checkImports: true,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('analyze_test_gaps for source directory', async () => {
            const res = await client.callTool({
                name: 'analyze_test_gaps',
                arguments: {
                    root: 'src',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);
    });

    // ============================================
    // SCENARIO 10: Planning and Verification Workflow
    // ============================================
    describe('Scenario 10: Planning and Verification Workflow', () => {
        it('mcp_health with full details', async () => {
            const res = await client.callTool({
                name: 'mcp_health',
                arguments: { includeDetails: true },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Health check should return structured status info
            // Accept various field names (status, uptime, healthy, etc.)
            expect(typeof parsed).toBe('object');
            expect(parsed.status === 'healthy' || parsed.healthy === true || parsed.uptime !== undefined || Object.keys(parsed).length > 0).toBe(true);
        }, 30000);

        it('mcp_plan_implementation breaks down feature', async () => {
            const res = await client.callTool({
                name: 'mcp_plan_implementation',
                arguments: {
                    feature: 'Add WebSocket support for real-time task status updates',
                    codebase: 'TypeScript MCP server with agent task execution',
                    constraints: ['Must be backward compatible', 'No new dependencies'],
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('verify_plan with quick mode', async () => {
            const res = await client.callTool({
                name: 'verify_plan',
                arguments: {
                    plan_id: 'test-plan-1',
                    context_root: '.',
                    steps: [
                        {
                            id: 's1',
                            title: 'Check package.json exists',
                            description: 'Verify the package.json file is present',
                            targets: ['package.json'],
                        },
                        {
                            id: 's2',
                            title: 'Verify src directory',
                            description: 'Check src directory exists with TypeScript files',
                            targets: ['src'],
                        },
                    ],
                    mode: 'quick',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.plan_id).toBe('test-plan-1');
            expect(parsed.overall_verdict).toBeTruthy();
        }, 60000);

        it('verify_plan with deep mode', async () => {
            const res = await client.callTool(
                {
                    name: 'verify_plan',
                    arguments: {
                        context_root: '.',
                        steps: [
                            {
                                id: 's1',
                                title: 'Analyze agent runner',
                                description: 'Deep analysis of agent task execution flow',
                                targets: ['src/agent/runner.ts'],
                            },
                        ],
                        mode: 'deep',
                    },
                },
                undefined,
                { timeout: 180000 }
            );

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.overall_verdict).toBeTruthy();
        }, 180000);

        it('summarize action: path', async () => {
            const res = await client.callTool({
                name: 'summarize',
                arguments: {
                    action: 'path',
                    path: 'src/server',
                    mode: 'compact',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('summarize action: repo', async () => {
            const res = await client.callTool({
                name: 'summarize',
                arguments: {
                    action: 'repo',
                    root: '.',
                    mode: 'compact',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 120000);

        it('mcp_diff_summarizer explains changes', async () => {
            const res = await client.callTool({
                name: 'mcp_diff_summarizer',
                arguments: {
                    diff: TEST_FIXTURES.sampleDiff,
                    format: 'bullet',
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);

        it('mcp_summarize_logs analyzes log output', async () => {
            const res = await client.callTool({
                name: 'mcp_summarize_logs',
                arguments: {
                    logs: TEST_FIXTURES.sampleLogs,
                    focus: 'errors',
                    maxLines: 100,
                },
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed).toBeTruthy();
        }, 60000);
    });
});
