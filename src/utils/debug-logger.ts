/**
 * MCP Debug System - Centralized Logging and Error Collection
 *
 * Features:
 * - Log levels: ERROR, WARN, INFO, DEBUG, TRACE
 * - Error collection for proactive debugging
 * - Categorized logging (MCP, Agent, Queue, Client)
 * - Conditional output based on environment
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogCategory =
  | 'mcp'
  | 'agent'
  | 'queue'
  | 'client'
  | 'server'
  | 'llm'
  | 'general'
  | 'adapter'
  | 'cache';

export interface DebugLogEntry {
  id: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
  durationMs?: number; // Optional duration for timed operations
  correlationId?: string; // PLAN A: correlation ID for request tracing
}

export interface OperationMetrics {
  name: string;
  category: LogCategory;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  failures: number;
  lastOccurrence: Date;
}

export interface DebugConfig {
  /** Minimum log level to record (default: 'info') */
  minLevel: LogLevel;
  /** Enable console output (default: false in production) */
  consoleOutput: boolean;
  /** Max entries to keep in memory (default: 500) */
  maxEntries: number;
  /** Max errors to collect (default: 100) */
  maxErrors: number;
  /** Categories to enable (empty = all) */
  enabledCategories: LogCategory[];
  /** Track operation performance metrics (default: true) */
  trackMetrics: boolean;
  /** Max unique operations to track (default: 100) */
  maxMetrics: number;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const LOG_LEVEL_SYMBOLS: Record<LogLevel, string> = {
  error: '✗',
  warn: '⚠',
  info: '→',
  debug: '·',
  trace: '…',
};

const DEFAULT_CONFIG: DebugConfig = {
  minLevel: (process.env.MCP_DEBUG_LEVEL as LogLevel) || 'info',
  consoleOutput: process.env.MCP_DEBUG === '1' || process.env.AGENT_DEBUG === '1',
  maxEntries: 500,
  maxErrors: 100,
  enabledCategories: [],
  trackMetrics: true,
  maxMetrics: 100,
};

// PLAN A: Correlation ID generation utility
let correlationIdCounter = 0;
export function generateCorrelationId(): string {
  return `corr-${Date.now()}-${++correlationIdCounter}-${Math.random().toString(36).substring(2, 9)}`;
}

export class DebugLogger {
  private config: DebugConfig;
  private logs: DebugLogEntry[] = [];
  private errors: DebugLogEntry[] = [];
  private logCounter = 0;
  private startTime = Date.now();

  // Operation metrics tracking
  private operationMetrics: Map<string, OperationMetrics> = new Map();
  // PLAN A: Store category AND correlationId for each active operation
  private activeOperations: Map<
    string,
    { startTime: number; category: LogCategory; correlationId?: string }
  > = new Map();

  // Slow operation threshold (5s default)
  private slowOperationThresholdMs = 5000;

  constructor(config?: Partial<DebugConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<DebugConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if a log level should be recorded
   */
  private shouldLog(level: LogLevel, category: LogCategory): boolean {
    // Check level
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return false;
    }
    // Check category filter
    if (
      this.config.enabledCategories.length > 0 &&
      !this.config.enabledCategories.includes(category)
    ) {
      return false;
    }
    return true;
  }

