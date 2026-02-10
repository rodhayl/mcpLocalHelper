import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';
import { INPUT_LIMITS } from '../src/utils/input-limits.js';

const tempDir = path.join(process.cwd(), 'tests', '.tmp-llm-enhanced-prompts');

describe('LlmEnhancedTools prompt limits', () => {
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('analyzeFile should cap user prompt length to safe limits', async () => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const target = path.join(tempDir, 'huge.ts');
    const hugeContent = 'x'.repeat(INPUT_LIMITS.MAX_PROMPT_LENGTH * 2);
    writeFileSync(target, hugeContent);

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    let capturedUser = '';
    (tools as any).llmChat = {
      chat: vi.fn(async (req: any) => {
        const userMsg = req.messages.find((m: any) => m.role === 'user');
        capturedUser = userMsg?.content ?? '';
        return { message: { content: 'ok' } };
      }),
    };

    const relPath = path.relative(process.cwd(), target).replace(/\\/g, '/');
    await tools.analyzeFile(relPath, { analysisType: 'full' });

    expect(capturedUser.length).toBeLessThanOrEqual(INPUT_LIMITS.MAX_PROMPT_LENGTH);
  });

  it('localCodeReview should cap user prompt length to safe limits', async () => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    const a = path.join(tempDir, 'a.ts');
    const b = path.join(tempDir, 'b.ts');
    const hugeContent = 'y'.repeat(INPUT_LIMITS.MAX_PROMPT_LENGTH);
    writeFileSync(a, hugeContent);
    writeFileSync(b, hugeContent);

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    let capturedUser = '';
    (tools as any).llmChat = {
      chat: vi.fn(async (req: any) => {
        const userMsg = req.messages.find((m: any) => m.role === 'user');
        capturedUser = userMsg?.content ?? '';
        return { message: { content: JSON.stringify({ issues: [], recommendations: [], summary: 'ok', score: 9 }) } };
      }),
    };

    const relDir = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    await tools.localCodeReview([relDir], { reviewType: 'comprehensive' });

    expect(capturedUser.length).toBeLessThanOrEqual(INPUT_LIMITS.MAX_PROMPT_LENGTH);
  });
});
