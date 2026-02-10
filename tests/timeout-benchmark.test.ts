/**
 * Timeout Benchmark Test Suite
 * 
 * Purpose: Measure actual response times for LLM-invoking tools to establish
 * optimal timeout values based on real-world performance data.
 * 
 * This test runs each LLM tool multiple times and calculates:
 * - Average response time
 * - P50, P90, P95, P99 percentiles
 * - Min/Max response times
 * - Recommended timeout (P99 + 50% buffer)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { getTestConfig } from './test-config.js';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const testConfig = getTestConfig();
const LMSTUDIO_READY = process.env.VITEST_LMSTUDIO_READY === 'true';
const FULL_BENCHMARKS_ENABLED =
  process.env.MCP_LOCAL_LLM_RUN_TIMEOUT_BENCHMARKS === '1' && LMSTUDIO_READY;

// Keep this test file bounded during normal suite runs. Enable full benchmarks explicitly.
const BENCHMARK_ITERATIONS = FULL_BENCHMARKS_ENABLED ? 3 : 1;
const WARM_UP_ITERATIONS = FULL_BENCHMARKS_ENABLED ? 1 : 0;

const TIER_TIMEOUTS_MS: Record<string, number> = FULL_BENCHMARKS_ENABLED
  ? {
      instant: 30000,
      script: 120000,
      'llm-short': 600000, // 10 minutes
      'llm-long': 600000, // 10 minutes
    }
  : {
      instant: 5000,
      script: 20000,
      'llm-short': 45000,
      'llm-long': 60000,
    };

const CONNECT_TIMEOUT = FULL_BENCHMARKS_ENABLED ? 120000 : 60000;

function getToolTimeoutMs(tier: string): number {
  return TIER_TIMEOUTS_MS[tier] ?? TIER_TIMEOUTS_MS['llm-short'] ?? 45000;
}

function getVitestTimeoutMs(tier: string): number {
  // Give the MCP server some overhead beyond the tool call timeout.
  return getToolTimeoutMs(tier) + 30000;
}

interface BenchmarkResult {
    tool: string;
    tier: string;
    iterations: number;
    times: number[];
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    recommendedTimeout: number;
    errors: number;
    errorMessages: string[];
}

function calculatePercentile(sortedTimes: number[], percentile: number): number {
    if (sortedTimes.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedTimes.length) - 1;
    return sortedTimes[Math.max(0, index)];
}

function createBenchmarkConfig(): { dir: string; path: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-benchmark-'));
    const p = path.join(dir, 'env.benchmark.settings');
    const workspaceRoot = path.resolve(__dirname, '..').replace(/\\/g, '/');

    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));

    cfg.backends = [
        {
            id: 'lmstudio',
            type: 'lmstudio',
            base_url: testConfig.lmStudioBaseUrl,
            model: testConfig.localModel,
        },
    ];
    cfg.defaults = {
        ...(cfg.defaults || {}),
        localBackendId: 'lmstudio',
        localModel: testConfig.localModel,
    };
    cfg.server = { ...(cfg.server || {}), host: '127.0.0.1', port: 0 };
    cfg.workspace = { roots: [workspaceRoot], defaultRoot: workspaceRoot };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [workspaceRoot], maxFileBytes: 262144 };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
    cfg.toolGroups = { ...(cfg.toolGroups || {}), activeMode: 'DEVELOPMENT' };
    cfg.rateLimiter = { ...(cfg.rateLimiter || {}), enabled: false };

    writeSettingsFile(p, cfg, {
        exposeSystemProfile: false,
        serverPort: 0,
        serverHost: '127.0.0.1',
        testingEnabled: false,
    });
    return { dir, path: p };
}

// Tool benchmarks categorized by expected tier
const BENCHMARKS: Array<{
    tool: string;
    args: Record<string, unknown>;
    tier: 'instant' | 'script' | 'llm-short' | 'llm-long';
    description: string;
}> = [
        // Instant tier (< 5s)
        { tool: 'mcp_health', args: { includeDetails: true }, tier: 'instant', description: 'Health check' },

        // Script tier (< 30s)
        { tool: 'search', args: { action: 'structured', root: '.', query: 'timeout', maxResults: 5 }, tier: 'script', description: 'Structured search' },

        // LLM-short tier (< 5min)
        { tool: 'llm_chat', args: { backendRole: 'local', messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }] }, tier: 'llm-short', description: 'Simple chat' },
        { tool: 'refine_prompt', args: { prompt: 'fix bug', style: 'concise' }, tier: 'llm-short', description: 'Prompt refinement' },
        { tool: 'mcp_error_explainer', args: { error: "TypeError: x is not a function", language: 'javascript' }, tier: 'llm-short', description: 'Error explanation' },
        { tool: 'mcp_terminal_command', args: { task: 'list files', shell: 'powershell', os: 'windows' }, tier: 'llm-short', description: 'Terminal command' },
        { tool: 'code_helper', args: { action: 'explain', code: 'const x = a => a * 2;' }, tier: 'llm-short', description: 'Code explanation' },

        // LLM-long tier (< 15min)
        { tool: 'summarize', args: { action: 'path', path: 'package.json', mode: 'compact' }, tier: 'llm-long', description: 'File summary' },
        { tool: 'analyze_file', args: { path: 'package.json', analysisType: 'quality' }, tier: 'llm-long', description: 'File analysis' },
    ];

describe('Timeout Benchmarks', () => {
    let client: any;
    let tempDir: string | null = null;
    const results: BenchmarkResult[] = [];

    beforeAll(async () => {
        if (process.env.MCP_LOCAL_LLM_RUN_TIMEOUT_BENCHMARKS === '1' && !LMSTUDIO_READY) {
            console.log(
                `[timeout-benchmark] Full benchmarks requested but LM Studio is not ready; running bounded smoke mode.`
            );
        }

        const cfg = createBenchmarkConfig();
        tempDir = cfg.dir;

        const transport = new StdioClientTransport({
            command: 'node',
            args: [path.resolve(__dirname, '../dist/index.js'), '--settings', cfg.path],
            env: { ...process.env },
            stderr: 'pipe',
            cwd: path.resolve(__dirname, '..'),
        });

        client = new Client({ name: 'benchmark-test', version: '1.0.0' });
        await client.connect(transport);

        console.log('\n' + '='.repeat(80));
        console.log('TIMEOUT BENCHMARK SUITE');
        console.log('='.repeat(80));
        console.log(`Mode: ${FULL_BENCHMARKS_ENABLED ? 'FULL' : 'SMOKE'}`);
        console.log(`Iterations: ${BENCHMARK_ITERATIONS} (+ ${WARM_UP_ITERATIONS} warm-up)`);
        console.log(
            `Tier timeouts: instant=${getToolTimeoutMs('instant')}ms, script=${getToolTimeoutMs('script')}ms, llm-short=${getToolTimeoutMs('llm-short')}ms, llm-long=${getToolTimeoutMs('llm-long')}ms`
        );
        console.log('='.repeat(80) + '\n');
    }, CONNECT_TIMEOUT);

    afterAll(async () => {
        if (client) await client.close();

        // Print summary
        console.log('\n' + '='.repeat(90));
        console.log('BENCHMARK RESULTS SUMMARY');
        console.log('='.repeat(90));
        console.log(`${'Tool'.padEnd(25)} ${'Tier'.padEnd(12)} ${'Min'.padStart(8)} ${'Avg'.padStart(8)} ${'P95'.padStart(8)} ${'P99'.padStart(8)} ${'Max'.padStart(8)} ${'Rec'.padStart(10)}`);
        console.log('-'.repeat(90));

        for (const r of results) {
            console.log(
                `${r.tool.padEnd(25)} ${r.tier.padEnd(12)} ${(r.min / 1000).toFixed(1).padStart(7)}s ${(r.avg / 1000).toFixed(1).padStart(7)}s ${(r.p95 / 1000).toFixed(1).padStart(7)}s ${(r.p99 / 1000).toFixed(1).padStart(7)}s ${(r.max / 1000).toFixed(1).padStart(7)}s ${(r.recommendedTimeout / 1000).toFixed(0).padStart(9)}s`
            );
        }

        console.log('='.repeat(90));

        // Calculate tier recommendations
        const tierMaxes: Record<string, { max: number; p99: number; recommended: number }> = {};
        for (const r of results) {
            if (!tierMaxes[r.tier] || r.recommendedTimeout > tierMaxes[r.tier].recommended) {
                tierMaxes[r.tier] = { max: r.max, p99: r.p99, recommended: r.recommendedTimeout };
            }
        }

        console.log('\nRECOMMENDED TIER TIMEOUTS:');
        for (const [tier, data] of Object.entries(tierMaxes).sort((a, b) => a[1].recommended - b[1].recommended)) {
            console.log(`  ${tier.padEnd(12)}: ${Math.ceil(data.recommended / 1000)}s (P99: ${Math.ceil(data.p99 / 1000)}s, Max: ${Math.ceil(data.max / 1000)}s)`);
        }

        // Save report (avoid dirtying the repo by default)
        const writeReportToRepo = process.env.MCP_LOCAL_LLM_WRITE_BENCHMARK_REPORT === '1';
        const reportPath = writeReportToRepo
            ? path.join(__dirname, '..', 'benchmark_report.json')
            : path.join(tmpdir(), `mcp-local-llm-benchmark_report_${Date.now()}.json`);

        writeFileSync(reportPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            iterations: BENCHMARK_ITERATIONS,
            results,
            tierRecommendations: tierMaxes,
        }, null, 2));
        console.log(`\nReport saved: ${reportPath}`);

        if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });

    const callTool = async (params: any, timeout: number) => {
        return await client.callTool(params, undefined, { timeout });
    };

    for (const benchmark of BENCHMARKS) {
        it(`benchmark: ${benchmark.tool} (${benchmark.tier})`, async () => {
            console.log(`\n[${benchmark.tool}] ${benchmark.description}`);

            const times: number[] = [];
            const errorMessages: string[] = [];
            let errors = 0;
            const timeoutMs = getToolTimeoutMs(benchmark.tier);

            // Warm-up
            for (let i = 0; i < WARM_UP_ITERATIONS; i++) {
                console.log(`  Warm-up ${i + 1}...`);
                try {
                    await callTool({ name: benchmark.tool, arguments: benchmark.args }, timeoutMs);
                } catch (e) {
                    console.log(`  Warm-up failed: ${e}`);
                }
            }

            // Benchmark runs
            for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
                const start = Date.now();
                console.log(`  Run ${i + 1}/${BENCHMARK_ITERATIONS}...`);

                try {
                    const res = await callTool({ name: benchmark.tool, arguments: benchmark.args }, timeoutMs);
                    const duration = Date.now() - start;

                    if (res.isError) {
                        errors++;
                        const errText = res.content?.[0]?.text?.substring(0, 100) || 'Unknown error';
                        errorMessages.push(errText);
                        console.log(`    Error (${duration}ms): ${errText}`);
                    } else {
                        times.push(duration);
                        console.log(`    Success: ${duration}ms`);
                    }
                } catch (e) {
                    const duration = Date.now() - start;
                    errors++;
                    const errMsg = e instanceof Error ? e.message.substring(0, 100) : String(e);
                    errorMessages.push(errMsg);
                    console.log(`    Exception (${duration}ms): ${errMsg}`);
                }
            }

            // Calculate stats
            if (times.length > 0) {
                const sorted = [...times].sort((a, b) => a - b);
                const sum = times.reduce((a, b) => a + b, 0);

                const result: BenchmarkResult = {
                    tool: benchmark.tool,
                    tier: benchmark.tier,
                    iterations: times.length,
                    times,
                    min: sorted[0],
                    max: sorted[sorted.length - 1],
                    avg: sum / times.length,
                    p50: calculatePercentile(sorted, 50),
                    p90: calculatePercentile(sorted, 90),
                    p95: calculatePercentile(sorted, 95),
                    p99: calculatePercentile(sorted, 99),
                    recommendedTimeout: Math.ceil(calculatePercentile(sorted, 99) * 1.5),
                    errors,
                    errorMessages,
                };

                results.push(result);
                console.log(`  Stats: avg=${(result.avg / 1000).toFixed(1)}s, p95=${(result.p95 / 1000).toFixed(1)}s, rec=${(result.recommendedTimeout / 1000).toFixed(0)}s`);
            } else {
                console.log(`  No successful runs - all ${errors} attempts failed`);
            }

            expect(times.length + errors).toBeGreaterThan(0);
        }, getVitestTimeoutMs(benchmark.tier));
    }
});
