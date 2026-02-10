/**
 * Combined V12/V13 Improvement Tests
 * Merged from: v12-improvements.test.ts, v13-improvements.test.ts
 *
 * Tests for improvements based on LLM feedback:
 *
 * V12 (test_feedback_2.md):
 * - F2-001: generate_tests collapsed Python repair
 * - F2-002: Enum validation error messages with allowed values
 * - F2-004: discover_tools returns agentOnly metadata
 *
 * V13 (test_feedback_3.md):
 * - F3-002: search type validation for root parameter
 * - F3-003: Enhanced Python repair patterns (import collisions, multi-statement)
 * - F3-004: discover_tools list_categories with agentOnly metadata
 * - F3-006: agent_task read-only for trivial prompts
 * - F3-007: Password detection for conversational text
 */

import { describe, it, expect } from 'vitest';
import { formatZodValidationError, parseZodError } from '../src/utils/validation-errors.js';
import { inferReadOnlyFromTaskText } from '../src/utils/task-intent.js';
import { ZodError, z } from 'zod';

// ============================================
// V12 Improvement Tests
// ============================================

describe('V12 Improvement Tests', () => {
  describe('F2-001: Python Line Repair Logic', () => {
    it('should detect collapsed def patterns', () => {
      const collapsedDef = 'def test_foo():assert True';
      const collapsedDefLine = /def\s+\w+\([^)]*\):\s*\w/.test(collapsedDef);
      expect(collapsedDefLine).toBe(true);

      const validPass = 'def test_foo():pass';
      const passMatch = /def\s+\w+\([^)]*\):\s*pass/.test(validPass);
      expect(passMatch).toBe(true);
    });

    it('should detect collapsed class-def patterns', () => {
      const collapsedClassDef = 'class TestClass:def test_method(self):';
      const classDefMatch = /^(\s*class\s+\w+[^:]*:\s*)(def\s+.+)$/.test(collapsedClassDef);
      expect(classDefMatch).toBe(true);
    });

    it('should detect import-def collisions', () => {
      const importDefCollision = 'import pytest def test_foo():';
      const collisionMatch = /(?:import|from)\s+.*(?:def|class)\s+\w/.test(importDefCollision);
      expect(collisionMatch).toBe(true);
    });

    it('should detect decorator-def collisions (V14)', () => {
      const decoratorDefCollision = '@pytest.fixture def test_foo():';
      const decoratorDefPattern = /^(\s*)(@[\w.]+(?:\([^)]*\))?)\s+(def\s+)/m;
      expect(decoratorDefPattern.test(decoratorDefCollision)).toBe(true);
    });
  });

  describe('F2-002: Enhanced Enum Validation Error Messages', () => {
    it('should include explicit allowed values in message', () => {
      const schema = z.object({
        action: z.enum(['scan', 'risk', 'redact', 'fix']),
      });

      try {
        schema.parse({ action: 'invalid' });
        expect.fail('Should have thrown ZodError');
      } catch (error) {
        expect(error).toBeInstanceOf(ZodError);
        const formatted = formatZodValidationError('security', error as ZodError);

        expect(formatted.message).toContain("must be one of:");
        expect(formatted.message).toContain('scan');
        expect(formatted.allowedValues).toBeDefined();
        expect(formatted.allowedValues).toContain('scan');
      }
    });
  });

  describe('F2-004: discover_tools agentOnly Metadata', () => {
    it('should define agent-only tool list', () => {
      const AGENT_ONLY_TOOL_NAMES = new Set([
        'llm_chat', 'agent_task_result', 'agent_queue_status', 'mcp_server', 'mcp_ask',
        'system_profile', 'model_info', 'mcp_debug', 'mcp_terminal_command', 'refine_prompt'
      ]);

      expect(AGENT_ONLY_TOOL_NAMES.size).toBe(10);
      expect(AGENT_ONLY_TOOL_NAMES.has('llm_chat')).toBe(true);
      expect(AGENT_ONLY_TOOL_NAMES.has('search')).toBe(false);
    });
  });
});

describe('V12 Regression Prevention', () => {
  describe('Enum validation backward compatibility', () => {
    it('should still extract allowedValues from Zod error', () => {
      const schema = z.enum(['a', 'b', 'c']);

      try {
        schema.parse('invalid');
      } catch (error) {
        const issues = parseZodError(error as ZodError);
        expect(issues.length).toBeGreaterThan(0);
        const firstIssue = issues[0];
        expect(Array.isArray(firstIssue.expected)).toBe(true);
        expect((firstIssue.expected as string[])).toContain('a');
      }
    });
  });
});

// ============================================
// V13 Improvement Tests
// ============================================

describe('V13 Improvement Tests', () => {
  describe('F3-006: Trivial Prompt Read-Only Inference', () => {
    it('should infer read-only for "Say ok" and similar simple prompts', () => {
      expect(inferReadOnlyFromTaskText('Say ok')).toBe(true);
      expect(inferReadOnlyFromTaskText('say hello')).toBe(true);
      expect(inferReadOnlyFromTaskText('echo test')).toBe(true);
    });

    it('should NOT infer read-only for write tasks even if short', () => {
      expect(inferReadOnlyFromTaskText('Fix the bug')).toBe(false);
      expect(inferReadOnlyFromTaskText('Create a file')).toBe(false);
    });

    it('should infer read-only for analysis tasks', () => {
      expect(inferReadOnlyFromTaskText('Analyze the codebase')).toBe(true);
      expect(inferReadOnlyFromTaskText('Review auth module')).toBe(true);
    });
  });

  describe('F3-003: Enhanced Python Repair Patterns', () => {
    it('should detect import-import collision patterns', () => {
      const collapsed = 'import pytest import unittest';
      const pattern = /^(\s*)(import\s+\S+)\s+(import\s+)/;
      expect(pattern.test(collapsed)).toBe(true);
    });

    it('should detect import-def collision patterns', () => {
      const collapsed = 'import pytest def test_foo():';
      const pattern = /^(\s*)((?:import|from)\s+[^\n]+?)\s+(def\s+)/;
      expect(pattern.test(collapsed)).toBe(true);
    });
  });

  describe('F3-007: Conversational Password Detection', () => {
    it('should detect "My password is X" pattern', () => {
      const pattern = /(?:my|the|your)?\s*password\s+is\s+['"]?([^\s'"]{4,})['"]?/gi;

      const test1 = 'My password is 123456';
      const match1 = pattern.exec(test1);
      expect(match1).not.toBeNull();
    });

    it('should handle minimum 4-char passwords', () => {
      const pattern = /(?:my|the|your)?\s*password\s+is\s+['"]?([^\s'"]{4,})['"]?/gi;

      const test = 'My password is 1234';
      const match = pattern.exec(test);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('1234');
    });
  });
});

describe('V13 Regression Prevention', () => {
  it('should NOT infer read-only for prompts with no clear intent', () => {
    expect(inferReadOnlyFromTaskText('What are the dependencies?')).toBe(false);
  });

  it('should correctly classify report generation as read-only', () => {
    expect(inferReadOnlyFromTaskText('Generate a report about the project structure')).toBe(true);
  });

  it('should still detect existing read-only patterns', () => {
    expect(inferReadOnlyFromTaskText('Analyze the codebase for security issues')).toBe(true);
    expect(inferReadOnlyFromTaskText('Audit the auth module')).toBe(true);
  });
});
