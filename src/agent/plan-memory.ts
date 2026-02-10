/**
 * Plan Memory
 *
 * Stores successful execution plans for common task patterns.
 * Enables plan reuse across runs to skip LLM-based planning for similar tasks.
 *
 * - Fingerprint-based task matching (normalized text hash)
 * - Success rate tracking to prefer reliable plans
 * - File-based persistence to ~/.mcp-local-llm/plan-memory.json
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface PlanTemplate {
  fingerprint: string;
  /** Normalized task pattern (e.g., "audit * for security vulnerabilities") */
  taskPattern: string;
  /** Original task text (first occurrence) */
  originalTask: string;
  /** Plan skeleton with subtask/step structure */
  planSkeleton: {
    subtasks: Array<{
      title: string;
      task: string;
      stepTitles: string[];
    }>;
  };
  /** Number of successful executions */
  successCount: number;
  /** Number of failed executions */
  failureCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Total times this plan was used */
  uses: number;
  /** Last time this plan was used */
  lastUsed: string;
  /** When this plan was first created */
  createdAt: string;
}

export interface PlanMemoryConfig {
  /** Path to persistence file */
  filePath: string;
  /** Minimum success rate to reuse a plan (default: 0.6) */
  minSuccessRate: number;
  /** Minimum uses before trusting success rate (default: 2) */
  minUsesForTrust: number;
  /** Maximum plans to store (default: 100) */
  maxPlans: number;
  /** Enable/disable plan memory (default: true) */
  enabled: boolean;
}

interface PersistedData {
  version: 1;
  savedAt: string;
  plans: PlanTemplate[];
}

const DEFAULT_CONFIG: PlanMemoryConfig = {
  filePath: join(homedir(), '.mcp-local-llm', 'plan-memory.json'),
  minSuccessRate: 0.6,
  minUsesForTrust: 2,
  maxPlans: 100,
  enabled: true,
};

/**
 * Stop words to remove when normalizing task text
 */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'is',
  'was',
  'are',
  'were',
  'been',
  'be',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'please',
  'now',
]);

/**
 * Action verbs that define task intent
 */
const ACTION_VERBS = new Set([
  'audit',
  'analyze',
  'review',
  'scan',
  'check',
  'find',
  'search',
  'list',
  'count',
  'summarize',
  'describe',
  'explain',
  'document',
  'create',
  'add',
  'implement',
  'build',
  'generate',
  'write',
  'fix',
  'repair',
  'resolve',
  'debug',
  'patch',
  'update',
  'modify',
  'change',
  'refactor',
  'improve',
  'delete',
  'remove',
  'clean',
  'purge',
  'test',
  'verify',
  'validate',
  'ensure',
  'migrate',
  'convert',
  'transform',
]);

export class PlanMemory {
  private config: PlanMemoryConfig;
  private plans = new Map<string, PlanTemplate>();
  private dirty = false;

  constructor(config?: Partial<PlanMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.load();
  }

