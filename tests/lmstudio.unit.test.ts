/**
 * Combined LM Studio Unit Tests
 * Merged from: lmstudio.probe.unit.test.ts, lmstudio.request-format.unit.test.ts
 *
 * Tests:
 * - probeLmStudio readiness detection
 * - LmStudioAdapter request format sanitization
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeLmStudio } from './test-utils/lmstudio.js';
import { LmStudioAdapter } from '../src/adapters/lmstudio.js';

// ============================================
// probeLmStudio Tests
// ============================================

describe('probeLmStudio', () => {
  const base = 'http://127.0.0.1:1234/v1';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns not-ready when /models returns empty data', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    );

    const res = await probeLmStudio(base, { timeoutMs: 5000 });
    expect(res.reachable).toBe(true);
    expect(res.hasModels).toBe(false);
    expect(res.ready).toBe(false);
  });

  it('returns ready when models exist and chat works', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'm' }] }) }).mockResolvedValueOnce({ ok: true }));

    const res = await probeLmStudio(base, { timeoutMs: 5000 });
    expect(res.ready).toBe(true);
    expect(res.inferenceOk).toBe(true);
  });

  it.skip('returns not-ready when chat fails (model not loaded)', async () => {
    // TODO: This test has timer interaction issues with vitest mocks
    // The AbortController setTimeout conflicts with fake timers
    // Skipping until we can refactor probeLmStudio to be more testable

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'm' }] }) })
        .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'No model loaded' })
    );

    const res = await probeLmStudio(base, { timeoutMs: 5000 });
    expect(res.reachable).toBe(true);
    expect(res.hasModels).toBe(true);
    expect(res.inferenceOk).toBe(false);
    expect(res.ready).toBe(false);
  });
});

// ============================================
// LmStudioAdapter Request Format Tests
// ============================================

describe('LmStudioAdapter request format', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should strip non-OpenAI fields from messages before sending', async () => {
    let capturedBody: any = null;

    const fetchMock = vi.fn(async (url: any, options: any) => {
      const u = String(url);
      if (u.endsWith('/chat/completions')) {
        capturedBody = JSON.parse(String(options?.body || 'null'));
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    });

    vi.stubGlobal('fetch', fetchMock as any);

    const adapter = new LmStudioAdapter('lmstudio', 'http://127.0.0.1:1234/v1', {
      backendChat: 5000,
      backendListModels: 5000,
    });

    await adapter.invokeChat({
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: 'hello',
          // Simulate non-standard message fields that some callers may include.
          name: 'alice',
          tool_call_id: 'tool-123',
        } as any,
      ],
      // Also simulate odd numeric values some callers may send.
      temperature: Number.NaN as any,
      max_tokens: 123.4 as any,
    } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).toBeTruthy();

    expect(Array.isArray(capturedBody.messages)).toBe(true);
    expect(capturedBody.messages[0]).toEqual({ role: 'user', content: 'hello' });
    // Ensure we don't send NaN/float values through to LM Studio.
    expect(capturedBody.temperature).toBeUndefined();
    expect(capturedBody.max_tokens).toBeUndefined();
  });
});
