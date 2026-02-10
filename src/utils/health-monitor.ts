/**
 * Backend Health Monitor
 *
 * Proactively monitors LLM backend health to detect issues before tool calls fail.
 * Features:
 * - Periodic health probes with configurable interval
 * - Cached health status with TTL
 * - Health history for trend analysis
 * - Event-based notifications for status changes
 */

import { EventEmitter } from 'events';
import { BackendManager } from '../adapters/factory.js';
import { ProbeResult } from '../types/index.js';

export interface BackendHealthStatus {
  backendId: string;
  healthy: boolean;
  lastCheck: Date;
  lastHealthy: Date | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  error: string | null;
  probeResult: ProbeResult | null;
}

export interface HealthMonitorConfig {
  /** Interval between health checks in milliseconds (default: 30000 = 30s) */
  checkIntervalMs: number;
  /** TTL for cached health status in milliseconds (default: 15000 = 15s) */
  cacheTtlMs: number;
  /** Number of consecutive failures before marking backend as unhealthy (default: 2) */
  failureThreshold: number;
  /** Timeout for individual health probes in milliseconds (default: 5000 = 5s) */
  probeTimeoutMs: number;
  /** Maximum history entries per backend (default: 100) */
  maxHistoryEntries: number;
}

export interface HealthHistoryEntry {
  timestamp: Date;
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 30000,
  cacheTtlMs: 15000,
  failureThreshold: 2,
  probeTimeoutMs: 5000,
  maxHistoryEntries: 100,
};

export class BackendHealthMonitor extends EventEmitter {
  private backendManager: BackendManager;
  private config: HealthMonitorConfig;
  private healthStatus: Map<string, BackendHealthStatus> = new Map();
  private healthHistory: Map<string, HealthHistoryEntry[]> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(backendManager: BackendManager, config?: Partial<HealthMonitorConfig>) {
    super();
    this.backendManager = backendManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the health monitoring loop
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Run initial check immediately
    this.checkAllBackends();

    // Start periodic checks
    this.checkTimer = setInterval(() => {
      this.checkAllBackends();
    }, this.config.checkIntervalMs);

    // Prevent timer from keeping process alive
    if (this.checkTimer.unref) {
      this.checkTimer.unref();
    }
  }

  /**
   * Stop the health monitoring loop
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Get cached health status for a backend
   * Returns null if no cached status or status is stale
   */
  getHealthStatus(backendId: string): BackendHealthStatus | null {
    const status = this.healthStatus.get(backendId);
    if (!status) return null;

    // Check if cached status is still valid
    const age = Date.now() - status.lastCheck.getTime();
    if (age > this.config.cacheTtlMs) {
      return null; // Stale, trigger fresh check
    }

    return status;
  }

  /**
   * Get health status for all backends
   */
  getAllHealthStatus(): BackendHealthStatus[] {
    return Array.from(this.healthStatus.values());
  }

  /**
   * Get health history for a backend
   */
  getHealthHistory(backendId: string): HealthHistoryEntry[] {
    return this.healthHistory.get(backendId) || [];
  }

  /**
   * Check if a backend is healthy (uses cache, triggers probe if stale)
   */
  async isHealthy(backendId: string): Promise<boolean> {
    const cached = this.getHealthStatus(backendId);
    if (cached) {
      return cached.healthy;
    }

    // No valid cache, do a fresh probe
    await this.checkBackend(backendId);
    const fresh = this.healthStatus.get(backendId);
    return fresh?.healthy ?? false;
  }

  /**
   * Force a health check on all backends
   */
  async checkAllBackends(): Promise<void> {
    const backends = this.backendManager.getAllBackends();
    await Promise.all(backends.map((b) => this.checkBackend(b.id)));
  }

