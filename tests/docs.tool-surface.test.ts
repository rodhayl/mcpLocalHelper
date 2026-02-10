import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { CORE_TOOLS, AGENT_ONLY_TOOLS } from '../src/server/tool-discovery';

const PROMPT_FILES = [
  'docs/prompts/MCP_TEST_CRITICAL_STANDARD.md',
  'docs/prompts/MCP_TEST_CRITICAL_COMPACT.md',
  'docs/prompts/MCP_TEST_COMPREHENSIVE_V2.md',
  'docs/prompts/MCP_TEST_COMPACT_V2.md',
  'docs/prompts/MCP_TEST_BLACK_BOX_STANDARD.md',
  'docs/prompts/MCP_TEST_BLACK_BOX_COMPACT.md',
];

describe('documentation tool surface alignment', () => {
  it('AGENTS.md core tools list matches CORE_TOOLS', () => {
    const content = readFileSync('.mcp-local-llm/AGENTS.md', 'utf8');
    const coreLine = content.split('\n').find((line) => line.includes('**Core Tools**')) || '';
    const listed = Array.from(coreLine.matchAll(/`([^`]+)`/g)).map((m) => m[1]);
    const expected = Array.from(CORE_TOOLS);

    expect(listed.length).toBe(expected.length);
    expect(new Set(listed)).toEqual(new Set(expected));
  });

  it('AGENTS.md lists verify_plan as agent-only', () => {
    const content = readFileSync('.mcp-local-llm/AGENTS.md', 'utf8');
    expect(content).toContain('verify_plan');
    expect(AGENT_ONLY_TOOLS).toContain('verify_plan');
  });

  it('MCP_TEST prompts call out verify_plan agent-only and generate_tests removal', () => {
    for (const filePath of PROMPT_FILES) {
      const content = readFileSync(filePath, 'utf8');
      expect(content).toMatch(/verify_plan/i);
      expect(content).toMatch(/agent[_-]?task/i);
      expect(content).toMatch(/generate_tests.*removed|removed.*generate_tests/i);
    }
  });
});
