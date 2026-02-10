import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';

describe('LlmEnhancedTools.localCodeReview', () => {
  it('should accept a directory path and review files within it', async () => {
    const tempDir = path.join(process.cwd(), 'tests', '.tmp-local-review');
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(tempDir, 'b.ts'), 'export const b = 2;\n');

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    // Stub LLM to avoid real backend calls
    (tools as any).llmChat = {
      chat: vi.fn(async () => ({
        message: {
          content: JSON.stringify({
            issues: [],
            recommendations: [],
            summary: 'Reviewed files.',
            score: 9,
          }),
        },
      })),
    };

    const relPath = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = await tools.localCodeReview([relPath], { reviewType: 'style' });

    expect(result.success).toBe(true);
    expect(result.filesReviewed).toBe(2);
    expect(result.summary).toContain('Reviewed files');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should require includeHidden=true when only hidden files exist', async () => {
    const tempDir = path.join(process.cwd(), 'tests', '.tmp-local-review-hidden');
    const hiddenDir = path.join(tempDir, '.hidden');
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(path.join(hiddenDir, 'secret.ts'), 'export const secret = true;\n');

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({
        message: {
          content: JSON.stringify({
            issues: [],
            recommendations: [],
            summary: 'Reviewed hidden files.',
            score: 8,
          }),
        },
      })),
    };

    const relPath = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = await tools.localCodeReview([relPath], { reviewType: 'style' });

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toMatch(/No readable files found/i);
    expect(String(result.error || '')).toMatch(/includeHidden=true/i);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should recover structured issues when model nests issue JSON inside summary text', async () => {
    const tempDir = path.join(process.cwd(), 'tests', '.tmp-local-review-summary-json');
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(path.join(tempDir, 'a.ts'), 'export const a = 1;\n');

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    const embedded = JSON.stringify({
      issues: [
        {
          file: 'tests/.tmp-local-review-summary-json/a.ts',
          line: 1,
          severity: 'medium',
          message: 'Prefer explicit return type for exported values.',
          fix: 'Add an explicit type annotation.',
        },
      ],
      recommendations: ['Enable stricter TS lint rules for exported APIs.'],
      summary: 'Recovered one maintainability issue.',
    });

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({
        message: {
          content: JSON.stringify({
            issues: [],
            recommendations: [],
            summary: `Model note (non-ideal format): ${embedded}`,
            score: 7,
          }),
        },
      })),
    };

    const relPath = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = await tools.localCodeReview([relPath], { reviewType: 'style' });

    expect(result.success).toBe(true);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]?.file).toContain('a.ts');
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.summary).toContain('Recovered one maintainability issue');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return actionable guidance when no readable files are found', async () => {
    const tempDir = path.join(process.cwd(), 'tests', '.tmp-local-review-empty');
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });

    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    const relPath = path.relative(process.cwd(), tempDir).replace(/\\/g, '/');
    const result = await tools.localCodeReview([relPath], { reviewType: 'style' });

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toMatch(/No readable files found/i);
    expect(String(result.error || '')).toMatch(/includeHidden|workspace|search action=\"filenames\"/i);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
