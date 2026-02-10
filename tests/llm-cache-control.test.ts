/**
 * Tests for LLM cache control features and health endpoint cache stats
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LLMCache, getLLMCache, resetLLMCache } from '../src/utils/llm-cache.js';

describe('LLM Cache Control', () => {
  let cache: LLMCache;

  beforeEach(() => {
    resetLLMCache();
    cache = getLLMCache();
  });

  afterEach(() => {
    resetLLMCache();
  });

  describe('setEnabled', () => {
    it('should enable caching when set to true', () => {
      cache.setEnabled(true);
      const stats = cache.getStats();
      expect(stats.enabled).toBe(true);
    });

    it('should disable caching when set to false', () => {
      cache.setEnabled(false);
      const stats = cache.getStats();
      expect(stats.enabled).toBe(false);
    });

    it('should not cache when disabled', () => {
      cache.setEnabled(false);
      
      const messages = [{ role: 'user', content: 'Hello' }];
      cache.setFromMessages(messages, { message: { role: 'assistant', content: 'Hi there!' } }, 'test-model');
      
      const result = cache.getFromMessages(messages, 'test-model');
      expect(result).toBeNull();
    });

    it('should resume caching when re-enabled', () => {
      cache.setEnabled(false);
      cache.setEnabled(true);
      
      const messages = [{ role: 'user', content: 'Hello test message for caching' }];
      const response = { message: { role: 'assistant', content: 'Hi there! This is a response with enough tokens to be cached.' } };
      
      cache.setFromMessages(messages, response, 'test-model');
      
      const result = cache.getFromMessages(messages, 'test-model');
      expect(result).not.toBeNull();
    });
  });

  describe('setTtl', () => {
    it('should update TTL for new cache entries', () => {
      cache.setTtl(1000); // 1 second TTL
      
      const messages = [{ role: 'user', content: 'Short TTL test message' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages, response, 'test-model');
      
      // Should still be cached immediately
      const result = cache.getFromMessages(messages, 'test-model');
      expect(result).not.toBeNull();
    });

    it('should expire entries after TTL', async () => {
      cache.setTtl(50); // 50ms TTL
      
      const messages = [{ role: 'user', content: 'Expiring TTL test message' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages, response, 'test-model');
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const result = cache.getFromMessages(messages, 'test-model');
      expect(result).toBeNull();
    }, 1000);
  });

  describe('clear', () => {
    it('should clear all cache entries', () => {
      const messages1 = [{ role: 'user', content: 'First message for cache clear test' }];
      const messages2 = [{ role: 'user', content: 'Second message for cache clear test' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages1, response, 'test-model');
      cache.setFromMessages(messages2, response, 'test-model');
      
      const statsBefore = cache.getStats();
      expect(statsBefore.entries).toBe(2);
      
      cache.clear();
      
      const statsAfter = cache.getStats();
      expect(statsAfter.entries).toBe(0);
      expect(statsAfter.hits).toBe(0);
      expect(statsAfter.misses).toBe(0);
    });

    it('should reset hit/miss counters', () => {
      const messages = [{ role: 'user', content: 'Message for hit/miss counter test' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages, response, 'test-model');
      cache.getFromMessages(messages, 'test-model'); // hit
      cache.getFromMessages([{ role: 'user', content: 'nonexistent' }], 'test-model'); // miss
      
      const statsBefore = cache.getStats();
      expect(statsBefore.hits).toBeGreaterThan(0);
      expect(statsBefore.misses).toBeGreaterThan(0);
      
      cache.clear();
      
      const statsAfter = cache.getStats();
      expect(statsAfter.hits).toBe(0);
      expect(statsAfter.misses).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct cache statistics', () => {
      const stats = cache.getStats();
      
      expect(stats).toHaveProperty('enabled');
      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('entries');
      expect(stats).toHaveProperty('hitRate');
      expect(stats).toHaveProperty('avgHitAge');
      expect(stats).toHaveProperty('inFlight');
    });

    it('should track hit rate correctly', () => {
      const messages = [{ role: 'user', content: 'Hit rate tracking test message' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages, response, 'test-model');
      
      // Generate some hits and misses
      cache.getFromMessages(messages, 'test-model'); // hit
      cache.getFromMessages(messages, 'test-model'); // hit
      cache.getFromMessages([{ role: 'user', content: 'miss1' }], 'test-model'); // miss
      cache.getFromMessages([{ role: 'user', content: 'miss2' }], 'test-model'); // miss
      
      const stats = cache.getStats();
      // 2 hits out of 4 total = 0.5 hit rate
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(0.5, 1);
    });

    it('should track in-flight count', () => {
      const stats = cache.getStats();
      expect(typeof stats.inFlight).toBe('number');
      expect(stats.inFlight).toBeGreaterThanOrEqual(0);
    });
  });

  describe('singleton behavior', () => {
    it('should return same instance from getLLMCache', () => {
      const cache1 = getLLMCache();
      const cache2 = getLLMCache();
      expect(cache1).toBe(cache2);
    });

    it('should create new instance after reset', () => {
      const cache1 = getLLMCache();
      cache1.setEnabled(false);
      
      resetLLMCache();
      
      const cache2 = getLLMCache();
      const stats = cache2.getStats();
      expect(stats.enabled).toBe(true); // New instance with default enabled
    });
  });

  describe('message normalization', () => {
    it('should normalize whitespace for cache key', () => {
      const messages1 = [{ role: 'user', content: 'Hello   world   test' }];
      const messages2 = [{ role: 'user', content: 'Hello world test' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages1, response, 'test-model');
      
      // Should hit cache with normalized whitespace
      const result = cache.getFromMessages(messages2, 'test-model');
      expect(result).not.toBeNull();
    });

    it('should NOT normalize case for cache key (Plan 2: case matters for code)', () => {
      // Plan 2: Cache key normalization was changed to preserve case
      // because case is significant in code (FunctionName vs functionname)
      const messages1 = [{ role: 'user', content: 'HELLO WORLD TEST MESSAGE' }];
      const messages2 = [{ role: 'user', content: 'hello world test message' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages1, response, 'test-model');
      
      // Should NOT hit cache because case is now preserved (different keys)
      const result = cache.getFromMessages(messages2, 'test-model');
      expect(result).toBeNull();
      
      // Same case SHOULD hit cache
      const sameCase = cache.getFromMessages(messages1, 'test-model');
      expect(sameCase).not.toBeNull();
    });

    it('should normalize model names', () => {
      const messages = [{ role: 'user', content: 'Model name normalization test' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      cache.setFromMessages(messages, response, 'GPT-4');
      
      // Should hit cache with normalized model name
      const result = cache.getFromMessages(messages, 'gpt-4');
      expect(result).not.toBeNull();
    });

    it('should normalize temperature for cache key', () => {
      const messages = [{ role: 'user', content: 'Temperature normalization test message' }];
      const response = { message: { role: 'assistant', content: 'Response with enough content to be cached properly.' } };
      
      // Set with floating point precision issue
      cache.setFromMessages(messages, response, 'test-model', { temperature: 0.7000000001 });
      
      // Should hit cache with rounded temperature
      const result = cache.getFromMessages(messages, 'test-model', { temperature: 0.7 });
      expect(result).not.toBeNull();
    });
  });
});

describe('Cache integration with mcp_health', () => {
  // These would be integration tests that require the full server
  // For now, we just test the cache stats format matches expectations
  
  it('should provide stats in expected format for health endpoint', () => {
    resetLLMCache();
    const cache = getLLMCache();
    
    const stats = cache.getStats();
    
    // Health endpoint expects these fields
    expect(typeof stats.enabled).toBe('boolean');
    expect(typeof stats.entries).toBe('number');
    expect(typeof stats.hitRate).toBe('number');
    expect(typeof stats.inFlight).toBe('number');
    expect(typeof stats.hits).toBe('number');
    expect(typeof stats.misses).toBe('number');
    expect(typeof stats.avgHitAge).toBe('number');
  });
});
