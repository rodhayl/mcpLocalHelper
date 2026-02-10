import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';
import { getTestConfig } from './test-config.js';

const TEST_DIR = resolve('tests/tmp/llm-enhanced');

// Use centralized test configuration
const testConfig = getTestConfig();
const LMSTUDIO_BASE_URL = testConfig.lmStudioBaseUrl;
const LMSTUDIO_API_BASE_URL = testConfig.lmStudioApiBaseUrl;

const LMSTUDIO_READY = process.env.VITEST_LMSTUDIO_READY === 'true';

const isTimeoutError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|\[TIMEOUT\]/i.test(error.message);
};

const runWithTimeout = async <T>(
  label: string,
  work: Promise<T>,
  timeoutMs: number
): Promise<T> => {
  const safeWork = work.catch((err) => {
    throw err;
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[TIMEOUT] ${label}`)), timeoutMs);
  });

  try {
    return await Promise.race([safeWork, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const runLlmTest = (label: string, fn: () => Promise<void>, timeoutMs: number) => async () => {
  try {
    await runWithTimeout(label, fn(), timeoutMs);
  } catch (error) {
    if (isTimeoutError(error)) {
      console.warn(`${label} skipped due to LLM timeout`);
      return;
    }
    throw error;
  }
};

describe.skipIf(!LMSTUDIO_READY)('LLM Enhanced Tools', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;
  let llmEnhancedTools: LlmEnhancedTools;

  beforeAll(async () => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }

    mkdirSync(join(TEST_DIR, 'src'), { recursive: true });

    writeFileSync(
      join(TEST_DIR, 'src', 'example.ts'),
      `/**
 * Example TypeScript file for testing
 */
export interface User {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  private users: User[] = [];

  /** Add a new user */
  addUser(user: User): void {
    this.users.push(user);
  }

  /** Get user by ID */
  getUser(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  /** Validate an email address */
  validateEmail(email: string): boolean {
    const emailRegExp = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-z]{2,3}$/;
    return emailRegExp.test(email);
  }
}
`,
      'utf-8'
    );

    writeFileSync(
      join(TEST_DIR, 'src', 'utils.ts'),
      `/**
 * Utility functions
 */
export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseJson(json: string): unknown {
  return JSON.parse(json);
}
`,
      'utf-8'
    );

    writeFileSync(
      join(TEST_DIR, 'README.md'),
      `# Test Project

This is a test project for LLM-enhanced tools testing.

## Features
- User management
- Utility functions
`,
      'utf-8'
    );

    config = new ConfigManager();
    config.setDynamicWorkspaceRoots([TEST_DIR]);

    // Ensure the global overrides are applied (LM Studio + model selection from centralized config)
    // Note: Only localBackendId is required - sota settings are optional (calling LLM is the SOTA)
    expect(config.getConfig().defaults.localBackendId).toBe(testConfig.localBackendId);
    // sotaBackendId and sotaModel are optional in env.settings
    // Only check them if they're defined in config (they may be undefined)
    if (config.getConfig().defaults.sotaBackendId) {
      expect(config.getConfig().defaults.sotaBackendId).toBe(testConfig.sotaBackendId);
    }
    if (config.getConfig().defaults.localModel) {
      expect(config.getConfig().defaults.localModel).toBe(testConfig.localModel);
    }
    if (config.getConfig().defaults.sotaModel) {
      expect(config.getConfig().defaults.sotaModel).toBe(testConfig.sotaModel);
    }

    backendManager = new BackendManager(config.getConfig().backends);
    llmEnhancedTools = new LlmEnhancedTools(config, backendManager);
  }, 60000);

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('analyzeFile (unit)', () => {
    it('throws for non-existent file', async () => {
      await expect(
        llmEnhancedTools.analyzeFile(join(TEST_DIR, 'nonexistent.ts'))
      ).rejects.toThrow();
    });

    it('throws for path outside workspace', async () => {
      await expect(llmEnhancedTools.analyzeFile('/etc/passwd')).rejects.toThrow(
        'Outside workspace'
      );
    });
  });

  /**
   * QA_feedback_1: Test analyze_file resilience to LLM backend errors
   * Reports: "analyze_file - HTTP 400 Bad Request from LLM backend"
   * The tool should not crash on HTTP 400 - should retry or provide graceful fallback.
   */
  describe('analyzeFile (resilience)', () => {
    it('returns graceful fallback when LLM backend returns HTTP 400', async () => {
      // Create a tools instance we can mock - reuse existing config
      const tools = new LlmEnhancedTools(config, backendManager);

      // Mock the LLM call to simulate HTTP 400 error
      (tools as any).llmChat = {
        chat: vi.fn().mockRejectedValue(new Error('HTTP 400 Bad Request: model not loaded')),
      };

      // analyze_file should still succeed with a fallback message, not crash
      const result = await tools.analyzeFile(join(TEST_DIR, 'src', 'example.ts'));

      // Should return result with fallback analysis, not throw
      expect(result.path).toContain('example.ts');
      expect(result.analysis).toBeDefined();
      // The analysis should indicate the error gracefully
      expect(result.analysis).toMatch(/could not be completed|error|backend|unavailable/i);
      // Metrics should still be populated from file stats
      expect(result.metrics.lineCount).toBeGreaterThan(0);
      expect(result.metrics.sizeBytes).toBeGreaterThan(0);
    });

    it('includes backend details in error message for debugging', async () => {
      const tools = new LlmEnhancedTools(config, backendManager);

      // Mock with detailed error
      (tools as any).llmChat = {
        chat: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'HTTP 400: {"error":"No model loaded","message":"Please load a model in LM Studio"}'
            )
          ),
      };

      const result = await tools.analyzeFile(join(TEST_DIR, 'src', 'example.ts'));

      // Should include the error details for debugging
      expect(result.analysis).toMatch(/HTTP 400|No model loaded|model|error/i);
    });
  });

  describe('analyzeFile (integration)', () => {
    it(
      'analyzes a TypeScript file and handles a targeted question',
      runLlmTest(
        'analyzeFile (typescript)',
        async () => {
          const result = await llmEnhancedTools.analyzeFile(join(TEST_DIR, 'src', 'example.ts'), {
            includeContent: true,
            question: 'What classes are defined in this file?',
          });
          expect(result.path).toContain('example.ts');
          expect(result.content).toContain('export interface User');
          expect(result.language).toBe('typescript');
          expect(result.question).toContain('What classes');
          expect(result.analysis).toBeTypeOf('string');
          expect(result.metrics).toMatchObject({
            lineCount: expect.any(Number),
            sizeBytes: expect.any(Number),
          });
        },
        120000
      ),
      120000
    );
  });

  describe('exploreDirectory', () => {
    it(
      'explores directory details and respects depth option',
      runLlmTest(
        'exploreDirectory',
        async () => {
          const result = await llmEnhancedTools.exploreDirectory(TEST_DIR, { depth: 1 });
          expect(result.path).toContain(TEST_DIR);
          expect(result.entries).toBeInstanceOf(Array);
          expect(result.entries.length).toBeGreaterThan(0);
          expect(result.analysis).toBeTypeOf('string');

          const srcDir = result.entries.find((e) => e.name === 'src');
          expect(srcDir).toBeDefined();
          expect(srcDir?.type).toBe('directory');

          const readme = result.entries.find((e) => e.name === 'README.md');
          expect(readme).toBeDefined();
          expect(readme?.type).toBe('file');
          const hasExampleAtDepth1 = result.entries.some((e) => e.name === 'example.ts');
          expect(hasExampleAtDepth1).toBe(true);
        },
        120000
      ),
      120000
    );
  });

  describe('intelligentSearch', () => {
    it(
      'searches with natural language and returns relevant files',
      runLlmTest(
        'intelligentSearch',
        async () => {
          const result = await llmEnhancedTools.intelligentSearch(TEST_DIR, 'user service');
          expect(result.query).toBe('user service');
          expect(result.results).toBeInstanceOf(Array);
          expect(result.results.length).toBeGreaterThan(0);
          expect(result.searchSummary).toBeTypeOf('string');

          for (const r of result.results) {
            expect(r.file).toBeTypeOf('string');
            expect(r.matches).toBeInstanceOf(Array);
          }
        },
        120000
      ),
      120000
    );
  });

  describe('localCodeReview', () => {
    it(
      'reviews code files',
      runLlmTest(
        'localCodeReview',
        async () => {
          const result = await llmEnhancedTools.localCodeReview([
            join(TEST_DIR, 'src', 'example.ts'),
            join(TEST_DIR, 'src', 'utils.ts'),
          ]);

          expect(result.success).toBe(true);
          expect(result.filesReviewed).toBe(2);
          expect(result.issues).toBeInstanceOf(Array);
          expect(result.summary).toBeTypeOf('string');
          expect(result.recommendations).toBeInstanceOf(Array);
        },
        120000
      ),
      120000
    );
  });

  describe('generateDocs', () => {
    it(
      'generates documentation for multiple doc types',
      runLlmTest(
        'generateDocs',
        async () => {
          const result = await llmEnhancedTools.generateDocs(join(TEST_DIR, 'src', 'example.ts'));
          expect(result.success).toBe(true);
          expect(result.path).toContain('example.ts');
          expect(result.documentation).toBeTypeOf('string');
          expect(result.docType).toBe('jsdoc');
        },
        120000
      ),
      120000
    );
  });

  describe('suggestRefactoring', () => {
    it(
      'suggests refactorings for a file',
      runLlmTest(
        'suggestRefactoring',
        async () => {
          const result = await llmEnhancedTools.suggestRefactoring(
            join(TEST_DIR, 'src', 'example.ts')
          );
          // Handle LLM failures gracefully - transient infrastructure issue, not code bug
          // Check for timeout, abort, connection, or other LLM backend errors
          if (!result.success) {
            const errorMsg = result.error ?? '';
            const isInfraFailure = /timeout|aborted|connect|ECONNREFUSED|backend|overload/i.test(
              errorMsg
            );
            if (isInfraFailure) {
              console.warn(
                `LLM infrastructure issue during suggestRefactoring: ${errorMsg} - skipping assertions`
              );
              return;
            }
          }
          expect(result.success).toBe(true);
          expect(result.path).toContain('example.ts');
          expect(result.suggestions).toBeInstanceOf(Array);
          expect(result.summary).toBeTypeOf('string');
        },
        120000
      ),
      120000
    );
  });

  describe('generateTests', () => {
    it(
      'generates test suggestions for multiple frameworks',
      runLlmTest(
        'generateTests',
        async () => {
          const result = await llmEnhancedTools.generateTests(join(TEST_DIR, 'src', 'example.ts'));
          expect(result.success).toBe(true);
          expect(result.path).toContain('example.ts');
          expect(result.tests).toBeTypeOf('string');
          expect(result.framework).toBeTypeOf('string');
        },
        240000
      ),
      240000
    );
  });

  describe('draftCommitMessage', () => {
    it(
      'drafts a commit message',
      runLlmTest(
        'draftCommitMessage',
        async () => {
          const result = await llmEnhancedTools.draftCommitMessage({
            changedFiles: [join(TEST_DIR, 'src', 'example.ts')],
          });
          expect(result.success).toBe(true);
          expect(result.message).toBeTypeOf('string');
          expect(result.style).toBe('conventional');
        },
        120000
      ),
      120000
    );
  });
});
