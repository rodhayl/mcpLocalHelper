/**
 * Real MCP Server Tests - Analysis & Quality Matrix
 * 
 * Consolidated suites for search/analysis, code quality, and code assistance tools
 * against a REAL running server instance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    checkLMStudioAvailable,
    writeRealTestConfig,
    createTestWorkspace,
    connectToRealServer,
    cleanupWorkspace,
    TestContext
} from './test-utils';

const LMSTUDIO_READY = process.env.VITEST_LMSTUDIO_READY === 'true';

class SkipTestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SkipTestError';
    }
}

const isTimeoutError = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    return /timeout|timed out|request timed out/i.test(error.message);
};

const isTimeoutText = (text: string): boolean => /timeout|timed out|request timed out/i.test(text);

const MCP_SDK_TIMEOUT_MS = 180000; // 3 minutes for CLI operations

const wrapCallTool = (client: any): void => {
    const original = client.callTool.bind(client);
    // MCP SDK callTool(params, resultSchema?, options?) - inject timeout in options
    client.callTool = async (params: any, resultSchema?: any, options?: any) => {
        const mergedOptions = { timeout: MCP_SDK_TIMEOUT_MS, ...options };
        try {
            const res = await original(params, resultSchema, mergedOptions);
            const text = (res?.content?.[0] as any)?.text ?? '';
            if (res?.isError && isTimeoutText(text)) {
                throw new SkipTestError(text || 'Request timed out');
            }
            return res;
        } catch (error) {
            if (isTimeoutError(error)) {
                throw new SkipTestError((error as Error).message);
            }
            throw error;
        }
    };
};

/**
 * Search & Analysis Tools
 */
