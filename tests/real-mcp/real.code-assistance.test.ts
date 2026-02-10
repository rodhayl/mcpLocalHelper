/**
 * Real MCP Server Tests - Code Assistance Tools
 * 
 * Tests for code assistance tools against a REAL running server instance.
 * Requires LM Studio to be running at http://127.0.0.1:1234
 * 
 * Categories tested:
 * - code_helper (explain, optimize, simplify)
 * - regex_helper
 * - refactor_helper
 * - suggest_edit
 * - draft_file
 * - generate_docs
 * - generate_tests
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

describe.skipIf(!LMSTUDIO_READY)('Real MCP Server - Code Assistance Tools', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        const lmStudioAvailable = await checkLMStudioAvailable();
        if (!lmStudioAvailable) {
            const baseUrl = process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
            throw new Error(`[SETUP] LM Studio not available at ${baseUrl} - start LM Studio and load a model.`);
        }

        const tempDir = createTestWorkspace();
        // Uses centralized env.settings backend settings
        const configPath = writeRealTestConfig({
            workspaceDir: tempDir,
            maxConcurrentTasks: 2
        });

        const client = await connectToRealServer(configPath, tempDir);

        ctx = {
            client,
            tempDir,
            configPath,
            startTime: Date.now(),
            lmStudioAvailable: true
        };
    }, 60000);

    afterAll(async () => {
        if (ctx?.client) {
            try {
                await ctx.client.close();
            } catch { /* ignore */ }
        }
        if (ctx?.tempDir) {
            cleanupWorkspace(ctx.tempDir);
        }
    });

    const runTest = (fn: () => Promise<void>) => fn;

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
            // Response must have success:true OR explanation/result (backward compat)
            expect(parsed.success === true || parsed.explanation || parsed.result).toBeTruthy();
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
                lines.push(`}`);
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
                    lines.push(`}`);
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
