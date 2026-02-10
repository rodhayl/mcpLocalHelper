/**
 * MCP Request/Response Logger
 *
 * Provides structured logging for MCP tool calls with timing information.
 * Maintains a rolling log of recent requests for debugging.
 */

export interface MCPLogEntry {
  id: string;
  timestamp: Date;
  direction: 'request' | 'response';
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface MCPLoggerConfig {
  /** Enable logging (default: true) */
  enabled: boolean;
  /** Log level (default: 'info') */
  logLevel: 'none' | 'error' | 'info' | 'debug';
  /** Max entries to keep in memory (default: 100) */
  maxEntries: number;
  /** Log to console (default: false in production) */
  logToConsole: boolean;
}

const DEFAULT_CONFIG: MCPLoggerConfig = {
  enabled: true,
  logLevel: 'info',
  maxEntries: 100,
  logToConsole: process.env.NODE_ENV !== 'production',
};

export class MCPLogger {
  private config: MCPLoggerConfig;
  private logs: MCPLogEntry[] = [];
  private requestCounter = 0;
  private pendingRequests: Map<string, { toolName: string; startTime: number; args?: unknown }> =
    new Map();

  // Stats
  private stats = {
    totalRequests: 0,
    totalErrors: 0,
    avgDurationMs: 0,
    totalDurationMs: 0,
  };

  constructor(config?: Partial<MCPLoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MCPLoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): MCPLoggerConfig {
    return { ...this.config };
  }

  /**
   * Log a request start - returns request ID for correlation
   */
  logRequest(toolName: string, args?: unknown): string {
    if (!this.config.enabled) return '';

    const id = `req-${++this.requestCounter}-${Date.now()}`;

    this.pendingRequests.set(id, {
      toolName,
      startTime: Date.now(),
      args,
    });

    const entry: MCPLogEntry = {
      id,
      timestamp: new Date(),
      direction: 'request',
      toolName,
      args: this.config.logLevel === 'debug' ? args : undefined,
    };

    this.addEntry(entry);
    this.stats.totalRequests++;

    if (this.config.logToConsole && this.config.logLevel !== 'none') {
      process.stderr.write(`[MCP] → ${toolName} (${id})\n`);
      if (this.config.logLevel === 'debug' && args) {
        process.stderr.write(`[MCP]   args: ${JSON.stringify(args, null, 2).substring(0, 200)}\n`);
      }
    }

    return id;
  }

  /**
   * Log a response end
   */
  logResponse(requestId: string, result?: unknown, error?: string): void {
    if (!this.config.enabled || !requestId) return;

    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    const durationMs = Date.now() - pending.startTime;
    this.pendingRequests.delete(requestId);

    const entry: MCPLogEntry = {
      id: requestId,
      timestamp: new Date(),
      direction: 'response',
      toolName: pending.toolName,
      durationMs,
      error,
      result: this.config.logLevel === 'debug' ? this.truncateResult(result) : undefined,
    };

    this.addEntry(entry);

    // Update stats
    this.stats.totalDurationMs += durationMs;
    this.stats.avgDurationMs = this.stats.totalDurationMs / this.stats.totalRequests;
    if (error) this.stats.totalErrors++;

    if (this.config.logToConsole) {
      if (error && this.config.logLevel !== 'none') {
        process.stderr.write(`[MCP] ✗ ${pending.toolName} (${durationMs}ms): ${error}\n`);
      } else if (this.config.logLevel === 'info' || this.config.logLevel === 'debug') {
        process.stderr.write(`[MCP] ← ${pending.toolName} (${durationMs}ms)\n`);
      }
    }
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(count: number = 20): MCPLogEntry[] {
    return this.logs.slice(-count);
  }

  /**
   * Get stats
   */
  getStats(): {
    totalRequests: number;
    totalErrors: number;
    avgDurationMs: number;
    pendingRequests: number;
  } {
    return {
      ...this.stats,
      avgDurationMs: Math.round(this.stats.avgDurationMs),
      pendingRequests: this.pendingRequests.size,
    };
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = [];
    this.pendingRequests.clear();
    this.stats = {
      totalRequests: 0,
      totalErrors: 0,
      avgDurationMs: 0,
      totalDurationMs: 0,
    };
  }

  /**
   * Add entry to log with max size enforcement
   */
  private addEntry(entry: MCPLogEntry): void {
    this.logs.push(entry);

    // Trim to max size
    if (this.logs.length > this.config.maxEntries) {
      this.logs = this.logs.slice(-this.config.maxEntries);
    }
  }

  /**
   * Truncate large results for logging
   */
  private truncateResult(result: unknown): unknown {
    if (result === undefined || result === null) return result;

    const str = JSON.stringify(result);
    if (str.length <= 500) return result;

    return {
      _truncated: true,
      _length: str.length,
      _preview: str.substring(0, 200) + '...',
    };
  }
}

// Singleton instance
let mcpLoggerInstance: MCPLogger | null = null;

/**
 * Get or create the singleton MCP logger
 */
export function getMCPLogger(config?: Partial<MCPLoggerConfig>): MCPLogger {
  if (!mcpLoggerInstance) {
    mcpLoggerInstance = new MCPLogger(config);
  } else if (config) {
    mcpLoggerInstance.updateConfig(config);
  }
  return mcpLoggerInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetMCPLogger(): void {
  mcpLoggerInstance = null;
}
