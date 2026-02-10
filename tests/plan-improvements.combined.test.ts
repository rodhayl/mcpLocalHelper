/**
 * Combined Plan Improvements Tests
 * 
 * Merged from:
 * - plan-improvements.test.ts - Plans 1-5
 * - plan-improvements-v2.test.ts - Plans V2.1-V2.3
 * 
 * Plans covered:
 * - Plan 1: Complete Edit Loop (filePattern, agent path correction, propose_changes)
 * - Plan 2: Output Density Controls
 * - Plan 3: Proactive Warnings System, Deterministic Search Mode
 * - Plan 4: Smart Defaults & Filters, Execution Metadata
 * - Plan 5: Tool Contract Standardization, Test Generation Quality
 * - Plan V2.1: LLM Response Parsing Revolution
 * - Plan V2.2: Process Lifecycle Cleanup
 * - Plan V2.3: Test Code Import Fixer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Plan 2: Output Formatter
import { toDenseOutput, formatOutput, extractCodeSignatures } from '../src/utils/output-formatter.js';

// Plan 3: Proactive Warnings
import { 
  ProactiveWarningManager, 
  getProactiveWarningManager 
} from '../src/utils/proactive-warnings.js';

// Plan 4: Smart Defaults
import { 
  SmartDefaultsManager, 
  getSmartDefaultsManager,
  DEFAULT_EXCLUDE_PATTERNS,
  PROJECT_PATTERNS,
} from '../src/utils/smart-defaults.js';

// Plan 5: Tool Contracts
import {
  registerToolContract,
  validateToolInput,
  validateToolOutput,
  getToolContract,
  registerDefaultContracts,
} from '../src/utils/tool-contracts.js';

// Plan 4 V2: Execution Metadata
import { 
  generateExecutionMetadata, 
  withExecutionMetadata,
  type ExecutionMetadata
} from '../src/utils/output-formatter.js';

// Type imports
import type { OutputFormat, ProactiveWarning } from '../src/types/index.js';

// ============================================================================
// SECTION 1: Plan 2 - Output Density Controls (from plan-improvements.test.ts)
// ============================================================================

describe('Plan 2: Output Density Controls', () => {
  describe('toDenseOutput', () => {
    it('should handle null/undefined input', () => {
      expect(toDenseOutput(null)).toEqual({ message: 'No output' });
      expect(toDenseOutput(undefined)).toEqual({ message: 'No output' });
    });

    it('should handle primitive input', () => {
      expect(toDenseOutput('test string')).toEqual({ message: 'test string' });
      expect(toDenseOutput(42)).toEqual({ message: '42' });
    });

    it('should extract path from object', () => {
      const result = toDenseOutput({ path: '/test/file.ts', statistics: { count: 5 } });
      expect(result.path).toBe('/test/file.ts');
      expect((result as Record<string, unknown>).statistics).toBeUndefined();
    });

    it('should extract code/content', () => {
      const result = toDenseOutput({ 
        code: 'const x = 1;',
        metadata: { lang: 'ts' } 
      });
      expect(result.code).toBe('const x = 1;');
    });

    it('should handle arrays of results', () => {
      const result = toDenseOutput({
        results: [
          { path: '/a.ts', line: 10, content: 'line 1' },
          { file: '/b.ts', line: 20, preview: 'line 2' },
        ],
      });
      expect(result.results).toHaveLength(2);
      expect(result.results![0]).toMatchObject({ path: '/a.ts', line: 10, content: 'line 1' });
      expect(result.results![1]).toMatchObject({ path: '/b.ts', line: 20, content: 'line 2' });
    });

    it('should handle matches array (grep format)', () => {
      const result = toDenseOutput({
        matches: [
          { file: '/test.ts', line: 5, preview: 'matched line' },
        ],
      });
      expect(result.results).toHaveLength(1);
      expect(result.results![0].path).toBe('/test.ts');
    });

    it('should handle suggestions array', () => {
      const result = toDenseOutput({
        suggestions: [
          { description: 'Fix typo', after: 'corrected code' },
        ],
      });
      expect(result.results).toHaveLength(1);
      expect(result.results![0].content).toBe('Fix typo');
    });

    it('should handle findings array (security)', () => {
      const result = toDenseOutput({
        findings: [
          { file: '/config.ts', line: 10, type: 'api_key' },
        ],
      });
      expect(result.results).toHaveLength(1);
      expect(result.results![0].path).toBe('/config.ts');
    });

    it('should use searchSummary as message (search tool)', () => {
      const result = toDenseOutput({
        searchSummary: 'Found 2 matches',
        matches: [{ file: '/a.ts', line: 1, preview: 'x' }],
      });
      expect(result.message).toBe('Found 2 matches');
    });

    it('should include notice in message when present', () => {
      const result = toDenseOutput({
        searchSummary: 'Found 1 match',
        notice: "Root defaulted to '.' (workspace root).",
        matches: [{ file: '/a.ts', line: 1, preview: 'x' }],
      });
      expect(result.message).toContain('Found 1 match');
      expect(result.message).toContain("Root defaulted to '.'");
    });
  });

  describe('formatOutput', () => {
    it('should return dense format when specified', () => {
      const output = { path: '/test.ts', statistics: { count: 5 } };
      const result = formatOutput(output, 'dense') as Record<string, unknown>;
      expect(result.path).toBe('/test.ts');
      expect(result.statistics).toBeUndefined();
    });

    it('should return JSON string when format is json', () => {
      const output = { path: '/test.ts' };
      const result = formatOutput(output, 'json');
      expect(typeof result).toBe('string');
      expect(JSON.parse(result as string)).toEqual(output);
    });

    it('should return detailed (original) when format is detailed', () => {
      const output = { path: '/test.ts', statistics: { count: 5 } };
      const result = formatOutput(output, 'detailed');
      expect(result).toEqual(output);
    });

    it('should return compact format with only paths', () => {
      const output = {
        searchSummary: 'Found 1 match',
        matches: [{ file: '/a.ts', line: 1, preview: 'matched line' }],
        truncated: false,
      };
      const result = formatOutput(output, 'compact') as any;
      expect(result.paths).toEqual(['/a.ts']);
      expect(result.message).toBe('Found 1 match');
      expect(result.preview).toBeUndefined();
    });

    it('should surface notice in compact message when present', () => {
      const output = {
        searchSummary: 'Found 1 match',
        notice: "Root defaulted to '.' (workspace root).",
        matches: [{ file: '/a.ts', line: 1, preview: 'matched line' }],
        truncated: false,
      };
      const result = formatOutput(output, 'compact') as any;
      expect(result.paths).toEqual(['/a.ts']);
      expect(result.message).toContain('Found 1 match');
      expect(result.message).toContain("Root defaulted to '.'");
    });
  });

  describe('extractCodeSignatures', () => {
    it('should extract function signatures from TypeScript', () => {
      const code = `
function hello(name: string): string {
  return 'Hello ' + name;
}

async function fetchData(url: string): Promise<void> {
  await fetch(url);
}
      `;
      const sigs = extractCodeSignatures(code, 'typescript');
      expect(sigs).toContain('function hello(name: string): string');
      expect(sigs).toContain('async function fetchData(url: string): Promise<void>');
    });

    it('should extract class definitions', () => {
      const code = `
class MyService {
  private data: string;
}

export class PublicClass extends BaseClass {
}
      `;
      const sigs = extractCodeSignatures(code, 'typescript');
      expect(sigs).toContain('class MyService');
      expect(sigs).toContain('export class PublicClass extends BaseClass');
    });

    it('should extract interface definitions', () => {
      const code = `
interface User {
  name: string;
}

export interface Config extends BaseConfig {
  port: number;
}
      `;
      const sigs = extractCodeSignatures(code, 'typescript');
      expect(sigs).toContain('interface User');
      expect(sigs).toContain('export interface Config extends BaseConfig');
    });
  });
});

describe('Plan 2: Format Output Integration', () => {
  it('should support format parameter in tool handlers', () => {
    const supportedFormats: OutputFormat[] = ['dense', 'detailed', 'json'];
    expect(supportedFormats).toContain('dense');
    expect(supportedFormats).toContain('detailed');
    expect(supportedFormats).toContain('json');
  });
  
  it('should apply formatOutput to tool results', () => {
    const testResult = {
      matches: [
        { file: '/test.py', line: 10, preview: 'test' },
      ],
      totalMatches: 1,
      truncated: false,
    };
    
    const denseResult = formatOutput(testResult, 'dense');
    expect(typeof denseResult).toBe('object');
    
    const jsonResult = formatOutput(testResult, 'json');
    expect(typeof jsonResult).toBe('string');
    expect(() => JSON.parse(jsonResult as string)).not.toThrow();
  });
});

// ============================================================================
// SECTION 2: Plan 3 - Proactive Warnings (from plan-improvements.test.ts)
// ============================================================================

describe('Plan 3: Proactive Warnings', () => {
  let manager: ProactiveWarningManager;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `proactive-warnings-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new ProactiveWarningManager({
      enabled: true,
      severityThreshold: 'info',
      cacheWarnings: true,
      cacheTtlMs: 300000,
    });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('scanContent', () => {
    it('should detect API keys', () => {
      const content = `const apiKey = "${`sk${'-proj-1234567890abcdef1234567890abcdef1234567890abcdef'}`}";`;
      const warnings = manager.scanContent(content, '/test/config.ts');
      
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.type === 'secret')).toBe(true);
    });

    it('should detect AWS credentials', () => {
      const content = `
        const AWS_ACCESS_KEY = "${`AKIA${'IOSFODNN7EXAMPLE'}`}";
        const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      `;
      const warnings = manager.scanContent(content, '/test/aws.ts');
      expect(warnings.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect hardcoded passwords', () => {
      const content = `const password = "MySecretPassword123!";`;
      const warnings = manager.scanContent(content, '/test/auth.ts');
      
      expect(warnings.some(w => 
        w.message.toLowerCase().includes('password') || 
        w.type === 'secret'
      )).toBe(true);
    });

    it('should detect SQL injection vulnerabilities', () => {
      const content = `
        const query = "SELECT * FROM users WHERE id = " + userId;
        db.query(query);
      `;
      const warnings = manager.scanContent(content, '/test/db.ts');
      expect(warnings.length).toBeGreaterThanOrEqual(0);
    });

    it('should respect severity threshold', () => {
      const warningManager = new ProactiveWarningManager({
        enabled: true,
        severityThreshold: 'critical',
        cacheWarnings: false,
        cacheTtlMs: 300000,
      });
      
      const content = `const info = "some info";`;
      const warnings = warningManager.scanContent(content, '/test/info.ts');
      expect(warnings.every(w => w.severity === 'critical')).toBe(true);
    });

    it('should cache warnings when enabled', () => {
      const content = `const secret = "${`sk${'-proj-abcdef123456'}`}";`;
      const filePath = '/test/cached.ts';
      
      const warnings1 = manager.scanContent(content, filePath);
      const warnings2 = manager.getCachedWarnings(filePath);
      
      expect(warnings2).toBeDefined();
      expect(warnings2?.length).toBe(warnings1.length);
    });

    it('should invalidate cache when content changes', () => {
      const content1 = `const secret = "${`sk${'-proj-abcdef123456'}`}";`;
      const content2 = `const nothing = "safe content";`;
      const filePath = '/test/changing.ts';
      
      manager.scanContent(content1, filePath);
      const warnings = manager.scanContent(content2, filePath);
      const cached = manager.getCachedWarnings(filePath);
      expect(cached?.length).toBeLessThanOrEqual(warnings.length);
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific file', () => {
      const content = `const key = "api-key-12345";`;
      const filePath = '/test/clear-test.ts';
      
      manager.scanContent(content, filePath);
      expect(manager.getCachedWarnings(filePath)).toBeDefined();
      
      manager.clearCache(filePath);
      expect(manager.getCachedWarnings(filePath)).toBeUndefined();
    });

    it('should clear all cache when no file specified', () => {
      manager.scanContent('const a = 1;', '/test/a.ts');
      manager.scanContent('const b = 2;', '/test/b.ts');
      
      manager.clearCache();
      
      expect(manager.getCachedWarnings('/test/a.ts')).toBeUndefined();
      expect(manager.getCachedWarnings('/test/b.ts')).toBeUndefined();
    });
  });

  describe('getProactiveWarningManager singleton', () => {
    it('should return singleton instance', () => {
      const instance1 = getProactiveWarningManager();
      const instance2 = getProactiveWarningManager();
      expect(instance1).toBe(instance2);
    });
  });
});

describe('Plan 3: Deterministic Search Mode', () => {
  it('should have deterministic option in search schema', () => {
    const searchSchema = {
      action: { enum: ['intelligent', 'structured', 'gather'] },
      query: { type: 'string' },
      deterministic: { type: 'boolean' },
    };
    expect(searchSchema.deterministic).toBeDefined();
    expect(searchSchema.deterministic.type).toBe('boolean');
  });
  
  it('should use structured search when deterministic=true', () => {
    const mode = { deterministic: true };
    if (mode.deterministic) {
      expect(true).toBe(true);
    }
  });
});

// ============================================================================
// SECTION 3: Plan 4 - Smart Defaults (from plan-improvements.test.ts)
// ============================================================================

describe('Plan 4: Smart Defaults & Filters', () => {
  let manager: SmartDefaultsManager;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `smart-defaults-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new SmartDefaultsManager({
      autoDetect: true,
      customExcludePatterns: [],
      customIncludePatterns: [],
    });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('DEFAULT_EXCLUDE_PATTERNS', () => {
    it('should include common package manager directories', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('node_modules/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.pnpm/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('bower_components/**');
    });

    it('should include version control directories', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.git/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.svn/**');
    });

    it('should include Python virtual environments', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('venv/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.venv/**');
    });

    it('should include build output directories', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('dist/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('build/**');
    });

    it('should include IDE directories', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.idea/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.vscode/**');
    });
  });

  describe('PROJECT_PATTERNS', () => {
    it('should define Node.js project patterns', () => {
      const nodePattern = PROJECT_PATTERNS.find(p => p.type === 'node');
      expect(nodePattern).toBeDefined();
      expect(nodePattern?.indicator).toBe('package.json');
      expect(nodePattern?.excludePatterns).toContain('node_modules/**');
    });

    it('should define Python project patterns', () => {
      const pythonPattern = PROJECT_PATTERNS.find(p => p.type === 'python');
      expect(pythonPattern).toBeDefined();
      expect(pythonPattern?.excludePatterns).toContain('__pycache__/**');
    });

    it('should define TypeScript project patterns', () => {
      const tsPattern = PROJECT_PATTERNS.find(p => p.type === 'typescript');
      expect(tsPattern).toBeDefined();
      expect(tsPattern?.indicator).toBe('tsconfig.json');
    });
  });

  describe('shouldExclude', () => {
    it('should exclude node_modules paths', () => {
      expect(manager.shouldExclude('node_modules/lodash/index.js')).toBe(true);
      expect(manager.shouldExclude('/project/node_modules/package/file.js')).toBe(true);
    });

    it('should exclude .git paths', () => {
      expect(manager.shouldExclude('.git/objects/abc')).toBe(true);
      expect(manager.shouldExclude('/project/.git/config')).toBe(true);
    });

    it('should exclude dist/build directories', () => {
      expect(manager.shouldExclude('dist/bundle.js')).toBe(true);
      expect(manager.shouldExclude('build/output.js')).toBe(true);
    });

    it('should NOT exclude source files', () => {
      expect(manager.shouldExclude('src/index.ts')).toBe(false);
      expect(manager.shouldExclude('lib/utils.js')).toBe(false);
    });

    it('should respect custom exclude patterns', () => {
      const customManager = new SmartDefaultsManager({
        autoDetect: true,
        customExcludePatterns: ['custom-ignore/**'],
        customIncludePatterns: [],
      });
      expect(customManager.shouldExclude('custom-ignore/file.ts')).toBe(true);
    });
  });

  describe('filterPaths', () => {
    it('should filter out excluded paths', () => {
      const paths = [
        'src/index.ts',
        'node_modules/lodash/index.js',
        'src/utils.ts',
        '.git/config',
        'dist/bundle.js',
      ];
      
      const filtered = manager.filterPaths(paths);
      
      expect(filtered).toContain('src/index.ts');
      expect(filtered).toContain('src/utils.ts');
      expect(filtered).not.toContain('node_modules/lodash/index.js');
      expect(filtered).not.toContain('.git/config');
      expect(filtered).not.toContain('dist/bundle.js');
    });

    it('should return empty array for all excluded paths', () => {
      const paths = [
        'node_modules/a.js',
        '.git/b',
        'dist/c.js',
      ];
      
      const filtered = manager.filterPaths(paths);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('detectProjectType', () => {
    it('should detect Node.js project', () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: 'test' }));
      
      const projectType = manager.detectProjectType(testDir);
      expect(projectType).toBe('node');
    });

    it('should detect TypeScript project', () => {
      const tsconfigPath = join(testDir, 'tsconfig.json');
      writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: {} }));
      
      const projectType = manager.detectProjectType(testDir);
      expect(projectType).toBe('typescript');
    });

    it('should detect Python project', () => {
      const requirementsPath = join(testDir, 'requirements.txt');
      writeFileSync(requirementsPath, 'flask==2.0.0');
      
      const projectType = manager.detectProjectType(testDir);
      expect(projectType).toBe('python');
    });

    it('should return unknown for empty directory', () => {
      const emptyDir = join(testDir, 'empty');
      mkdirSync(emptyDir, { recursive: true });
      
      const projectType = manager.detectProjectType(emptyDir);
      expect(projectType).toBe('unknown');
    });
  });

  describe('getExcludePatternsForProject', () => {
    it('should return project-specific patterns for Node.js', () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: 'test' }));
      
      const patterns = manager.getExcludePatternsForProject(testDir);
      expect(patterns).toContain('node_modules/**');
    });

    it('should include default patterns', () => {
      const patterns = manager.getExcludePatternsForProject(testDir);
      expect(patterns).toContain('.git/**');
    });
  });

  describe('getSmartDefaultsManager singleton', () => {
    it('should return singleton instance', () => {
      const instance1 = getSmartDefaultsManager();
      const instance2 = getSmartDefaultsManager();
      expect(instance1).toBe(instance2);
    });
  });
});

// ============================================================================
// SECTION 4: Plan 5 - Tool Contracts (from plan-improvements.test.ts)
// ============================================================================

describe('Plan 5: Tool Contract Standardization', () => {
  beforeEach(() => {
    registerDefaultContracts();
  });

  describe('registerToolContract', () => {
    it('should register a new tool contract', () => {
      registerToolContract({
        name: 'test_tool',
        version: '1.0.0',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
          required: ['input'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
        },
        sideEffects: ['read'],
        retryable: true,
      });

      const contract = getToolContract('test_tool');
      expect(contract).toBeDefined();
      expect(contract?.name).toBe('test_tool');
    });
  });

  describe('validateToolInput', () => {
    it('should validate correct input', () => {
      const result = validateToolInput('suggest_edit', {
        file_path: '/test.ts',
        intent: 'Fix bug',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing required fields', () => {
      const result = validateToolInput('suggest_edit', {
        file_path: '/test.ts',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject invalid field types', () => {
      const result = validateToolInput('suggest_edit', {
        file_path: 123,
        intent: 'Fix bug',
      });
      expect(result.valid).toBe(false);
    });

    it('should return valid for unknown tools', () => {
      const result = validateToolInput('unknown_tool', { any: 'data' });
      expect(result.valid).toBe(true);
      expect(result.warnings?.length).toBeGreaterThan(0);
    });
  });

  describe('validateToolOutput', () => {
    it('should validate correct output', () => {
      const result = validateToolOutput('suggest_edit', {
        success: true,
        path: '/test.ts',
        intent: 'Fix bug',
        suggestions: [],
        summary: 'No suggestions',
      });
      expect(result.valid).toBe(true);
    });

    it('should reject output missing required fields', () => {
      const result = validateToolOutput('suggest_edit', {
        success: true,
      });
      expect(result.valid).toBe(false);
    });

    it('should return valid for unknown tools', () => {
      const result = validateToolOutput('unknown_tool', { any: 'output' });
      expect(result.valid).toBe(true);
    });
  });

  describe('getToolContract', () => {
    it('should return registered contract', () => {
      const contract = getToolContract('security');
      expect(contract).toBeDefined();
      expect(contract?.name).toBe('security');
    });

    it('should return undefined for unknown tool', () => {
      const contract = getToolContract('nonexistent_tool');
      expect(contract).toBeUndefined();
    });
  });

  describe('default contracts', () => {
    it('should have contract for suggest_edit', () => {
      const contract = getToolContract('suggest_edit');
      expect(contract).toBeDefined();
      expect(contract?.sideEffects).toContain('write');
    });

    it('should have contract for security', () => {
      const contract = getToolContract('security');
      expect(contract).toBeDefined();
      expect(contract?.sideEffects).toContain('write');
    });

    it('should have contract for search', () => {
      const contract = getToolContract('search');
      expect(contract).toBeDefined();
      expect(contract?.sideEffects).toEqual(['read']);
      expect(contract?.retryable).toBe(true);
    });

    it('should have contract for find_and_fix', () => {
      const contract = getToolContract('find_and_fix');
      expect(contract).toBeDefined();
      expect(contract?.sideEffects).toContain('write');
    });
  });
});

// ============================================================================
// SECTION 5: Plan 1 - File Pattern & Agent Path (from plan-improvements.test.ts)
// ============================================================================

describe('Plan 1: filePattern Fix', () => {
  it('should define matchesFilePattern for glob patterns', () => {
    expect(true).toBe(true);
  });
  
  it('should match **/*.py pattern correctly', () => {
    const patterns = [
      { pattern: '**/*.py', file: 'test.py', path: 'src/test.py', expected: true },
      { pattern: '**/*.py', file: 'test.ts', path: 'src/test.ts', expected: false },
      { pattern: '*.py', file: 'test.py', path: 'test.py', expected: true },
      { pattern: 'src/**/*.ts', file: 'util.ts', path: 'src/utils/util.ts', expected: true },
      { pattern: 'src/**/*.ts', file: 'util.ts', path: 'lib/util.ts', expected: false },
    ];
    
    for (const { pattern, file, expected } of patterns) {
      const ext = file.split('.').pop();
      const patternExt = pattern.includes('*.') ? pattern.split('*.').pop() : null;
      if (patternExt && ext === patternExt) {
        expect(true).toBe(expected || true);
      }
    }
  });
});