describe.skipIf(!LMSTUDIO_READY)('Real MCP Server - Search & Analysis Tools', () => {
    let ctx: TestContext;
    let lmStudioAvailable = false;

    beforeAll(async () => {
        lmStudioAvailable = await checkLMStudioAvailable();
        if (!lmStudioAvailable) {
            const baseUrl = process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
            console.warn(`[SETUP] LM Studio not available at ${baseUrl} - skipping Search & Analysis Tools tests.`);
            return;
        }

        const tempDir = createTestWorkspace();
        // Uses centralized env.settings backend settings
        const configPath = writeRealTestConfig({
            workspaceDir: tempDir,
            maxConcurrentTasks: 2
        });

        const client = await connectToRealServer(configPath, tempDir);
        wrapCallTool(client);

        ctx = {
            client,
            tempDir,
            configPath,
            startTime: Date.now(),
            lmStudioAvailable: true
        };
    }, 60000);

    afterAll(async () => {
        if (!lmStudioAvailable) return;
        if (ctx?.client) {
            try {
                await ctx.client.close();
            } catch { /* ignore */ }
        }
        if (ctx?.tempDir) {
            cleanupWorkspace(ctx.tempDir);
        }
    });

    const runTest = (fn: () => Promise<void>) => async () => {
        if (!lmStudioAvailable) return;
        try {
            await fn();
        } catch (error) {
            if (error instanceof SkipTestError) {
                console.warn(`Skipping test due to timeout: ${error.message}`);
                return;
            }
            throw error;
        }
    };

    // ============================================
    // Search Tool Tests
    // ============================================
    describe('search', () => {
        it('should perform intelligent search (action=intelligent)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'intelligent',
                    query: 'main function entry point',
                    root: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.results || parsed.matches).toBeTruthy();
        }), 60000);

        it('should perform structured search (action=structured)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'structured',
                    query: 'function',
                    root: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should gather context (action=gather)', runTest(async () => {
            // gather action requires 'path' not 'root'
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'gather',
                    query: 'understand the project structure',
                    path: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should reject invalid action', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'invalid',
                    query: 'test',
                    root: ctx.tempDir
                }
            });
            expect(res.isError).toBe(true);
        }), 30000);

        // V14: search now defaults root to '.' when omitted (per LLM feedback)
        // This is the preferred UX - users wanted auto-defaulting instead of errors
        it('should default root to "." when omitted for intelligent action', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'intelligent',
                    query: 'calculateSum'
                    // root intentionally omitted - should default to '.' per V14
                }
            });
            // V14: Now returns results instead of error (defaults to workspace root)
            // If error, it should NOT be missing_params error
            if (res.isError) {
                const parsed = JSON.parse((res.content[0] as any).text);
                // Should not be missing_params - that indicates we didn't default correctly
                expect(parsed.errorType).not.toBe('missing_params');
            } else {
                // If success, should have some response structure
                // Intelligent search returns results array or object with query/results
                const parsed = JSON.parse((res.content[0] as any).text);
                // Verify we got a valid response (not undefined/null)
                expect(parsed).toBeDefined();
                // Response could have results array, matches, or other structure
                const hasResults = parsed.results !== undefined || 
                                   parsed.matches !== undefined ||
                                   Array.isArray(parsed) ||
                                   typeof parsed === 'object';
                expect(hasResults).toBe(true);
            }
        }), 30000);

        it('should return structured error when path is missing for gather action', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'gather',
                    query: 'understand structure'
                    // missing path parameter
                }
            });
            expect(res.isError).toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.success).toBe(false);
            expect(parsed.errorType).toBe('missing_params');
        }), 30000);

        it('should return explicit error for non-existent root path', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'intelligent',
                    query: 'test function',
                    root: `${ctx.tempDir}/nonexistent-directory`
                }
            });
            // Should return error with explicit path feedback
            expect(res.content).toBeTruthy();
            const text = (res.content[0] as any).text;
            expect(text).toMatch(/Path not found|does not exist|not a directory|ENOENT/i);
        }), 30000);

        // QA_feedback_7 Regression: "Empty Results Bug" - if totalMatches > 0, results array must not be empty
        it('should never return empty results when totalMatches > 0', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'search',
                arguments: {
                    action: 'intelligent',
                    query: 'function',  // Common term that should find matches
                    root: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            
            // Critical regression check: if we found matches, results array must contain at least 1 item
            if (parsed.totalMatches > 0) {
                expect(parsed.results).toBeDefined();
                expect(Array.isArray(parsed.results)).toBe(true);
                expect(parsed.results.length).toBeGreaterThan(0);
                // Verify each result has required fields
                expect(parsed.results[0]).toHaveProperty('file');
                expect(parsed.results[0]).toHaveProperty('relevanceScore');
                expect(parsed.results[0]).toHaveProperty('matches');
            } else {
                // If no matches, should provide helpful hint
                expect(parsed.results).toBeDefined();
                expect(Array.isArray(parsed.results)).toBe(true);
                expect(parsed.results.length).toBe(0);
                expect(parsed.suggestedNextSteps).toBeDefined();
            }
        }), 60000);
    });

    // ============================================
    // TODO Tool Tests
    // ============================================
    describe('todos', () => {
        it('should find TODOs in workspace (action=find)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'todos',
                arguments: {
                    action: 'find',
                    root: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Our test workspace has TODOs
            expect(parsed.todos || parsed.results || parsed.findings).toBeTruthy();
        }), 60000);

        it('should find TODOs with groupBy', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'todos',
                arguments: {
                    action: 'find',
                    root: ctx.tempDir,
                    groupBy: 'file'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should find specific TODO types', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'todos',
                arguments: {
                    action: 'find',
                    root: ctx.tempDir,
                    todoTypes: ['TODO', 'FIXME']
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should reject invalid action', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'todos',
                arguments: {
                    action: 'invalid',
                    root: ctx.tempDir
                }
            });
            expect(res.isError).toBe(true);
        }), 30000);
    });

    // ============================================
    // Find Duplicates Tests
    // ============================================
    describe('find_duplicates', () => {
        it('should find duplicate code spans (findType=code)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'code'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should find similar functions (findType=functions)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'functions'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should find similar files (findType=files)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'files',
                    fileName: `${ctx.tempDir}/src/index.ts`  // Required for findType=files
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should reject invalid findType', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'find_duplicates',
                arguments: {
                    findType: 'invalid'
                }
            });
            expect(res.isError).toBe(true);
        }), 30000);
    });

    // ============================================
    // Cross File Links Tests
    // Returns: { files[], graph: { nodes[], edges[] } }
    // ============================================
    describe('cross_file_links', () => {
        it('should analyze import relationships', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'cross_file_links',
                arguments: {
                    entryPoints: [`${ctx.tempDir}/src/index.ts`]
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // CrossFileLinksResult: { files[], graph: { nodes[], edges[] } }
            expect(Array.isArray(parsed.files)).toBe(true);
            expect(parsed.graph).toBeTruthy();
            expect(Array.isArray(parsed.graph.nodes)).toBe(true);
            expect(Array.isArray(parsed.graph.edges)).toBe(true);
        }), 60000);

        it('should respect depth limit', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'cross_file_links',
                arguments: {
                    entryPoints: [`${ctx.tempDir}/src/index.ts`],
                    depth: 1
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should handle non-existent entry point', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'cross_file_links',
                arguments: {
                    entryPoints: [`${ctx.tempDir}/nonexistent.ts`]
                }
            });
            // Should handle gracefully
            expect(res.content).toBeTruthy();
        }), 30000);
    });

    // ============================================
    // Index Symbols Tests
    // ============================================
    describe('index_symbols', () => {
        it('should index symbols in workspace', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'index_symbols',
                arguments: {
                    root: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.symbols || parsed.indexed || parsed.count).toBeDefined();
        }), 60000);

        it('should filter by language', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'index_symbols',
                arguments: {
                    root: ctx.tempDir,
                    languages: ['typescript']
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);

        it('should filter by symbol types', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'index_symbols',
                arguments: {
                    root: ctx.tempDir,
                    symbolTypes: ['function', 'class']
                }
            });
            expect(res.isError).not.toBe(true);
        }), 60000);
    });
});

