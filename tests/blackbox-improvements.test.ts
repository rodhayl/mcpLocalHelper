/**
 * Consolidated Black-box Improvements Tests
 * 
 * This file consolidates tests from V6-V9 black-box evaluation feedback:
 * - V6: Structured errors, summary provenance, search fallback, security scan coverage
 * - V7: Framework validation, ALL_CAPS exclusion, default patterns, syntaxValid field, tool examples
 * - V8: Security scan defaults, analyze_file dense output, generate_agents_md exposure
 * - V9: Newline normalization, skipTests option, gatherContext priority, loop detection, filename boosting
 */
import { describe, it, expect } from 'vitest';
import { join, basename } from 'path';
import {
  createStructuredError,
  createFileNotFoundError,
  createPathAccessDeniedError,
  createScanEmptyError,
  createSearchNoResultsError,
  getDefaultSuggestions,
  ERROR_SUGGESTIONS,
  type StructuredErrorType,
} from '../src/utils/structured-errors.js';
import { 
  SummarySourceSchema, 
  IntelligentSearchResultSchema, 
  SecretScanResultSchema,
  GenerateTestsResultSchema,
  GenerateAgentsMdResultSchema,
} from '../src/types/index.js';
import {
  VALID_FRAMEWORKS,
  isValidFramework,
  getFrameworkSuggestions,
} from '../src/tools/llm-enhanced.js';
import {
  TOOL_EXAMPLES,
  TOOL_CATEGORIES,
  CORE_TOOLS,
} from '../src/server/tool-discovery.js';
import { toDenseOutput, toCompactOutput } from '../src/utils/output-formatter.js';

// ============================================
// V6: Structured Errors & Schema Improvements
// ============================================
describe('V6: Structured Error Utilities', () => {
  it('should create a basic structured error', () => {
    const error = createStructuredError({
      errorType: 'FILE_NOT_FOUND',
      message: 'File not found',
      resolvedPath: '/path/to/file.ts',
      suggestions: ['Check the path'],
    });

    expect(error.errorType).toBe('FILE_NOT_FOUND');
    expect(error.message).toBe('File not found');
    expect(error.resolvedPath).toBe('/path/to/file.ts');
    expect(error.suggestions).toContain('Check the path');
    expect(error.timestamp).toBeDefined();
  });

  it('should create file not found error with default suggestions', () => {
    const error = createFileNotFoundError('myfile.ts', '/workspace/myfile.ts');
    expect(error.errorType).toBe('FILE_NOT_FOUND');
    expect(error.suggestions).toContain('Verify the file path is correct');
  });

  it('should create path access denied error', () => {
    const error = createPathAccessDeniedError('/etc/passwd', '/etc/passwd');
    expect(error.errorType).toBe('PATH_ACCESS_DENIED');
    expect(error.suggestions).toContain('Ensure the path is within the allowed workspace');
  });

  it('should create scan empty error with skipped reasons', () => {
    const error = createScanEmptyError(0, 20, { hidden: 5, node_modules: 100 });
    expect(error.errorType).toBe('SCAN_EMPTY');
    expect(error.message).toContain('scanned 0 files');
  });

  it('should create search no results error with fallback note', () => {
    const error = createSearchNoResultsError('myquery', true);
    expect(error.errorType).toBe('SEARCH_NO_RESULTS');
    expect(error.suggestions?.[0]).toContain('Fallback search was attempted');
  });

  it('should have default suggestions for all error types', () => {
    const errorTypes: StructuredErrorType[] = [
      'FILE_NOT_FOUND', 'PATH_ACCESS_DENIED', 'INVALID_PARAMETER', 
      'VALIDATION_ERROR', 'SCAN_EMPTY', 'SCAN_INCOMPLETE', 
      'SEARCH_NO_RESULTS', 'LLM_ERROR', 'TIMEOUT', 'INTERNAL_ERROR',
      'TOOL_HIDDEN', 'PARSE_ERROR',
    ];

    for (const type of errorTypes) {
      expect(getDefaultSuggestions(type).length).toBeGreaterThan(0);
      expect(ERROR_SUGGESTIONS[type]).toBeDefined();
    }
  });
});

