/**
 * LLM Response Cache
 *
 * Caches LLM responses to reduce API calls and improve response times.
 * - Configurable TTL for cache entries
 * - Hash-based key generation from prompts
 * - Statistics for hit/miss rates
 */

import { createHash } from 'crypto';

export interface LLMCacheConfig {
  /** Enable/disable caching (default: true) */
  enabled: boolean;
  /** Time to live for cache entries in ms (default: 20 minutes) */
  ttlMs: number;
  /** Maximum entries to keep in cache (default: 300) */
  maxEntries: number;
  /** Only cache responses with at least this many tokens (default: 10) */
  minResponseTokens: number;
  /** Adaptive TTL: multiply TTL by hit count for popular entries (default: true) */
  adaptiveTtl: boolean;
  /** Maximum TTL even with adaptive scaling (default: 2 hours) */
  maxTtlMs: number;
  /** Cleanup interval in ms (default: 60 seconds) */
  cleanupIntervalMs: number;
}

export interface LLMCacheEntry {
  key: string;
  prompt: string;
  response: unknown;
  createdAt: Date;
  expiresAt: Date;
  hitCount: number;
  lastAccessedAt: Date;
  responseSize: number;
}

export interface LLMCacheStats {
  enabled: boolean;
  hits: number;
  misses: number;
  entries: number;
  hitRate: number;
  avgHitAge: number;
  /** Number of requests currently in-flight (for monitoring request coalescing) */
  inFlight: number;
  /** Total memory used by cached responses (approximate) */
  memorySizeBytes: number;
  /** Number of cache evictions due to size limit */
  evictions: number;
  /** Number of expired entries cleaned up */
  expirations: number;
}

const DEFAULT_CONFIG: LLMCacheConfig = {
  enabled: true,
  ttlMs: 30 * 60 * 1000, // 30 minutes - longer TTL for better hit rate (Analysis_1/2 feedback)
  maxEntries: 500, // 500 entries to accommodate more concurrent clients (Analysis_1/2 hit rate improvement)
  minResponseTokens: 5, // Lower threshold to cache more responses
  adaptiveTtl: true,
  maxTtlMs: 4 * 60 * 60 * 1000, // 4 hours max - allow popular entries to live longer
  cleanupIntervalMs: 120000, // 2 minutes - less frequent cleanup to reduce overhead
};

export class LLMCache {
  private config: LLMCacheConfig;
  private cache: Map<string, LLMCacheEntry> = new Map();
  private hits = 0;
  private misses = 0;
  private totalHitAge = 0; // For calculating avg hit age
  private evictions = 0;
  private expirations = 0;
  private totalMemoryBytes = 0;
  private lastCleanup = 0;

  // Track in-flight requests to prevent duplicate LLM calls for identical requests
  private inFlightRequests: Map<string, Promise<unknown>> = new Map();

