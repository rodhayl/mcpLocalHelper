import { describe, it, expect } from 'vitest';
import { LmStudioAdapter } from '../src/adapters/lmstudio.js';
import { OpenRouterAdapter } from '../src/adapters/openrouter.js';
import { getTestConfig } from './test-config.js';

const LMSTUDIO_READY = process.env.VITEST_LMSTUDIO_READY === 'true';

describe('E2E LM Studio Adapter', () => {
  it(
    'should probe and chat with the configured model',
    async () => {
      const config = getTestConfig();
      const baseUrl = config.lmStudioBaseUrl;
      const preferredModel = config.localModel;

      const adapter = new LmStudioAdapter('lmstudio-local', baseUrl);
      const probe = await adapter.probe();
      expect(probe.available).toBe(true);

      const models = await adapter.listModels();
      expect(models.length).toBeGreaterThan(0);

      const isChatCandidate = (id: string): boolean => {
        const lower = id.toLowerCase();
        return !(lower.includes('embedding') || lower.includes('text-embedding') || lower.includes('embed'));
      };

      const model =
        models.find((m) => m.id === preferredModel && isChatCandidate(m.id))?.id ||
        models.find((m) => isChatCandidate(m.id))?.id ||
        models[0].id;

      const res = await adapter.invokeChat({
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        model,
        max_tokens: 8,
        temperature: 0,
      });
      const content = (res.message.content || '').trim();
      expect(content.length).toBeGreaterThan(0);
    },
    60000
  );
});

describe.skipIf(!LMSTUDIO_READY)('E2E OpenRouter Adapter (LM Studio endpoint)', () => {
  it(
    'should list models and invoke chat',
    async () => {
      const config = getTestConfig();
      const baseUrl = config.lmStudioBaseUrl;
      const model = config.localModel;

      // OpenRouterAdapter is OpenAI-compatible; we point it at LM Studio to keep all tests local.
      const adapter = new OpenRouterAdapter('openrouter-sota', 'lmstudio-test-key', baseUrl);

      const probe = await adapter.probe();
      expect(probe.available).toBe(true);

      const models = await adapter.listModels();
      expect(models.length).toBeGreaterThan(0);

      const res = await adapter.invokeChat({
        messages: [{ role: 'user', content: 'Say "pong" only.' }],
        model,
        max_tokens: 16,
        temperature: 0,
      });
      expect((res.message.content || '').toLowerCase()).toContain('pong');
    },
    60000
  );
});