  /**
   * Core logging method
   * PLAN A: Now accepts optional correlationId for request tracing
   */
  log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ): void {
    if (!this.shouldLog(level, category)) return;

    const entry: DebugLogEntry = {
      id: `log-${++this.logCounter}-${Date.now()}`,
      timestamp: new Date(),
      level,
      category,
      message,
      context,
      stack: level === 'error' ? new Error().stack : undefined,
      correlationId, // PLAN A: Include correlation ID for tracing
    };

    // Add to logs
    this.logs.push(entry);
    if (this.logs.length > this.config.maxEntries) {
      this.logs = this.logs.slice(-this.config.maxEntries);
    }

    // Collect errors separately
    if (level === 'error' || level === 'warn') {
      this.errors.push(entry);
      if (this.errors.length > this.config.maxErrors) {
        this.errors = this.errors.slice(-this.config.maxErrors);
      }
    }

    // Console output
    if (this.config.consoleOutput) {
      const prefix = `[${category.toUpperCase()}]`;
      const symbol = LOG_LEVEL_SYMBOLS[level];
      // PLAN A: Include correlation ID in console output if present
      const corrId = correlationId ? ` [${correlationId}]` : '';
      const line = `${prefix} ${symbol}${corrId} ${message}\n`;

      // Use stderr for errors/warnings, stderr for others (MCP protocol requirement)
      process.stderr.write(line);

      if (context && level === 'debug') {
        process.stderr.write(`${prefix}   context: ${JSON.stringify(context).substring(0, 200)}\n`);
      }
    }
  }

  // Convenience methods
  // PLAN A: Now accept optional correlationId for all logging levels
  error(
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ): void {
    this.log('error', category, message, context, correlationId);
  }

  warn(
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ): void {
    this.log('warn', category, message, context, correlationId);
  }

  info(
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ): void {
    this.log('info', category, message, context, correlationId);
  }

  debug(
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ): void {
    this.log('debug', category, message, context, correlationId);
  }

  trace(
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ): void {
    this.log('trace', category, message, context, correlationId);
  }

  /**
   * Start timing an operation
   * Returns an operation ID to use with endOperation
   * PLAN A: Now accepts optional correlationId for tracing
   */
  startOperation(name: string, category: LogCategory, correlationId?: string): string {
    const opId = `op-${++this.logCounter}-${Date.now()}`;
    this.activeOperations.set(opId, { startTime: Date.now(), category, correlationId });
    this.debug(category, `Starting operation: ${name}`, { operationId: opId }, correlationId);
    return opId;
  }

  /**
   * End a timed operation and record metrics
   * PLAN A: Propagates correlationId from the operation start
   */
  endOperation(
    opId: string,
    name: string,
    success: boolean = true,
    context?: Record<string, unknown>
  ): number {
    const op = this.activeOperations.get(opId);
    if (!op) {
      this.warn('general', `endOperation called for unknown operation: ${opId}`);
      return 0;
    }

    const durationMs = Date.now() - op.startTime;
    this.activeOperations.delete(opId);

    // Log completion with correlation ID if present
    const level: LogLevel = !success
      ? 'warn'
      : durationMs > this.slowOperationThresholdMs
        ? 'warn'
        : 'debug';
    this.log(
      level,
      op.category,
      `Completed operation: ${name} (${durationMs}ms)`,
      {
        ...context,
        operationId: opId,
        durationMs,
        success,
        slow: durationMs > this.slowOperationThresholdMs,
      },
      op.correlationId
    );

    // Update metrics if tracking is enabled
    if (this.config.trackMetrics) {
      this.updateMetrics(name, op.category, durationMs, success);
    }

    return durationMs;
  }

  /**
   * Update operation metrics
   */
  private updateMetrics(
    name: string,
    category: LogCategory,
    durationMs: number,
    success: boolean
  ): void {
    const existing = this.operationMetrics.get(name);
    if (existing) {
      existing.count++;
      existing.totalDurationMs += durationMs;
      existing.avgDurationMs = existing.totalDurationMs / existing.count;
      existing.minDurationMs = Math.min(existing.minDurationMs, durationMs);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      if (!success) existing.failures++;
      existing.lastOccurrence = new Date();
    } else {
      // Check if we need to evict old metrics
      if (this.operationMetrics.size >= this.config.maxMetrics) {
        // Remove the oldest operation by lastOccurrence
        let oldestKey: string | null = null;
        let oldestTime = Date.now();
        for (const [key, metric] of this.operationMetrics) {
          if (metric.lastOccurrence.getTime() < oldestTime) {
            oldestTime = metric.lastOccurrence.getTime();
            oldestKey = key;
          }
        }
        if (oldestKey) this.operationMetrics.delete(oldestKey);
      }

      this.operationMetrics.set(name, {
        name,
        category,
        count: 1,
        totalDurationMs: durationMs,
        avgDurationMs: durationMs,
        minDurationMs: durationMs,
        maxDurationMs: durationMs,
        failures: success ? 0 : 1,
        lastOccurrence: new Date(),
      });
    }
  }

  /**
   * Get performance metrics for all tracked operations
   */
  getMetrics(): OperationMetrics[] {
    return Array.from(this.operationMetrics.values());
  }

  /**
   * Get metrics for slowest operations
   */
  getSlowestOperations(count: number = 10): OperationMetrics[] {
    return this.getMetrics()
      .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
      .slice(0, count);
  }

  /**
   * Get metrics for most frequently failing operations
   */
  getMostFailingOperations(count: number = 10): OperationMetrics[] {
    return this.getMetrics()
      .filter((m) => m.failures > 0)
      .sort((a, b) => b.failures / b.count - a.failures / a.count)
      .slice(0, count);
  }

  /**
   * Helper: Time a function and record metrics
   */
  async timeAsync<T>(name: string, category: LogCategory, fn: () => Promise<T>): Promise<T> {
    const opId = this.startOperation(name, category);
    try {
      const result = await fn();
      this.endOperation(opId, name, true);
      return result;
    } catch (error) {
      this.endOperation(opId, name, false, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Set slow operation threshold (in ms)
   */
  setSlowOperationThreshold(ms: number): void {
    this.slowOperationThresholdMs = ms;
  }

  /**
   * Redact absolute paths from text to prevent information leakage
   * Replaces absolute paths like C:\Users\username\... or /home/username/...
   * with relative paths or placeholders
   */
  private redactPaths(text: string): string {
    if (!text) return text;

    // Windows absolute paths: C:\Users\... or D:\...
    let redacted = text.replace(/[A-Z]:\\Users\\[^\\]+\\([^\s:]+)/gi, '<workspace>/$1');
    redacted = redacted.replace(/[A-Z]:\\[^\s:]+/gi, (match) => {
      // Extract just the last path segment for context
      const parts = match.split('\\');
      const relevant = parts.slice(-3).join('/');
      return `<path>/${relevant}`;
    });

    // Unix absolute paths: /home/username/... or /Users/...
    redacted = redacted.replace(/\/(?:home|Users)\/[^/]+\/([^\s:]+)/gi, '<workspace>/$1');

    return redacted;
  }

  /**
   * Get all collected errors (for proactive debugging)
   * Paths are redacted to prevent information leakage
   */
  getErrors(count?: number): DebugLogEntry[] {
    return this.errors.slice(-(count || 50)).map((entry) => this.redactLogEntry(entry));
  }

  /**
   * Redact sensitive information from a log entry
   */
  private redactLogEntry(entry: DebugLogEntry): DebugLogEntry {
    return {
      ...entry,
      message: this.redactPaths(entry.message),
      stack: entry.stack ? this.redactPaths(entry.stack) : undefined,
      context: entry.context ? this.redactContext(entry.context) : undefined,
    };
  }

  /**
   * Redact paths in context object
   */
  private redactContext(context: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === 'string') {
        redacted[key] = this.redactPaths(value);
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactContext(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  /**
   * Get recent logs
   * Paths are redacted to prevent information leakage
   */
  getRecentLogs(count?: number, level?: LogLevel, category?: LogCategory): DebugLogEntry[] {
    let filtered = this.logs;

    if (level) {
      filtered = filtered.filter((l) => l.level === level);
    }
    if (category) {
      filtered = filtered.filter((l) => l.category === category);
    }

    return filtered.slice(-(count || 50)).map((entry) => this.redactLogEntry(entry));
  }

  /**
   * Get debug summary for diagnostics
   * Paths in recent errors are redacted to prevent information leakage
   */
  getSummary(): {
    uptimeSeconds: number;
    totalLogs: number;
    totalErrors: number;
    totalWarnings: number;
    logsByCategory: Record<string, number>;
    logsByLevel: Record<string, number>;
    recentErrors: DebugLogEntry[];
    activeOperations: number;
    trackedMetrics: number;
    slowestOperations: { name: string; avgMs: number }[];
  } {
    const logsByCategory: Record<string, number> = {};
    const logsByLevel: Record<string, number> = {};
    let totalWarnings = 0;

    for (const entry of this.logs) {
      logsByCategory[entry.category] = (logsByCategory[entry.category] || 0) + 1;
      logsByLevel[entry.level] = (logsByLevel[entry.level] || 0) + 1;
      if (entry.level === 'warn') totalWarnings++;
    }

    const slowest = this.getSlowestOperations(5).map((m) => ({
      name: m.name,
      avgMs: Math.round(m.avgDurationMs),
    }));

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      totalLogs: this.logs.length,
      totalErrors: this.errors.filter((e) => e.level === 'error').length,
      totalWarnings,
      logsByCategory,
      logsByLevel,
      recentErrors: this.errors.slice(-10).map((entry) => this.redactLogEntry(entry)),
      activeOperations: this.activeOperations.size,
      trackedMetrics: this.operationMetrics.size,
      slowestOperations: slowest,
    };
  }

  /**
   * Clear all logs and metrics
   */
  clear(): void {
    this.logs = [];
    this.errors = [];
    this.operationMetrics.clear();
    // Note: activeOperations not cleared as they may still be running
  }

  /**
   * Get performance health report
   */
  getHealthReport(): {
    status: 'healthy' | 'degraded' | 'critical';
    issues: string[];
    metrics: {
      avgResponseTimeMs: number;
      errorRate: number;
      activeOps: number;
      slowOps: number;
    };
  } {
    const issues: string[] = [];
    const metrics = this.getMetrics();

    // Calculate aggregate stats
    let totalOps = 0;
    let totalDuration = 0;
    let totalFailures = 0;
    let slowOps = 0;

    for (const m of metrics) {
      totalOps += m.count;
      totalDuration += m.totalDurationMs;
      totalFailures += m.failures;
      if (m.avgDurationMs > this.slowOperationThresholdMs) slowOps++;
    }

    const avgResponseTimeMs = totalOps > 0 ? totalDuration / totalOps : 0;
    const errorRate = totalOps > 0 ? totalFailures / totalOps : 0;

    // Check for issues
    if (errorRate > 0.2) issues.push(`High error rate: ${(errorRate * 100).toFixed(1)}%`);
    if (avgResponseTimeMs > 10000)
      issues.push(`Slow avg response: ${Math.round(avgResponseTimeMs)}ms`);
    if (this.activeOperations.size > 10)
      issues.push(`Many active ops: ${this.activeOperations.size}`);
    if (slowOps > 5)
      issues.push(`${slowOps} operations averaging > ${this.slowOperationThresholdMs}ms`);

    // Determine status
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (issues.length > 0) status = 'degraded';
    if (errorRate > 0.5 || avgResponseTimeMs > 30000) status = 'critical';

    return {
      status,
      issues,
      metrics: {
        avgResponseTimeMs: Math.round(avgResponseTimeMs),
        errorRate: Math.round(errorRate * 100) / 100,
        activeOps: this.activeOperations.size,
        slowOps,
      },
    };
  }
}

// Singleton instance
let debugLoggerInstance: DebugLogger | null = null;

/**
 * Get or create the singleton debug logger
 */
export function getDebugLogger(config?: Partial<DebugConfig>): DebugLogger {
  if (!debugLoggerInstance) {
    debugLoggerInstance = new DebugLogger(config);
  } else if (config) {
    debugLoggerInstance.updateConfig(config);
  }
  return debugLoggerInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetDebugLogger(): void {
  debugLoggerInstance = null;
}

// Quick access functions for common use
// PLAN A: Updated to accept optional correlationId parameter
export const debug = {
  error: (
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ) => getDebugLogger().error(category, message, context, correlationId),
  warn: (
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ) => getDebugLogger().warn(category, message, context, correlationId),
  info: (
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ) => getDebugLogger().info(category, message, context, correlationId),
  debug: (
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ) => getDebugLogger().debug(category, message, context, correlationId),
  trace: (
    category: LogCategory,
    message: string,
    context?: Record<string, unknown>,
    correlationId?: string
  ) => getDebugLogger().trace(category, message, context, correlationId),
  getErrors: () => getDebugLogger().getErrors(),
  getSummary: () => getDebugLogger().getSummary(),
  // Operation timing - PLAN A: Updated to accept correlationId
  startOp: (name: string, category: LogCategory, correlationId?: string) =>
    getDebugLogger().startOperation(name, category, correlationId),
  endOp: (opId: string, name: string, success?: boolean, context?: Record<string, unknown>) =>
    getDebugLogger().endOperation(opId, name, success, context),
  timeAsync: <T>(name: string, category: LogCategory, fn: () => Promise<T>) =>
    getDebugLogger().timeAsync(name, category, fn),
  getMetrics: () => getDebugLogger().getMetrics(),
  getHealthReport: () => getDebugLogger().getHealthReport(),
};
