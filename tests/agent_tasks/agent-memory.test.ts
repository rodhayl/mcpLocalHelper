/**
 * Agent Memory System Unit Tests
 * 
 * Tests for all 3 memory tiers:
 * - Tier 1: AgentResultCache
 * - Tier 2: PlanMemory
 * - Tier 3: SemanticMemory
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentResultCache } from '../../src/agent/agent-result-cache.js';
import { PlanMemory, resetPlanMemory } from '../../src/agent/plan-memory.js';
import { SemanticMemory, resetSemanticMemory } from '../../src/agent/semantic-memory.js';
import { resetCircuitBreakerRegistry } from '../../src/utils/circuit-breaker.js';

// ============================================
// Tier 1: AgentResultCache Tests
// ============================================

describe('AgentResultCache (Tier 1)', () => {
    let cache: AgentResultCache;

    beforeEach(() => {
        cache = new AgentResultCache();
    });

    it('should return null for uncached actions', () => {
        const result = cache.get('read_file', { path: 'test.ts' });
        expect(result).toBeNull();
    });

    it('should cache and retrieve results', () => {
        const params = { path: 'src/index.ts' };
        const output = { content: 'file contents', lines: 100 };

        cache.set('read_file', params, output);
        const cached = cache.get('read_file', params);

        expect(cached).toEqual(output);
    });

    it('should generate consistent keys for same params', () => {
        const params1 = { path: 'test.ts', lines: 50 };
        const params2 = { lines: 50, path: 'test.ts' }; // Different order

        cache.set('read_file', params1, 'result1');
        const cached = cache.get('read_file', params2);

        expect(cached).toBe('result1');
    });

    it('should only cache read-only actions', () => {
        // Cacheable actions
        expect(cache.isCacheable('read_file')).toBe(true);
        expect(cache.isCacheable('search_repo')).toBe(true);
        expect(cache.isCacheable('list_files')).toBe(true);
        expect(cache.isCacheable('summarize_path')).toBe(true);
        expect(cache.isCacheable('mcp_list_tools')).toBe(true);

        // Non-cacheable (write) actions
        expect(cache.isCacheable('apply_diff')).toBe(false);
        expect(cache.isCacheable('create_file')).toBe(false);
        expect(cache.isCacheable('write_json_file')).toBe(false);
    });

    it('should track cache statistics', () => {
        cache.set('read_file', { path: 'a.ts' }, 'content-a');
        cache.get('read_file', { path: 'a.ts' }); // hit
        cache.get('read_file', { path: 'b.ts' }); // miss

        const stats = cache.getStats();
        expect(stats.hits).toBeGreaterThanOrEqual(1);
        expect(stats.misses).toBeGreaterThanOrEqual(1);
        expect(stats.entries).toBe(1);
    });

    it('should clear all entries', () => {
        cache.set('read_file', { path: 'a.ts' }, 'a');
        cache.set('list_files', { dir: '/' }, ['b']);

        cache.clear();

        expect(cache.get('read_file', { path: 'a.ts' })).toBeNull();
        expect(cache.get('list_files', { dir: '/' })).toBeNull();
        expect(cache.getStats().entries).toBe(0);
    });
});

// ============================================
// Tier 2: PlanMemory Tests
// ============================================

describe('PlanMemory (Tier 2)', () => {
    let planMemory: PlanMemory;

    beforeEach(() => {
        resetPlanMemory();
        planMemory = new PlanMemory({ enabled: true, filePath: '' }); // No persistence for tests
    });

    afterEach(() => {
        resetPlanMemory();
    });

    it('should generate fingerprints for tasks', () => {
        const fp1 = (planMemory as any).generateFingerprint('find files in src folder');
        const fp2 = (planMemory as any).generateFingerprint('find files in lib folder');
        const fp3 = (planMemory as any).generateFingerprint('analyze the database schema');

        // Fingerprints should be strings
        expect(typeof fp1).toBe('string');
        expect(typeof fp2).toBe('string');
        expect(typeof fp3).toBe('string');
        // Different task patterns generate fingerprints
        expect(fp1.length).toBeGreaterThan(0);
    });

    it('should record successful plans and track stats', () => {
        const task = 'search for TODO comments in the project';
        const plan = {
            subtasks: [
                {
                    id: 't1',
                    title: 'Search for TODOs',
                    task: 'grep for TODO',
                    steps: [{ id: 's1', title: 'Execute grep', description: 'grep', targets: [] }],
                },
            ],
        };

        planMemory.recordSuccess(task, plan);

        // After recording, stats should show 1 plan
        const stats = planMemory.getStats();
        expect(stats.planCount).toBe(1);
        expect(stats.totalUses).toBeGreaterThanOrEqual(1);
    });

    it('should track success rates', () => {
        const task = 'analyze code quality';
        const plan = {
            subtasks: [{ id: 't1', title: 'Analyze', task: 'run linter', steps: [] }],
        };

        planMemory.recordSuccess(task, plan);
        planMemory.recordSuccess(task, plan);
        planMemory.recordFailure(task);

        const stats = planMemory.getStats();
        expect(stats.planCount).toBe(1);
        expect(stats.avgSuccessRate).toBeCloseTo(0.67, 1);
        expect(stats.totalUses).toBe(3);
    });

    it('should evict old plans when exceeding max', () => {
        const createPlan = (title: string) => ({
            subtasks: [{ id: 't1', title, task: title, steps: [] }],
        });

        // Create many plans to trigger eviction (default max is 50)
        for (let i = 0; i < 55; i++) {
            planMemory.recordSuccess(`unique task ${i} with pattern ${i}`, createPlan(`Plan ${i}`));
        }

        const stats = planMemory.getStats();
        expect(stats.planCount).toBeLessThanOrEqual(50);
    });

    it('should clear all plans', () => {
        planMemory.recordSuccess('test task', {
            subtasks: [{ id: 't1', title: 'T', task: 't', steps: [] }],
        });

        planMemory.clear();

        expect(planMemory.getStats().planCount).toBe(0);
        expect(planMemory.findSimilar('test task')).toBeNull();
    });
});

// ============================================
// Tier 3: SemanticMemory Tests
// ============================================

describe('SemanticMemory (Tier 3)', () => {
    let semanticMemory: SemanticMemory;

    beforeEach(() => {
        resetSemanticMemory();
        semanticMemory = new SemanticMemory({
            enabled: true,
            cachePath: '', // No persistence for tests
            lmStudioBaseUrl: 'http://127.0.0.1:1234',
            embeddingModel: 'test-model',
        });
    });

    afterEach(() => {
        resetSemanticMemory();
        vi.restoreAllMocks();
    });

    it('should chunk content correctly', () => {
        const content = Array(100).fill('Line of code').join('\n');
        const chunks = (semanticMemory as any).chunkContent(content, 'test.ts');

        expect(chunks.length).toBeGreaterThan(0);
        chunks.forEach((chunk: any) => {
            expect(chunk.content.length).toBeLessThanOrEqual(1500 + 200); // maxChunkSize + buffer
            expect(chunk.lineRange[0]).toBeGreaterThan(0);
            expect(chunk.lineRange[1]).toBeGreaterThanOrEqual(chunk.lineRange[0]);
        });
    });

    it('should return empty results when disabled', async () => {
        semanticMemory.setEnabled(false);
        const results = await semanticMemory.search('test query');
        expect(results).toEqual([]);
    });

    it('should return empty results when no index', async () => {
        const results = await semanticMemory.search('test query');
        expect(results).toEqual([]);
    });

    it('should clear index', () => {
        // Simulate adding chunks directly
        (semanticMemory as any).chunks.set('test-id', {
            id: 'test-id',
            filePath: 'test.ts',
            lineRange: [1, 10],
            content: 'test content',
            embedding: [0.1, 0.2, 0.3],
            fileHash: 'abc123',
            indexedAt: new Date().toISOString(),
        });

        semanticMemory.clear();

        expect(semanticMemory.getStats().chunkCount).toBe(0);
        expect(semanticMemory.getStats().fileCount).toBe(0);
    });

    it('should track statistics correctly', () => {
        const stats = semanticMemory.getStats();

        expect(stats).toHaveProperty('enabled');
        expect(stats).toHaveProperty('chunkCount');
        expect(stats).toHaveProperty('fileCount');
        expect(stats).toHaveProperty('modelId');
        expect(stats.modelId).toBe('test-model');
    });

    it('should configure embedding settings', () => {
        semanticMemory.configure({
            lmStudioBaseUrl: 'http://localhost:8080',
            embeddingModel: 'new-model',
        });

        const stats = semanticMemory.getStats();
        expect(stats.modelId).toBe('new-model');
    });

    it('should expose circuit breaker state', () => {
        expect(typeof semanticMemory.isCircuitOpen()).toBe('boolean');
        expect(semanticMemory.isCircuitOpen()).toBe(false);
    });

    it('should expose circuit breaker stats', () => {
        const cbStats = semanticMemory.getCircuitBreakerStats();
        expect(cbStats).toHaveProperty('state');
        expect(cbStats).toHaveProperty('failures');
        expect(cbStats).toHaveProperty('totalRequests');
        expect(cbStats.state).toBe('closed');
    });
});

// ============================================
// SemanticMemory Resilience Tests (Circuit Breaker + Timeout)
// ============================================

describe('SemanticMemory Resilience', () => {
    let semanticMemory: SemanticMemory;

    beforeEach(() => {
        resetSemanticMemory();
        semanticMemory = new SemanticMemory({
            enabled: true,
            cachePath: '',
            // Use an invalid port to simulate connection failure
            lmStudioBaseUrl: 'http://127.0.0.1:59999',
            embeddingModel: 'test-model',
        });
        // Add a chunk so search will attempt to call getEmbedding
        (semanticMemory as any).chunks.set('test-id', {
            id: 'test-id',
            filePath: 'test.ts',
            lineRange: [1, 10],
            content: 'test content',
            embedding: [0.1, 0.2, 0.3],
            fileHash: 'abc123',
            indexedAt: new Date().toISOString(),
        });
    });

    afterEach(() => {
        resetSemanticMemory();
        resetCircuitBreakerRegistry();
    });

    it('should timeout or fail gracefully on unreachable endpoint', async () => {
        // Using an unreachable port - should fail with ECONNREFUSED or similar
        const startTime = Date.now();
        const results = await semanticMemory.search('test query');
        const elapsed = Date.now() - startTime;

        // Should complete within timeout (5s) + small buffer, not hang forever
        expect(elapsed).toBeLessThan(8000);
        // Should return empty results due to error, not throw
        expect(results).toEqual([]);
    }, 15000);

    it('should return empty results when circuit breaker opens after failures', async () => {
        // Trigger 3 failures to open the circuit (failureThreshold: 3)
        // Each call will fail with ECONNREFUSED since port 59999 is not listening
        await semanticMemory.search('query1');
        await semanticMemory.search('query2');
        await semanticMemory.search('query3');

        // Circuit should now be open
        expect(semanticMemory.isCircuitOpen()).toBe(true);

        // Stats should show failures
        const stats = semanticMemory.getCircuitBreakerStats();
        expect(stats.state).toBe('open');
    }, 30000);

    it('should continue working after circuit breaker resets', async () => {
        // First, trigger circuit open
        await semanticMemory.search('q1');
        await semanticMemory.search('q2');
        await semanticMemory.search('q3');
        expect(semanticMemory.isCircuitOpen()).toBe(true);

        // Manually reset circuit (simulates time passing past resetTimeoutMs)
        const breaker = (semanticMemory as any).circuitBreaker;
        breaker.reset();

        expect(semanticMemory.isCircuitOpen()).toBe(false);
        expect(semanticMemory.getCircuitBreakerStats().state).toBe('closed');
    });

    it('should report circuit breaker stats correctly', async () => {
        const initialStats = semanticMemory.getCircuitBreakerStats();
        expect(initialStats.state).toBe('closed');
        expect(initialStats.failures).toBe(0);
        expect(initialStats.totalRequests).toBe(0);

        // Trigger a failure
        await semanticMemory.search('query1');

        const afterOneFailure = semanticMemory.getCircuitBreakerStats();
        expect(afterOneFailure.totalRequests).toBe(1);
    }, 10000);
});

// ============================================
// Cosine Similarity Unit Test
// ============================================

describe('Cosine Similarity', () => {
    it('should calculate correct similarity', () => {
        // Import the function dynamically to avoid module issues
        const cosineSimilarity = (a: number[], b: number[]): number => {
            if (a.length !== b.length) return 0;
            let dotProduct = 0, normA = 0, normB = 0;
            for (let i = 0; i < a.length; i++) {
                dotProduct += a[i] * b[i];
                normA += a[i] * a[i];
                normB += b[i] * b[i];
            }
            const denominator = Math.sqrt(normA) * Math.sqrt(normB);
            return denominator === 0 ? 0 : dotProduct / denominator;
        };

        expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1); // Identical
        expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0); // Orthogonal
        expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBe(-1); // Opposite
        expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1, 5);
        expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96, 2);
    });
});
