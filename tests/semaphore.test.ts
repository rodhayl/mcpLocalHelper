/**
 * Semaphore Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    Semaphore,
    SemaphoreTimeoutError,
    SemaphoreRegistry,
    getSemaphoreRegistry,
    resetSemaphoreRegistry,
} from '../src/utils/semaphore.js';

describe('Semaphore', () => {
    describe('basic operations', () => {
        it('should allow acquiring permits up to limit', async () => {
            const semaphore = new Semaphore(2);

            expect(semaphore.available()).toBe(2);
            await semaphore.acquire();
            expect(semaphore.available()).toBe(1);
            await semaphore.acquire();
            expect(semaphore.available()).toBe(0);
        });

        it('should release permits correctly', async () => {
            const semaphore = new Semaphore(2);

            await semaphore.acquire();
            await semaphore.acquire();
            expect(semaphore.available()).toBe(0);

            semaphore.release();
            expect(semaphore.available()).toBe(1);
            semaphore.release();
            expect(semaphore.available()).toBe(2);
        });

        it('should not exceed max permits on release', () => {
            const semaphore = new Semaphore(2);

            semaphore.release();
            semaphore.release();
            semaphore.release();

            expect(semaphore.available()).toBe(2);
        });

        it('should throw if permits < 1', () => {
            expect(() => new Semaphore(0)).toThrow('at least 1 permit');
            expect(() => new Semaphore(-1)).toThrow('at least 1 permit');
        });
    });

    describe('tryAcquire', () => {
        it('should return true when permit available', () => {
            const semaphore = new Semaphore(1);
            expect(semaphore.tryAcquire()).toBe(true);
            expect(semaphore.available()).toBe(0);
        });

        it('should return false when no permit available', () => {
            const semaphore = new Semaphore(1);
            semaphore.tryAcquire();
            expect(semaphore.tryAcquire()).toBe(false);
        });
    });

    describe('waiting', () => {
        it('should queue waiters when no permits', async () => {
            const semaphore = new Semaphore(1);
            await semaphore.acquire();

            expect(semaphore.waitingCount()).toBe(0);

            // Start waiting for permit
            const waiting = semaphore.acquire();
            expect(semaphore.waitingCount()).toBe(1);

            // Release should give to waiter
            semaphore.release();
            await waiting;

            expect(semaphore.waitingCount()).toBe(0);
            expect(semaphore.available()).toBe(0); // Permit went to waiter
        });

        it('should process waiters in FIFO order', async () => {
            const semaphore = new Semaphore(1);
            await semaphore.acquire();

            const order: number[] = [];

            const wait1 = semaphore.acquire().then(() => order.push(1));
            const wait2 = semaphore.acquire().then(() => order.push(2));
            const wait3 = semaphore.acquire().then(() => order.push(3));

            semaphore.release();
            semaphore.release();
            semaphore.release();

            await Promise.all([wait1, wait2, wait3]);

            expect(order).toEqual([1, 2, 3]);
        });
    });

    describe('timeout', () => {
        it('should timeout if permit not available', async () => {
            vi.useFakeTimers();

            const semaphore = new Semaphore(1);
            await semaphore.acquire();

            const waitPromise = semaphore.acquire(1000);

            vi.advanceTimersByTime(1100);

            await expect(waitPromise).rejects.toThrow(SemaphoreTimeoutError);
            await expect(waitPromise).rejects.toThrow('1000ms');

            vi.useRealTimers();
        });

        it('should clear timeout when permit acquired before timeout', async () => {
            vi.useFakeTimers();

            const semaphore = new Semaphore(1);
            await semaphore.acquire();

            const waitPromise = semaphore.acquire(10000);

            // Release before timeout
            vi.advanceTimersByTime(500);
            semaphore.release();

            await waitPromise;
            expect(semaphore.available()).toBe(0);

            vi.useRealTimers();
        });
    });

    describe('withPermit', () => {
        it('should acquire and release around function', async () => {
            const semaphore = new Semaphore(1);

            const result = await semaphore.withPermit(async () => {
                expect(semaphore.available()).toBe(0);
                return 'done';
            });

            expect(result).toBe('done');
            expect(semaphore.available()).toBe(1);
        });

        it('should release on error', async () => {
            const semaphore = new Semaphore(1);

            await expect(
                semaphore.withPermit(async () => {
                    throw new Error('test error');
                })
            ).rejects.toThrow('test error');

            expect(semaphore.available()).toBe(1);
        });
    });

    describe('stats', () => {
        it('should return correct stats', async () => {
            const semaphore = new Semaphore(3);
            await semaphore.acquire();

            const stats = semaphore.getStats();
            expect(stats.total).toBe(3);
            expect(stats.available).toBe(2);
            expect(stats.waiting).toBe(0);
        });
    });
});

describe('SemaphoreRegistry', () => {
    beforeEach(() => {
        resetSemaphoreRegistry();
    });

    it('should create and cache semaphores by name', () => {
        const registry = new SemaphoreRegistry();

        const s1 = registry.get('llm', 2);
        const s2 = registry.get('llm', 2);

        expect(s1).toBe(s2);
    });

    it('should create separate semaphores for different names', () => {
        const registry = new SemaphoreRegistry();

        const s1 = registry.get('llm', 2);
        const s2 = registry.get('mcp', 5);

        expect(s1).not.toBe(s2);
        expect(s1.available()).toBe(2);
        expect(s2.available()).toBe(5);
    });

    it('should return all stats', async () => {
        const registry = new SemaphoreRegistry();

        const s1 = registry.get('a', 3);
        const s2 = registry.get('b', 2);

        await s1.acquire();

        const stats = registry.getAllStats();
        expect(stats['a'].available).toBe(2);
        expect(stats['b'].available).toBe(2);
    });
});

describe('getSemaphoreRegistry', () => {
    beforeEach(() => {
        resetSemaphoreRegistry();
    });

    it('should return singleton', () => {
        const r1 = getSemaphoreRegistry();
        const r2 = getSemaphoreRegistry();
        expect(r1).toBe(r2);
    });

    it('should reset singleton', () => {
        const r1 = getSemaphoreRegistry();
        resetSemaphoreRegistry();
        const r2 = getSemaphoreRegistry();
        expect(r1).not.toBe(r2);
    });
});