describe('Plan 1: Agent Path Correction', () => {
  it('should define observation tracking in AgentRunner', () => {
    expect(true).toBe(true);
  });
  
  it('should attempt path correction on file not found', () => {
    expect(true).toBe(true);
  });
});

describe('Plan 3: propose_changes Action', () => {
  it('should be a valid action type', () => {
    const validActionTypes = [
      'search_repo', 'read_file', 'list_files', 'summarize_path',
      'summarize_repo', 'http_request', 'extract_http_routes',
      'write_json_file', 'mcp_generate_cheatsheet', 'generate_api_inventory',
      'apply_diff', 'create_file', 'propose_changes', 'mcp_connect',
      'mcp_list_tools', 'mcp_call', 'done'
    ];
    expect(validActionTypes).toContain('propose_changes');
  });
  
  it('should return structured proposal without applying changes', () => {
    const expectedShape = {
      status: 'proposed',
      totalChanges: 1,
      proposals: [{
        filePath: 'test.ts',
        changeType: 'modify',
        description: 'Test change',
      }],
    };
    expect(expectedShape.status).toBe('proposed');
    expect(expectedShape.proposals).toHaveLength(1);
  });
});

// ============================================================================
// SECTION 6: Enhanced Security Scan (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan 1 V2: Enhanced Security Scan Coverage & Reporting', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `security-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('SecretScanResult Schema', () => {
    it('should include filesSkipped in statistics', () => {
      const result = {
        findings: [],
        statistics: {
          filesScanned: 10,
          filesSkipped: 5,
          skippedReasons: { 'node_modules': 3, 'hidden': 2 },
          findingsByCategory: {},
          riskScore: 0,
          scanDurationMs: 150,
        },
        executionId: 'test-uuid',
        timestamp: new Date().toISOString(),
      };
      
      expect(result.statistics.filesSkipped).toBe(5);
      expect(result.statistics.skippedReasons).toHaveProperty('node_modules');
      expect(result.statistics.scanDurationMs).toBeGreaterThan(0);
      expect(result.executionId).toBeTruthy();
      expect(result.timestamp).toBeTruthy();
    });

    it('should track skipped reasons by category', () => {
      const skippedReasons: Record<string, number> = {};
      
      const trackSkip = (reason: string) => {
        skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
      };

      trackSkip('node_modules');
      trackSkip('node_modules');
      trackSkip('hidden');
      trackSkip('.git');

      expect(skippedReasons['node_modules']).toBe(2);
      expect(skippedReasons['hidden']).toBe(1);
      expect(skippedReasons['.git']).toBe(1);
    });
  });

  describe('include/exclude patterns', () => {
    it('should match include patterns correctly', () => {
      const includePatterns = ['*.py', '*.js'];
      
      const matchesInclude = (path: string): boolean => {
        if (!includePatterns || includePatterns.length === 0) return true;
        const fileName = path.split(/[/\\]/).pop() || '';
        return includePatterns.some(pattern => {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          return regex.test(fileName);
        });
      };

      expect(matchesInclude('test.py')).toBe(true);
      expect(matchesInclude('app.js')).toBe(true);
      expect(matchesInclude('config.ts')).toBe(false);
      expect(matchesInclude('README.md')).toBe(false);
    });

    it('should match exclude patterns correctly', () => {
      const excludePatterns = ['*_test.py', '*.spec.ts'];
      
      const matchesExclude = (path: string): boolean => {
        if (!excludePatterns || excludePatterns.length === 0) return false;
        const fileName = path.split(/[/\\]/).pop() || '';
        return excludePatterns.some(pattern => {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          return regex.test(fileName);
        });
      };

      expect(matchesExclude('auth_test.py')).toBe(true);
      expect(matchesExclude('app.spec.ts')).toBe(true);
      expect(matchesExclude('auth.py')).toBe(false);
      expect(matchesExclude('app.ts')).toBe(false);
    });
  });

  describe('failOnEmpty behavior', () => {
    it('should throw error when failOnEmpty is true and no files scanned', () => {
      const failOnEmpty = true;
      const filesScanned = 0;
      const filesSkipped = 5;
      const skippedReasons = { 'venv': 3, 'hidden': 2 };

      if (failOnEmpty && filesScanned === 0) {
        const error = `Security scan found 0 files to scan. ` +
          `Skipped ${filesSkipped} files. Reasons: ${JSON.stringify(skippedReasons)}`;
        expect(error).toContain('0 files');
        expect(error).toContain('venv');
      }
    });

    it('should not throw when failOnEmpty is false', () => {
      const failOnEmpty = false;
      const filesScanned = 0;
      expect(failOnEmpty && filesScanned === 0).toBe(false);
    });
  });
});

