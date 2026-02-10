/**
 * Agent Result Cache
 *
 * Per-run cache for tool results to prevent duplicate operations
 * within a single agent_task execution.
 *
 * - Scoped to a single runTask() invocation
 * - Caches read-only operations (read_file, search_repo, list_files, etc.)
 * - Hash-based key generation from action type + params
 */

import { createHash } from 'crypto';

export interface CachedResult {
  result: unknown;
  timestamp: number;
  actionType: string;
}

export interface AgentResultCacheStats {
  hits: number;
  misses: number;
  entries: number;
  hitRate: number;
}

/**
 * Read-only action types that are safe to cache within a run.
 * Write actions are never cached as they may have side effects.
 */
const CACHEABLE_ACTIONS = new Set([
  'search_repo',
  'read_file',
  'list_files',
  'summarize_path',
  'summarize_repo',
  'extract_http_routes',
  'mcp_list_tools',
]);

export class AgentResultCache {
  private cache = new Map<string, CachedResult>();
  private hits = 0;
  private misses = 0;

  /**
   * Generate a cache key from action type and params.
   * Uses SHA-256 hash for consistent key length.
   */
  private generateKey(actionType: string, params: Record<string, unknown>): string {
    // Normalize params for consistent keys
    const normalizedParams = this.normalizeParams(params);
    const data = JSON.stringify({ actionType, params: normalizedParams });
    return createHash('sha256').update(data).digest('hex').substring(0, 24);
  }

  /**
   * Normalize params for consistent cache keys.
   * - Sorts object keys
   * - Normalizes paths (forward slashes)
   * - Trims strings
   */
  private normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(params).sort();

    for (const key of keys) {
      let value = params[key];

      // Normalize string values
      if (typeof value === 'string') {
        value = value.trim().replace(/\\/g, '/');
      }

      // Recursively normalize nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        value = this.normalizeParams(value as Record<string, unknown>);
      }

      sorted[key] = value;
    }

    return sorted;
  }

  /**
   * Check if an action type is cacheable.
   */
  isCacheable(actionType: string): boolean {
    return CACHEABLE_ACTIONS.has(actionType);
  }

  /**
   * Get a cached result if available.
   * Returns null if not found or action is not cacheable.
   */
  get(actionType: string, params: Record<string, unknown>): unknown | null {
    if (!this.isCacheable(actionType)) {
      return null;
    }

    const key = this.generateKey(actionType, params);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      if (process.env.DEBUG_AGENT_CACHE === '1') {
        process.stderr.write(`[agent-cache] MISS: ${actionType} key=${key.substring(0, 8)}...\n`);
      }
      return null;
    }

    this.hits++;
    if (process.env.DEBUG_AGENT_CACHE === '1') {
      const ageMs = Date.now() - entry.timestamp;
      process.stderr.write(
        `[agent-cache] HIT: ${actionType} key=${key.substring(0, 8)}... age=${ageMs}ms\n`
      );
    }

    return entry.result;
  }

  /**
   * Store a result in the cache.
   * Only stores if the action type is cacheable.
   */
  set(actionType: string, params: Record<string, unknown>, result: unknown): void {
    if (!this.isCacheable(actionType)) {
      return;
    }

    const key = this.generateKey(actionType, params);

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      actionType,
    });

    if (process.env.DEBUG_AGENT_CACHE === '1') {
      process.stderr.write(
        `[agent-cache] SET: ${actionType} key=${key.substring(0, 8)}... (${this.cache.size} entries)\n`
      );
    }
  }

  /**
   * Check if a result exists in cache (without counting as hit/miss).
   */
  has(actionType: string, params: Record<string, unknown>): boolean {
    if (!this.isCacheable(actionType)) {
      return false;
    }
    const key = this.generateKey(actionType, params);
    return this.cache.has(key);
  }

  /**
   * Get cache statistics.
   */
  getStats(): AgentResultCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Clear all cached results.
   * Called at the end of each runTask() invocation.
   */
  clear(): void {
    const stats = this.getStats();
    if (process.env.DEBUG_AGENT_CACHE === '1' && stats.entries > 0) {
      process.stderr.write(
        `[agent-cache] CLEAR: ${stats.entries} entries, hitRate=${Math.round(stats.hitRate * 100)}%\n`
      );
    }
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get the number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }
}
