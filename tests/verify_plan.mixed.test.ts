import { describe, it, expect, beforeAll } from 'vitest';
import { FileTools } from '../src/tools/file.js';
import { GrepTools } from '../src/tools/grep.js';
import { SummarizationTools } from '../src/tools/summarize.js';
import { VerifyPlanTool } from '../src/tools/verify.js';
import { ConfigManager } from '../src/config/index.js';

class StubLlmChatTool {
  async chat(req: any, _role: 'local' | 'sota') {
    // Return a JSON evaluation that marks needs_changes when description mentions missing
    const evaluation = {
      status: 'ok',
      reasons: ['Step looks reasonable'],
      suggested_changes: ['Consider running tests'],
    };
    return { message: { role: 'assistant', content: JSON.stringify(evaluation) } } as any;
  }
}

describe('verify_plan mixed verdicts with deep mode', () => {
  it('should produce evidence and needs_changes for missing targets', async () => {
    const cm = new ConfigManager();
    const ft = new FileTools(cm);
    const gt = new GrepTools(cm);
    const llm = new StubLlmChatTool() as any;
    const sum = new SummarizationTools(ft, llm);
    const vp = new VerifyPlanTool(ft, gt, llm, sum);

    const plan = {
      plan_id: 'mixed-1',
      context_root: process.cwd(),
      steps: [
        {
          id: 's1',
          title: 'Check adapters directory',
          description: 'Ensure adapters exist',
          targets: ['src/adapters/'],
        },
        {
          id: 's2',
          title: 'Nonexistent file',
          description: 'This should be missing',
          targets: ['src/does-not-exist.ts'],
        },
        {
          id: 's3',
          title: 'Pattern match',
          description: 'Find class declaration',
          targets: ['optional-pattern:class\\s+OllamaAdapter'],
        },
      ],
      mode: 'deep',
    };

    const res = await vp.verifyPlan(plan as any);
    expect(res.plan_id).toBe('mixed-1');
    expect(Array.isArray(res.steps)).toBe(true);
    const s2 = res.steps.find((s) => s.id === 's2');
    expect(s2?.status).toBe('needs_changes');
    const s1 = res.steps.find((s) => s.id === 's1');
    expect(['ok', 'needs_changes', 'blocked']).toContain(s1?.status as any);
    const s3 = res.steps.find((s) => s.id === 's3');
    expect(s3?.evidence?.length).toBeGreaterThan(0);
    expect(['ok', 'needs_changes', 'high_risk']).toContain(res.overall_verdict);
  });
});