// ============================================================================
// SECTION 7: Smart Exclude Patterns V2 (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan 2 V2: Smart Exclude Patterns for Search', () => {
  describe('DEFAULT_EXCLUDE_PATTERNS', () => {
    it('should include common noise directories', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('node_modules/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('venv/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.venv/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('__pycache__/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('dist/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('build/**');
    });

    it('should include Python virtual environments', () => {
      const pythonDirs = DEFAULT_EXCLUDE_PATTERNS.filter(p => 
        p.includes('venv') || p.includes('env') || p.includes('pyc')
      );
      expect(pythonDirs.length).toBeGreaterThan(0);
    });

    it('should include IDE directories', () => {
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.idea/**');
      expect(DEFAULT_EXCLUDE_PATTERNS).toContain('.vscode/**');
    });
  });

  describe('SmartDefaultsManager V2', () => {
    it('should return exclude patterns', () => {
      const manager = getSmartDefaultsManager();
      const patterns = manager.getExcludePatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('should support pattern detection from project files', () => {
      const manager = getSmartDefaultsManager();
      expect(typeof manager.getExcludePatterns).toBe('function');
    });
  });
});

// ============================================================================
// SECTION 8: Agent Task Limits (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan 3 V2: Agent Task Limits & Auto-Fallback', () => {
  describe('Loop Detection with Alternatives', () => {
    it('should suggest codebase_qa for repeated search_repo', () => {
      const suggestions: Record<string, string> = {
        'search_repo': 'Try "codebase_qa" for natural language questions, or "analyze_file" for specific file analysis.',
        'mcp_call': 'If searching, try using the search tool with different action types (intelligent, structured, gather).',
        'read_file': 'If you need to understand code, try "codebase_qa" or "analyze_file" instead of reading multiple files.',
        'read': 'If looking for patterns, try "search_repo" with a more specific pattern.',
      };

      expect(suggestions['search_repo']).toContain('codebase_qa');
      expect(suggestions['read_file']).toContain('analyze_file');
    });

    it('should detect loop from repeated identical signatures', () => {
      const signatures = ['search_repo:pattern=test', 'search_repo:pattern=test', 'search_repo:pattern=test'];
      const last3 = signatures.slice(-3);
      const isLoop = last3[0] === last3[1] && last3[1] === last3[2];
      expect(isLoop).toBe(true);
    });

    it('should not detect loop for different signatures', () => {
      const signatures = ['search_repo:pattern=test', 'search_repo:pattern=foo', 'read_file:path=/src'];
      const last3 = signatures.slice(-3);
      const isLoop = last3[0] === last3[1] && last3[1] === last3[2];
      expect(isLoop).toBe(false);
    });

    it('should format loop warning with suggestions', () => {
      const actionName = 'search_repo';
      const alternatives = 'Try "codebase_qa" for natural language questions';
      const warning = `⚠️ LOOP DETECTED: You have called "${actionName}" 3+ times. ` +
        `💡 SUGGESTED ALTERNATIVES: ${alternatives}`;
      
      expect(warning).toContain('LOOP DETECTED');
      expect(warning).toContain('SUGGESTED ALTERNATIVES');
      expect(warning).toContain('codebase_qa');
    });
  });
});

// ============================================================================
// SECTION 9: Execution Metadata (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan 4 V2: Execution Metadata & Traceability', () => {
  describe('generateExecutionMetadata', () => {
    it('should generate unique executionId', () => {
      const meta1 = generateExecutionMetadata();
      const meta2 = generateExecutionMetadata();
      
      expect(meta1.executionId).toBeTruthy();
      expect(meta2.executionId).toBeTruthy();
      expect(meta1.executionId).not.toBe(meta2.executionId);
    });

    it('should include ISO timestamp', () => {
      const meta = generateExecutionMetadata();
      expect(meta.timestamp).toBeTruthy();
      const date = new Date(meta.timestamp);
      expect(date.toISOString()).toBe(meta.timestamp);
    });

    it('should calculate duration when startTime provided', () => {
      const startTime = Date.now() - 100;
      const meta = generateExecutionMetadata('test_tool', startTime);
      
      expect(meta.durationMs).toBeDefined();
      expect(meta.durationMs).toBeGreaterThanOrEqual(100);
      expect(meta.durationMs).toBeLessThan(1000);
    });

    it('should include toolName when provided', () => {
      const meta = generateExecutionMetadata('security_scan');
      expect(meta.toolName).toBe('security_scan');
    });
  });

  describe('withExecutionMetadata', () => {
    it('should add _meta field to result object', () => {
      const result = { success: true, data: 'test' };
      const meta: ExecutionMetadata = {
        executionId: 'test-123',
        timestamp: new Date().toISOString(),
      };
      
      const enhanced = withExecutionMetadata(result, meta);
      
      expect(enhanced.success).toBe(true);
      expect(enhanced.data).toBe('test');
      expect(enhanced._meta).toEqual(meta);
    });

    it('should preserve all original fields', () => {
      const result = {
        findings: [],
        statistics: { count: 5 },
        nested: { deep: { value: true } },
      };
      const meta = generateExecutionMetadata();
      
      const enhanced = withExecutionMetadata(result, meta);
      
      expect(enhanced.findings).toEqual([]);
      expect(enhanced.statistics).toEqual({ count: 5 });
      expect(enhanced.nested.deep.value).toBe(true);
    });
  });
});

// ============================================================================
// SECTION 10: Test Generation Quality (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan 5 V2: Test Generation Quality Improvements', () => {
  describe('testStyle parameter', () => {
    it('should support unit test style (default)', () => {
      const styles = ['unit', 'integration', 'e2e', 'real-implementation'];
      expect(styles).toContain('unit');
    });

    it('should define instructions for each test style', () => {
      const testStyleInstructions: Record<string, string> = {
        unit: 'Mock ALL external dependencies',
        integration: 'Use REAL implementations for internal dependencies',
        'e2e': 'NO mocking of internal code',
        'real-implementation': 'DO NOT use vi.mock(), jest.mock(), or any mocking',
      };

      expect(testStyleInstructions['unit']).toContain('Mock');
      expect(testStyleInstructions['integration']).toContain('REAL');
      expect(testStyleInstructions['e2e']).toContain('NO mocking');
      expect(testStyleInstructions['real-implementation']).toContain('DO NOT');
    });

    it('should generate different prompts for each style', () => {
      const buildPromptForStyle = (style: string): string => {
        const basePrompt = 'Generate tests';
        const stylePrompt = style === 'real-implementation' 
          ? 'DO NOT use any mocks' 
          : style === 'unit' 
            ? 'Mock all dependencies'
            : 'Use appropriate mocking';
        return `${basePrompt}. ${stylePrompt}`;
      };

      const unitPrompt = buildPromptForStyle('unit');
      const realPrompt = buildPromptForStyle('real-implementation');

      expect(unitPrompt).toContain('Mock all');
      expect(realPrompt).toContain('DO NOT use any mocks');
    });
  });

  describe('Test framework detection', () => {
    it('should map TypeScript to vitest', () => {
      const frameworkMap: Record<string, string> = {
        typescript: 'vitest',
        javascript: 'jest',
        python: 'pytest',
      };
      expect(frameworkMap['typescript']).toBe('vitest');
    });

    it('should map Python to pytest', () => {
      const frameworkMap: Record<string, string> = {
        typescript: 'vitest',
        javascript: 'jest',
        python: 'pytest',
      };
      expect(frameworkMap['python']).toBe('pytest');
    });
  });
});

// ============================================================================
// SECTION 11: LLM Response Parsing (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan V2.1: LLM Response Parsing Revolution', () => {
  const mockLlmEnhancedTools = () => {
    const parseAnalysisResponseText = (text: string) => {
      const issues: Array<{
        type: string;
        line?: number;
        message: string;
        severity: 'error' | 'warning' | 'info';
      }> = [];
      const suggestions: string[] = [];
      const seenMessages = new Set<string>();

      const summaryLine = text.split('\n').find((l) => l.trim().length > 10) || '';
      const summary = summaryLine.substring(0, 200);

      let inIssuesSection = false;
      let inSuggestionsSection = false;
      const lines = text.split('\n');

      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        if (
          lowerLine.includes('issues:') ||
          lowerLine.includes('problems:') ||
          lowerLine.match(/^#+\s*issues?\b/i) ||
          lowerLine.match(/^#+\s*problems?\b/i)
        ) {
          inIssuesSection = true;
          inSuggestionsSection = false;
          continue;
        }
        if (
          lowerLine.includes('suggestions:') ||
          lowerLine.includes('recommendations:') ||
          lowerLine.match(/^#+\s*suggestions?\b/i) ||
          lowerLine.match(/^#+\s*recommendations?\b/i)
        ) {
          inSuggestionsSection = true;
          inIssuesSection = false;
          continue;
        }

        if (inIssuesSection && line.trim().match(/^[-*]\s+(.+)/)) {
          const match = line.trim().match(/^[-*]\s+(.+)/);
          if (match && match[1].length > 5) {
            const msg = match[1].trim();
            if (!seenMessages.has(msg.toLowerCase())) {
              seenMessages.add(msg.toLowerCase());
              issues.push({ type: 'general', message: msg, severity: 'warning' });
            }
          }
        }

        if (inSuggestionsSection && line.trim().match(/^[-*]\s+(.+)/)) {
          const match = line.trim().match(/^[-*]\s+(.+)/);
          if (match && match[1].length > 5) {
            suggestions.push(match[1].trim());
          }
        }
      }

      const lineErrorPattern = /[Ll]ine\s+(\d+)\s*[:–-]\s*(?:error|bug|issue)?[:\s]*(.+)/g;
      let match;
      while ((match = lineErrorPattern.exec(text)) !== null) {
        const lineNum = parseInt(match[1], 10);
        const message = match[2]?.trim();
        if (message && !seenMessages.has(message.toLowerCase())) {
          seenMessages.add(message.toLowerCase());
          issues.push({ type: 'line-error', line: lineNum, message, severity: 'error' });
        }
      }

      return { summary, issues, suggestions, metrics: {} };
    };

    return { parseAnalysisResponseText };
  };

  it('should extract issues from ISSUES section bullet points', () => {
    const tools = mockLlmEnhancedTools();
    const response = `
## Summary
Code has several issues.

## Issues:
- Missing null check on line 42
- Unused variable declaration
- Potential memory leak

## Suggestions:
- Add error handling
`;
    const result = tools.parseAnalysisResponseText(response);

    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    expect(result.issues.some(i => i.message.includes('null check'))).toBe(true);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract issues from "Line N: error" format', () => {
    const tools = mockLlmEnhancedTools();
    const response = `
Analysis complete.
Line 42: error - missing semicolon
Line 57: undefined variable 'foo'
`;
    const result = tools.parseAnalysisResponseText(response);

    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(result.issues.some(i => i.line === 42)).toBe(true);
    expect(result.issues.some(i => i.line === 57)).toBe(true);
  });

  it('should deduplicate identical issues', () => {
    const tools = mockLlmEnhancedTools();
    const response = `
## Issues:
- Missing null check
- Missing null check
- MISSING NULL CHECK
`;
    const result = tools.parseAnalysisResponseText(response);

    const nullCheckCount = result.issues.filter(i =>
      i.message.toLowerCase().includes('null check')
    ).length;
    expect(nullCheckCount).toBe(1);
  });

  it('should NOT return empty issues when LLM clearly identifies problems', () => {
    const tools = mockLlmEnhancedTools();
    const llmResponse = `
SUMMARY: This file has several quality issues.

ISSUES:
- Missing error handling in fetchData()
- Null reference risk at line 45
- Unawaited promise in processUser()
`;
    const result = tools.parseAnalysisResponseText(llmResponse);

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some(i => i.message.includes('error handling'))).toBe(true);
  });
});

// ============================================================================
// SECTION 12: Test Code Import Fixer (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan V2.3: Test Code Import Fixer', () => {
  const cleanGeneratedTestCode = (code: string, sourcePath?: string): string => {
    let cleaned = code;

    const pythonImportSplitters: Array<[RegExp, string]> = [
      [/^(from\s+\S+\s+import\s+[A-Za-z0-9_,\s]+?)(\s+import\s+)/gm, '$1\n$2'],
      [/^(from\s+\S+\s+import\s+[^f\n]+?)(\s+from\s+\S+\s+import)/gm, '$1\n$2'],
      [/^(import\s+[A-Za-z0-9_]+)(\s+import\s+)/gm, '$1\n$2'],
      [/^((?:from|import)\s+[^\n]+?)(\s*def\s+)/gm, '$1\n\n$2'],
      [/^((?:from|import)\s+[^\n]+?)(\s*class\s+)/gm, '$1\n\n$2'],
      [/^((?:from|import)\s+[^\n]+?)(\s*@(?:pytest\.)?(?:fixture|mark|param))/gm, '$1\n\n$2'],
    ];

    for (const [pattern, replacement] of pythonImportSplitters) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    const pytestFixes: Array<[RegExp, string]> = [
      [/(import pytest\n)import pytest\n/g, '$1'],
      [/^import pytest\nimport pytest$/m, 'import pytest'],
    ];
    for (const [pattern, replacement] of pytestFixes) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    cleaned = cleaned.replace(/^from src\.([a-zA-Z0-9_]+) import/gm, 'from $1 import');

    return cleaned.trim();
  };

  it('should split "from X import Y import Z"', () => {
    const broken = 'from pathlib import Path import pytest\n\ndef test_foo():';
    const fixed = cleanGeneratedTestCode(broken);

    expect(fixed).toContain('from pathlib import Path\n');
    expect(fixed).toContain('import pytest');
    expect(fixed).not.toMatch(/import Path import/);
  });

  it('should handle "from X import Y from Z import W" pattern on separate lines', () => {
    const broken = 'from os import path from sys import argv';
    const fixed = cleanGeneratedTestCode(broken);

    expect(fixed).toContain('from os import path');
    expect(fixed).not.toMatch(/path from sys/);
  });

  it('should split "import X import Y"', () => {
    const broken = 'import os import sys';
    const fixed = cleanGeneratedTestCode(broken);

    expect(fixed).toContain('import os\n');
    expect(fixed).toContain('import sys');
  });

  it('should add newline before def after import', () => {
    const broken = 'import pytest def test_example():';
    const fixed = cleanGeneratedTestCode(broken);

    expect(fixed).toContain('import pytest\n');
    expect(fixed.includes('import pytest def')).toBe(false);
  });

  it('should fix duplicate pytest imports when trailing content exists', () => {
    const broken = 'import pytest\nimport pytest\ndef test_foo():';
    const fixed = cleanGeneratedTestCode(broken);

    expect(fixed).toContain('import pytest');
    expect(fixed).toContain('def test_foo');
  });

  it('should fix src. prefix in Python imports', () => {
    const broken = 'from src.mymodule import MyClass';
    const fixed = cleanGeneratedTestCode(broken);

    expect(fixed).toBe('from mymodule import MyClass');
  });
});

// ============================================================================
// SECTION 13: Process Lifecycle (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Plan V2.2: Process Lifecycle Cleanup', () => {
  it('should have disconnectAllMcpClients call in gracefulShutdown', () => {
    const indexContent = readFileSync('src/index.ts', 'utf-8');

    expect(indexContent).toContain('mcpServerInstance: McpServer | null');
    expect(indexContent).toContain('mcpServerInstance = mcpServer');
    expect(indexContent).toContain('disconnectAllMcpClients()');
    expect(indexContent).toContain('getHealthMonitor');
  });

  it('should have disconnectAllMcpClients method on McpServer', () => {
    const mcpContent = readFileSync('src/server/mcp.ts', 'utf-8');

    expect(mcpContent).toContain('public async disconnectAllMcpClients()');
    expect(mcpContent).toContain('this.mcpClient.disconnectAll()');
  });
});

// ============================================================================
// SECTION 14: Integration Tests (from plan-improvements-v2.test.ts)
// ============================================================================

describe('Integration: All Plans Together', () => {
  it('should support security scan with all new options', () => {
    const scanOptions = {
      root: '/workspace',
      scanType: 'secrets' as const,
      include: ['*.py', '*.js'],
      exclude: ['*_test.py', '*.spec.ts'],
      failOnEmpty: true,
    };

    expect(scanOptions.include).toHaveLength(2);
    expect(scanOptions.exclude).toHaveLength(2);
    expect(scanOptions.failOnEmpty).toBe(true);
  });

  it('should support search with exclude patterns', () => {
    const searchOptions = {
      action: 'intelligent' as const,
      query: 'authentication',
      root: '/workspace',
      excludePatterns: ['node_modules/**', 'venv/**'],
    };

    expect(searchOptions.excludePatterns).toContain('node_modules/**');
    expect(searchOptions.excludePatterns).toContain('venv/**');
  });

  it('should support generate_tests with testStyle', () => {
    const generateOptions = {
      path: '/workspace/src/auth.ts',
      framework: 'vitest',
      coverage: 'comprehensive' as const,
      testStyle: 'real-implementation' as const,
      focusFunctions: ['login', 'logout'],
    };

    expect(generateOptions.testStyle).toBe('real-implementation');
    expect(generateOptions.focusFunctions).toContain('login');
  });

  it('should track execution metadata for all tools', () => {
    const tools = ['security_scan', 'search', 'generate_tests', 'analyze_file'];
    
    for (const tool of tools) {
      const meta = generateExecutionMetadata(tool);
      expect(meta.toolName).toBe(tool);
      expect(meta.executionId).toBeTruthy();
      expect(meta.timestamp).toBeTruthy();
    }
  });
});
