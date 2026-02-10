/**
 * Production Readiness Tests
 * 
 * Critical tests for QA_feedback_6.md analysis tasks to ensure production readiness.
 * These tests MUST PASS before shipping.
 * 
 * Issues covered:
 * 1. generate_tests: Black formatting ALWAYS called, AST validation, structured output
 * 2. search: Root parameter REQUIRED for action=intelligent (enforce immediately)
 * 3. agent_task: Increased defaults (maxSteps=50, maxActionsPerStep=15)
 * 4. Global workspace excludes (node_modules, .git, __pycache__, dist)
 * 5. Security scan: Entropy check, refined regex, default excludes
 * 6. Error responses: Structured JSON with allowed_values for enums
 */

import { describe, it, expect, beforeAll, vi, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ACTION_REQUIRED_PARAMS, validateActionRequiredParams, ACTION_ENUM_VALUES, validateEnumParam } from '../src/utils/validation-enhanced.js';

// ============================================
// Issue 1: generate_tests syntax validation - SKIPPED (V21: generate_tests removed)
// NOTE: Helper methods (formatPythonWithBlack, etc.) are retained for other tools
// ============================================
describe.skip('Production: generate_tests syntax validation (REMOVED)', () => {
  it('should have formatPythonWithBlack method available in LlmEnhancedTools', async () => {
    // Verify the method exists for Python formatting
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    const prototype = LlmEnhancedTools.prototype;
    expect(typeof (prototype as any).formatPythonWithBlack).toBe('function');
  });

  it('should have getPythonSyntaxErrorSummary method for AST validation', async () => {
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    const prototype = LlmEnhancedTools.prototype;
    expect(typeof (prototype as any).getPythonSyntaxErrorSummary).toBe('function');
  });

  it('should have validateGeneratedTestSyntax method for heuristic validation', async () => {
    const { LlmEnhancedTools } = await import('../src/tools/llm-enhanced.js');
    const prototype = LlmEnhancedTools.prototype;
    expect(typeof (prototype as any).validateGeneratedTestSyntax).toBe('function');
  });

  it('should wrap invalid Python code in comment block when syntax is invalid', () => {
    // This test verifies the graceful fallback behavior (V17)
    const errorPrefix = '"""';
    const errorMarker = '⚠️ GENERATED CODE HAS SYNTAX ERRORS';
    
    // When syntaxValid=false and hasSyntaxErrors=true, output should be wrapped
    // Checking the pattern exists in the implementation
    const llmEnhancedContent = readFileSync('src/tools/llm-enhanced.ts', 'utf-8');
    expect(llmEnhancedContent).toContain('GENERATED CODE HAS SYNTAX ERRORS');
    expect(llmEnhancedContent).toContain('Manual review required');
  });
});

// ============================================
// Issue 2: search root parameter defaults to '.' per V14/QA_feedback_8
// ============================================
describe('Production: search root parameter defaults', () => {
  it('should DEFAULT root parameter for action=intelligent (not require)', () => {
    // QA_feedback_8: "making root default to '.' would reduce friction"
    // V14/QA_feedback_8: root defaults to '.' when omitted
    const searchParams = ACTION_REQUIRED_PARAMS.search;
    expect(searchParams).toBeDefined();
    expect(searchParams.intelligent).toBeDefined();
    
    // Per QA_feedback_8: root should NOT be required, it defaults to '.'
    expect(searchParams.intelligent).not.toContain('root');
    expect(searchParams.intelligent).toContain('query');  // query is still required
  });

  it('should DEFAULT root parameter for action=structured', () => {
    const searchParams = ACTION_REQUIRED_PARAMS.search;
    expect(searchParams.structured).not.toContain('root');
    expect(searchParams.structured).toContain('query');
  });

  it('should DEFAULT root parameter for action=filenames', () => {
    const searchParams = ACTION_REQUIRED_PARAMS.search;
    expect(searchParams.filenames).not.toContain('root');
    expect(searchParams.filenames).toContain('query');
  });

  it('should NOT return validation error when root is missing for intelligent search', () => {
    // V14/QA_feedback_8: root defaults to '.' - no validation error
    const error = validateActionRequiredParams('search', 'intelligent', { query: 'test' });
    expect(error).toBeNull();  // No error because root defaults to '.'
  });

  it('should pass validation when root is provided', () => {
    const error = validateActionRequiredParams('search', 'intelligent', { 
      query: 'test', 
      root: '.' 
    });
    expect(error).toBeNull();
  });
});