  /**
   * Check health of a specific backend
   */
  async checkBackend(backendId: string): Promise<BackendHealthStatus> {
    const backend = this.backendManager.getBackend(backendId);
    if (!backend) {
      const status: BackendHealthStatus = {
        backendId,
        healthy: false,
        lastCheck: new Date(),
        lastHealthy: null,
        consecutiveFailures: 0,
        latencyMs: null,
        error: 'Backend not found',
        probeResult: null,
      };
      this.healthStatus.set(backendId, status);
      return status;
    }

    const startTime = Date.now();
    let probeResult: ProbeResult;
    let latencyMs: number;

    try {
      // Create timeout controller
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.probeTimeoutMs);

      try {
        probeResult = await backend.probe();
        latencyMs = Date.now() - startTime;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      latencyMs = Date.now() - startTime;
      probeResult = {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    const previousStatus = this.healthStatus.get(backendId);
    const wasHealthy = previousStatus?.healthy ?? null;
    const isHealthyNow = probeResult.available;

    // Calculate consecutive failures
    let consecutiveFailures = 0;
    if (!isHealthyNow) {
      consecutiveFailures = (previousStatus?.consecutiveFailures ?? 0) + 1;
    }

    // Determine if backend should be marked unhealthy
    const meetFailureThreshold = consecutiveFailures >= this.config.failureThreshold;
    const effectiveHealthy = isHealthyNow || !meetFailureThreshold;

    const status: BackendHealthStatus = {
      backendId,
      healthy: effectiveHealthy,
      lastCheck: new Date(),
      lastHealthy: isHealthyNow ? new Date() : (previousStatus?.lastHealthy ?? null),
      consecutiveFailures,
      latencyMs,
      error: probeResult.error ?? null,
      probeResult,
    };

    this.healthStatus.set(backendId, status);

    // Record history
    this.recordHistory(backendId, {
      timestamp: new Date(),
      healthy: isHealthyNow,
      latencyMs,
      error: probeResult.error ?? null,
    });

    // Emit events on status change
    if (wasHealthy !== null && wasHealthy !== effectiveHealthy) {
      if (effectiveHealthy) {
        this.emit('backend:recovered', { backendId, status });
      } else {
        this.emit('backend:unhealthy', { backendId, status });
      }
    }

    this.emit('backend:checked', { backendId, status });

    return status;
  }

  /**
   * Get overall health summary
   */
  getHealthSummary(): {
    totalBackends: number;
    healthyBackends: number;
    unhealthyBackends: number;
    avgLatencyMs: number | null;
    backends: Array<{ id: string; healthy: boolean; latencyMs: number | null }>;
  } {
    const statuses = this.getAllHealthStatus();
    const healthyCount = statuses.filter((s) => s.healthy).length;
    const latencies = statuses.filter((s) => s.latencyMs !== null).map((s) => s.latencyMs!);
    const avgLatency =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;

    return {
      totalBackends: statuses.length,
      healthyBackends: healthyCount,
      unhealthyBackends: statuses.length - healthyCount,
      avgLatencyMs: avgLatency,
      backends: statuses.map((s) => ({
        id: s.backendId,
        healthy: s.healthy,
        latencyMs: s.latencyMs,
      })),
    };
  }

  /**
   * Update configuration dynamically
   */
  updateConfig(config: Partial<HealthMonitorConfig>): void {
    const wasRunning = this.isRunning;
    if (wasRunning) this.stop();

    this.config = { ...this.config, ...config };

    if (wasRunning) this.start();
  }

  private recordHistory(backendId: string, entry: HealthHistoryEntry): void {
    let history = this.healthHistory.get(backendId);
    if (!history) {
      history = [];
      this.healthHistory.set(backendId, history);
    }

    history.push(entry);

    // Trim to max entries
    if (history.length > this.config.maxHistoryEntries) {
      history.shift();
    }
  }
}

// Singleton instance
let globalHealthMonitor: BackendHealthMonitor | null = null;

export function getHealthMonitor(): BackendHealthMonitor | null {
  return globalHealthMonitor;
}

export function initHealthMonitor(
  backendManager: BackendManager,
  config?: Partial<HealthMonitorConfig>
): BackendHealthMonitor {
  if (globalHealthMonitor) {
    globalHealthMonitor.stop();
  }
  globalHealthMonitor = new BackendHealthMonitor(backendManager, config);
  return globalHealthMonitor;
}
