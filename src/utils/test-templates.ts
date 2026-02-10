/**
 * Test Generation Templates
 *
 * Template-based test code generation for generate_tests tool.
 * LLM returns structured JSON test specifications, server renders code from templates.
 *
 * Benefits:
 * - Consistent syntax (no LLM hallucination issues)
 * - Framework-specific best practices built into templates
 * - Easy to maintain and update
 * - Separates test logic from code formatting
 *
 * QA_feedback_7.md Analysis Task:
 * - Refactor generate_tests to use template-based architecture
 * - LLM provides JSON test spec, server generates code from template
 */

import Handlebars from 'handlebars';

/**
 * JSON schema for test specifications from LLM
 */
export interface TestSpecification {
  /** File being tested (for imports) */
  sourceFile: string;
  /** Functions/classes to import from source */
  imports: string[];
  /** Test suite name */
  suiteName: string;
  /** Individual test cases */
  testCases: TestCase[];
  /** Setup code (beforeEach/setUp) */
  setup?: string;
  /** Teardown code (afterEach/tearDown) */
  teardown?: string;
  /** Additional imports needed (e.g., mocking libraries) */
  additionalImports?: string[];
}

export interface TestCase {
  /** Test name/description */
  name: string;
  /** What is being tested (function name) */
  target: string;
  /** Test category (e.g., 'happy path', 'edge case', 'error handling') */
  category?: string;
  /** Input values for the test */
  inputs: Array<{
    name: string;
    value: string; // JSON-serializable string representation
  }>;
  /** Expected output or behavior */
  expected: {
    type: 'return' | 'throw' | 'call' | 'state';
    value?: string;
    matcher?: string; // e.g., 'toBe', 'toEqual', 'toContain', 'toThrow'
  };
  /** Whether this test is async */
  isAsync?: boolean;
  /** Mock setup code */
  mocks?: string;
  /** Additional assertions */
  additionalAssertions?: string[];
}

// Register Handlebars helpers
Handlebars.registerHelper('json', function (context) {
  return JSON.stringify(context);
});

Handlebars.registerHelper('indent', function (text: string, spaces: number) {
  if (!text) return '';
  const indent = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : indent + line))
    .join('\n');
});

Handlebars.registerHelper(
  'ifEquals',
  function (this: unknown, arg1: unknown, arg2: unknown, options: Handlebars.HelperOptions) {
    return arg1 === arg2 ? options.fn(this) : options.inverse(this);
  }
);

/**
 * Vitest/Jest template (TypeScript/JavaScript)
 */
const VITEST_TEMPLATE = `
import { describe, it, expect{{#if spec.setup}}, beforeEach{{/if}}{{#if spec.teardown}}, afterEach{{/if}} } from 'vitest';
{{#each spec.additionalImports}}
import {{{this}}};
{{/each}}
import { {{#each spec.imports}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from '{{spec.sourceFile}}';

describe('{{spec.suiteName}}', () => {
{{#if spec.setup}}
  beforeEach(() => {
    {{indent spec.setup 4}}
  });

{{/if}}
{{#if spec.teardown}}
  afterEach(() => {
    {{indent spec.teardown 4}}
  });

{{/if}}
{{#each spec.testCases}}
  it('{{name}}'{{#if isAsync}}, async {{else}}, {{/if}}() => {
{{#if mocks}}
    {{indent mocks 4}}
{{/if}}
{{#each inputs}}
    const {{name}} = {{value}};
{{/each}}
{{#ifEquals expected.type 'return'}}
    {{#if isAsync}}const result = await {{else}}const result = {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}});
    expect(result).{{expected.matcher}}({{expected.value}});
{{/ifEquals}}
{{#ifEquals expected.type 'throw'}}
    {{#if isAsync}}await expect(async () => {{else}}expect(() => {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})).{{expected.matcher}}({{#if expected.value}}{{expected.value}}{{/if}});
{{/ifEquals}}
{{#ifEquals expected.type 'call'}}
    {{#if isAsync}}await {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}});
    {{expected.value}}
{{/ifEquals}}
{{#ifEquals expected.type 'state'}}
    {{#if isAsync}}await {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}});
    {{expected.value}}
{{/ifEquals}}
{{#each additionalAssertions}}
    {{this}}
{{/each}}
  });

{{/each}}
});
`.trim();

/**
 * pytest template (Python)
 */