  constructor(config?: Partial<LLMCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get or create a response, coalescing duplicate in-flight requests.
   * This prevents multiple identical LLM calls from running simultaneously.
   * @param messages - The message array
   * @param model - Optional model name
   * @param options - Optional temperature/max_tokens
   * @param fetchFn - Function to call if cache miss and no in-flight request
   * @returns Object with cached flag and response
   */
  async getOrFetch(
    messages: Array<{ role: string; content: string }>,
    model: string | undefined,
    options: { temperature?: number; max_tokens?: number } | undefined,
    fetchFn: () => Promise<unknown>
  ): Promise<{ cached: boolean; coalesced: boolean; response: unknown }> {
    // Check cache first
    const cached = this.getFromMessages(messages, model, options);
    if (cached !== null) {
      return { cached: true, coalesced: false, response: cached };
    }

    // Generate key for in-flight tracking
    const key = this.generateKeyFromMessages(messages, model, options);

    // Check for in-flight request and coalesce
    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) {
      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] COALESCE: ${key.substring(0, 8)}... (waiting for in-flight request)\n`
        );
      }
      try {
        const response = await inFlight;
        // Count coalesced requests as hits since they avoid duplicate LLM calls
        // This reflects the true efficiency gain from request deduplication
        this.hits++;
        return { cached: false, coalesced: true, response };
      } catch (error) {
        // If the in-flight request failed, let this one try again
        this.inFlightRequests.delete(key);
        throw error;
      }
    }

    // Create new request with in-flight tracking
    const promise = (async () => {
      try {
        const response = await fetchFn();
        this.setFromMessages(messages, response, model, options);
        return response;
      } finally {
        // Clean up in-flight tracking
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, promise);

    try {
      const response = await promise;
      return { cached: false, coalesced: false, response };
    } catch (error) {
      // Make sure to clean up on error
      this.inFlightRequests.delete(key);
      throw error;
    }
  }

  /**
   * Get count of current in-flight requests (for debugging/monitoring)
   */
  getInFlightCount(): number {
    return this.inFlightRequests.size;
  }

  /**
   * Generate a cache key from prompt and model info
   * @deprecated Use generateKeyFromMessages for multi-turn conversations
   */
  private generateKey(prompt: string, model?: string, systemPrompt?: string): string {
    const data = JSON.stringify({ prompt, model, systemPrompt });
    return createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Normalize a model name for consistent cache key generation.
   * Handles variations like 'gpt-4', 'GPT-4', 'gpt_4' etc.
   */
  private normalizeModelName(model: string | undefined): string | undefined {
    if (!model) return undefined;
    // Trim, lowercase, and normalize separators for consistent keys
    return model
      .trim()
      .toLowerCase()
      .replace(/[\s:]+/g, '-') // Normalize colons and spaces to hyphens
      .replace(/_+/g, '-') // Normalize underscores to hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Normalize message content for consistent cache keys.
   * Plan 2: Less aggressive normalization to improve cache hit rate.
   *
   * Previous behavior (0% hit rate): Lowercased everything, stripped all punctuation
   * New behavior: Preserve case for code/identifiers, only normalize whitespace and encoding variants
   *
   * Handles whitespace, line endings, and common encoding differences only.
   */
  private normalizeContent(content: string): string {
    return (
      content
        .trim()
        // Normalize all line endings to single newline (preserve structure)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Collapse multiple consecutive whitespace within lines (but preserve newlines)
        .replace(/[ \t]+/g, ' ')
        // Collapse multiple newlines to single newline
        .replace(/\n{3,}/g, '\n\n')
        // Normalize quotes (smart quotes to regular quotes) - encoding difference only
        // U+2018 = ', U+2019 = ' (single curly quotes)
        // U+201C = ", U+201D = " (double curly quotes)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        // Normalize dashes (en-dash, em-dash to regular hyphen) - encoding difference only
        .replace(/[\u2013\u2014]/g, '-')
        // Normalize ellipsis - encoding difference only
        .replace(/\u2026/g, '...')
      // NOTE: Removed lowercase conversion and trailing punctuation removal
      // These caused semantically identical prompts to miss cache due to case differences
      // Case is significant for code (FunctionName vs functionname)
    );
  }

  /**
   * Normalize temperature to 1 decimal place for consistent cache keys.
   * Handles floating-point precision issues (e.g., 0.7000000001 -> 0.7)
   */
  private normalizeTemperature(temp: number | undefined): number | undefined {
    if (temp === undefined || temp === null) return undefined;
    // Round to 1 decimal place (10x multiplier)
    return Math.round(temp * 10) / 10;
  }

  /**
   * Generate a cache key from full message array for better cache hit rates.
   * This is the preferred method for multi-turn conversations.
   *
   * Normalization strategy for improved hit rates:
   * - Model names: lowercase, normalize separators
   * - Temperature: round to 1 decimal place
   * - Content: normalize whitespace, line endings, quotes, case-insensitive
   * - Ignores: max_tokens (doesn't affect semantic output)
   */
  generateKeyFromMessages(
    messages: Array<{ role: string; content: string }>,
    model?: string,
    options?: { temperature?: number; max_tokens?: number }
  ): string {
    // Normalize messages for consistent cache keys
    const normalizedMessages = messages.map((m) => ({
      role: m.role.toLowerCase().trim(),
      content: this.normalizeContent(m.content),
    }));

    // Normalize temperature to 1 decimal place to handle floating-point precision
    const normalizedTemp = this.normalizeTemperature(options?.temperature);

    // Include only options that semantically affect output
    // Note: max_tokens is intentionally excluded - it affects length, not semantic content
    const keyData = {
      messages: normalizedMessages,
      model: this.normalizeModelName(model),
      // Temperature affects randomness - round to 1 decimal to handle precision issues
      temp: normalizedTemp,
    };

    const data = JSON.stringify(keyData);
    const key = createHash('sha256').update(data).digest('hex').substring(0, 16);

    // Enhanced debug logging to diagnose cache hit issues
    if (process.env.DEBUG_CACHE === '1') {
      const msgSummary =
        messages.length > 0
          ? `[${messages.length} msgs, last=${messages[messages.length - 1].content.substring(0, 40)}...]`
          : '[empty]';
      process.stderr.write(
        `[cache] KEY: ${key} ${msgSummary} model=${this.normalizeModelName(model) || 'default'} temp=${normalizedTemp ?? 'N/A'}\n`
      );
    }

    return key;
  }

  /**
   * Expose the cache key calculation for callers that want to coalesce in-flight requests.
   * This does not imply the entry exists in the cache.
   * @deprecated Use getKeyFromMessages for multi-turn conversations
   */
  getKey(prompt: string, model?: string, systemPrompt?: string): string {
    return this.generateKey(prompt, model, systemPrompt);
  }

  /**
   * Get cache key from full message array - preferred method for multi-turn conversations
   */
  getKeyFromMessages(
    messages: Array<{ role: string; content: string }>,
    model?: string,
    options?: { temperature?: number; max_tokens?: number }
  ): string {
    return this.generateKeyFromMessages(messages, model, options);
  }

  /**
   * Get a cached response if available and not expired
   */
  get(prompt: string, model?: string, systemPrompt?: string): unknown | null {
    if (!this.config.enabled) {
      return null;
    }

    const key = this.generateKey(prompt, model, systemPrompt);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      // Debug logging for cache monitoring
      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] MISS: ${key.substring(0, 8)}... (${this.cache.size} entries)\n`
        );
      }
      return null;
    }

    // Check expiration
    if (new Date() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Cache hit
    this.hits++;
    entry.hitCount++;
    this.totalHitAge += Date.now() - entry.createdAt.getTime();

    // Debug logging for cache monitoring
    if (process.env.DEBUG_CACHE === '1') {
      const ageMs = Date.now() - entry.createdAt.getTime();
      process.stderr.write(
        `[cache] HIT: ${key.substring(0, 8)}... (age: ${Math.round(ageMs / 1000)}s, hits: ${entry.hitCount})\n`
      );
    }

    return entry.response;
  }

  /**
   * Store a response in the cache
   */
  set(prompt: string, response: unknown, model?: string, systemPrompt?: string): void {
    if (!this.config.enabled) {
      return;
    }

    // Check minimum response size
    let responseStr = '';
    try {
      responseStr = JSON.stringify(response);
    } catch {
      // Non-serializable response; skip caching rather than crashing.
      return;
    }
    if (responseStr.length < this.config.minResponseTokens * 4) {
      // ~4 chars per token estimate
      return;
    }

    // Cleanup if at max capacity
    if (this.cache.size >= this.config.maxEntries) {
      this.cleanup();
    }

    const key = this.generateKey(prompt, model, systemPrompt);
    const now = new Date();

    this.cache.set(key, {
      key,
      prompt: prompt.substring(0, 100), // Store truncated prompt for debugging
      response,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.ttlMs),
      hitCount: 0,
      lastAccessedAt: now,
      responseSize: JSON.stringify(response).length,
    });
  }

  /**
   * Get a cached response using full message array key - preferred for multi-turn conversations
   * Implements adaptive TTL: frequently accessed entries get extended TTL
   */
  getFromMessages(
    messages: Array<{ role: string; content: string }>,
    model?: string,
    options?: { temperature?: number; max_tokens?: number }
  ): unknown | null {
    if (!this.config.enabled) {
      return null;
    }

    // Periodic cleanup on reads
    this.maybeCleanup();

    const key = this.generateKeyFromMessages(messages, model, options);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] MISS(msgs): ${key.substring(0, 8)}... (${this.cache.size} entries, hitRate=${Math.round(this.getHitRate() * 100)}%)\n`
        );
      }
      return null;
    }

    const now = new Date();

    // Check expiration
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      this.totalMemoryBytes -= entry.responseSize;
      this.expirations++;
      this.misses++;
      return null;
    }

    // Cache hit
    this.hits++;
    entry.hitCount++;
    entry.lastAccessedAt = now;
    this.totalHitAge += Date.now() - entry.createdAt.getTime();

    // Adaptive TTL: extend TTL for frequently accessed entries
    if (this.config.adaptiveTtl && entry.hitCount > 1) {
      const extensionFactor = Math.min(entry.hitCount, 5); // Cap at 5x
      const baseRemaining = entry.expiresAt.getTime() - now.getTime();
      const extension = Math.min(
        this.config.ttlMs * 0.5 * extensionFactor, // Extend by up to 50% * hitCount
        this.config.maxTtlMs - (now.getTime() - entry.createdAt.getTime()) // Don't exceed maxTtlMs total age
      );
      if (extension > 0 && baseRemaining < this.config.ttlMs) {
        entry.expiresAt = new Date(entry.expiresAt.getTime() + extension);
      }
    }

    if (process.env.DEBUG_CACHE === '1') {
      const ageMs = Date.now() - entry.createdAt.getTime();
      const remainingMs = entry.expiresAt.getTime() - now.getTime();
      process.stderr.write(
        `[cache] HIT(msgs): ${key.substring(0, 8)}... (age: ${Math.round(ageMs / 1000)}s, remaining: ${Math.round(remainingMs / 1000)}s, hits: ${entry.hitCount})\n`
      );
    }

    return entry.response;
  }

  /**
   * Store a response using full message array key - preferred for multi-turn conversations
   * Tracks memory usage for better cache management
   */
  setFromMessages(
    messages: Array<{ role: string; content: string }>,
    response: unknown,
    model?: string,
    options?: { temperature?: number; max_tokens?: number }
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Check minimum response size
    let responseStr = '';
    try {
      responseStr = JSON.stringify(response);
    } catch {
      return;
    }
    const responseSize = responseStr.length;
    if (responseSize < this.config.minResponseTokens * 4) {
      return;
    }

    // Cleanup if at max capacity
    if (this.cache.size >= this.config.maxEntries) {
      this.cleanup();
    }

    const key = this.generateKeyFromMessages(messages, model, options);
    const now = new Date();

    // Store first message content for debugging
    const debugPrompt =
      messages.length > 0
        ? `[${messages.length} msgs] ${messages[messages.length - 1].content.substring(0, 80)}`
        : '[empty]';

    // Check if we're replacing an existing entry
    const existing = this.cache.get(key);
    if (existing) {
      this.totalMemoryBytes -= existing.responseSize;
    }

    this.cache.set(key, {
      key,
      prompt: debugPrompt,
      response,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.ttlMs),
      hitCount: 0,
      lastAccessedAt: now,
      responseSize,
    });

    this.totalMemoryBytes += responseSize;
  }

  /**
   * Periodic cleanup check - call this on cache reads to keep cache healthy
   */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup > this.config.cleanupIntervalMs) {
      this.cleanup();
    }
  }

  /**
   * Get current hit rate
   */
  private getHitRate(): number {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }

  /**
   * Clear expired entries and evict LRU entries if over capacity
   * Uses a scoring system: low score = more likely to evict
   * Score = hitCount * 10 + recency (0-10 based on lastAccessedAt)
   */
  private cleanup(): void {
    this.lastCleanup = Date.now();
    const now = new Date();
    const toDelete: string[] = [];

    // Remove expired entries
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        toDelete.push(key);
        this.totalMemoryBytes -= entry.responseSize;
        this.expirations++;
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key);
    }

    // If still over capacity, evict using LRU+LFU hybrid scoring
    if (this.cache.size >= this.config.maxEntries) {
      const nowMs = now.getTime();
      const maxAge = this.config.ttlMs; // Use TTL as the reference for recency scoring

      const entries = Array.from(this.cache.entries()).map(([key, entry]) => {
        // Calculate recency score (0-10): higher = more recent
        const ageMs = nowMs - entry.lastAccessedAt.getTime();
        const recencyScore = Math.max(0, 10 - Math.floor((ageMs / maxAge) * 10));

        // Combined score: hits matter more than recency
        const score = entry.hitCount * 10 + recencyScore;

        return { key, entry, score };
      });

      // Sort by score ascending (lowest score = evict first)
      entries.sort((a, b) => a.score - b.score);

      const toRemove = Math.max(1, this.cache.size - this.config.maxEntries + 20); // Remove 20 extra for headroom
      for (let i = 0; i < toRemove && i < entries.length; i++) {
        this.cache.delete(entries[i].key);
        this.totalMemoryBytes -= entries[i].entry.responseSize;
        this.evictions++;
      }

      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] CLEANUP: evicted ${toRemove} entries, ${this.cache.size} remaining, ~${Math.round(this.totalMemoryBytes / 1024)}KB\n`
        );
      }
    }
  }

  /**
   * Get cache statistics with detailed memory and eviction info
   */
  getStats(): LLMCacheStats {
    const total = this.hits + this.misses;
    return {
      enabled: this.config.enabled,
      hits: this.hits,
      misses: this.misses,
      entries: this.cache.size,
      hitRate: total > 0 ? this.hits / total : 0,
      avgHitAge: this.hits > 0 ? this.totalHitAge / this.hits : 0,
      inFlight: this.inFlightRequests.size,
      memorySizeBytes: this.totalMemoryBytes,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  /**
   * Clear entire cache and reset all statistics
   */
  clear(): void {
    this.cache.clear();
    this.inFlightRequests.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalHitAge = 0;
    this.totalMemoryBytes = 0;
    this.evictions = 0;
    this.expirations = 0;
    this.lastCleanup = Date.now();
  }

  /**
   * Enable or disable caching
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Update TTL
   */
  setTtl(ttlMs: number): void {
    this.config.ttlMs = ttlMs;
  }

  /**
   * Record a coalesced hit (for external in-flight tracking)
   * This should be called when a request reuses an in-flight promise
   * to accurately reflect avoided duplicate LLM calls in statistics.
   */
  recordCoalescedHit(): void {
    this.hits++;
  }
}

// Singleton instance
let llmCacheInstance: LLMCache | null = null;

/**
 * Get or create the singleton LLM cache
 */
export function getLLMCache(config?: Partial<LLMCacheConfig>): LLMCache {
  if (!llmCacheInstance) {
    llmCacheInstance = new LLMCache(config);
  }
  return llmCacheInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetLLMCache(): void {
  if (llmCacheInstance) {
    llmCacheInstance.clear();
  }
  llmCacheInstance = null;
}

// ============================================
// CACHE PERSISTENCE (Optional File-Based)
// ============================================

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface CachePersistenceConfig {
  /** Path to cache file (default: ~/.mcp-local-llm/cache.json) */
  filePath: string;
  /** Auto-save interval in ms (0 = disabled, default: 300000 = 5 min) */
  autoSaveIntervalMs: number;
  /** Max entries to persist (default: 200) */
  maxPersistEntries: number;
  /** Only persist entries with at least this many hits (default: 1) */
  minHitsToPerist: number;
}

const DEFAULT_PERSISTENCE_CONFIG: CachePersistenceConfig = {
  filePath: join(homedir(), '.mcp-local-llm', 'cache.json'),
  autoSaveIntervalMs: 300000, // 5 minutes
  maxPersistEntries: 200,
  minHitsToPerist: 1,
};

interface PersistedCacheEntry {
  key: string;
  prompt: string;
  response: unknown;
  hitCount: number;
  responseSize: number;
  createdAt: string;
}

interface PersistedCacheData {
  version: 1;
  savedAt: string;
  entries: PersistedCacheEntry[];
}

/**
 * CachePersistence - Handles saving and loading cache to/from disk
 */
export class CachePersistence {
  private config: CachePersistenceConfig;
  private cache: LLMCache;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(cache: LLMCache, config?: Partial<CachePersistenceConfig>) {
    this.cache = cache;
    this.config = { ...DEFAULT_PERSISTENCE_CONFIG, ...config };
  }

  /**
   * Start auto-save timer
   */
  startAutoSave(): void {
    if (this.config.autoSaveIntervalMs <= 0) return;
    if (this.saveTimer) return;

    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.save();
        this.dirty = false;
      }
    }, this.config.autoSaveIntervalMs);

    // Don't keep process alive just for cache saves
    if (this.saveTimer.unref) {
      this.saveTimer.unref();
    }
  }

  /**
   * Stop auto-save timer
   */
  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * Mark cache as dirty (needs saving)
   */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Save cache to disk
   */
  save(): boolean {
    try {
      const stats = this.cache.getStats();
      if (stats.entries === 0) {
        return false; // Nothing to save
      }

      // Get entries sorted by hit count (most valuable first)
      const entries = this.getEntriesForPersistence();
      if (entries.length === 0) {
        return false;
      }

      const data: PersistedCacheData = {
        version: 1,
        savedAt: new Date().toISOString(),
        entries,
      };

      // Ensure directory exists
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Write atomically (write to temp, then rename)
      const tempPath = this.config.filePath + '.tmp';
      writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');

      // On Windows, rename can fail if target exists, so remove first
      try {
        if (existsSync(this.config.filePath)) {
          unlinkSync(this.config.filePath);
        }
      } catch {
        // Ignore unlink errors
      }

      renameSync(tempPath, this.config.filePath);

      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] PERSIST: Saved ${entries.length} entries to ${this.config.filePath}\n`
        );
      }

      return true;
    } catch (error) {
      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] PERSIST ERROR: ${error instanceof Error ? error.message : error}\n`
        );
      }
      return false;
    }
  }

  /**
   * Load cache from disk
   */
  load(): boolean {
    try {
      if (!existsSync(this.config.filePath)) {
        return false;
      }

      const content = readFileSync(this.config.filePath, 'utf-8');
      const data = JSON.parse(content) as PersistedCacheData;

      if (data.version !== 1) {
        return false; // Incompatible version
      }

      let loaded = 0;
      const now = new Date();
      const cacheConfig = (this.cache as any).config as LLMCacheConfig;

      for (const entry of data.entries) {
        // Skip invalid entries
        if (!entry.key || !entry.response) continue;

        // Reconstruct cache entry with fresh TTL
        const cacheEntry: LLMCacheEntry = {
          key: entry.key,
          prompt: entry.prompt || '[persisted]',
          response: entry.response,
          createdAt: new Date(entry.createdAt || now),
          expiresAt: new Date(now.getTime() + cacheConfig.ttlMs),
          hitCount: entry.hitCount || 0,
          lastAccessedAt: now,
          responseSize: entry.responseSize || JSON.stringify(entry.response).length,
        };

        // Add to cache directly (bypass normal checks)
        (this.cache as any).cache.set(entry.key, cacheEntry);
        (this.cache as any).totalMemoryBytes += cacheEntry.responseSize;
        loaded++;
      }

      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] PERSIST: Loaded ${loaded} entries from ${this.config.filePath}\n`
        );
      }

      return loaded > 0;
    } catch (error) {
      if (process.env.DEBUG_CACHE === '1') {
        process.stderr.write(
          `[cache] PERSIST LOAD ERROR: ${error instanceof Error ? error.message : error}\n`
        );
      }
      return false;
    }
  }

  /**
   * Get entries suitable for persistence (high-value entries only)
   */
  private getEntriesForPersistence(): PersistedCacheEntry[] {
    const cacheMap = (this.cache as any).cache as Map<string, LLMCacheEntry>;
    const entries: Array<{ entry: LLMCacheEntry; score: number }> = [];

    for (const entry of cacheMap.values()) {
      // Only persist entries with enough hits
      if (entry.hitCount < this.config.minHitsToPerist) continue;

      // Score: prioritize high hit count entries
      const score = entry.hitCount;
      entries.push({ entry, score });
    }

    // Sort by score descending and take top N
    entries.sort((a, b) => b.score - a.score);
    const topEntries = entries.slice(0, this.config.maxPersistEntries);

    return topEntries.map(({ entry }) => ({
      key: entry.key,
      prompt: entry.prompt,
      response: entry.response,
      hitCount: entry.hitCount,
      responseSize: entry.responseSize,
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}

// Global persistence instance
let cachePersistence: CachePersistence | null = null;

/**
 * Initialize cache persistence for the global LLM cache
 */
export function initCachePersistence(config?: Partial<CachePersistenceConfig>): CachePersistence {
  const cache = getLLMCache();
  cachePersistence = new CachePersistence(cache, config);
  cachePersistence.load();
  cachePersistence.startAutoSave();
  return cachePersistence;
}

/**
 * Get global cache persistence instance
 */
export function getCachePersistence(): CachePersistence | null {
  return cachePersistence;
}

/**
 * Save cache before shutdown
 */
export function saveCacheOnShutdown(): void {
  if (cachePersistence) {
    cachePersistence.stopAutoSave();
    cachePersistence.save();
  }
}