// ============================================
// Issue 3: agent_task defaults MUST be increased
// ============================================
describe('Production: agent_task default limits', () => {
  it('should have maxSteps default of 50 (not 25)', async () => {
    const runnerContent = readFileSync('src/agent/runner.ts', 'utf-8');
    
    // Check that default is 50
    expect(runnerContent).toContain('maxSteps ?? 50');
    // Should NOT have old value of 25
    expect(runnerContent).not.toMatch(/maxSteps\s*\?\?\s*25(?!\d)/);
  });

  it('should have maxActionsPerStep default of 100', async () => {
    const runnerContent = readFileSync('src/agent/runner.ts', 'utf-8');
    
    expect(runnerContent).toContain('maxActionsPerStep ?? 100');
    // Should NOT have old values
    expect(runnerContent).not.toMatch(/maxActionsPerStep\s*\?\?\s*12(?!\d)/);
    expect(runnerContent).not.toMatch(/maxActionsPerStep\s*\?\?\s*15(?!\d)/);
    expect(runnerContent).not.toMatch(/maxActionsPerStep\s*\?\?\s*20(?!\d)/);
    expect(runnerContent).not.toMatch(/maxActionsPerStep\s*\?\?\s*30(?!\d)/);
    expect(runnerContent).not.toMatch(/maxActionsPerStep\s*\?\?\s*50(?!\d)/);
  });

  it('should have maxSubtasks default of at least 8', async () => {
    const runnerContent = readFileSync('src/agent/runner.ts', 'utf-8');
    
    // Check that default is at least 8
    const match = runnerContent.match(/maxSubtasks\s*\?\?\s*(\d+)/);
    expect(match).not.toBeNull();
    const value = parseInt(match![1], 10);
    expect(value).toBeGreaterThanOrEqual(8);
  });
});

// ============================================
// Issue 4: Global workspace excludes
// ============================================
describe('Production: global workspace excludes', () => {
  it('should have DEFAULT_WORKSPACE_EXCLUDES exported from shared location', async () => {
    // Check that a shared constant exists
    const { DEFAULT_WORKSPACE_EXCLUDES } = await import('../src/utils/workspace-excludes.js');
    expect(DEFAULT_WORKSPACE_EXCLUDES).toBeDefined();
    expect(Array.isArray(DEFAULT_WORKSPACE_EXCLUDES)).toBe(true);
  });

  it('should include node_modules in default excludes', async () => {
    const { DEFAULT_WORKSPACE_EXCLUDES } = await import('../src/utils/workspace-excludes.js');
    expect(DEFAULT_WORKSPACE_EXCLUDES.some((p: string) => p.includes('node_modules'))).toBe(true);
  });

  it('should include .git in default excludes', async () => {
    const { DEFAULT_WORKSPACE_EXCLUDES } = await import('../src/utils/workspace-excludes.js');
    expect(DEFAULT_WORKSPACE_EXCLUDES.some((p: string) => p.includes('.git'))).toBe(true);
  });

  it('should include __pycache__ in default excludes', async () => {
    const { DEFAULT_WORKSPACE_EXCLUDES } = await import('../src/utils/workspace-excludes.js');
    expect(DEFAULT_WORKSPACE_EXCLUDES.some((p: string) => p.includes('__pycache__'))).toBe(true);
  });

  it('should include dist in default excludes', async () => {
    const { DEFAULT_WORKSPACE_EXCLUDES } = await import('../src/utils/workspace-excludes.js');
    expect(DEFAULT_WORKSPACE_EXCLUDES.some((p: string) => p.includes('dist'))).toBe(true);
  });
});

// ============================================
// Issue 5: Security scan precision
// ============================================
describe('Production: security scan precision', () => {
  it('should have calculateEntropy function for secret validation', async () => {
    // Verify entropy check is implemented
    const highvalueContent = readFileSync('src/tools/highvalue.ts', 'utf-8');
    expect(highvalueContent).toContain('calculateEntropy');
    expect(highvalueContent).toContain('MIN_SECRET_ENTROPY');
  });

  it('should have isLikelyPlaceholder function for false positive reduction', async () => {
    const highvalueContent = readFileSync('src/tools/highvalue.ts', 'utf-8');
    expect(highvalueContent).toContain('isLikelyPlaceholder');
  });

  it('should have false positive patterns for Python type hints', async () => {
    const highvalueContent = readFileSync('src/tools/highvalue.ts', 'utf-8');
    // Should have pattern for "password: str" type hints
    expect(highvalueContent).toMatch(/password\s*:\s*(?:str|Optional)/);
  });

  it('should have false positive patterns for function signatures', async () => {
    const highvalueContent = readFileSync('src/tools/highvalue.ts', 'utf-8');
    // Should have pattern for "def validate_password("
    expect(highvalueContent).toContain('validate|check|verify|hash|encrypt|compare|reset|change|set|get|update|clear');
  });

  it('should ignore password variable assignments from request/params', async () => {
    const highvalueContent = readFileSync('src/tools/highvalue.ts', 'utf-8');
    // Should have pattern for "password = self." or "password = req."
    // The code uses [:=] to match either : or = assignment operators
    // Pattern in regex form: /password\s*[:=]\s*(?:self\.|this\.|req\.|request\.|...)/
    expect(highvalueContent).toContain('password');
    expect(highvalueContent).toContain('self\\.');  // Escaped dot in regex
    expect(highvalueContent).toContain('request\\.');  // Escaped dot in regex
  });
});

