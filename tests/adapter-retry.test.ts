/**
 * Tests for adapter retry/backoff logic and error classification
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fetch for adapter tests
const originalFetch = global.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

describe('BaseBackend retry/backoff', () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    // Clear env vars
    delete process.env.LLM_ADAPTER_RETRIES;
    delete process.env.LLM_ADAPTER_RETRY_DELAY_MS;
    delete process.env.LLM_ADAPTER_RETRY_BACKOFF;
    delete process.env.DEBUG_ADAPTER;
    delete process.env.DEBUG_LLM;
  });

  describe('error classification', () => {
    it('should classify ECONNREFUSED as connection_refused', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      mockFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      // Now uses generic AdapterError hint
      expect(result.error).toContain('Backend unreachable');
    });

    it('should classify timeout errors correctly', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      mockFetch.mockRejectedValue(new Error('Request timed out'));
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should classify HTTP 429 as rate_limited', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Simulate 429 response - should retry but eventually fail
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });
      
      // Set retries to 0 to fail immediately
      process.env.LLM_ADAPTER_RETRIES = '0';
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      expect(result.error).toContain('429');
    });

    it('should classify HTTP 5xx as server_error', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Set retries to 0 to fail immediately
      process.env.LLM_ADAPTER_RETRIES = '0';
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      expect(result.error).toContain('503');
    });

    it('should classify HTTP 404 as not_found (non-retryable)', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      
      // Even with retries enabled, 404 should not retry
      process.env.LLM_ADAPTER_RETRIES = '3';
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      expect(result.error).toContain('404');
      // Should only be called once (no retries for 404)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry behavior', () => {
    it('should retry transient errors up to max retries', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Configure 2 retries with very short delay
      process.env.LLM_ADAPTER_RETRIES = '2';
      process.env.LLM_ADAPTER_RETRY_DELAY_MS = '10';
      
      // Fail with transient error 3 times (1 initial + 2 retries)
      mockFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      // 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    }, 5000);

    it('should succeed on retry after initial failure', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Configure 2 retries with very short delay
      process.env.LLM_ADAPTER_RETRIES = '2';
      process.env.LLM_ADAPTER_RETRY_DELAY_MS = '10';
      
      // Fail first, then succeed
      mockFetch
        .mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [] }),
        });
      
      const result = await adapter.probe();
      expect(result.available).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 5000);

    it('should apply exponential backoff', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Configure with specific backoff
      process.env.LLM_ADAPTER_RETRIES = '2';
      process.env.LLM_ADAPTER_RETRY_DELAY_MS = '100';
      process.env.LLM_ADAPTER_RETRY_BACKOFF = '2';
      
      const startTime = Date.now();
      
      // Fail all attempts
      mockFetch.mockRejectedValue(new Error('fetch failed'));
      
      const result = await adapter.probe();
      const elapsed = Date.now() - startTime;
      
      expect(result.available).toBe(false);
      // With 2 retries, delays should be ~100ms and ~200ms = ~300ms minimum
      // Allow some margin for execution time
      expect(elapsed).toBeGreaterThanOrEqual(200);
    }, 10000);

    it('should not retry when retries disabled', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Disable retries
      process.env.LLM_ADAPTER_RETRIES = '0';
      
      mockFetch.mockRejectedValue(new Error('fetch failed'));
      
      const result = await adapter.probe();
      expect(result.available).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('environment variable configuration', () => {
    it('should respect LLM_ADAPTER_RETRIES env var', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Set custom retry count
      process.env.LLM_ADAPTER_RETRIES = '5';
      process.env.LLM_ADAPTER_RETRY_DELAY_MS = '1';
      
      mockFetch.mockRejectedValue(new Error('fetch failed'));
      
      await adapter.probe();
      // 1 initial + 5 retries = 6 calls
      expect(mockFetch).toHaveBeenCalledTimes(6);
    }, 5000);

    it('should handle invalid env vars gracefully', async () => {
      const { LmStudioAdapter } = await import('../src/adapters/lmstudio.js');
      const adapter = new LmStudioAdapter('test', 'http://127.0.0.1:9999');
      
      // Set invalid values - should fall back to defaults
      process.env.LLM_ADAPTER_RETRIES = 'invalid';
      process.env.LLM_ADAPTER_RETRY_DELAY_MS = 'not-a-number';
      process.env.LLM_ADAPTER_RETRY_BACKOFF = 'NaN';
      
      mockFetch.mockRejectedValue(new Error('fetch failed'));
      
      // Should use defaults (3 retries - updated default for better reliability)
      await adapter.probe();
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 default retries
    }, 10000);
  });
});

describe('Ollama adapter error handling', () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.LLM_ADAPTER_RETRIES;
  });

  it('should provide helpful hints for connection errors', async () => {
    const { OllamaAdapter } = await import('../src/adapters/ollama.js');
    const adapter = new OllamaAdapter('test', 'http://127.0.0.1:11434');
    
    mockFetch.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
    
    const result = await adapter.probe();
    expect(result.available).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.error).toContain("Is Ollama running");
  });

  it('should handle timeout with helpful hint', async () => {
    const { OllamaAdapter } = await import('../src/adapters/ollama.js');
    const adapter = new OllamaAdapter('test', 'http://127.0.0.1:11434');
    
    mockFetch.mockRejectedValue(new Error('Request timed out'));
    
    const result = await adapter.probe();
    expect(result.available).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