const PYTEST_TEMPLATE = `
import pytest
{{#each spec.additionalImports}}
{{this}}
{{/each}}
from {{spec.sourceFile}} import {{#each spec.imports}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}


class Test{{spec.suiteName}}:
    """Test suite for {{spec.suiteName}}"""
{{#if spec.setup}}

    def setup_method(self):
        """Set up test fixtures"""
        {{indent spec.setup 8}}
{{/if}}
{{#if spec.teardown}}

    def teardown_method(self):
        """Tear down test fixtures"""
        {{indent spec.teardown 8}}
{{/if}}

{{#each spec.testCases}}
    {{#if isAsync}}async {{/if}}def test_{{target}}_{{@index}}(self):
        """{{name}}"""
{{#if mocks}}
        {{indent mocks 8}}
{{/if}}
{{#each inputs}}
        {{name}} = {{value}}
{{/each}}
{{#ifEquals expected.type 'return'}}
        {{#if isAsync}}result = await {{else}}result = {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})
        assert result {{expected.matcher}} {{expected.value}}
{{/ifEquals}}
{{#ifEquals expected.type 'throw'}}
        with pytest.raises({{expected.value}}):
            {{#if isAsync}}await {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})
{{/ifEquals}}
{{#ifEquals expected.type 'call'}}
        {{#if isAsync}}await {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})
        {{expected.value}}
{{/ifEquals}}
{{#ifEquals expected.type 'state'}}
        {{#if isAsync}}await {{/if}}{{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})
        {{expected.value}}
{{/ifEquals}}
{{#each additionalAssertions}}
        {{this}}
{{/each}}

{{/each}}
`.trim();

/**
 * JUnit 5 template (Java)
 */
const JUNIT_TEMPLATE = `
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.DisplayName;
{{#if spec.setup}}
import org.junit.jupiter.api.BeforeEach;
{{/if}}
{{#if spec.teardown}}
import org.junit.jupiter.api.AfterEach;
{{/if}}
import static org.junit.jupiter.api.Assertions.*;
{{#each spec.additionalImports}}
{{this}}
{{/each}}
import {{spec.sourceFile}};

class {{spec.suiteName}}Test {
{{#if spec.setup}}

    @BeforeEach
    void setUp() {
        {{indent spec.setup 8}}
    }
{{/if}}
{{#if spec.teardown}}

    @AfterEach
    void tearDown() {
        {{indent spec.teardown 8}}
    }
{{/if}}

{{#each spec.testCases}}
    @Test
    @DisplayName("{{name}}")
    void test{{target}}_{{@index}}() {
{{#if mocks}}
        {{indent mocks 8}}
{{/if}}
{{#each inputs}}
        var {{name}} = {{value}};
{{/each}}
{{#ifEquals expected.type 'return'}}
        var result = {{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}});
        {{expected.matcher}}({{expected.value}}, result);
{{/ifEquals}}
{{#ifEquals expected.type 'throw'}}
        assertThrows({{expected.value}}.class, () -> {{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}}));
{{/ifEquals}}
{{#ifEquals expected.type 'call'}}
        {{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}});
        {{expected.value}}
{{/ifEquals}}
{{#each additionalAssertions}}
        {{this}}
{{/each}}
    }

{{/each}}
}
`.trim();

/**
 * Go testing template
 */
const GO_TEST_TEMPLATE = `
package {{spec.suiteName}}

import (
    "testing"
{{#each spec.additionalImports}}
    "{{this}}"
{{/each}}
)

{{#each spec.testCases}}
func Test{{target}}_{{@index}}(t *testing.T) {
    // {{name}}
{{#if mocks}}
    {{indent mocks 4}}
{{/if}}
{{#each inputs}}
    {{name}} := {{value}}
{{/each}}
{{#ifEquals expected.type 'return'}}
    result := {{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})
    if result {{expected.matcher}} {{expected.value}} {
        t.Errorf("Expected {{expected.value}}, got %v", result)
    }
{{/ifEquals}}
{{#ifEquals expected.type 'throw'}}
    defer func() {
        if r := recover(); r == nil {
            t.Errorf("Expected panic")
        }
    }()
    {{target}}({{#each inputs}}{{name}}{{#unless @last}}, {{/unless}}{{/each}})
{{/ifEquals}}
{{#each additionalAssertions}}
    {{this}}
{{/each}}
}

{{/each}}
`.trim();