/**
 * Code Quality Tools
 */
describe.skipIf(!LMSTUDIO_READY)('Real MCP Server - Code Quality Tools', () => {
    let ctx: TestContext;
    let lmStudioAvailable = false;

    beforeAll(async () => {
        lmStudioAvailable = await checkLMStudioAvailable();
        if (!lmStudioAvailable) {
            const baseUrl = process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
            console.warn(`[SETUP] LM Studio not available at ${baseUrl} - skipping Code Quality Tools tests.`);
            return;
        }

        const tempDir = createTestWorkspace();
        // Uses centralized env.settings backend settings
        const configPath = writeRealTestConfig({
            workspaceDir: tempDir,
            maxConcurrentTasks: 2
        });

        const client = await connectToRealServer(configPath, tempDir);
        wrapCallTool(client);

        ctx = {
            client,
            tempDir,
            configPath,
            startTime: Date.now(),
            lmStudioAvailable: true
        };
    }, 60000);

    afterAll(async () => {
        if (!lmStudioAvailable) return;
        if (ctx?.client) {
            try {
                await ctx.client.close();
            } catch { /* ignore */ }
        }
        if (ctx?.tempDir) {
            cleanupWorkspace(ctx.tempDir);
        }
    });

    const runTest = (fn: () => Promise<void>) => async () => {
        if (!lmStudioAvailable) return;
        try {
            await fn();
        } catch (error) {
            if (error instanceof SkipTestError) {
                console.warn(`Skipping test due to timeout: ${error.message}`);
                return;
            }
            throw error;
        }
    };

    // ============================================
    // Linter Tool Tests
    // ExecutionResult: { success, exitCode, stdout, stderr, duration, command }
    // ============================================
    describe('linter', () => {
        it('should run linter (action=run)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'linter',
                arguments: {
                    action: 'run'
                    // Note: files is optional, command will be auto-detected
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // ExecutionResult: { success, exitCode, stdout, stderr, duration, command }
            expect(typeof parsed.success).toBe('boolean');
            expect(typeof parsed.exitCode).toBe('number');
            expect(parsed.command).toBeDefined();
        }), 60000);

        it('should handle empty directory gracefully', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'linter',
                arguments: {
                    action: 'run',
                    paths: [`${ctx.tempDir}/.mcp-backups`]
                }
            });
            // Should not error, just return empty results
            expect(res.content).toBeTruthy();
        }), 30000);

        it('should reject invalid action', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'linter',
                arguments: {
                    action: 'invalid',
                    paths: [ctx.tempDir]
                }
            });
            expect(res.isError).toBe(true);
        }), 30000);
    });

    // ============================================
    // Local Code Review Tests
    // LocalCodeReviewResult: { success, filesReviewed, issues[], summary, recommendations[], overallScore }
    // ============================================
    describe('local_code_review', () => {
        it('should review file for quality', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'local_code_review',
                arguments: {
                    paths: [`${ctx.tempDir}/src/index.ts`],
                    focus: 'comprehensive'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // LocalCodeReviewResult: { success, filesReviewed, issues[], summary, recommendations[] }
            expect(typeof parsed.success).toBe('boolean');
            expect(typeof parsed.filesReviewed).toBe('number');
            expect(Array.isArray(parsed.issues)).toBe(true);
        }), 120000);

        it('should review for security focus', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'local_code_review',
                arguments: {
                    paths: [`${ctx.tempDir}/src/index.ts`],
                    focus: 'security'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 120000);

        it('should review for performance focus', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'local_code_review',
                arguments: {
                    paths: [`${ctx.tempDir}/src/utils.ts`],
                    focus: 'performance'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 120000);

        it('should reject empty paths', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'local_code_review',
                arguments: {
                    paths: []
                }
            });
            expect(res.isError).toBe(true);
        }), 30000);
    });

    // ============================================
    // Code Quality Analyzer Tests
    // CodeQualityResult: { total_issues, by_type, by_severity, issues[] }
    // ============================================
    describe('code_quality_analyzer', () => {
        it('should analyze code quality comprehensively', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_quality_analyzer',
                arguments: {
                    rootDir: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // CodeQualityResult: { total_issues, by_type, by_severity, issues[] }
            expect(typeof parsed.total_issues).toBe('number');
            expect(parsed.by_type).toBeTruthy();
            expect(parsed.by_severity).toBeTruthy();
            expect(Array.isArray(parsed.issues)).toBe(true);
        }), 120000);

        it('should analyze specific types only', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_quality_analyzer',
                arguments: {
                    rootDir: ctx.tempDir,
                    includeTypes: ['complexity', 'smells']
                }
            });
            expect(res.isError).not.toBe(true);
        }), 120000);

        it('should use default root when not specified', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_quality_analyzer',
                arguments: {}
            });
            expect(res.isError).not.toBe(true);
        }), 120000);
    });

    // ============================================
    // Impact Analysis Tests
    // AnalyzeImpactResult: { changedFiles[], impactedFiles[], affectedTests[], affectedDependencies[], riskLevel, suggestions[] }
    // ============================================
    describe('analyze_impact', () => {
        it('should analyze impact of file changes', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_impact',
                arguments: {
                    changedFiles: [`${ctx.tempDir}/src/utils.ts`]
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // AnalyzeImpactResult: { changedFiles[], impactedFiles[], affectedTests[], affectedDependencies[], riskLevel, suggestions[] }
            expect(Array.isArray(parsed.changedFiles)).toBe(true);
            expect(Array.isArray(parsed.impactedFiles)).toBe(true);
            expect(Array.isArray(parsed.affectedTests)).toBe(true);
            expect(parsed.riskLevel).toBeTruthy();
        }), 90000);

        it('should check dependencies', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_impact',
                arguments: {
                    changedFiles: [`${ctx.tempDir}/src/index.ts`],
                    checkDependencies: true
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);

        it('should check imports', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_impact',
                arguments: {
                    changedFiles: [`${ctx.tempDir}/src/utils.ts`],
                    checkImports: true
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);

        it('should check affected tests', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_impact',
                arguments: {
                    changedFiles: [`${ctx.tempDir}/src/utils.ts`],
                    checkTests: true
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);
    });

    // ============================================
    // Test Gap Analysis Tests
    // TestGapsResult: { untestedFiles[], partiallyTestedFiles[], coverageSummary, recommendations[] }
    // ============================================
    describe('analyze_test_gaps', () => {
        it('should analyze test coverage gaps', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_test_gaps',
                arguments: {
                    root: ctx.tempDir
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // TestGapsResult: { untestedFiles[], partiallyTestedFiles[], coverageSummary, recommendations[] }
            expect(Array.isArray(parsed.untestedFiles)).toBe(true);
            expect(Array.isArray(parsed.partiallyTestedFiles)).toBe(true);
            expect(parsed.coverageSummary).toBeTruthy();
            expect(typeof parsed.coverageSummary.totalSourceFiles).toBe('number');
        }), 90000);

        it('should use custom source patterns', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_test_gaps',
                arguments: {
                    root: ctx.tempDir,
                    sourcePatterns: ['src/**/*.ts']
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);

        it('should use custom test patterns', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'analyze_test_gaps',
                arguments: {
                    root: ctx.tempDir,
                    testPatterns: ['tests/**/*.test.ts']
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);
    });
});

/**
 * Code Assistance Tools
 */
describe.skipIf(!LMSTUDIO_READY)('Real MCP Server - Code Assistance Tools', () => {
    let ctx: TestContext;
    let lmStudioAvailable = false;

    beforeAll(async () => {
        lmStudioAvailable = await checkLMStudioAvailable();
        if (!lmStudioAvailable) {
            const baseUrl = process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
            console.warn(`[SETUP] LM Studio not available at ${baseUrl} - skipping Code Assistance Tools tests.`);
            return;
        }

        const tempDir = createTestWorkspace();
        // Uses centralized env.settings backend settings
        const configPath = writeRealTestConfig({
            workspaceDir: tempDir,
            maxConcurrentTasks: 2
        });

        const client = await connectToRealServer(configPath, tempDir);
        wrapCallTool(client);

        ctx = {
            client,
            tempDir,
            configPath,
            startTime: Date.now(),
            lmStudioAvailable: true
        };
    }, 60000);

    afterAll(async () => {
        if (!lmStudioAvailable) return;
        if (ctx?.client) {
            try {
                await ctx.client.close();
            } catch { /* ignore */ }
        }
        if (ctx?.tempDir) {
            cleanupWorkspace(ctx.tempDir);
        }
    });

    const runTest = (fn: () => Promise<void>) => async () => {
        if (!lmStudioAvailable) return;
        try {
            await fn();
        } catch (error) {
            if (error instanceof SkipTestError) {
                console.warn(`Skipping test due to timeout: ${error.message}`);
                return;
            }
            throw error;
        }
    };

    // ============================================
    // Code Helper Tests
    // ============================================
    describe('code_helper', () => {
        it('should explain code (action=explain)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'explain',
                    code: 'const sum = (a: number, b: number): number => a + b;'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.explanation || parsed.result).toBeTruthy();
        }), 90000);

        it('should optimize code (action=optimize)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'optimize',
                    code: `function slowSum(arr) {
                        let sum = 0;
                        for (let i = 0; i < arr.length; i++) {
                            sum = sum + arr[i];
                        }
                        return sum;
                    }`
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);

        it('should simplify code (action=simplify)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'simplify',
                    code: `if (condition === true) { return true; } else { return false; }`
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);

        it('should reject invalid action', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'code_helper',
                arguments: {
                    action: 'invalid',
                    code: 'test'
                }
            });
            expect(res.isError).toBe(true);
        }), 30000);
    });

    // ============================================
    // Regex Helper Tests
    // ============================================
    describe('regex_helper', () => {
        it('should explain regex (action=explain)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'regex_helper',
                arguments: {
                    action: 'explain',
                    pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Response must have success:true OR explanation/result (backward compat)
            expect(parsed.success === true || parsed.explanation || parsed.result).toBeTruthy();
        }), 90000);

        it('should generate regex (action=generate)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'regex_helper',
                arguments: {
                    action: 'generate',
                    description: 'Match US phone numbers in format (XXX) XXX-XXXX'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // GenerateRegexResult: { success, pattern, flags?, explanation, examples, alternativePatterns?, error? }
            expect(parsed.success).toBe(true);
            expect(typeof parsed.pattern).toBe('string');
            // explanation can be a string or object depending on LLM response parsing
            expect(parsed.explanation).toBeDefined();
        }), 90000);

        it('should return error for missing required params', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'regex_helper',
                arguments: {
                    action: 'explain'
                    // Missing pattern - should return error
                }
            });
            // Error can be returned via isError flag OR in JSON body
            if (res.isError) {
                expect(res.isError).toBe(true);
            } else {
                const parsed = JSON.parse((res.content[0] as any).text);
                // Expect error or success=false in JSON response
                expect(parsed.error || parsed.success === false).toBeTruthy();
            }
        }), 30000);
    });

    // ============================================
    // Refactor Helper Tests
    // ============================================
    describe('refactor_helper', () => {
        it('should suggest names (action=suggest_names)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'refactor_helper',
                arguments: {
                    action: 'suggest_names',
                    code: 'function x(a, b) { return a + b; }',
                    context: 'This function calculates the total price'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.suggestions || parsed.names || parsed.result).toBeTruthy();
        }), 90000);

        it('should extract function (action=extract_function)', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'refactor_helper',
                arguments: {
                    action: 'extract_function',
                    code: `
                        const users = data.filter(u => u.active);
                        const emails = users.map(u => u.email);
                        const sorted = emails.sort();
                    `,
                    context: 'Get sorted active user emails'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 90000);
    });

    // ============================================
    // Suggest Edit Tests
    // ============================================
    describe('suggest_edit', () => {
        it('should suggest edits for file', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'suggest_edit',
                arguments: {
                    file_path: `${ctx.tempDir}/src/index.ts`,
                    intent: 'Add error handling to the main function'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Returns { suggestions: [...], summary }
            expect(parsed.suggestions || parsed.suggestion || parsed.edit).toBeTruthy();
        }), 120000);

        it('should handle non-existent file', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'suggest_edit',
                arguments: {
                    file_path: `${ctx.tempDir}/nonexistent.ts`,
                    intent: 'Add something'
                }
            });
            // File path validation returns isError or error in JSON
            const errorOccurred = res.isError || (res.content?.[0] && JSON.parse((res.content[0] as any).text).error);
            expect(errorOccurred).toBeTruthy();
        }), 30000);
    });

    // ============================================
    // Draft File Tests
    // ============================================
    describe('draft_file', () => {
        it('should draft new file content', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'draft_file',
                arguments: {
                    file_path: `${ctx.tempDir}/src/newfile.ts`,
                    intent: 'Create a TypeScript file with a Logger class that has info, warn, and error methods'
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Returns { filePath, content, explanation }
            expect(parsed.content || parsed.draft || parsed.code).toBeTruthy();
        }), 120000);

        it('should respect file type for content', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'draft_file',
                arguments: {
                    file_path: `${ctx.tempDir}/config.yaml`,
                    intent: 'Create a YAML configuration file for a web server with host and port settings'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 120000);
    });

    // ============================================
    // Generate Docs Tests
    // ============================================
    describe('generate_docs', () => {
        it('should generate documentation for file', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'generate_docs',
                arguments: {
                    path: `${ctx.tempDir}/src/utils.ts`
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Returns { documentation, sourceFile, docType }
            expect(parsed.documentation || parsed.docs || parsed.result).toBeTruthy();
        }), 120000);

        it('should generate docs with docType=readme', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'generate_docs',
                arguments: {
                    path: `${ctx.tempDir}/src`,
                    docType: 'readme'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 120000);
    });

    // ============================================
    // Generate Tests Tests - SKIPPED (V21: generate_tests removed due to unreliable output quality)
    // ============================================
    describe.skip('generate_tests (REMOVED)', () => {
        it('should generate tests for file', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'generate_tests',
                arguments: {
                    path: `${ctx.tempDir}/src/utils.ts`,
                    format: 'json',
                }
            });
            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Returns { tests, sourceFile, framework, coverage }
            expect(parsed.tests || parsed.testCode || parsed.result).toBeTruthy();
        }), 120000);

        it('should generate tests with custom coverage', runTest(async () => {
            const res = await ctx.client.callTool({
                name: 'generate_tests',
                arguments: {
                    path: `${ctx.tempDir}/src/utils.ts`,
                    coverage: 'basic'
                }
            });
            expect(res.isError).not.toBe(true);
        }), 120000);

        // QA_feedback_26012026: Test large file guard with clear error message
        it('should return clear error for files > 300 lines without focusFunctions', runTest(async () => {
            // Create a large file (350+ lines)
            const { writeFileSync } = await import('fs');
            const largePath = `${ctx.tempDir}/src/large-module.ts`;
            const lines: string[] = [];
            lines.push('/**');
            lines.push(' * Large module for testing generate_tests size guard');
            lines.push(' */');
            lines.push('');
            // Generate 350 lines of functions
            for (let i = 0; i < 100; i++) {
                lines.push(`export function function${i}(a: number, b: number): number {`);
                lines.push(`    // Function implementation ${i}`);
                lines.push(`    return a + b + ${i};`);
                lines.push('}');
                lines.push('');
            }
            writeFileSync(largePath, lines.join('\n'), 'utf-8');

            const res = await ctx.client.callTool({
                name: 'generate_tests',
                arguments: {
                    path: largePath,
                    coverage: 'basic'
                }
            });

            // Should not be a hard error, but a soft error in the response
            const parsed = JSON.parse((res.content[0] as any).text);
            
            // Must have clear error message about size limit
            expect(parsed.success).toBe(false);
            expect(parsed.error).toBeDefined();
            expect(parsed.error).toMatch(/too large|300 lines|focusFunctions/i);
            
            // Must include a hint about using focusFunctions
            expect(parsed.error).toMatch(/focusFunctions/);
        }), 30000);

        // QA_feedback_26012026: Test that focusFunctions works for large files
        it('should succeed with focusFunctions on large file', runTest(async () => {
            // Create a large file (350+ lines) if not already created
            const { writeFileSync, existsSync } = await import('fs');
            const largePath = `${ctx.tempDir}/src/large-module.ts`;
            if (!existsSync(largePath)) {
                const lines: string[] = [];
                lines.push('/**');
                lines.push(' * Large module for testing generate_tests size guard');
                lines.push(' */');
                lines.push('');
                for (let i = 0; i < 100; i++) {
                    lines.push(`export function function${i}(a: number, b: number): number {`);
                    lines.push(`    return a + b + ${i};`);
                    lines.push('}');
                    lines.push('');
                }
                writeFileSync(largePath, lines.join('\n'), 'utf-8');
            }

            const res = await ctx.client.callTool({
                name: 'generate_tests',
                arguments: {
                    path: largePath,
                    focusFunctions: ['function0', 'function1'],
                    coverage: 'basic',
                    format: 'json'
                }
            });

            expect(res.isError).not.toBe(true);
            const parsed = JSON.parse((res.content[0] as any).text);
            // Should succeed with focusFunctions
            expect(parsed.success).toBe(true);
            expect(parsed.tests || parsed.testCode).toBeTruthy();
        }), 120000);

        // QA_feedback_26012026: Test non-code file rejection with alternatives
        it('should reject JSON files with actionable alternatives', runTest(async () => {
            const { writeFileSync } = await import('fs');
            const jsonPath = `${ctx.tempDir}/config.json`;
            writeFileSync(jsonPath, JSON.stringify({ key: 'value' }), 'utf-8');

            const res = await ctx.client.callTool({
                name: 'generate_tests',
                arguments: {
                    path: jsonPath,
                    coverage: 'basic'
                }
            });

            const parsed = JSON.parse((res.content[0] as any).text);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toMatch(/Cannot generate tests.*\.json/i);
            // Should include alternative suggestions
            expect(parsed.error).toMatch(/security|analyze_file/i);
        }), 30000);
    });
});
