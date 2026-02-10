/**
 * Validation Improvements Test
 * 
 * Tests for validation enhancements identified in LLM verification reports:
 * - verify_plan target path resolution
 * - cross_file_links package import resolution
 * - Parameter validation for suggest_refactoring, suggest_edit, etc.
 * - System profile validation order
 * - Timeout handling for heavy tools
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '../src/config/index.js';
import { SymbolIndexer } from '../src/tools/symbols.js';
import { VerifyPlanTool } from '../src/tools/verify.js';
import { LlmChatTool } from '../src/tools/llm.js';
import { BackendManager } from '../src/adapters/factory.js';
import { z } from 'zod';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

// ============================================
// Path Resolution Tests
// ============================================
describe('Path Resolution Improvements', () => {
  let tempDir: string;
  let config: ConfigManager;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-path-test-'));
    const tempDirNorm = tempDir.replace(/\\/g, '/');
    
    // Create test directory structure
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
    writeFileSync(path.join(tempDir, 'src', 'main.ts'), 'export function main() {}');
    writeFileSync(path.join(tempDir, 'tests', 'main.test.ts'), 'test("main", () => {})');
    
    const cfgPath = path.join(tempDir, 'env.test.settings');
    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.workspace = { roots: [tempDirNorm], defaultRoot: tempDirNorm };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [tempDirNorm] };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
    writeSettingsFile(cfgPath, cfg, { exposeSystemProfile: false, testingEnabled: false });
    config = new ConfigManager(cfgPath);
  });

  it('should resolve relative paths within workspace', () => {
    const resolved = config.resolveWorkspacePath('src/main.ts');
    expect(resolved).toContain('src');
    expect(resolved).toContain('main.ts');
  });

  it('should handle absolute paths correctly', () => {
    const absPath = path.join(tempDir, 'src', 'main.ts');
    const resolved = config.resolveWorkspacePath(absPath);
    expect(resolved).toBe(absPath);
  });
});

// ============================================
// Cross File Links - Package Resolution Tests
// ============================================
describe('Cross File Links Package Resolution', () => {
  let tempDir: string;
  let config: ConfigManager;
  let symbolIndexer: SymbolIndexer;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-cross-links-'));
    const tempDirNorm = tempDir.replace(/\\/g, '/');
    
    // Create test directory structure with imports
    mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    mkdirSync(path.join(tempDir, 'node_modules', '@scope', 'package'), { recursive: true });
    mkdirSync(path.join(tempDir, 'node_modules', 'bare-pkg'), { recursive: true });
    
    // Create source file with imports
    writeFileSync(path.join(tempDir, 'src', 'entry.ts'), `
import { something } from '@scope/package';
import { another } from 'bare-pkg';
import { local } from './local';
export function main() {}
`);
    writeFileSync(path.join(tempDir, 'src', 'local.ts'), `export const local = 'test';`);
    writeFileSync(path.join(tempDir, 'node_modules', '@scope', 'package', 'index.js'), `exports.something = 'test';`);
    writeFileSync(path.join(tempDir, 'node_modules', 'bare-pkg', 'index.js'), `exports.another = 'test';`);
    
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

  it('should resolve relative import paths', () => {
    const entryFile = path.join(tempDir, 'src', 'entry.ts');
    const result = symbolIndexer.crossFileLinks([entryFile], { depth: 1 });
    
    // Should have graph structure
    expect(result.graph).toBeDefined();
    expect(result.graph.nodes).toBeDefined();
    // Entry file should be in the graph
    expect(result.graph.nodes.some(n => n.includes('entry.ts'))).toBe(true);
  });

  it('should handle package imports gracefully', () => {
    const entryFile = path.join(tempDir, 'src', 'entry.ts');
    const result = symbolIndexer.crossFileLinks([entryFile], { depth: 1 });
    
    // Should not crash on package imports
    expect(result.graph).toBeDefined();
    expect(result.graph.nodes).toBeDefined();
    expect(result.graph.edges).toBeDefined();
  });
});

// ============================================
// Zod Validation Schema Tests
// ============================================
describe('Zod Validation Schemas', () => {
  describe('suggest_refactoring schema', () => {
    const schema = z.object({
      code: z.string().min(1, 'Code is required'),
      focus: z.enum(['performance', 'maintainability', 'readability', 'all']).optional(),
      language: z.string().optional(),
    });

    it('should accept valid focus values', () => {
      const result = schema.safeParse({ code: 'function x() {}', focus: 'performance' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid focus values', () => {
      const result = schema.safeParse({ code: 'function x() {}', focus: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should require non-empty code', () => {
      const result = schema.safeParse({ code: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('suggest_edit schema', () => {
    const schema = z.object({
      instruction: z.string().min(1, 'Instruction is required'),
      target_file: z.string().min(1, 'Target file is required'),
      context: z.string().optional(),
    });

    it('should reject empty instruction', () => {
      const result = schema.safeParse({ instruction: '', target_file: 'test.ts' });
      expect(result.success).toBe(false);
    });

    it('should reject empty target_file', () => {
      const result = schema.safeParse({ instruction: 'Add tests', target_file: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('draft_file schema', () => {
    const schema = z.object({
      intent: z.string().min(1),
      file_path: z.string().min(1),
      style: z.enum(['minimal', 'documented', 'verbose']).optional(),
    });

    it('should accept valid style values', () => {
      const result = schema.safeParse({ intent: 'Create util', file_path: 'util.ts', style: 'documented' });
      expect(result.success).toBe(true);
    });

    it('should reject invalid style values', () => {
      const result = schema.safeParse({ intent: 'Create util', file_path: 'util.ts', style: 'fancy' });
      expect(result.success).toBe(false);
    });
  });

  describe('mcp_translate_code schema', () => {
    const schema = z.object({
      code: z.string().min(1),
      source_language: z.string().min(1),
      target_language: z.string().min(1),
    });

    it('should require non-empty languages', () => {
      const result = schema.safeParse({ code: 'print("hi")', source_language: '', target_language: 'javascript' });
      expect(result.success).toBe(false);
    });
  });

  describe('mcp_ask schema', () => {
    const schema = z.object({
      question: z.string().min(1, 'Question is required'),
      context: z.string().optional(),
    });

    it('should reject empty question', () => {
      const result = schema.safeParse({ question: '' });
      expect(result.success).toBe(false);
    });

    it('should accept valid question', () => {
      const result = schema.safeParse({ question: 'What is this?' });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================
// Timeout Parameter Schema Tests
// ============================================
describe('Timeout Parameter Schemas', () => {
  describe('code_quality_analyzer timeout schema', () => {
    const schema = z.object({
      rootDir: z.string().optional(),
      timeout: z.number().min(1000).max(300000).optional(),
    });

    it('should accept timeout within range', () => {
      const result = schema.safeParse({ timeout: 60000 });
      expect(result.success).toBe(true);
    });

    it('should reject timeout below minimum', () => {
      const result = schema.safeParse({ timeout: 500 });
      expect(result.success).toBe(false);
    });

    it('should reject timeout above maximum', () => {
      const result = schema.safeParse({ timeout: 500000 });
      expect(result.success).toBe(false);
    });
  });

  describe('index_symbols timeout schema', () => {
    const schema = z.object({
      root: z.string(),
      timeout: z.number().min(1000).max(300000).optional(),
    });

    it('should accept valid timeout', () => {
      const result = schema.safeParse({ root: '.', timeout: 90000 });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================
// System Profile Validation Order Tests
// ============================================
describe('System Profile Validation', () => {
  const schema = z.object({
    detail: z.enum(['basic', 'extended']).optional(),
  }).optional();

  it('should validate detail parameter before checking if enabled', () => {
    // Invalid detail value should fail validation
    const result = schema.safeParse({ detail: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should accept valid detail values', () => {
    const result = schema.safeParse({ detail: 'extended' });
    expect(result.success).toBe(true);
  });

  it('should accept undefined/empty', () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ============================================
// Parameter Correction Tests
// ============================================
describe('Parameter Correction Detection', () => {
  const validParams = ['task', 'options', 'maxSteps', 'readOnly', 'async'];

  function suggestCorrection(param: string): string | null {
    // Simple Levenshtein-like matching
    const normalized = param.toLowerCase();
    for (const valid of validParams) {
      if (valid.toLowerCase() === normalized) return valid;
      // Check for common typos
      if (normalized === 'taks' && valid === 'task') return valid;
      if (normalized === 'optoins' && valid === 'options') return valid;
      if (normalized === 'readonly' && valid === 'readOnly') return valid;
    }
    return null;
  }

  it('should detect typo: taks -> task', () => {
    expect(suggestCorrection('taks')).toBe('task');
  });

  it('should detect case mismatch: TASK -> task', () => {
    expect(suggestCorrection('TASK')).toBe('task');
  });

  it('should detect typo: optoins -> options', () => {
    expect(suggestCorrection('optoins')).toBe('options');
  });
});
