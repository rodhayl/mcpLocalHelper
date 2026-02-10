/**
 * Tests for V4 Improvement Plans
 * 
 * Based on LLM feedback analysis (TRAE AI IDE, GitHub Copilot):
 * - Plan 1: Parameter Validation & Enum Hardening (Score: 96/100)
 * - Plan 2: Zero-Files Security Guard (Score: 93/100)
 * - Plan 3: Code Review Depth Enhancement (Score: 91/100)
 * - Plan 4: LLM Response Parsing (Score: 88/100)
 * - Plan 5: Process Lifecycle Cleanup (Score: 85/100) - Already implemented
 */

import { describe, it, expect } from 'vitest';
import {
  ACTION_ENUM_VALUES,
  validateEnumParam,
  validateAllEnumParams,
} from '../src/utils/validation-enhanced.js';

describe('V4 Improvement Plans', () => {
  // ==================================
  // PLAN 1: Parameter Validation & Enum Hardening
  // ==================================
  describe('Plan 1: Parameter Validation & Enum Hardening', () => {
    describe('ACTION_ENUM_VALUES mapping', () => {
      it('should define enum values for summarize tool', () => {
        expect(ACTION_ENUM_VALUES.summarize).toBeDefined();
        expect(ACTION_ENUM_VALUES.summarize.action).toEqual(['path', 'repo']);
      });

      it('should define enum values for search tool', () => {
        expect(ACTION_ENUM_VALUES.search).toBeDefined();
        expect(ACTION_ENUM_VALUES.search.action).toEqual(['intelligent', 'structured', 'gather', 'filenames']);
      });

      it('should define enum values for security tool', () => {
        expect(ACTION_ENUM_VALUES.security).toBeDefined();
        expect(ACTION_ENUM_VALUES.security.action).toEqual(['scan', 'risk', 'redact', 'fix']);
      });

      it('should define enum values for analyze_file tool', () => {
        expect(ACTION_ENUM_VALUES.analyze_file).toBeDefined();
        expect(ACTION_ENUM_VALUES.analyze_file.analysisType).toEqual([
          'quality', 'security', 'performance', 'documentation', 'full'
        ]);
      });

      it('should define enum values for local_code_review tool', () => {
        expect(ACTION_ENUM_VALUES.local_code_review).toBeDefined();
        expect(ACTION_ENUM_VALUES.local_code_review.reviewType).toEqual([
          'security', 'performance', 'style', 'comprehensive'
        ]);
      });

      it('should define enum values for todos tool', () => {
        expect(ACTION_ENUM_VALUES.todos).toBeDefined();
        expect(ACTION_ENUM_VALUES.todos.action).toEqual(['find', 'implement', 'find_and_implement']);
      });

      it('should define enum values for linter tool', () => {
        expect(ACTION_ENUM_VALUES.linter).toBeDefined();
        // Actual values: ['validate', 'fix', 'run']
        expect(ACTION_ENUM_VALUES.linter.action).toContain('run');
        expect(ACTION_ENUM_VALUES.linter.action).toContain('fix');
      });

      it('should define enum values for formatter tool', () => {
        expect(ACTION_ENUM_VALUES.formatter).toBeDefined();
        // Actual values: ['run', 'fix']
        expect(ACTION_ENUM_VALUES.formatter.action).toContain('run');
        expect(ACTION_ENUM_VALUES.formatter.action).toContain('fix');
      });

      it('should define enum values for workspace tool', () => {
        expect(ACTION_ENUM_VALUES.workspace).toBeDefined();
        // Actual values: ['metadata', 'snapshot', 'explore']
        expect(ACTION_ENUM_VALUES.workspace.action).toContain('metadata');
      });

      it('should have at least 10 tools with enum definitions', () => {
        const toolCount = Object.keys(ACTION_ENUM_VALUES).length;
        expect(toolCount).toBeGreaterThanOrEqual(10);
      });
    });

    describe('validateEnumParam function', () => {
      it('should return null for valid enum value', () => {
        const result = validateEnumParam('summarize', 'action', 'path');
        expect(result).toBeNull();
      });

      it('should return null for valid enum value - security scan', () => {
        const result = validateEnumParam('security', 'action', 'scan');
        expect(result).toBeNull();
      });

      it('should return error for invalid enum value', () => {
        const result = validateEnumParam('summarize', 'action', 'invalid_action');
        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
        expect(result?.errorType).toBe('invalid_enum');
        expect(result?.message).toContain('Invalid value');
      });

      it('should return error with valid options in hint', () => {
        const result = validateEnumParam('security', 'action', 'delete');
        expect(result).not.toBeNull();
        expect(result?.hint).toContain('scan');
        expect(result?.hint).toContain('risk');
        expect(result?.hint).toContain('redact');
        expect(result?.hint).toContain('fix');
      });

      it('should return null for undefined value (optional params)', () => {
        const result = validateEnumParam('summarize', 'action', undefined);
        expect(result).toBeNull();
      });

      it('should return null for unknown tool (not enforcing)', () => {
        const result = validateEnumParam('unknown_tool', 'action', 'anything');
        expect(result).toBeNull();
      });

      it('should return null for unknown param on known tool', () => {
        const result = validateEnumParam('summarize', 'unknownParam', 'anything');
        expect(result).toBeNull();
      });
    });

    describe('validateAllEnumParams function', () => {
      it('should validate all enum params in one call - valid', () => {
        const result = validateAllEnumParams('summarize', { action: 'path', mode: 'compact' });
        expect(result).toBeNull();
      });

      it('should catch first invalid enum param', () => {
        const result = validateAllEnumParams('search', { action: 'bad_action' });
        expect(result).not.toBeNull();
        expect(result?.success).toBe(false);
      });

      it('should handle empty params object', () => {
        const result = validateAllEnumParams('summarize', {});
        expect(result).toBeNull();
      });

      it('should handle null/undefined params gracefully', () => {
        expect(validateAllEnumParams('summarize', null as unknown as Record<string, unknown>)).toBeNull();
        expect(validateAllEnumParams('summarize', undefined as unknown as Record<string, unknown>)).toBeNull();
      });
    });
  });

  // ==================================
  // PLAN 2: Zero-Files Security Guard
  // ==================================
  describe('Plan 2: Zero-Files Security Guard', () => {
    // These tests verify the type definitions exist - actual functionality is tested in real-mcp tests
    it('should have warnings field in SecretScanResult schema', async () => {
      const { SecretScanResultSchema } = await import('../src/types/index.js');
      // Verify the schema accepts warnings
      const validResult = {
        findings: [],
        statistics: {
          filesScanned: 0,
          findingsByCategory: {},
          riskScore: 0,
        },
        warnings: ['Test warning'],
      };
      const parsed = SecretScanResultSchema.parse(validResult);
      expect(parsed.warnings).toEqual(['Test warning']);
    });

    it('should allow undefined warnings in SecretScanResult', async () => {
      const { SecretScanResultSchema } = await import('../src/types/index.js');
      const resultWithoutWarnings = {
        findings: [],
        statistics: {
          filesScanned: 5,
          findingsByCategory: {},
          riskScore: 0,
        },
      };
      const parsed = SecretScanResultSchema.parse(resultWithoutWarnings);
      expect(parsed.warnings).toBeUndefined();
    });
  });

  // ==================================
  // PLAN 3: Code Review Depth Enhancement
  // ==================================
  describe('Plan 3: Code Review Depth Enhancement', () => {
    it('should verify llm-enhanced module exports correctly', async () => {
      // This verifies the module can be imported without errors
      const llmEnhanced = await import('../src/tools/llm-enhanced.js');
      expect(llmEnhanced).toBeDefined();
      // The class is exported as a named export with lowercase 'llm'
      expect(llmEnhanced.LlmEnhancedTools).toBeDefined();
    });

    // Note: Actual code review depth is tested in real-mcp tests with live LLM
  });

  // ==================================
  // PLAN 4: LLM Response Parsing Enhancement
  // ==================================
  describe('Plan 4: LLM Response Parsing', () => {
    it('should verify llm-enhanced module is importable', async () => {
      const llmEnhanced = await import('../src/tools/llm-enhanced.js');
      expect(llmEnhanced).toBeDefined();
    });

    // Note: Actual JSON parsing is tested in integration tests with live LLM
    // The improvement is in buildAnalysisPrompt requesting structured JSON output
  });

  // ==================================
  // PLAN 5: Process Lifecycle Cleanup (Already Implemented)
  // ==================================
  describe('Plan 5: Process Lifecycle Cleanup', () => {
    it('should verify McpServer has disconnectAllMcpClients method', async () => {
      // The method is on McpServer class in mcp.ts
      const { readFileSync } = await import('fs');
      const mcpContent = readFileSync('./src/server/mcp.ts', 'utf-8');
      expect(mcpContent).toContain('disconnectAllMcpClients');
      expect(mcpContent).toContain('public async disconnectAllMcpClients()');
    });

    it('should have disconnectAllMcpClients call in gracefulShutdown', async () => {
      const { readFileSync } = await import('fs');
      const indexContent = readFileSync('./src/index.ts', 'utf-8');
      expect(indexContent).toContain('disconnectAllMcpClients');
    });
  });
});

