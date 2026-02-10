/**
 * Real MCP Server Test Utilities
 * 
 * Shared utilities for tests that run against a REAL MCP server instance.
 * These tests validate the server in a production-like environment.
 * 
 * Key features:
 * - Connection to actual running MCP server via stdio
 * - Uses centralized env.settings (same as other e2e tests)
 * - LLM availability checking (LM Studio/Ollama)
 * - Structured error reporting for LLM analysis
 * - Test timing and performance tracking
 */

import path from 'path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { probeLmStudio } from '../test-utils/lmstudio.js';
import { parseEnvSettings } from '../../src/config/index.js';

// MCP SDK imports
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

/**
 * Get the centralized settings path (env*.settings)
 * This ensures all real-mcp tests use the same configuration as other e2e tests.
 */
export function getCentralizedConfigPath(): string {
    const configPath =
        process.env.MCP_LOCAL_LLM_SETTINGS_PATH || process.env.MCP_LOCAL_LLM_CONFIG || './env.settings';
    const resolvedPath = path.resolve(process.cwd(), configPath);

    if (!existsSync(resolvedPath)) {
        throw new Error(
            `Centralized settings not found: ${resolvedPath}\n` +
            `Please ensure env.settings exists or set MCP_LOCAL_LLM_SETTINGS_PATH environment variable.`
        );
    }

    return resolvedPath;
}

export interface TestContext {
    client: any;
    tempDir: string;
    configPath: string;
    serverPid?: number;
    startTime: number;
    lmStudioAvailable: boolean;
}

export interface TestResult {
    name: string;
    passed: boolean;
    duration: number;
    error?: string;
    errorStack?: string;
    category: string;
    subCategory?: string;
}

export interface TestSuiteResult {
    suite: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
    results: TestResult[];
    errors: TestResult[];
}

/**
 * Check if LM Studio is available at the default endpoint AND has a model loaded.
 * 
 * This checks both:
 * 1. The /v1/models endpoint returns models (models exist in library)
 * 2. A minimal chat completion works (a model is actually loaded for inference)
 * 
 * The second check is critical because LM Studio can have models in the library
 * but return HTTP 400 on inference if no model is loaded.
 */
export async function checkLMStudioAvailable(): Promise<boolean> {
    const baseUrl = process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
    const normalized = baseUrl.replace(/\/+$/, '');
    const apiBaseUrl = normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;

    try {
        const probe = await probeLmStudio(apiBaseUrl, {
            timeoutMs: 15000,
            modelHint: process.env.MCP_LOCAL_LLM_MODEL,
        });
        return probe.ready;
    } catch {
        return false;
    }
}

/**
 * Safe JSON parse helper for test responses
 * Provides better error messages when parsing fails
 */
export function safeParseResponse(response: any, toolName: string): any {
    if (!response?.content?.[0]) {
        throw new Error(`${toolName}: Empty response content`);
    }

    const text = (response.content[0] as any).text;
    if (typeof text !== 'string') {
        throw new Error(`${toolName}: Response content is not a string: ${typeof text}`);
    }

    try {
        return JSON.parse(text);
    } catch (parseError) {
        // Truncate long responses for readability
        const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
        throw new Error(`${toolName}: Failed to parse JSON response: ${preview}`);
    }
}

/**
 * Check if Ollama is available
 */
