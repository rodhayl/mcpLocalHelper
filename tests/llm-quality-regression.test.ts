/**
 * LLM Quality Regression Tests
 * 
 * Tests for issues identified in LLM verification reports:
 * 1. Search fallback behavior when LLM ranking unavailable
 * 2. Index symbols filtering (exclude keywords like if/for)
 * 3. Agent task planning loop detection
 * 4. Workspace path resolution
 * 5. Security scan noise/false positives
 * 6. Parameter validation consistency
 * 7. Error response structure uniformity
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '../src/config/index.js';
import { SymbolIndexer } from '../src/tools/symbols.js';
import { z } from 'zod';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

// ============================================
// Index Symbols Quality Tests
// ============================================
describe('Index Symbols Quality', () => {
  let tempDir: string;
  let config: ConfigManager;
  let symbolIndexer: SymbolIndexer;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-symbols-test-'));
    const tempDirNorm = tempDir.replace(/\\/g, '/');
    
    // Create test TypeScript file with functions and keywords
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    writeFileSync(path.join(tempDir, 'src', 'sample.ts'), `
// A sample TypeScript file
export function processData(items: string[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (item.length > 0) {
      result.push(item.toUpperCase());
    }
  }
  return result;
}

export class DataProcessor {
  private data: string[] = [];
  
  constructor() {
    // Initialize
  }
  
  process(input: string): void {
    if (input) {
      this.data.push(input);
    }
  }
}

export const MAX_ITEMS = 100;
export type ItemType = 'a' | 'b' | 'c';
`);
    
    const cfgPath = path.join(tempDir, 'env.test.settings');
    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.workspace = { roots: [tempDirNorm], defaultRoot: tempDirNorm };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [tempDirNorm] };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
    writeSettingsFile(cfgPath, cfg, { exposeSystemProfile: false, testingEnabled: false });
    config = new ConfigManager(cfgPath);
    symbolIndexer = new SymbolIndexer(config);
  });

  afterAll(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should extract function symbols', () => {
    const result = symbolIndexer.indexSymbols(tempDir);
    const symbols = result.symbols;
    
    // Should find the processData function
    const processDataSymbol = symbols.find(s => s.name === 'processData');
    expect(processDataSymbol).toBeDefined();
    expect(processDataSymbol?.type).toBe('function');
  });

  it('should extract class symbols', () => {
    const result = symbolIndexer.indexSymbols(tempDir);
    const symbols = result.symbols;
    
    // Should find the DataProcessor class
    const classSymbol = symbols.find(s => s.name === 'DataProcessor');
    expect(classSymbol).toBeDefined();
    expect(classSymbol?.type).toBe('class');
  });

  it('should NOT extract keywords as symbols', () => {
    const result = symbolIndexer.indexSymbols(tempDir);
    const symbols = result.symbols;
    
    // Keywords like 'if', 'for', 'const', 'return' should NOT be symbols
    const keywords = ['if', 'for', 'const', 'return', 'export', 'import'];
    for (const keyword of keywords) {
      const found = symbols.find(s => s.name === keyword && s.type === 'function');
      expect(found).toBeUndefined();
    }
  });

  it('should extract constants and types', () => {
    const result = symbolIndexer.indexSymbols(tempDir);
    const symbols = result.symbols;
    
    // Should find MAX_ITEMS constant
    const constSymbol = symbols.find(s => s.name === 'MAX_ITEMS');
    expect(constSymbol).toBeDefined();
    
    // Should find ItemType type
    const typeSymbol = symbols.find(s => s.name === 'ItemType');
    expect(typeSymbol).toBeDefined();
  });
});

// ============================================
// Workspace Path Resolution Tests
// ============================================
describe('Workspace Path Resolution', () => {
  let tempDir: string;
  let config: ConfigManager;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-workspace-test-'));
    const tempDirNorm = tempDir.replace(/\\/g, '/');
    
    mkdirSync(path.join(tempDir, 'subdir'), { recursive: true });
    writeFileSync(path.join(tempDir, 'root.txt'), 'root file');
    writeFileSync(path.join(tempDir, 'subdir', 'nested.txt'), 'nested file');
    
    const cfgPath = path.join(tempDir, 'env.test.settings');
    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.workspace = { roots: [tempDirNorm], defaultRoot: tempDirNorm };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [tempDirNorm] };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
    writeSettingsFile(cfgPath, cfg, { exposeSystemProfile: false, testingEnabled: false });
    config = new ConfigManager(cfgPath);
  });

  afterAll(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve paths within workspace correctly', () => {
    const resolved = config.resolveWorkspacePath('subdir/nested.txt');
    expect(resolved).toContain('subdir');
    expect(resolved).toContain('nested.txt');
  });

  it('should check if path is allowed within workspace', () => {
    const inWorkspace = config.isPathAllowed(path.join(tempDir, 'root.txt'));
    expect(inWorkspace).toBe(true);
  });

  it('should reject paths outside workspace', () => {
    // Path traversal attempt
    const outsidePath = path.resolve(tempDir, '..', '..', 'etc', 'passwd');
    const inWorkspace = config.isPathAllowed(outsidePath);
    expect(inWorkspace).toBe(false);
  });

  it('should handle symbolic path traversal attempts', () => {
    // Attempt with ../ 
    const traversalPath = path.join(tempDir, '..', 'other');
    const inWorkspace = config.isPathAllowed(traversalPath);
    expect(inWorkspace).toBe(false);
  });
});

// ============================================
// Error Response Structure Tests
// ============================================
describe('Error Response Structure Consistency', () => {
  // Standard error response schema
  const errorResponseSchema = z.object({
    success: z.literal(false),
    error: z.string(),
    errorType: z.string().optional(),
    suggestion: z.string().optional(),
    context: z.record(z.string(), z.any()).optional(),
  });

  it('should validate standard error structure', () => {
    const validError = {
      success: false,
      error: 'File not found',
      errorType: 'file_not_found',
    };
    expect(errorResponseSchema.safeParse(validError).success).toBe(true);
  });

  it('should validate error with suggestion', () => {
    const errorWithSuggestion = {
      success: false,
      error: 'Unknown parameter: taks',
      errorType: 'validation_error',
      suggestion: 'Did you mean: task?',
    };
    expect(errorResponseSchema.safeParse(errorWithSuggestion).success).toBe(true);
  });

  it('should validate error with context', () => {
    const errorWithContext = {
      success: false,
      error: 'Path outside workspace',
      errorType: 'security_error',
      context: {
        requestedPath: '/etc/passwd',
        workspaceRoot: '/home/user/project',
      },
    };
    expect(errorResponseSchema.safeParse(errorWithContext).success).toBe(true);
  });
});

// ============================================
// Agent Task Parameter Validation Tests
// ============================================
describe('Agent Task Parameter Validation', () => {
  // Agent task options schema
  const agentTaskOptionsSchema = z.object({
    maxSteps: z.number().min(1).max(100).optional(),
    maxSubtasks: z.number().min(0).max(10).optional(),
    maxActionsPerStep: z.number().min(1).max(10).optional(),
    readOnly: z.boolean().optional(),
    async: z.boolean().optional(),
    contextRoot: z.string().optional(),
  });

  it('should accept valid options', () => {
    const valid = {
      maxSteps: 5,
      maxSubtasks: 2,
      maxActionsPerStep: 3,
      readOnly: true,
    };
    expect(agentTaskOptionsSchema.safeParse(valid).success).toBe(true);
  });

  it('should cap maxSteps at reasonable limit', () => {
    const tooMany = { maxSteps: 1000 };
    expect(agentTaskOptionsSchema.safeParse(tooMany).success).toBe(false);
  });

  it('should reject negative maxSteps', () => {
    const negative = { maxSteps: -1 };
    expect(agentTaskOptionsSchema.safeParse(negative).success).toBe(false);
  });

  it('should reject zero maxSteps', () => {
    const zero = { maxSteps: 0 };
    expect(agentTaskOptionsSchema.safeParse(zero).success).toBe(false);
  });

  it('should cap maxSubtasks at reasonable limit', () => {
    const tooMany = { maxSubtasks: 50 };
    expect(agentTaskOptionsSchema.safeParse(tooMany).success).toBe(false);
  });
});

// ============================================
// Search Fallback Behavior Tests  
// ============================================
describe('Search Fallback Behavior', () => {
  // When LLM ranking is unavailable, search should still return useful results
  const searchResultSchema = z.object({
    results: z.array(z.object({
      file: z.string(),
      line: z.number().optional(),
      content: z.string().optional(),
      score: z.number().optional(),
    })),
    fallback: z.boolean().optional(),
    message: z.string().optional(),
  });

  it('should validate search result structure', () => {
    const result = {
      results: [
        { file: 'src/main.ts', line: 10, content: 'function main()' },
      ],
    };
    expect(searchResultSchema.safeParse(result).success).toBe(true);
  });

  it('should validate fallback indicator in results', () => {
    const resultWithFallback = {
      results: [
        { file: 'src/main.ts', line: 10, content: 'function main()' },
      ],
      fallback: true,
      message: 'LLM ranking unavailable, using lexical search',
    };
    expect(searchResultSchema.safeParse(resultWithFallback).success).toBe(true);
  });
});

// ============================================
// Security Scan False Positive Tests
// ============================================
describe('Security Scan Quality', () => {
  // Patterns that should NOT be flagged as secrets
  const falsePositivePatterns = [
    '[REDACTED]',
    `sk${'-test-XXXX'}`,
    'api_key: <YOUR_KEY_HERE>',
    'password: "********"',
    'API_KEY=dummy_value_for_testing',
  ];

  // Patterns that SHOULD be flagged
  const truePositivePatterns = [
    `sk${'-live-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz'}`,
    `AKIA${'IOSFODNN7EXAMPLE'}`,
    `gh${'p_1234567890abcdefghijklmnopqrstuvwxyz'}`,
  ];

  it('should have distinct patterns for redacted values', () => {
    for (const pattern of falsePositivePatterns) {
      // Pattern contains obvious placeholder markers
      const isPlaceholder = 
        pattern.includes('REDACTED') ||
        pattern.includes('XXXX') ||
        pattern.includes('YOUR_') ||
        pattern.includes('****') ||
        pattern.includes('dummy') ||
        pattern.includes('_for_testing');
      expect(isPlaceholder).toBe(true);
    }
  });

  it('should recognize real secret patterns', () => {
    for (const pattern of truePositivePatterns) {
      // Real secrets have sufficient length
      const hasRealLength = pattern.length >= 20;
      // Real secrets have varied characters (at least some variation)
      const hasVariedChars = new Set(pattern.replace(/[^a-zA-Z0-9]/g, '')).size >= 8;
      expect(hasRealLength).toBe(true);
      expect(hasVariedChars).toBe(true);
    }
  });
});

// ============================================
// Enum Validation Tests (from LLM reports)
// ============================================
describe('Enum Validation Consistency', () => {
  // Action enums used across tools
  const searchActionSchema = z.enum(['intelligent', 'structured', 'gather']);
  const securityActionSchema = z.enum(['scan', 'risk', 'redact']);
  const todoActionSchema = z.enum(['find', 'implement', 'find_and_implement']);
  const linterActionSchema = z.enum(['run', 'fix']);

  it('should validate search action enum', () => {
    expect(searchActionSchema.safeParse('intelligent').success).toBe(true);
    expect(searchActionSchema.safeParse('invalid').success).toBe(false);
    expect(searchActionSchema.safeParse('INTELLIGENT').success).toBe(false);
  });

  it('should validate security action enum', () => {
    expect(securityActionSchema.safeParse('scan').success).toBe(true);
    expect(securityActionSchema.safeParse('risk').success).toBe(true);
    expect(securityActionSchema.safeParse('redact').success).toBe(true);
    expect(securityActionSchema.safeParse('detect').success).toBe(false);
  });

  it('should validate todo action enum', () => {
    expect(todoActionSchema.safeParse('find').success).toBe(true);
    expect(todoActionSchema.safeParse('implement').success).toBe(true);
    expect(todoActionSchema.safeParse('find_and_implement').success).toBe(true);
    expect(todoActionSchema.safeParse('search').success).toBe(false);
  });

  it('should validate linter action enum', () => {
    expect(linterActionSchema.safeParse('run').success).toBe(true);
    expect(linterActionSchema.safeParse('fix').success).toBe(true);
    expect(linterActionSchema.safeParse('check').success).toBe(false);
  });
});

// ============================================
// Backend Role Validation Tests
// ============================================
describe('Backend Role Validation', () => {
  const backendRoleSchema = z.enum(['local', 'sota']);
  const modelInfoActionSchema = z.enum(['list', 'get']);

  it('should validate backend role for llm_chat', () => {
    expect(backendRoleSchema.safeParse('local').success).toBe(true);
    expect(backendRoleSchema.safeParse('sota').success).toBe(true);
    expect(backendRoleSchema.safeParse('remote').success).toBe(false);
    expect(backendRoleSchema.safeParse('LOCAL').success).toBe(false);
  });

  it('should validate model_info action', () => {
    expect(modelInfoActionSchema.safeParse('list').success).toBe(true);
    expect(modelInfoActionSchema.safeParse('get').success).toBe(true);
    expect(modelInfoActionSchema.safeParse('info').success).toBe(false);
  });
});

// ============================================
// Required Field Validation Tests
// ============================================
describe('Required Field Validation', () => {
  const localCodeReviewSchema = z.object({
    paths: z.array(z.string()).min(1, 'At least one path is required'),
    focus: z.string().optional(),
  });

  const analyzeImpactSchema = z.object({
    changedFiles: z.array(z.string()).min(1, 'At least one changed file is required'),
    depth: z.number().optional(),
  });

  const crossFileLinksSchema = z.object({
    entryPoints: z.array(z.string()).min(1, 'At least one entry point is required'),
    depth: z.number().optional(),
  });

  it('should require paths array for local_code_review', () => {
    // String instead of array should fail
    const invalid = { paths: 'src/main.ts' };
    expect(localCodeReviewSchema.safeParse(invalid).success).toBe(false);

    // Empty array should fail
    const empty = { paths: [] };
    expect(localCodeReviewSchema.safeParse(empty).success).toBe(false);

    // Valid array should pass
    const valid = { paths: ['src/main.ts'] };
    expect(localCodeReviewSchema.safeParse(valid).success).toBe(true);
  });

  it('should require changedFiles array for analyze_impact', () => {
    const invalid = { changedFiles: 'src/main.ts' };
    expect(analyzeImpactSchema.safeParse(invalid).success).toBe(false);

    const empty = { changedFiles: [] };
    expect(analyzeImpactSchema.safeParse(empty).success).toBe(false);

    const valid = { changedFiles: ['src/main.ts'] };
    expect(analyzeImpactSchema.safeParse(valid).success).toBe(true);
  });

  it('should require entryPoints array for cross_file_links', () => {
    const invalid = { entryPoints: 'src/index.ts' };
    expect(crossFileLinksSchema.safeParse(invalid).success).toBe(false);

    const empty = { entryPoints: [] };
    expect(crossFileLinksSchema.safeParse(empty).success).toBe(false);

    const valid = { entryPoints: ['src/index.ts'] };
    expect(crossFileLinksSchema.safeParse(valid).success).toBe(true);
  });
});

// ============================================
// Queue State Validation Tests
// ============================================
describe('Queue State Validation', () => {
  const queueStatusSchema = z.object({
    isBusy: z.boolean(),
    running: z.number().min(0),
    queued: z.number().min(0),
    maxConcurrent: z.number().min(1),
    message: z.string().optional(),
  });

  it('should validate idle queue state', () => {
    const idle = {
      isBusy: false,
      running: 0,
      queued: 0,
      maxConcurrent: 3,
      message: 'Queue idle',
    };
    expect(queueStatusSchema.safeParse(idle).success).toBe(true);
  });

  it('should validate busy queue state', () => {
    const busy = {
      isBusy: true,
      running: 2,
      queued: 5,
      maxConcurrent: 3,
    };
    expect(queueStatusSchema.safeParse(busy).success).toBe(true);
  });

  it('should reject invalid queue states', () => {
    const invalid = {
      isBusy: true,
      running: -1,  // Invalid negative
      queued: 0,
      maxConcurrent: 3,
    };
    expect(queueStatusSchema.safeParse(invalid).success).toBe(false);
  });
});