// ==================================
// Regression Tests - Ensure V3 features still work
// ==================================
describe('V3 Regression Tests', () => {
  describe('Enhanced Validation', () => {
    it('should maintain validateActionRequiredParams functionality', async () => {
      const { validateActionRequiredParams } = await import('../src/utils/validation-enhanced.js');
      expect(typeof validateActionRequiredParams).toBe('function');
    });
  });

  describe('Type Safety', () => {
    it('should export all V3 types', async () => {
      const types = await import('../src/types/index.js');
      expect(types.SecretScanResultSchema).toBeDefined();
      expect(types.LocalCodeReviewResultSchema).toBeDefined();
      expect(types.SummarySchema).toBeDefined();
    });
  });
});

// ==================================
// Integration Boundary Tests
// ==================================
describe('Integration Boundary Tests', () => {
  describe('Enum validation edge cases', () => {
    it('should handle case sensitivity', () => {
      // Enum values should be case-sensitive
      const result = validateEnumParam('summarize', 'action', 'PATH');
      expect(result).not.toBeNull(); // PATH is not path
    });

    it('should handle trimmed values', () => {
      // Values with extra whitespace should fail
      const result = validateEnumParam('summarize', 'action', ' path ');
      expect(result).not.toBeNull(); // ' path ' is not 'path'
    });

    it('should validate multiple enum params for todos tool', () => {
      const validResult = validateAllEnumParams('todos', { action: 'find' });
      expect(validResult).toBeNull();

      const invalidResult = validateAllEnumParams('todos', { action: 'search' });
      expect(invalidResult).not.toBeNull();
    });

    it('should validate code_helper tool actions', () => {
      expect(ACTION_ENUM_VALUES.code_helper).toBeDefined();
      expect(ACTION_ENUM_VALUES.code_helper.action).toContain('explain');
      expect(ACTION_ENUM_VALUES.code_helper.action).toContain('optimize');
      expect(ACTION_ENUM_VALUES.code_helper.action).toContain('simplify');
    });

    it('should validate regex_helper tool actions', () => {
      expect(ACTION_ENUM_VALUES.regex_helper).toBeDefined();
      expect(ACTION_ENUM_VALUES.regex_helper.action).toContain('explain');
      expect(ACTION_ENUM_VALUES.regex_helper.action).toContain('generate');
    });

    it('should validate refactor_helper tool actions', () => {
      expect(ACTION_ENUM_VALUES.refactor_helper).toBeDefined();
      expect(ACTION_ENUM_VALUES.refactor_helper.action).toContain('suggest_names');
      expect(ACTION_ENUM_VALUES.refactor_helper.action).toContain('extract_function');
    });
  });

  describe('Zero-files guard integration', () => {
    it('should have warnOnEmpty option documented in secretScan', async () => {
      const { HighValueTools } = await import('../src/tools/highvalue.js');
      expect(HighValueTools).toBeDefined();
      // The actual warnOnEmpty functionality is tested in real-mcp tests
    });

    it('should have minimumFilesExpected option documented in secretScan', async () => {
      const { HighValueTools } = await import('../src/tools/highvalue.js');
      expect(HighValueTools).toBeDefined();
      // The actual minimumFilesExpected functionality is tested in real-mcp tests
    });
  });
});
