/**
 * Combined Utility Tests
 * Merged from: utils/concurrency-limiter.test.ts, utils/debug-logger.test.ts,
 *              utils/llm-cache.test.ts, utils/task-queue.test.ts
 *
 * Tests the enhanced utility features including:
 * - ConcurrencyLimiter: Semaphore, timeouts, queue limits, progressive timeout
 * - DebugLogger: Logging levels, operation timing, health reporting, path redaction
 * - LLMCache: Caching, adaptive TTL, LRU+LFU eviction, request coalescing
 * - TaskQueue: Queuing, progressive timeout, health checks, stale task cleanup
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConcurrencyLimiter,
  ConcurrencyLimiterTimeoutError,
  ConcurrencyLimiterQueueFullError,
} from '../src/utils/concurrency-limiter.js';
import {
  DebugLogger,
  getDebugLogger,
  resetDebugLogger,
  debug,
  type LogCategory,
} from '../src/utils/debug-logger.js';
import { LLMCache } from '../src/utils/llm-cache.js';
import { TaskQueue } from '../src/utils/task-queue.js';

// ============================================
// ConcurrencyLimiter Tests
// ============================================

describe('ConcurrencyLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic functionality', () => {
    it('should allow up to max concurrent operations', async () => {
      const limiter = new ConcurrencyLimiter(2);
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 100));
        concurrent--;
      };

      vi.useRealTimers();
      const promises = [limiter.run(task), limiter.run(task), limiter.run(task)];
      await Promise.all(promises);
      expect(maxConcurrent).toBe(2);
    });

    it('should queue tasks when at max concurrency', async () => {
      vi.useRealTimers();
      const limiter = new ConcurrencyLimiter(1);
      const order: number[] = [];

      const task = (n: number) => async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, 10));
      };

      await Promise.all([limiter.run(task(1)), limiter.run(task(2)), limiter.run(task(3))]);
      expect(order).toEqual([1, 2, 3]);
    });

    it('should report correct status', () => {
      const limiter = new ConcurrencyLimiter({ max: 3 });
      const status = limiter.getStatus();
      expect(status.max).toBe(3);
      expect(status.running).toBe(0);
      expect(status.queued).toBe(0);
    });
  });

  describe('timeout protection', () => {
    it('should timeout when waiting too long for a slot', async () => {
      const limiter = new ConcurrencyLimiter({ max: 1, acquireTimeoutMs: 100 });
      const longTask = limiter.run(async () => {
        await new Promise((r) => setTimeout(r, 1000));
      });

      const acquirePromise = limiter.run(async () => 'completed');
      let rejectedError: Error | null = null;
      acquirePromise.catch((err) => { rejectedError = err; });

      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => rejectedError !== null);
      expect(rejectedError).toBeInstanceOf(ConcurrencyLimiterTimeoutError);

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.allSettled([longTask]);
    });
  });

  describe('queue limits', () => {
    it('should reject when queue is full', async () => {
      const limiter = new ConcurrencyLimiter({ max: 1, maxQueueSize: 2, acquireTimeoutMs: 10000 });
      const tasks = [
        limiter.run(async () => { await new Promise((r) => setTimeout(r, 1000)); }),
        limiter.run(async () => { await new Promise((r) => setTimeout(r, 1000)); }),
        limiter.run(async () => { await new Promise((r) => setTimeout(r, 1000)); }),
      ];

      await expect(limiter.run(async () => 'overflow')).rejects.toThrow(ConcurrencyLimiterQueueFullError);
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.allSettled(tasks);
    });
  });

  describe('diagnostics', () => {
    it('should track run time statistics', async () => {
      vi.useRealTimers();
      const limiter = new ConcurrencyLimiter(2);

      await limiter.run(async () => { await new Promise((r) => setTimeout(r, 50)); });
      await limiter.run(async () => { await new Promise((r) => setTimeout(r, 30)); });

      const diag = limiter.getDiagnostics();
      expect(diag.totalCompletedRuns).toBe(2);
      expect(diag.avgRunTimeMs).toBeGreaterThan(0);
    });
  });
});

// ============================================
// DebugLogger Tests
// ============================================

describe('DebugLogger', () => {
  let logger: DebugLogger;

  beforeEach(() => {
    logger = new DebugLogger({
      minLevel: 'trace',
      consoleOutput: false,
      maxEntries: 100,
      maxErrors: 50,
      enabledCategories: [],
      trackMetrics: true,
      maxMetrics: 50,
    });
  });

  afterEach(() => {
    resetDebugLogger();
    vi.useRealTimers();
  });

  describe('basic logging', () => {
    it('should log messages at all levels', () => {
      logger.error('mcp', 'Error message');
      logger.warn('mcp', 'Warning message');
      logger.info('mcp', 'Info message');
      logger.debug('mcp', 'Debug message');
      logger.trace('mcp', 'Trace message');

      const logs = logger.getRecentLogs(10);
      expect(logs.length).toBe(5);
    });

    it('should filter by minimum level', () => {
      const infoLogger = new DebugLogger({ minLevel: 'info', consoleOutput: false });
      infoLogger.error('mcp', 'Error');
      infoLogger.warn('mcp', 'Warning');
      infoLogger.info('mcp', 'Info');
      infoLogger.debug('mcp', 'Debug');
      infoLogger.trace('mcp', 'Trace');

      const logs = infoLogger.getRecentLogs(10);
      expect(logs.length).toBe(3);
    });

    it('should include context in log entries', () => {
      logger.info('mcp', 'Message with context', { key: 'value', count: 42 });
      const logs = logger.getRecentLogs(1);
      expect(logs[0].context).toEqual({ key: 'value', count: 42 });
    });
  });

  describe('operation timing', () => {
    it('should track operation duration', async () => {
      const opId = logger.startOperation('test-operation', 'mcp');
      await new Promise((r) => setTimeout(r, 50));
      const duration = logger.endOperation(opId, 'test-operation', true);
      expect(duration).toBeGreaterThanOrEqual(40);
    });

    it('should track failure count', () => {
      const opId1 = logger.startOperation('flaky-op', 'agent');
      logger.endOperation(opId1, 'flaky-op', true);
      const opId2 = logger.startOperation('flaky-op', 'agent');
      logger.endOperation(opId2, 'flaky-op', false);

      const metrics = logger.getMetrics();
      const metric = metrics.find((m) => m.name === 'flaky-op');
      expect(metric!.count).toBe(2);
      expect(metric!.failures).toBe(1);
    });
  });

  describe('health report', () => {
    it('should report healthy status with no issues', () => {
      const opId = logger.startOperation('healthy-op', 'mcp');
      logger.endOperation(opId, 'healthy-op', true);
      const report = logger.getHealthReport();
      expect(report.status).toBe('healthy');
      expect(report.issues.length).toBe(0);
    });
  });

  describe('path redaction', () => {
    it('should redact Windows absolute paths in log messages', () => {
      logger.error('mcp', 'Error at C:\\Users\\testuser\\project\\file.ts:10');
      const errors = logger.getErrors();
      const msg = errors[0].message;
      expect(msg).not.toContain('testuser');
    });
  });

  describe('singleton instance', () => {
    it('should return the same instance', () => {
      const instance1 = getDebugLogger();
      const instance2 = getDebugLogger();
      expect(instance1).toBe(instance2);
    });
  });

  describe('debug quick access functions', () => {
    beforeEach(() => { resetDebugLogger(); });

    it('should provide shorthand logging methods', () => {
      debug.error('mcp', 'Error');
      debug.warn('mcp', 'Warn');
      debug.info('mcp', 'Info');
      const summary = debug.getSummary();
      expect(summary.totalLogs).toBeGreaterThan(0);
    });
  });
});

// ============================================
// LLMCache Tests
// ============================================

describe('LLMCache', () => {
  let cache: LLMCache;

  beforeEach(() => {
    cache = new LLMCache({
      enabled: true,
      ttlMs: 60000,
      maxEntries: 10,
      minResponseTokens: 1,
      adaptiveTtl: true,
      maxTtlMs: 300000,
      cleanupIntervalMs: 30000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic operations', () => {
    it('should cache and retrieve responses', () => {
      cache.set('test prompt', 'test response', 'model-1');
      const result = cache.get('test prompt', 'model-1');
      expect(result).toBe('test response');
    });

    it('should return null for cache miss', () => {
      const result = cache.get('nonexistent', 'model-1');
      expect(result).toBeNull();
    });

    it('should differentiate by model', () => {
      cache.set('prompt', 'response-a', 'model-a');
      cache.set('prompt', 'response-b', 'model-b');
      expect(cache.get('prompt', 'model-a')).toBe('response-a');
      expect(cache.get('prompt', 'model-b')).toBe('response-b');
    });

    it('should track hits and misses', () => {
      cache.set('prompt', 'response');
      cache.get('prompt');
      cache.get('missing');
      cache.get('prompt');
      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });
  });

  describe('message-based caching', () => {
    it('should cache using message arrays', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];
      cache.setFromMessages(messages, { content: 'response' }, 'model');
      const result = cache.getFromMessages(messages, 'model');
      expect(result).toEqual({ content: 'response' });
    });
  });

  describe('TTL and expiration', () => {
    it('should expire entries after TTL', async () => {
      vi.useFakeTimers();
      cache.set('prompt', 'response');
      expect(cache.get('prompt')).toBe('response');
      vi.advanceTimersByTime(70000);
      expect(cache.get('prompt')).toBeNull();
    });
  });

  describe('request coalescing', () => {
    it('should coalesce duplicate in-flight requests', async () => {
      let fetchCount = 0;
      const fetchFn = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { result: 'fetched' };
      };

      const messages = [{ role: 'user', content: 'test' }];
      const [result1, result2] = await Promise.all([
        cache.getOrFetch(messages, 'model', undefined, fetchFn),
        cache.getOrFetch(messages, 'model', undefined, fetchFn),
      ]);

      expect(result1.response).toEqual({ result: 'fetched' });
      expect(result2.response).toEqual({ result: 'fetched' });
      expect(fetchCount).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all entries and reset stats', () => {
      cache.set('a', 'a');
      cache.set('b', 'b');
      cache.get('a');
      cache.clear();
      const stats = cache.getStats();
      expect(stats.entries).toBe(0);
      expect(stats.hits).toBe(0);
    });
  });
});

// ============================================
// TaskQueue Tests
// ============================================

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue({
      maxConcurrentTasks: 2,
      queueTimeoutMs: 5000,
      staleTaskTimeoutMs: 10000,
      progressiveTimeout: true,
      queueWarningThreshold: 3,
      healthCheckIntervalMs: 60000,
    });
  });

  afterEach(() => {
    queue.shutdown();
    vi.useRealTimers();
  });

  describe('basic functionality', () => {
    it('should execute tasks and return results', async () => {
      const result = await queue.enqueue(async () => 42, 'test-task');
      expect(result).toBe(42);
    });

    it('should limit concurrent executions', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const task = async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return maxConcurrent;
      };

      await Promise.all([
        queue.enqueue(task, 't1'),
        queue.enqueue(task, 't2'),
        queue.enqueue(task, 't3'),
        queue.enqueue(task, 't4'),
      ]);

      expect(maxConcurrent).toBe(2);
    });

    it('should propagate task errors', async () => {
      await expect(
        queue.enqueue(async () => { throw new Error('Task failed'); }, 'failing-task')
      ).rejects.toThrow('Task failed');
    });
  });

  describe('status reporting', () => {
    it('should report idle status when empty', () => {
      const status = queue.getStatus();
      expect(status.running).toBe(0);
      expect(status.queued).toBe(0);
      expect(status.isBusy).toBe(false);
      expect(status.message).toContain('idle');
    });

    it('should track running task IDs', async () => {
      const task = queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'done';
      }, 'named-task');

      await new Promise((r) => setTimeout(r, 10));
      const status = queue.getStatus();
      expect(status.runningTaskIds).toContain('named-task');
      await task;
    });
  });

  describe('statistics', () => {
    it('should track completed tasks', async () => {
      await queue.enqueue(async () => 'done', 'task1');
      await queue.enqueue(async () => 'done', 'task2');
      const stats = queue.getStats();
      expect(stats.totalCompleted).toBe(2);
    });

    it('should track failed tasks', async () => {
      await queue.enqueue(async () => { throw new Error('fail'); }).catch(() => {});
      const stats = queue.getStats();
      expect(stats.totalFailed).toBe(1);
    });

    it('should calculate success rate', async () => {
      await queue.enqueue(async () => 'success', 't1');
      await queue.enqueue(async () => 'success', 't2');
      await queue.enqueue(async () => { throw new Error('fail'); }).catch(() => {});
      const stats = queue.getStats();
      expect(stats.successRate).toBeCloseTo(2 / 3, 2);
    });
  });

  describe('client session tracking', () => {
    it('should cancel client tasks on cancelClient', async () => {
      const taskPromise = queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'done';
      }, 'client-task', 'client-to-cancel');

      const cancelledErrorPromise = taskPromise.catch((err) => err as Error);
      await new Promise((r) => setTimeout(r, 10));
      queue.cancelClient('client-to-cancel');

      const cancelledError = await cancelledErrorPromise;
      expect(cancelledError).toBeInstanceOf(Error);
      expect(cancelledError.message).toMatch(/cancelled/i);
    });
  });
});
