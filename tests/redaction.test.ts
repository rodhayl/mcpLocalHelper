import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { RedactionEngine } from '../src/utils/redaction.js';
import { ConfigManager } from '../src/config/index.js';
import { FileTools } from '../src/tools/file.js';

describe('RedactionEngine', () => {
  it('should redact API keys', () => {
    const engine = new RedactionEngine();
    const simulatedApiKey = `sk${'-1234567890abcdef1234567890abcdef'}`;
    const text = `api_key=${simulatedApiKey}`;
    const redacted = engine.redact(text);
    // The sk- pattern should redact the API key value
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain(`sk${'-1234567890abcdef'}`);
  });

  it('should avoid sk- false positives inside normal words', () => {
    const engine = new RedactionEngine();
    const text = '/api/models/task-suitability';
    const redacted = engine.redact(text);
    expect(redacted).toBe(text);
  });

  it('should redact bearer tokens', () => {
    const engine = new RedactionEngine();
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const redacted = engine.redact(text);
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('should truncate text within byte limits', () => {
    const engine = new RedactionEngine();
    const text = 'a'.repeat(1000);
    const { text: truncated, truncated: wasTruncated } = engine.truncate(text, 100);
    expect(wasTruncated).toBe(true);
    expect(truncated.length).toBeLessThan(200); // Should include truncation marker
  });

  it('should not truncate text within limits', () => {
    const engine = new RedactionEngine();
    const text = 'Short text';
    const { text: result, truncated: wasTruncated } = engine.truncate(text, 1000);
    expect(wasTruncated).toBe(false);
    expect(result).toBe(text);
  });

  it('should strip <think> tags from LLM responses', () => {
    const engine = new RedactionEngine();
    const text = '<think>\nLet me analyze this...\nOkay, I understand.\n</think>\n\nThe answer is 42.';
    const cleaned = engine.stripThinkTags(text);
    expect(cleaned).toBe('The answer is 42.');
    expect(cleaned).not.toContain('<think>');
    expect(cleaned).not.toContain('</think>');
    expect(cleaned).not.toContain('Let me analyze');
  });

  it('should handle multiple <think> blocks', () => {
    const engine = new RedactionEngine();
    const text = '<think>First thought</think>Hello <think>Second thought</think>World';
    const cleaned = engine.stripThinkTags(text);
    expect(cleaned).toBe('Hello World');
  });

  it('should handle case-insensitive think tags', () => {
    const engine = new RedactionEngine();
    const text = '<THINK>Uppercase</THINK>Result<Think>Mixed</Think>Final';
    const cleaned = engine.stripThinkTags(text);
    expect(cleaned).toBe('ResultFinal');
  });

  it('should provide redaction summary with pattern counts', () => {
    const engine = new RedactionEngine();
    const simulatedApiKey = `sk${'-1234567890abcdef1234567890abcdef'}`;
    const text = `api_key=${simulatedApiKey}`;
    const { text: redacted, summary } = engine.redactWithSummary(text);

    expect(redacted).toContain('[REDACTED]');
    expect(summary.totalReplacements).toBeGreaterThan(0);
    expect(Object.keys(summary.byPattern).length).toBeGreaterThan(0);
  });

  it('should only redact env-style assignments in strict mode', () => {
    const defaultEngine = new RedactionEngine({ mode: 'default' });
    const strictEngine = new RedactionEngine({ mode: 'strict' });

    const text = 'SOME_VALUE=notsecret';
    expect(defaultEngine.redact(text)).toBe(text);
    expect(strictEngine.redact(text)).toContain('[REDACTED]');
    expect(strictEngine.redact(text)).toBe('SOME_VALUE=[REDACTED]');
  });
});

describe('RedactionEngine SOTA filters', () => {
  it('should remove large code blocks and Windows paths', () => {
    const engine = new RedactionEngine();
    const text = '```' + 'a'.repeat(1500) + '```\nC:\\Users\\bob\\secret\\file.txt';
    const filtered = engine.applySotaFilters(text);
    expect(filtered).toContain('[LARGE CODE BLOCK REMOVED]');
    expect(filtered).toContain('[PATH]');
  });
});

describe('RedactionEngine truncation boundaries', () => {
  it('should truncate multibyte strings within byte limit and append marker', () => {
    const engine = new RedactionEngine();
    const emoji = '😀';
    const text = emoji.repeat(2000); // multibyte heavy
    const maxBytes = 500; // small limit
    const { text: truncated, truncated: wasTruncated } = engine.truncate(text, maxBytes);
    expect(wasTruncated).toBe(true);
    expect(truncated.endsWith('...[truncated]')).toBe(true);

    const encoder = new TextEncoder();
    const [pre] = truncated.split('\n...[truncated]');
    expect(encoder.encode(pre).length).toBeLessThanOrEqual(maxBytes);
  });
});

describe('read_file redaction cases', () => {
  const tmpDir = resolve(process.cwd(), 'tests/tmp');
  const filePath = resolve(tmpDir, 'secrets.txt');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    const simulatedApiKey = `sk${'-1234567890abcdef1234567890abcdef'}`;
    const content = [
      `API_KEY=${simulatedApiKey}`,
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      'DATABASE_URL=https://user:pass@host.example.com/db',
      'SOME_VALUE=notsecret',
    ].join('\n');
    writeFileSync(filePath, content, 'utf-8');
  });

  it('should redact .env lines, tokens, and URLs with credentials', () => {
    const cm = new ConfigManager();
    const ft = new FileTools(cm);
    const result = ft.readFile(filePath, 65536);
    expect(result.content).toContain('[REDACTED]');
    expect(result.content).not.toContain(`sk${'-1234567890abcdef1234567890abcdef'}`);
    expect(result.content).not.toContain('Bearer abcdef');
    expect(result.content).not.toContain('user:pass@');
    expect(result.truncated).toBe(false);
  });
});