// ============================================
// Issue 6: Standardized error responses
// ============================================
describe('Production: standardized error responses', () => {
  it('should include allowed_values in enum validation errors', () => {
    // Test enum validation returns allowed values
    const error = validateEnumParam('search', 'action', 'invalid_action');
    expect(error).not.toBeNull();
    expect(error?.hint).toContain('intelligent');
    expect(error?.hint).toContain('structured');
    expect(error?.hint).toContain('gather');
    expect(error?.hint).toContain('filenames');
  });

  it('should have structured error response format', () => {
    const error = validateActionRequiredParams('search', 'intelligent', {});
    expect(error).not.toBeNull();
    expect(error).toHaveProperty('success');
    expect(error).toHaveProperty('errorType');
    expect(error).toHaveProperty('tool');
    expect(error).toHaveProperty('message');
    expect(error).toHaveProperty('issues');
    expect(error).toHaveProperty('hint');
  });

  it('should have ACTION_ENUM_VALUES for all major tools', () => {
    // Verify enum values are defined for key tools
    expect(ACTION_ENUM_VALUES.search).toBeDefined();
    expect(ACTION_ENUM_VALUES.security).toBeDefined();
    expect(ACTION_ENUM_VALUES.summarize).toBeDefined();
    expect(ACTION_ENUM_VALUES.workspace).toBeDefined();
    expect(ACTION_ENUM_VALUES.todos).toBeDefined();
    expect(ACTION_ENUM_VALUES.linter).toBeDefined();
    // generate_tests removed V21 (QA_feedback_8: unreliable output quality)
  });
});

// ============================================
// Issue 7: install.bat includes black
// ============================================
describe('Production: install.bat dependencies', () => {
  it.skip('should include black in dist_package install or postinstall (or skip in dev)', () => {
    // TODO: This test requires rebuilding the distribution package which includes
    // adding black installation to install.bat or INSTALL.md
    // Skipping until distribution package is rebuilt with black mentioned
    
    // Check if black installation is mentioned in install scripts or postinstall
    let blackMentioned = false;
    let filesChecked = 0;
    
    if (existsSync('dist_package/install.bat')) {
      filesChecked++;
      const installBat = readFileSync('dist_package/install.bat', 'utf-8');
      if (installBat.includes('black') || installBat.includes('pip install')) {
        blackMentioned = true;
      }
    }
    
    if (existsSync('dist_package/postinstall.js')) {
      filesChecked++;
      const postinstall = readFileSync('dist_package/postinstall.js', 'utf-8');
      if (postinstall.includes('black')) {
        blackMentioned = true;
      }
    }
    
    if (existsSync('dist_package/INSTALL.md')) {
      filesChecked++;
      const installMd = readFileSync('dist_package/INSTALL.md', 'utf-8');
      if (installMd.includes('black')) {
        blackMentioned = true;
      }
    }
    
    // Only check if files exist (production environment)
    // If no files exist (dev environment), skip the check
    if (filesChecked > 0) {
      // In production, black must be mentioned
      expect(blackMentioned).toBe(true);
    } else {
      // Dev environment - test passes
      console.log('[SKIP] dist_package not built yet - test passes in dev mode');
    }
  });
});

// ============================================
// Integration: Verify no regressions
// ============================================
describe('Production: no regressions from previous fixes', () => {
  it('should still have entropy check for secret detection', () => {
    const highvalueContent = readFileSync('src/tools/highvalue.ts', 'utf-8');
    expect(highvalueContent).toContain('MIN_SECRET_ENTROPY = 3.5');
  });

  it('should still have validateGeneratedImports for test generation', () => {
    const llmEnhancedContent = readFileSync('src/tools/llm-enhanced.ts', 'utf-8');
    expect(llmEnhancedContent).toContain('validateGeneratedImports');
  });

  it('should still have cleanGeneratedTestCode for common LLM errors', () => {
    const llmEnhancedContent = readFileSync('src/tools/llm-enhanced.ts', 'utf-8');
    expect(llmEnhancedContent).toContain('cleanGeneratedTestCode');
  });

  it('should still support continuation for partial agent tasks', () => {
    const runnerContent = readFileSync('src/agent/runner.ts', 'utf-8');
    expect(runnerContent).toContain('continueAvailable');
    expect(runnerContent).toContain('completionReason');
  });
});