export async function checkOllamaAvailable(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch('http://127.0.0.1:11434/api/tags', {
            signal: controller.signal
        });
        clearTimeout(timeout);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Check if CLI orchestration is enabled and CLI backend is available.
 * Returns the CLI backend ID if available, null otherwise.
 */
export async function checkCliOrchestrationAvailable(): Promise<string | null> {
    const cliEnabled = process.env.CLI_ORCHESTRATION_ENABLED === 'true';
    if (!cliEnabled) return null;

    const cliBackends = process.env.CLI_ORCHESTRATION_BACKENDS?.split(',').map(b => b.trim()).filter(Boolean);
    if (!cliBackends || cliBackends.length === 0) return null;

    const primaryBackend = cliBackends[0];
    const command = primaryBackend === 'copilot-cli' ? 'copilot' : 'opencode';

    try {
        const { execSync } = await import('child_process');
        execSync(`${command} --version`, { 
            encoding: 'utf-8', 
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return primaryBackend;
    } catch {
        return null;
    }
}

/**
 * Check if ANY LLM backend is available (CLI orchestration, LM Studio, or Ollama)
 */
export async function checkAnyLlmAvailable(): Promise<{ available: boolean; backend: string }> {
    // First check CLI orchestration (priority when enabled)
    const cliBackend = await checkCliOrchestrationAvailable();
    if (cliBackend) {
        console.log(`[TEST-UTILS] CLI orchestration available: ${cliBackend}`);
        return { available: true, backend: cliBackend };
    }

    // Then check LM Studio
    if (await checkLMStudioAvailable()) {
        console.log(`[TEST-UTILS] LM Studio available`);
        return { available: true, backend: 'lmstudio' };
    }

    // Finally check Ollama
    if (await checkOllamaAvailable()) {
        console.log(`[TEST-UTILS] Ollama available`);
        return { available: true, backend: 'ollama' };
    }

    console.log(`[TEST-UTILS] No LLM backend available`);
    return { available: false, backend: 'none' };
}

/**
 * Write test configuration for real MCP server.
 * 
 * This creates a test-specific config that:
 * 1. Uses backend settings from env.settings (centralized configuration)
 * 2. Overrides workspace paths to use the test temp directory
 * 
 * This ensures tests run against the same LLM backends as configured in the project
 * while isolating file operations to the test workspace.
 */
export function writeRealTestConfig(options: {
    workspaceDir: string;
    useLmStudio?: boolean;
    useOllama?: boolean;
    maxConcurrentTasks?: number;
    enableMcpServers?: boolean;
}): string {
    const {
        workspaceDir,
        maxConcurrentTasks = 2,
        enableMcpServers = false
    } = options;

    const centralSettingsPath = getCentralizedConfigPath();
    const centralContent = readFileSync(centralSettingsPath, 'utf-8');
    const sections = parseEnvSettings(centralContent);
    const raw = (sections.config || sections.CONFIG || {}).CONFIG_JSON;
    if (!raw) {
        throw new Error(`Missing [config] CONFIG_JSON in settings file: ${centralSettingsPath}`);
    }

    const baseConfig = JSON.parse(raw);
    const cfg = JSON.parse(JSON.stringify(baseConfig));

    // Isolate workspace to temp dir
    const root = workspaceDir.replace(/\\/g, '/');
    cfg.workspace = { roots: [root], defaultRoot: root };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [root], maxFileBytes: 524288 };

    // Stable server settings for tests
    cfg.server = {
        ...(cfg.server || {}),
        host: '127.0.0.1',
        port: 0,
        maxConcurrentAgentTasks: maxConcurrentTasks,
        agentTaskQueueTimeoutMs: 300000,
    };

    // Real-mcp tests expect system_profile to be available
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: true };

    // Keep/discard MCP servers
    if (!enableMcpServers) {
        cfg.mcpServers = {};
    }

    // Test-friendly defaults
    cfg.toolDiscovery = { ...(cfg.toolDiscovery || {}), fullToolList: true };
    cfg.rateLimiter = { ...(cfg.rateLimiter || {}), enabled: false };

    // Propagate CLI orchestration and backend settings from environment (set by run_all_tests_ALL.py)
    const cliEnabled = process.env.CLI_ORCHESTRATION_ENABLED || 'false';
    const cliBackends = process.env.CLI_ORCHESTRATION_BACKENDS || 'opencode-cli,copilot-cli';
    const localBackendId = process.env.MCP_LOCAL_LLM_BACKEND_ID || cfg.defaults?.localBackendId || 'lmstudio';

    // Update config defaults to use the specified backend for ALL LLM calls
    cfg.defaults = { ...(cfg.defaults || {}), localBackendId };

    const p = path.join(workspaceDir, 'env.real-test.settings');
    const settingsText =
        `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n\n` +
        `[advanced]\nSERVER_PORT=0\nSERVER_HOST=127.0.0.1\nEXPOSE_SYSTEM_PROFILE=true\nTOOL_GROUP_MODE=DEVELOPMENT\n` +
        `AGENT_MAX_STEPS=50\nAGENT_MAX_ACTIONS_PER_STEP=100\nAGENT_MAX_SUBTASKS=8\nAGENT_TIMEOUT_MS=300000\n\n` +
        `[testing]\nTESTING_MODE_ENABLED=true\nTEST_LOCAL_BACKEND_ID=${localBackendId}\nTEST_LOCAL_MODEL=\n` +
        `TEST_LOCAL_BACKEND_URL=http://127.0.0.1:11434\nTEST_SOTA_BACKEND_TYPE=local\nTEST_SOTA_BACKEND_ID=\n` +
        `TEST_SOTA_MODEL=\nTEST_SOTA_BACKEND_URL=\nOPENROUTER_API_KEY=\n\n` +
        `[CLI_ORCHESTRATION]\nCLI_ORCHESTRATION_ENABLED=${cliEnabled}\nCLI_ORCHESTRATION_BACKENDS=${cliBackends}\n` +
        `CLI_AUTO_VERIFY=true\nCLI_SCORE_THRESHOLD=7\nCLI_MAX_ITERATIONS=3\n`;

    writeFileSync(p, settingsText, 'utf-8');
    return p;
}

/**
 * Create a test workspace with sample files
 */
export function createTestWorkspace(): string {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-real-test-'));

    // Create directory structure
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
    mkdirSync(path.join(tempDir, '.mcp-backups'), { recursive: true });

    // Create sample files
    writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
        name: 'mcp-test-project',
        version: '1.0.0',
        description: 'Test project for MCP real server testing',
        scripts: {
            test: 'echo "test"',
            build: 'echo "build"'
        },
        dependencies: {},
        devDependencies: {}
    }, null, 2));

    writeFileSync(path.join(tempDir, 'README.md'), `# MCP Test Project

This is a test project for validating MCP server functionality.

## Features
- Test feature 1
- Test feature 2

## TODO
- [ ] Implement feature X
- [ ] Fix bug Y
`);

    writeFileSync(path.join(tempDir, 'src', 'index.ts'), `/**
 * Main entry point
 * TODO: Add initialization logic
 */
export function main(): void {
    console.log('Hello from MCP test project');
}

// FIXME: This function has a bug
export function buggyFunction(x: number): number {
    return x * 2; // Should be x + 2
}

export const config = {
    apiKey: 'test-api-key-12345', // This should be detected by security scan
    endpoint: 'https://api.example.com'
};
`);

    writeFileSync(path.join(tempDir, 'src', 'utils.ts'), `/**
 * Utility functions
 */

// TODO: Optimize this function
export function slowFunction(items: string[]): string[] {
    return items.map(item => item.toUpperCase());
}

export function calculateSum(numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0);
}
`);

    writeFileSync(path.join(tempDir, 'tests', 'sample.test.ts'), `import { describe, it, expect } from 'vitest';
import { calculateSum } from '../src/utils';

describe('calculateSum', () => {
    it('should sum numbers correctly', () => {
        expect(calculateSum([1, 2, 3])).toBe(6);
    });
});
`);

    return tempDir;
}