// Compile templates
const templates: Record<string, Handlebars.TemplateDelegate<{ spec: TestSpecification }>> = {
  vitest: Handlebars.compile(VITEST_TEMPLATE),
  jest: Handlebars.compile(VITEST_TEMPLATE), // Same syntax as vitest
  pytest: Handlebars.compile(PYTEST_TEMPLATE),
  junit: Handlebars.compile(JUNIT_TEMPLATE),
  testng: Handlebars.compile(JUNIT_TEMPLATE), // Similar to JUnit
  go: Handlebars.compile(GO_TEST_TEMPLATE),
  'cargo test': Handlebars.compile(GO_TEST_TEMPLATE), // Placeholder - needs Rust template
};

/**
 * Get the template for a given framework
 */
export function getTemplate(
  framework: string
): Handlebars.TemplateDelegate<{ spec: TestSpecification }> | null {
  const normalizedFramework = framework.toLowerCase().trim();
  return templates[normalizedFramework] || null;
}

/**
 * Render test code from a test specification
 */
export function renderTestCode(spec: TestSpecification, framework: string): string {
  const template = getTemplate(framework);
  if (!template) {
    // Fallback: use vitest template for unknown frameworks
    return templates.vitest({ spec });
  }
  return template({ spec });
}

/**
 * Get the LLM prompt for generating test specifications (JSON)
 */
export function getTestSpecPrompt(
  framework: string,
  coverage: string,
  focusFunctions?: string[],
  testStyle?: string
): string {
  const focusClause = focusFunctions?.length
    ? `\nFocus ONLY on these functions: ${focusFunctions.join(', ')}`
    : '';

  return `You are a test specification generator. Analyze the provided code and generate a JSON test specification.

OUTPUT FORMAT: Return ONLY a valid JSON object with NO other text, following this exact schema:

{
  "sourceFile": "relative/path/to/source",
  "imports": ["functionName1", "ClassName2"],
  "suiteName": "DescriptiveTestSuiteName",
  "testCases": [
    {
      "name": "descriptive test name",
      "target": "functionOrMethodName",
      "category": "happy path|edge case|error handling",
      "inputs": [
        { "name": "paramName", "value": "JSON-serializable value as string" }
      ],
      "expected": {
        "type": "return|throw|call|state",
        "value": "expected value or assertion code",
        "matcher": "${framework === 'pytest' ? '==|!=|in|not in' : 'toBe|toEqual|toContain|toThrow|assertEquals'}"
      },
      "isAsync": false,
      "mocks": "optional mock setup code",
      "additionalAssertions": ["optional extra assertions"]
    }
  ],
  "setup": "optional beforeEach/setup code",
  "teardown": "optional afterEach/teardown code",
  "additionalImports": ["optional extra imports"]
}

COVERAGE LEVEL: ${coverage}
${coverage === 'basic' ? '- Generate 2-3 tests per function (happy path + one edge case)' : ''}
${coverage === 'comprehensive' ? '- Generate 4-6 tests per function (happy path, edge cases, error handling)' : ''}
${coverage === 'edge-cases' ? '- Focus on boundary conditions, null/undefined, type coercion, concurrency' : ''}

TEST STYLE: ${testStyle || 'unit'}
${testStyle === 'unit' ? '- Mock all external dependencies' : ''}
${testStyle === 'integration' ? '- Use real dependencies where possible' : ''}
${testStyle === 'real-implementation' ? '- No mocks, test actual behavior' : ''}
${focusClause}

FRAMEWORK: ${framework}

IMPORTANT:
1. Output ONLY the JSON object - no markdown, no explanation, no code blocks
2. All "value" fields in inputs/expected must be valid ${framework === 'pytest' ? 'Python' : 'JavaScript/TypeScript'} expressions as strings
3. Use appropriate matchers for the framework
4. Include realistic test data
5. For async functions, set isAsync: true`;
}

/**
 * Parse LLM response to extract test specification
 */
export function parseTestSpec(llmResponse: string): TestSpecification | null {
  try {
    // Try to extract JSON from the response
    let jsonStr = llmResponse.trim();

    // Remove markdown code blocks if present
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Remove any leading/trailing non-JSON content
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);

    // Basic validation
    if (!parsed.sourceFile || !parsed.imports || !parsed.suiteName || !parsed.testCases) {
      return null;
    }

    return parsed as TestSpecification;
  } catch {
    return null;
  }
}

/**
 * List of supported frameworks for template generation
 */
export const TEMPLATE_SUPPORTED_FRAMEWORKS = ['vitest', 'jest', 'pytest', 'junit', 'testng', 'go'];

/**
 * Check if a framework supports template generation
 */
export function supportsTemplateGeneration(framework: string): boolean {
  return TEMPLATE_SUPPORTED_FRAMEWORKS.includes(framework.toLowerCase().trim());
}
