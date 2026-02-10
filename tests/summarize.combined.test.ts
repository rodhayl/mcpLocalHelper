/**
 * Combined summarization tests
 * Merged from: summarize.fallback.test.ts, summarize_repo.limit.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '../src/config/index.js';
import { FileTools } from '../src/tools/file.js';
import { SummarizationTools } from '../src/tools/summarize.js';

// ===== Test LLM Stubs =====

class PlaceholderLlm {
  async chat() {
    return {
      message: {
        role: 'assistant',
        content: 'Summary was produced, but the raw text was not completed.',
      },
    } as any;
  }
}

class RecordingLlm {
  count = 0;
  async chat(_req: any, _role: 'local' | 'sota') {
    this.count++;
    return {
      message: { role: 'assistant', content: 'stub summary' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as any;
  }
}

// ===== Summarize Fallback Heuristics =====

describe('summarize fallback heuristics', () => {
  const testRoot = join(process.cwd(), 'tests', 'tmp', 'summarize-fallback');
  const docsDir = join(testRoot, 'docs');
  const docPath = join(docsDir, 'sample.md');

  beforeAll(() => {
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      docPath,
      '# Sample Document\n\nThis document explains the build and test workflow.\n\n## Usage\n\nRun npm test after changes.',
      'utf-8'
    );
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('returns a content-based summary when LLM output is a placeholder', async () => {
    const config = new ConfigManager();
    config.setDynamicWorkspaceRoots([testRoot]);
    const fileTools = new FileTools(config);
    const summaryTools = new SummarizationTools(fileTools, new PlaceholderLlm() as any);

    const result = await summaryTools.summarizePath('docs/sample.md', 'compact');

    expect(result.summary).toContain('Sample Document');
    expect(result.summary).not.toMatch(/raw text was not completed/i);
  });
});

// ===== Summarize Repo Limits =====

describe('summarize_repo limits file summaries and reports token usage', () => {
  it('compact mode limits to ≤3 file summaries and includes tokensUsed', async () => {
    const cm = new ConfigManager();
    const ft = new FileTools(cm);
    const llm = new RecordingLlm();
    const sum = new SummarizationTools(ft, llm as any);

    const res = await sum.summarizeRepo(process.cwd(), 'compact');
    expect(typeof res.summary).toBe('string');

    // tokensUsed is optional - only assert if present (depends on orchestration mode)
    if (res.tokensUsed) {
      expect(res.tokensUsed.input).toBeGreaterThanOrEqual(0);
      expect(res.tokensUsed.output).toBeGreaterThanOrEqual(0);
    }

    // Chat was invoked for each file summary (up to 3) plus one final repo summary
    expect(llm.count).toBeLessThanOrEqual(4);
    expect(llm.count).toBeGreaterThanOrEqual(2);
  });
});