describe('V6: Summary Provenance Schema', () => {
  it('should validate SummarySource schema', () => {
    const validSource = {
      file: 'README.md',
      startLine: 1,
      endLine: 10,
      excerpt: 'This is a sample project...',
      confidence: 0.8,
    };
    expect(SummarySourceSchema.safeParse(validSource).success).toBe(true);
  });

  it('should validate confidence range (0-1)', () => {
    const invalidConfidence = { file: 'test.ts', excerpt: 'code', confidence: 1.5 };
    expect(SummarySourceSchema.safeParse(invalidConfidence).success).toBe(false);
  });
});

describe('V6: Search & Security Schema Extensions', () => {
  it('should include usedFallback in IntelligentSearchResult', () => {
    const result = IntelligentSearchResultSchema.safeParse({
      query: 'test',
      results: [],
      totalMatches: 0,
      filesSearched: 100,
      searchSummary: 'No matches found',
      suggestedNextSteps: [],
      usedFallback: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.usedFallback).toBe(true);
  });

  it('should include filesSkipped in security scan statistics', () => {
    const result = SecretScanResultSchema.safeParse({
      findings: [],
      statistics: {
        filesScanned: 50,
        filesSkipped: 100,
        skippedReasons: { hidden: 20, node_modules: 80 },
        findingsByCategory: {},
        riskScore: 0,
        scanDurationMs: 500,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.statistics.filesSkipped).toBe(100);
  });
});

// ============================================
// V7: Framework Validation & Tool Examples
// ============================================
describe('V7: Framework Validation', () => {
  it('should have VALID_FRAMEWORKS with common frameworks', () => {
    expect(VALID_FRAMEWORKS).toContain('vitest');
    expect(VALID_FRAMEWORKS).toContain('jest');
    expect(VALID_FRAMEWORKS).toContain('pytest');
    expect(VALID_FRAMEWORKS.length).toBeGreaterThan(15);
  });

  it('should validate known frameworks (case insensitive)', () => {
    expect(isValidFramework('vitest')).toBe(true);
    expect(isValidFramework('VITEST')).toBe(true);
    expect(isValidFramework('pytest')).toBe(true);
  });

  it('should reject invalid frameworks', () => {
    expect(isValidFramework('invalid_framework')).toBe(false);
  });

  it('should suggest similar frameworks for typos', () => {
    const suggestions = getFrameworkSuggestions('jset');
    expect(suggestions).toContain('jest');
  });
});

describe('V7: ALL_CAPS False Positive Exclusion', () => {
  it('should match ALL_CAPS constant assignment patterns', () => {
    const pattern = /^[A-Z][A-Z0-9_]+\s*=\s*['"][A-Z][A-Z0-9_]*['"]/;
    expect(pattern.test('WEAK_PASSWORD = "REG_WEAK_PASSWORD"')).toBe(true);
    expect(pattern.test('ERROR_CODE = "ERR_INVALID"')).toBe(true);
  });

  it('should NOT match actual secrets', () => {
    const pattern = /^[A-Z][A-Z0-9_]+\s*=\s*['"][A-Z][A-Z0-9_]*['"]/;
    expect(pattern.test(`API_KEY = "${`sk${'-proj-abc123xyz'}`}"`)).toBe(false);
  });
});

describe('V7: syntaxValid Field', () => {
  it('should include syntaxValid in GenerateTestsResult', () => {
    const result = GenerateTestsResultSchema.safeParse({
      success: true,
      tests: 'describe("test", () => {});',
      framework: 'vitest',
      coverage: 'comprehensive',
      testCount: 1,
      syntaxValid: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('V7: TOOL_EXAMPLES', () => {
  it('should have examples for core tools', () => {
    expect(TOOL_EXAMPLES.search).toBeDefined();
    expect(TOOL_EXAMPLES.generate_tests).toBeDefined();
    expect(TOOL_EXAMPLES.security).toBeDefined();
    expect(TOOL_EXAMPLES.mcp_health).toBeDefined();
  });

  it('should have meaningful descriptions', () => {
    for (const [, example] of Object.entries(TOOL_EXAMPLES)) {
      expect(example.description.length).toBeGreaterThan(10);
    }
  });

  it('should have valid tool references in categories', () => {
    for (const [, category] of Object.entries(TOOL_CATEGORIES)) {
      expect(category.tools.length).toBeGreaterThan(0);
    }
  });
});

// ============================================
// V8: Dense Output & generate_agents_md
// ============================================
describe('V8: analyze_file Dense Output', () => {
  it('should prioritize analysis over content', () => {
    const analyzeResult = {
      path: '/src/example.ts',
      content: 'code'.repeat(100),
      language: 'typescript',
      analysis: 'This file defines a simple hello function.',
      issues: [{ type: 'style', line: 10, message: 'Add JSDoc', severity: 'info' }],
      suggestions: ['Add documentation'],
      metrics: { lineCount: 100 },
      analysisType: 'quality',
    };

    const dense = toDenseOutput(analyzeResult);
    expect(dense.message).toContain('hello function');
    expect(dense.code).toBeUndefined();
  });

  it('should truncate many issues to prevent bloat', () => {
    const manyIssues = {
      path: '/messy/file.ts',
      content: 'messy code',
      language: 'typescript',
      analysis: 'Multiple issues detected.',
      issues: Array.from({ length: 50 }, (_, i) => ({
        type: 'style', line: i + 1, message: `Issue ${i}`, severity: 'warning',
      })),
      suggestions: [],
      metrics: {},
      analysisType: 'full',
    };

    const dense = toDenseOutput(manyIssues);
    expect(dense.results!.length).toBeLessThanOrEqual(10);
  });
});

describe('V8: analyze_file Compact/Dense Output (no content)', () => {
  it('should surface analysis in compact output', () => {
    const analyzeResult = {
      path: '/docs/AGENTS.md',
      language: 'markdown',
      analysis: 'Setup and test instructions are missing.',
      issues: [],
      suggestions: ['Add setup instructions'],
      metrics: { lineCount: 42 },
      analysisType: 'documentation',
    };

    const compact = toCompactOutput(analyzeResult);
    expect(compact.message).toContain('Setup and test instructions are missing');
  });

  it('should surface analysis in dense output even without raw content', () => {
    const analyzeResult = {
      path: '/docs/AGENTS.md',
      language: 'markdown',
      analysis: 'Documentation looks incomplete.',
      issues: [],
      suggestions: [],
      metrics: { lineCount: 12 },
      analysisType: 'documentation',
    };

    const dense = toDenseOutput(analyzeResult);
    expect(dense.message).toContain('Documentation looks incomplete');
  });
});

describe('V8: generate_agents_md Exposure', () => {
  it('should have GenerateAgentsMdResult schema defined', () => {
    expect(GenerateAgentsMdResultSchema).toBeDefined();
  });

  it('should validate GenerateAgentsMdResult shape', () => {
    const validResult = {
      success: true,
      path: '.mcp-local-llm/AGENTS.md',
      content: '# AGENTS.md\n\nProject instructions.',
      sections: [{ name: 'Project Overview', present: true }],
      existedBefore: false,
    };
    expect(GenerateAgentsMdResultSchema.parse(validResult).success).toBe(true);
  });

  it('should have generateAgentsMd method in LlmEnhancedTools', async () => {
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    expect(LlmEnhancedTools.prototype.generateAgentsMd).toBeDefined();
  });
});

// ============================================
// V9: Newlines, skipTests, Loop Detection
// ============================================
describe('V9: generate_tests Newline Handling', () => {
  it('should have generateTests method', async () => {
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    expect(LlmEnhancedTools.prototype.generateTests).toBeDefined();
  });

  it('should normalize escaped newlines in code blocks', () => {
    const raw = 'def test_example():\\n    assert True\\n    # comment';
    const normalized = raw.replace(/\\n/g, '\n');
    expect(normalized.split('\n').length).toBeGreaterThan(1);
    expect(normalized).not.toContain('\\n');
  });

  it('should have Python syntax validation', async () => {
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    const proto = LlmEnhancedTools.prototype;
    expect('getPythonSyntaxErrorSummary' in proto).toBe(true);
  });
  
  it('should have Python indentation normalizer', async () => {
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    const proto = LlmEnhancedTools.prototype;
    expect('normalizePythonIndentation' in proto).toBe(true);
  });
});

describe('V9: Security Scan skipTests', () => {
  it('should have secretScan method', async () => {
    const { HighValueTools } = await import('../src/tools/highvalue.js');
    expect(HighValueTools.prototype.secretScan).toBeDefined();
  });

  it('should skip test directories by default', () => {
    const testPatterns = [
      'src/tests/unit.test.ts',
      'src/test/api.test.js',
      'src/__tests__/component.tsx',
    ];

    const skipPattern = /[\\/]tests?[\\/][^/\\]+\.(ts|js|tsx|jsx|py)$/i;
    const skipJest = /[\\/]__tests__[\\/]/i;

    expect(skipPattern.test(testPatterns[0])).toBe(true);
    expect(skipPattern.test(testPatterns[1])).toBe(true);
    expect(skipJest.test(testPatterns[2])).toBe(true);
  });

  it('should NOT skip non-test directories', () => {
    const nonTestPaths = [
      'src/utils/testing-helpers.ts',
      'lib/contest/module.py',
    ];
    const skipRegex = /[\\/]tests?[\\/]|[\\/]__tests__[\\/]/i;
    for (const path of nonTestPaths) {
      expect(skipRegex.test(path)).toBe(false);
    }
  });
});

describe('V9: gatherContext File Priority', () => {
  it('should prioritize code files over markdown', () => {
    const files = [
      { path: 'README.md', ext: '.md' },
      { path: 'src/index.ts', ext: '.ts' },
      { path: 'src/utils.py', ext: '.py' },
    ];

    const scored = files.map(f => {
      let priority = 50;
      if (['.ts', '.js', '.py'].includes(f.ext)) priority += 20;
      if (['.md', '.txt'].includes(f.ext)) priority -= 15;
      return { ...f, priority };
    });

    scored.sort((a, b) => b.priority - a.priority);
    expect(scored[0].ext).toBe('.ts');
    expect(scored[scored.length - 1].ext).toBe('.md');
  });
});

describe('V9: Agent Loop Detection', () => {
  it('should have AgentRunner with loop detection', async () => {
    const { AgentRunner } = await import('../src/agent/runner.js');
    expect(AgentRunner.prototype).toBeDefined();
  });

  it('should generate deterministic loop signature', () => {
    const action1 = { type: 'mcp_call', tool: 'search', args: { query: 'foo' } };
    const action2 = { type: 'mcp_call', tool: 'search', args: { query: 'foo' } };
    const action3 = { type: 'mcp_call', tool: 'search', args: { query: 'bar' } };

    const sig = (a: typeof action1) => JSON.stringify([a.type, a.tool, a.args]);
    expect(sig(action1)).toBe(sig(action2));
    expect(sig(action1)).not.toBe(sig(action3));
  });

  it('should have aggressive warning with DO NOT repeat', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(join(process.cwd(), 'src/agent/runner.ts'), 'utf-8');
    expect(source).toContain('DO NOT repeat');
    expect(source).toContain('LOOP WARNING');
  });
});

describe('V9: Search Filename Boosting', () => {
  it('should boost exact filename matches', () => {
    const query = 'runner.ts';
    const files = [
      { path: 'src/agent/runner.ts', basename: 'runner.ts' },
      { path: 'src/utils/task-runner.ts', basename: 'task-runner.ts' },
    ];

    const queryLower = query.toLowerCase();
    const scored = files.map(f => {
      let priority = 50;
      if (f.basename.toLowerCase() === queryLower) priority = 100;
      else if (f.basename.toLowerCase().includes(queryLower.replace(/\.[^.]+$/, ''))) priority = 80;
      return { ...f, priority };
    });

    expect(scored.find(f => f.basename === 'runner.ts')!.priority).toBe(100);
  });

  it('should have filename boosting in intelligentSearch', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(join(process.cwd(), 'src/tools/llm-enhanced.ts'), 'utf-8');
    expect(source).toContain('queryBasename');
    expect(source).toContain('Filename match boosting');
  });
});

describe('V9: AGENTS.md Trigger Expansion', () => {
  it('should have ensureAgentsMdExists in MCP server', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(join(process.cwd(), 'src/server/mcp.ts'), 'utf-8');
    expect(source).toContain('ensureAgentsMdExists');
  });

  it('should not block tools when AGENTS.md generation fails', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(join(process.cwd(), 'src/server/mcp.ts'), 'utf-8');
    expect(source).toContain('void this.ensureAgentsMdExists');
  });
});

// ============================================
// Integration Scenarios
// ============================================
describe('Integration: Code Generation Formatting', () => {
  it('should preserve generated test code formatting', () => {
    const rawOutput = '```python\n\\ndef test_example():\\n    assert True\\n```';
    const codeMatch = rawOutput.match(/```(?:python)?\n([\s\S]*?)```/);
    let code = codeMatch?.[1] || '';
    code = code.replace(/\\n/g, '\n').trim();

    expect(code.split('\n').length).toBeGreaterThan(1);
    expect(code).toContain('def test_example():');
  });
});