  /**
   * Normalize task text for fingerprinting.
   * - Lowercase
   * - Remove stop words
   * - Replace specific paths/names with wildcards
   * - Keep action verbs and key nouns
   */
  private normalizeTask(task: string): string {
    let normalized = task
      .toLowerCase()
      .replace(/[`'"]/g, '') // Remove quotes
      .replace(/\r\n/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Replace file paths with wildcard
    normalized = normalized.replace(/[a-z]:\\[^\s]+/gi, '*');
    normalized = normalized.replace(/\/[^\s]+\.[a-z]+/gi, '*');
    normalized = normalized.replace(/\.[a-z]{1,5}\b/gi, '.*');

    // Replace URLs with wildcard
    normalized = normalized.replace(/https?:\/\/[^\s]+/gi, '*');

    // Replace numbers with wildcard
    normalized = normalized.replace(/\b\d+\b/g, '*');

    // Split into words and filter
    const words = normalized.split(/\s+/);
    const filtered = words.filter((word) => {
      // Keep action verbs
      if (ACTION_VERBS.has(word)) return true;
      // Remove stop words
      if (STOP_WORDS.has(word)) return false;
      // Keep words longer than 2 chars
      return word.length > 2;
    });

    return filtered.join(' ');
  }

  /**
   * Generate a fingerprint from normalized task text.
   */
  private generateFingerprint(task: string): string {
    const normalized = this.normalizeTask(task);
    return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
  }

  /**
   * Find a similar plan based on task fingerprint.
   * Returns null if no suitable plan found.
   */
  findSimilar(task: string): PlanTemplate | null {
    if (!this.config.enabled) return null;

    const fingerprint = this.generateFingerprint(task);
    const plan = this.plans.get(fingerprint);

    if (!plan) {
      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(
          `[plan-memory] MISS: ${fingerprint.substring(0, 8)}... (${this.plans.size} plans)\n`
        );
      }
      return null;
    }

    // Check if plan is trustworthy enough to reuse
    if (plan.uses >= this.config.minUsesForTrust) {
      if (plan.successRate < this.config.minSuccessRate) {
        if (process.env.DEBUG_PLAN_MEMORY === '1') {
          process.stderr.write(
            `[plan-memory] SKIP: low success rate ${Math.round(plan.successRate * 100)}%\n`
          );
        }
        return null;
      }
    }

    if (process.env.DEBUG_PLAN_MEMORY === '1') {
      process.stderr.write(
        `[plan-memory] HIT: ${fingerprint.substring(0, 8)}... ` +
          `successRate=${Math.round(plan.successRate * 100)}% uses=${plan.uses}\n`
      );
    }

    return plan;
  }

  /**
   * Record a successful task execution.
   * Creates or updates the plan template.
   */
  recordSuccess(
    task: string,
    plan: {
      subtasks: Array<{
        id: string;
        title: string;
        task: string;
        steps: Array<{ id: string; title: string }>;
      }>;
    }
  ): void {
    if (!this.config.enabled) return;

    const fingerprint = this.generateFingerprint(task);
    const existing = this.plans.get(fingerprint);
    const now = new Date().toISOString();

    if (existing) {
      existing.successCount++;
      existing.uses++;
      existing.successRate =
        existing.successCount / (existing.successCount + existing.failureCount);
      existing.lastUsed = now;
      this.dirty = true;
    } else {
      // Create new plan template
      const template: PlanTemplate = {
        fingerprint,
        taskPattern: this.normalizeTask(task),
        originalTask: task.substring(0, 500),
        planSkeleton: {
          subtasks: plan.subtasks.map((st) => ({
            title: st.title,
            task: st.task,
            stepTitles: st.steps.map((s) => s.title),
          })),
        },
        successCount: 1,
        failureCount: 0,
        successRate: 1.0,
        uses: 1,
        lastUsed: now,
        createdAt: now,
      };
      this.plans.set(fingerprint, template);
      this.dirty = true;

      // Evict if over capacity
      if (this.plans.size > this.config.maxPlans) {
        this.evictLeastValuable();
      }
    }

    if (process.env.DEBUG_PLAN_MEMORY === '1') {
      const p = this.plans.get(fingerprint)!;
      process.stderr.write(
        `[plan-memory] RECORD SUCCESS: ${fingerprint.substring(0, 8)}... uses=${p.uses}\n`
      );
    }

    // Auto-save after recording
    this.save();
  }

  /**
   * Record a failed task execution.
   */
  recordFailure(task: string): void {
    if (!this.config.enabled) return;

    const fingerprint = this.generateFingerprint(task);
    const existing = this.plans.get(fingerprint);

    if (existing) {
      existing.failureCount++;
      existing.uses++;
      existing.successRate =
        existing.successCount / (existing.successCount + existing.failureCount);
      existing.lastUsed = new Date().toISOString();
      this.dirty = true;
      this.save();

      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(
          `[plan-memory] RECORD FAILURE: ${fingerprint.substring(0, 8)}... ` +
            `successRate=${Math.round(existing.successRate * 100)}%\n`
        );
      }
    }
  }

  /**
   * Evict the least valuable plan (lowest score).
   * Score = successRate * log(uses + 1) * recency
   */
  private evictLeastValuable(): void {
    if (this.plans.size === 0) return;

    const now = Date.now();
    let minScore = Infinity;
    let minKey = '';

    for (const [key, plan] of this.plans.entries()) {
      const ageMs = now - new Date(plan.lastUsed).getTime();
      const recency = 1 / (1 + ageMs / (24 * 60 * 60 * 1000)); // Decay over days
      const score = plan.successRate * Math.log(plan.uses + 1) * recency;

      if (score < minScore) {
        minScore = score;
        minKey = key;
      }
    }

    if (minKey) {
      this.plans.delete(minKey);
      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(`[plan-memory] EVICT: ${minKey.substring(0, 8)}...\n`);
      }
    }
  }

  /**
   * Load plans from disk.
   */
  private load(): void {
    try {
      if (!existsSync(this.config.filePath)) return;

      const content = readFileSync(this.config.filePath, 'utf-8');
      const data: PersistedData = JSON.parse(content);

      if (data.version !== 1) return;

      for (const plan of data.plans) {
        this.plans.set(plan.fingerprint, plan);
      }

      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(`[plan-memory] LOAD: ${this.plans.size} plans\n`);
      }
    } catch (e) {
      // Ignore load errors - start fresh
      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(`[plan-memory] LOAD ERROR: ${e}\n`);
      }
    }
  }

  /**
   * Save plans to disk.
   */
  save(): boolean {
    if (!this.dirty) return false;

    try {
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data: PersistedData = {
        version: 1,
        savedAt: new Date().toISOString(),
        plans: Array.from(this.plans.values()),
      };

      writeFileSync(this.config.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;

      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(`[plan-memory] SAVE: ${this.plans.size} plans\n`);
      }

      return true;
    } catch (e) {
      if (process.env.DEBUG_PLAN_MEMORY === '1') {
        process.stderr.write(`[plan-memory] SAVE ERROR: ${e}\n`);
      }
      return false;
    }
  }

  /**
   * Get statistics about plan memory.
   */
  getStats(): {
    enabled: boolean;
    planCount: number;
    avgSuccessRate: number;
    totalUses: number;
  } {
    let totalSuccessRate = 0;
    let totalUses = 0;

    for (const plan of this.plans.values()) {
      totalSuccessRate += plan.successRate;
      totalUses += plan.uses;
    }

    return {
      enabled: this.config.enabled,
      planCount: this.plans.size,
      avgSuccessRate: this.plans.size > 0 ? totalSuccessRate / this.plans.size : 0,
      totalUses,
    };
  }

  /**
   * Clear all stored plans.
   */
  clear(): void {
    this.plans.clear();
    this.dirty = true;
    this.save();
  }

  /**
   * Enable or disable plan memory.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

// Singleton instance
let planMemoryInstance: PlanMemory | null = null;

/**
 * Get or create the singleton plan memory instance.
 */
export function getPlanMemory(config?: Partial<PlanMemoryConfig>): PlanMemory {
  if (!planMemoryInstance) {
    planMemoryInstance = new PlanMemory(config);
  }
  return planMemoryInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetPlanMemory(): void {
  planMemoryInstance = null;
}