/**
 * Connect to a real MCP server
 */
export async function connectToRealServer(configPath: string | undefined, cwd: string): Promise<any> {
    const distPath = path.resolve(__dirname, '../../dist/index.js');

    if (!existsSync(distPath)) {
        throw new Error(`Server not built. Run 'npm run build' first. Missing: ${distPath}`);
    }

    const serverArgs = [distPath];
    if (configPath) {
        serverArgs.push('--settings', configPath);
    }

    const transport = new StdioClientTransport({
        command: 'node',
        args: serverArgs,
        env: {
            ...process.env,
            // Propagate CLI and backend settings to spawned server
            MCP_LOCAL_LLM_BACKEND_ID: process.env.MCP_LOCAL_LLM_BACKEND_ID || 'lmstudio',
            CLI_ORCHESTRATION_ENABLED: process.env.CLI_ORCHESTRATION_ENABLED || 'false',
            CLI_ORCHESTRATION_BACKENDS: process.env.CLI_ORCHESTRATION_BACKENDS || 'opencode-cli,copilot-cli',
        },
        stderr: 'pipe',
        cwd: cwd,
    });

    const err = transport.stderr;
    if (err) {
        err.on('data', (chunk: any) => {
            const text = chunk.toString();
            // Only log errors, not info messages
            if (text.includes('[ERROR]') || text.includes('Error:')) {
                process.stderr.write(`[MCP-SERVER] ${text}`);
            }
        });
    }

    const client = new Client({ name: 'real-mcp-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
}

/**
 * Format test results for LLM analysis
 */
export function formatResultsForLLM(suiteResults: TestSuiteResult[]): string {
    const lines: string[] = [];

    lines.push('='.repeat(80));
    lines.push('MCP REAL SERVER TEST RESULTS - LLM ANALYSIS FORMAT');
    lines.push('='.repeat(80));
    lines.push('');

    // Summary
    let totalTests = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    for (const suite of suiteResults) {
        totalTests += suite.total;
        totalPassed += suite.passed;
        totalFailed += suite.failed;
        totalSkipped += suite.skipped;
    }

    lines.push('## SUMMARY');
    lines.push(`Total Tests: ${totalTests}`);
    lines.push(`Passed: ${totalPassed}`);
    lines.push(`Failed: ${totalFailed}`);
    lines.push(`Skipped: ${totalSkipped}`);
    lines.push(`Success Rate: ${((totalPassed / totalTests) * 100).toFixed(1)}%`);
    lines.push('');

    // Failed tests (most important for LLM to fix)
    if (totalFailed > 0) {
        lines.push('## FAILED TESTS - REQUIRES FIXING');
        lines.push('-'.repeat(60));

        for (const suite of suiteResults) {
            for (const result of suite.errors) {
                lines.push('');
                lines.push(`### TEST: ${result.name}`);
                lines.push(`Category: ${result.category}${result.subCategory ? '/' + result.subCategory : ''}`);
                lines.push(`Duration: ${result.duration}ms`);
                lines.push('');
                lines.push('**ERROR:**');
                lines.push('```');
                lines.push(result.error || 'Unknown error');
                lines.push('```');
                if (result.errorStack) {
                    lines.push('');
                    lines.push('**STACK TRACE:**');
                    lines.push('```');
                    lines.push(result.errorStack);
                    lines.push('```');
                }
                lines.push('');
            }
        }
    }

    // Per-suite breakdown
    lines.push('## SUITE BREAKDOWN');
    lines.push('-'.repeat(60));

    for (const suite of suiteResults) {
        lines.push('');
        lines.push(`### ${suite.suite}`);
        lines.push(`- Total: ${suite.total}`);
        lines.push(`- Passed: ${suite.passed}`);
        lines.push(`- Failed: ${suite.failed}`);
        lines.push(`- Skipped: ${suite.skipped}`);
        lines.push(`- Duration: ${suite.duration}ms`);
    }

    lines.push('');
    lines.push('='.repeat(80));
    lines.push('END OF TEST RESULTS');
    lines.push('='.repeat(80));

    return lines.join('\n');
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cleanup test workspace
 */
export function cleanupWorkspace(tempDir: string): void {
    try {
        rmSync(tempDir, { recursive: true, force: true });
    } catch {
        // Ignore cleanup errors on Windows
    }
}

/**
 * Poll for async task result
 * 
 * Handles three terminal states: complete, failed, timeout
 * Also handles not_found which indicates the task ID is invalid
 */
export async function pollTaskResult(
    client: any,
    taskId: string,
    timeoutMs: number = 180000
): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const response = await client.callTool({
            name: 'agent_task_result',
            arguments: { taskId, includeProgress: false },
        });

        // Safely parse the response
        let result: any;
        try {
            result = JSON.parse((response.content[0] as any).text);
        } catch (parseError) {
            throw new Error(`Failed to parse agent_task_result response: ${(response.content[0] as any).text}`);
        }

        // Handle not_found status (task ID doesn't exist)
        if (result.status === 'not_found' || result.found === false) {
            throw new Error(`Task ${taskId} not found - it may have been cleared or never existed`);
        }

        // Check for terminal states
        if (result.status === 'complete' || result.status === 'failed' || result.status === 'timeout') {
            return result;
        }

        await sleep(1000);
    }
    // Return a timeout status instead of throwing - allows tests to handle timeout as expected state
    return { status: 'timeout', taskId, elapsedMs: Date.now() - start };
}
