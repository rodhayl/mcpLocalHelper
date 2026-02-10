/**
 * Task Queue - Manages concurrent execution of agent tasks
 *
 * Prevents overloading the local LLM by limiting concurrent agent_task executions.
 * Tasks are queued FIFO and executed when slots become available.
 */

import { debug } from './debug-logger.js';

export interface QueuedTask<T> {
  id: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  name?: string;
  clientId?: string; // For client session tracking
}

export interface TaskQueueStatus {
  isBusy: boolean;
  /** Whether there are any tasks currently running (for clearer status) */
  hasRunningTasks: boolean;
  running: number;
  queued: number;
  maxConcurrent: number;
  queuedTaskIds: string[];
  runningTaskIds: string[];
  oldestRunningTaskAgeMs?: number;
  /** Estimated seconds to wait before a new task can start (for agent polling guidance) */
  estimatedWaitSeconds?: number;
  /** Whether a new task can be submitted and run immediately (queue not full and not at max concurrency) */
  canSubmitImmediately: boolean;
  message?: string;
}

export interface TaskQueueConfig {
  /** Maximum concurrent tasks (default: 2) */
  maxConcurrentTasks: number;
  /** Queue timeout in ms - reject if waiting too long (default: 300000 = 5min) */
  queueTimeoutMs: number;
  /** Stale task timeout in ms - auto-cleanup tasks running too long (default: 600000 = 10min) */
  staleTaskTimeoutMs: number;
  /** Progressive timeout: multiply queueTimeout by queue position (default: false) */
  progressiveTimeout: boolean;
  /** Warning threshold: log warning when queue reaches this size (default: 5) */
  queueWarningThreshold: number;
  /** Health check interval in ms for stale task detection (default: 30000 = 30s) */
  healthCheckIntervalMs: number;
}

const DEFAULT_CONFIG: TaskQueueConfig = {
  maxConcurrentTasks: 2,
  queueTimeoutMs: 300000, // 5 minutes
  staleTaskTimeoutMs: 600000, // 10 minutes - allow complex tasks more time
  progressiveTimeout: true, // Enable by default for better UX
  queueWarningThreshold: 5,
  healthCheckIntervalMs: 30000, // Check every 30 seconds
};

let queueErrorHandlersRegistered = false;

export class TaskQueue {
  private queue: QueuedTask<unknown>[] = [];
  private running: Map<string, QueuedTask<unknown>> = new Map();
  private config: TaskQueueConfig;
  private taskCounter = 0;

  // Simplified lock: since JavaScript is single-threaded, a boolean flag is sufficient
  // for preventing re-entrant processing. The key is to check and set synchronously.
  private isProcessing = false;

  // Rolling average for better wait time estimates
  private recentTaskDurations: number[] = [];
  private readonly maxDurationSamples = 20;
  private totalCompletedTasks = 0;
  private totalFailedTasks = 0;
  private totalTimedOutTasks = 0;

  // Client session tracking to prevent cross-client interference
  private tasksByClient: Map<string, Set<string>> = new Map();

  // Track last queue processing time to avoid redundant processing
  private lastProcessTime = 0;
  private readonly minProcessIntervalMs = 10;
  private pendingProcessTimeout: NodeJS.Timeout | null = null;

  // Health check timer for proactive stale task detection
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private lastHealthCheck = 0;

  constructor(config?: Partial<TaskQueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Process-level error handlers to prevent crashes from affecting other clients
    this.setupErrorHandlers();

    // Start health check timer
    this.startHealthCheckTimer();
  }

  /**
   * Start the health check timer for proactive stale task detection
   */
  private startHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.cleanupStaleTasks();
      this.lastHealthCheck = Date.now();
    }, this.config.healthCheckIntervalMs);

    // Don't let the timer keep the process alive
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * Stop the health check timer (for cleanup)
   */
  private stopHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Setup process-level error handlers for robustness
   */
  private setupErrorHandlers(): void {
    if (queueErrorHandlersRegistered) return;
    queueErrorHandlersRegistered = true;

    // Catch unhandled promise rejections that escape task execution
    process.on('unhandledRejection', (reason, _promise) => {
      debug.error('queue', 'Unhandled rejection in task queue', {
        reason: String(reason),
      });
      // Don't crash - just log and continue
    });
  }

  /**
   * Update configuration dynamically
   */
  updateConfig(config: Partial<TaskQueueConfig>): void {
    this.config = { ...this.config, ...config };
    // Process queue in case we increased concurrency
    this.processQueue();
  }

  /**
   * Get current configuration
   */
  getConfig(): TaskQueueConfig {
    return { ...this.config };
  }

  /**
   * Enqueue a task for execution
   * Returns a promise that resolves when the task completes
   * @param execute - The async function to execute
   * @param name - Optional task name for debugging
   * @param clientId - Optional client session ID for isolation
   */
  async enqueue<T>(execute: () => Promise<T>, name?: string, clientId?: string): Promise<T> {
    // Clean up any stale running tasks first
    this.cleanupStaleTasks();

    const id = `task-${++this.taskCounter}-${Date.now()}`;
    const queuePosition = this.queue.length;

    // Calculate effective timeout based on queue position (if progressive timeout is enabled)
    const baseTimeout = this.config.queueTimeoutMs;
    const effectiveTimeout = this.config.progressiveTimeout
      ? Math.round(baseTimeout * (1 + queuePosition * 0.5)) // Add 50% per queue position
      : baseTimeout;

    // Warn if queue is getting long
    if (queuePosition >= this.config.queueWarningThreshold) {
      debug.warn('queue', `Queue getting long: ${queuePosition + 1} tasks waiting`, {
        running: this.running.size,
        maxConcurrent: this.config.maxConcurrentTasks,
        oldestRunningMs: this.getOldestRunningAge(),
      });
    }

    // Debug logging for concurrency monitoring
    debug.debug('queue', `Enqueueing task ${name || id}`, {
      running: this.running.size,
      maxConcurrent: this.config.maxConcurrentTasks,
      queued: this.queue.length,
      clientId: clientId || 'anonymous',
      queuePosition,
      effectiveTimeout,
    });

    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        id,
        execute,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt: new Date(),
        name,
        clientId,
      };

      // Track task by client for session isolation
      if (clientId) {
        if (!this.tasksByClient.has(clientId)) {
          this.tasksByClient.set(clientId, new Set());
        }
        this.tasksByClient.get(clientId)!.add(id);
      }

      // Set timeout for queue waiting with progressive timeout
      const timeoutId = setTimeout(() => {
        const index = this.queue.findIndex((t) => t.id === id);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.totalTimedOutTasks++;

          // Clean up client tracking on timeout
          if (clientId) {
            const clientTasks = this.tasksByClient.get(clientId);
            if (clientTasks) {
              clientTasks.delete(id);
              if (clientTasks.size === 0) {
                this.tasksByClient.delete(clientId);
              }
            }
          }

          const waitedMs = Date.now() - task.queuedAt.getTime();
          const runningTasks = Array.from(this.running.values())
            .map((t) => t.name || t.id)
            .slice(0, 3);

          debug.warn('queue', `Task ${name || id} timed out after ${waitedMs}ms`, {
            effectiveTimeout,
            queuePosition: index,
            running: this.running.size,
            queued: this.queue.length,
            runningTasks,
          });

          reject(
            new Error(
              `Task ${name || id} timed out after waiting ${Math.round(waitedMs / 1000)}s in queue. ` +
                `Queue status: ${this.queue.length} waiting, ${this.running.size}/${this.config.maxConcurrentTasks} running. ` +
                `Currently running: ${runningTasks.join(', ') || 'none'}. ` +
                `Suggestion: Try again later or increase queue timeout.`
            )
          );
        }
      }, effectiveTimeout);

      // Store timeout cleanup - wrap resolve/reject to clear timeout
      const originalResolve = task.resolve;
      const originalReject = task.reject;
      task.resolve = ((value: T) => {
        clearTimeout(timeoutId);
        originalResolve(value);
      }) as (value: T) => void;
      task.reject = (error: Error) => {
        clearTimeout(timeoutId);
        originalReject(error);
      };

      this.queue.push(task as QueuedTask<unknown>);
      this.processQueue();
    });
  }

  /**
   * Get age of oldest running task in ms
   */
  private getOldestRunningAge(): number {
    const now = Date.now();
    let oldest = 0;
    for (const task of this.running.values()) {
      if (task.startedAt) {
        const age = now - task.startedAt.getTime();
        if (age > oldest) oldest = age;
      }
    }
    return oldest;
  }

  /**
   * Get queue status with actionable information for clients
   */
  getStatus(): TaskQueueStatus {
    // Clean up stale tasks before reporting status
    this.cleanupStaleTasks();

    const runningTasks = Array.from(this.running.values());
    let oldestRunningTaskAgeMs: number | undefined;

    if (runningTasks.length > 0) {
      const now = Date.now();
      const oldest = runningTasks.reduce((min, t) => {
        const age = t.startedAt ? now - t.startedAt.getTime() : 0;
        return age > min ? age : min;
      }, 0);
      oldestRunningTaskAgeMs = oldest;
    }

    // Calculate estimated wait time for agents using rolling average if available
    let estimatedWaitSeconds: number | undefined;
    const isBusy = this.running.size >= this.config.maxConcurrentTasks;
    if (isBusy) {
      // Use rolling average if we have data, otherwise fall back to conservative estimate
      const avgTaskDurationSeconds = this.getAverageTaskDuration() / 1000 || 30;
      const queueAheadCount = this.queue.length;
      // Estimate based on oldest running task (likely to finish first)
      const oldestAgeSeconds = oldestRunningTaskAgeMs
        ? Math.floor(oldestRunningTaskAgeMs / 1000)
        : 0;
      const remainingForCurrent = Math.max(5, avgTaskDurationSeconds - oldestAgeSeconds);
      estimatedWaitSeconds = Math.round(
        remainingForCurrent + queueAheadCount * avgTaskDurationSeconds
      );
    }

    // Generate actionable message
    let message: string;
    if (this.running.size === 0 && this.queue.length === 0) {
      message = 'Queue idle - ready for tasks';
    } else if (isBusy) {
      message =
        `Queue busy: ${this.running.size}/${this.config.maxConcurrentTasks} slots in use, ${this.queue.length} waiting. ` +
        `Estimated wait: ${estimatedWaitSeconds}s.`;
    } else {
      message = `Queue processing: ${this.running.size}/${this.config.maxConcurrentTasks} slots in use, ${this.queue.length} waiting`;
    }

    return {
      isBusy,
      hasRunningTasks: this.running.size > 0,
      running: this.running.size,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrentTasks,
      queuedTaskIds: this.queue.map((t) => t.name || t.id),
      runningTaskIds: runningTasks.map((t) => t.name || t.id),
      oldestRunningTaskAgeMs,
      estimatedWaitSeconds,
      canSubmitImmediately: this.running.size < this.config.maxConcurrentTasks,
      message,
    };
  }

  /**
   * Get position in queue for a task (0 = running, 1+ = waiting)
   */
  getPosition(taskId: string): number {
    if (this.running.has(taskId)) return 0;
    const index = this.queue.findIndex((t) => t.id === taskId);
    return index === -1 ? -1 : index + 1;
  }

  /**
   * Clean up stale running tasks that have exceeded the timeout
   * This prevents the queue from getting permanently stuck
   */
  private cleanupStaleTasks(): void {
    const now = Date.now();
    const staleIds: string[] = [];
    const staleTasks: { id: string; name?: string; ageMs: number }[] = [];

    for (const [id, task] of this.running.entries()) {
      if (task.startedAt) {
        const age = now - task.startedAt.getTime();
        if (age > this.config.staleTaskTimeoutMs) {
          staleIds.push(id);
          staleTasks.push({ id, name: task.name, ageMs: age });
        }
      }
    }

    for (const id of staleIds) {
      const task = this.running.get(id);
      if (task) {
        const ageSeconds = Math.round((now - (task.startedAt?.getTime() || now)) / 1000);
        debug.warn('queue', `Cleaning up stale task ${task.name || id}`, {
          runningSeconds: ageSeconds,
          staleTimeoutSeconds: Math.round(this.config.staleTaskTimeoutMs / 1000),
        });
        this.running.delete(id);
        this.totalTimedOutTasks++;

        // Reject with actionable error message
        task.reject(
          new Error(
            `Task ${task.name || id} was terminated after running for ${ageSeconds}s ` +
              `(exceeded ${Math.round(this.config.staleTaskTimeoutMs / 1000)}s stale timeout). ` +
              `The task may have hung or the LLM backend may be overloaded. ` +
              `Suggestion: Check LLM backend health and consider breaking the task into smaller subtasks.`
          )
        );
      }
    }

    // Process queue after cleanup in case slots became available
    if (staleIds.length > 0) {
      debug.info('queue', `Cleaned up ${staleIds.length} stale tasks, processing queue`, {
        staleTasks: staleTasks.map((t) => `${t.name || t.id} (${Math.round(t.ageMs / 1000)}s)`),
      });
      this.processQueue();
    }
  }

  /**
   * Record a task duration for rolling average calculation
   */
  private recordTaskDuration(durationMs: number): void {
    this.recentTaskDurations.push(durationMs);
    // Keep only the most recent samples
    if (this.recentTaskDurations.length > this.maxDurationSamples) {
      this.recentTaskDurations.shift();
    }
  }

  /**
   * Get average task duration in milliseconds (for wait time estimates)
   */
  private getAverageTaskDuration(): number {
    if (this.recentTaskDurations.length === 0) {
      return 0; // No data yet, caller should use default
    }
    const sum = this.recentTaskDurations.reduce((a, b) => a + b, 0);
    return sum / this.recentTaskDurations.length;
  }

  /**
   * Get queue statistics for health monitoring
   */
  getStats(): {
    totalCompleted: number;
    totalFailed: number;
    totalTimedOut: number;
    avgDurationMs: number;
    durationSamples: number;
    activeClients: number;
    lastHealthCheck: number;
    successRate: number;
  } {
    const total = this.totalCompletedTasks + this.totalFailedTasks + this.totalTimedOutTasks;
    return {
      totalCompleted: this.totalCompletedTasks,
      totalFailed: this.totalFailedTasks,
      totalTimedOut: this.totalTimedOutTasks,
      avgDurationMs: this.getAverageTaskDuration(),
      durationSamples: this.recentTaskDurations.length,
      activeClients: this.tasksByClient.size,
      lastHealthCheck: this.lastHealthCheck,
      successRate: total > 0 ? this.totalCompletedTasks / total : 1,
    };
  }

  /**
   * Gracefully shutdown the task queue
   * Rejects all pending tasks and clears resources
   */
  shutdown(): void {
    debug.info('queue', 'Shutting down task queue', {
      running: this.running.size,
      queued: this.queue.length,
    });

    // Stop health check timer
    this.stopHealthCheckTimer();

    // Clear pending process timeout
    if (this.pendingProcessTimeout) {
      clearTimeout(this.pendingProcessTimeout);
      this.pendingProcessTimeout = null;
    }

    // Reject all queued tasks
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.reject(new Error('Task queue is shutting down'));
    }

    // Note: Running tasks are allowed to complete naturally
    // They will time out via the stale task mechanism if they hang
  }

  /**
   * Cancel all tasks for a specific client
   * This is useful when a client disconnects unexpectedly
   */
  cancelClient(clientId: string): number {
    let cancelledCount = 0;
    const clientTaskIds = this.tasksByClient.get(clientId);

    if (!clientTaskIds) {
      return 0;
    }

    // Cancel queued tasks for this client
    for (const taskId of Array.from(clientTaskIds)) {
      // Check if in queue
      const queueIndex = this.queue.findIndex((t) => t.id === taskId);
      if (queueIndex !== -1) {
        const task = this.queue.splice(queueIndex, 1)[0];
        task.reject(new Error(`Task cancelled: client ${clientId} disconnected`));
        cancelledCount++;
      }

      // Check if running
      const runningTask = this.running.get(taskId);
      if (runningTask) {
        this.running.delete(taskId);
        runningTask.reject(new Error(`Task cancelled: client ${clientId} disconnected`));
        cancelledCount++;
      }
    }

    // Clear client tracking
    this.tasksByClient.delete(clientId);

    debug.info('queue', `Cancelled ${cancelledCount} tasks for client ${clientId}`);

    // Process queue in case slots freed up
    if (cancelledCount > 0) {
      this.processQueue();
    }

    return cancelledCount;
  }

  /**
   * Process queue - start tasks if slots available (with proper atomic lock)
   */
  private processQueue(): void {
    // Debounce: avoid redundant processing within short intervals
    const now = Date.now();
    if (now - this.lastProcessTime < this.minProcessIntervalMs) {
      // Schedule a delayed processing if not already scheduled
      if (!this.pendingProcessTimeout) {
        this.pendingProcessTimeout = setTimeout(() => {
          this.pendingProcessTimeout = null;
          this.processQueue();
        }, this.minProcessIntervalMs);
      }
      return;
    }
    this.lastProcessTime = now;

    // Clear any pending timeout since we're processing now
    if (this.pendingProcessTimeout) {
      clearTimeout(this.pendingProcessTimeout);
      this.pendingProcessTimeout = null;
    }

    // Synchronous atomic check-and-set - safe in single-threaded JavaScript.
    // If already processing, the current processor will handle new items when it loops.
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    try {
      // Process all available slots in this batch
      while (this.running.size < this.config.maxConcurrentTasks && this.queue.length > 0) {
        const task = this.queue.shift()!;
        this.startTask(task);
      }
    } finally {
      // Release the lock
      this.isProcessing = false;
    }
  }

  /**
   * Start executing a task
   */
  private startTask(task: QueuedTask<unknown>): void {
    task.startedAt = new Date();
    this.running.set(task.id, task);

    // Debug logging for concurrency monitoring
    debug.debug('queue', `Starting task ${task.name || task.id}`, {
      running: this.running.size,
      maxConcurrent: this.config.maxConcurrentTasks,
    });

    // Execute task in a separate promise chain to avoid blocking the queue processor
    this.executeTask(task).catch((error) => {
      // This catch is a safety net - errors should be handled in executeTask
      debug.error('queue', `Unexpected error in task execution: ${task.name || task.id}`, {
        error: String(error),
      });
    });
  }

  /**
   * Execute a task and handle completion
   */
  private async executeTask(task: QueuedTask<unknown>): Promise<void> {
    try {
      const result = await task.execute();
      task.resolve(result);
      this.totalCompletedTasks++;
    } catch (error) {
      task.reject(error instanceof Error ? error : new Error(String(error)));
      this.totalFailedTasks++;
      debug.error('queue', `Task ${task.name || task.id} failed`, {
        error: String(error),
      });
    } finally {
      // Track task duration for better wait time estimates
      task.completedAt = new Date();
      if (task.startedAt) {
        task.durationMs = task.completedAt.getTime() - task.startedAt.getTime();
        this.recordTaskDuration(task.durationMs);
      }

      // Remove from client tracking
      if (task.clientId) {
        const clientTasks = this.tasksByClient.get(task.clientId);
        if (clientTasks) {
          clientTasks.delete(task.id);
          if (clientTasks.size === 0) {
            this.tasksByClient.delete(task.clientId);
          }
        }
      }

      this.running.delete(task.id);

      // Debug logging for task completion
      debug.debug('queue', `Completed task ${task.name || task.id}`, {
        durationMs: task.durationMs || 0,
        remaining: this.running.size,
        queued: this.queue.length,
        avgDurationMs: this.getAverageTaskDuration(),
      });

      // Process next task after a small delay to avoid tight loops
      setImmediate(() => this.processQueue());
    }
  }

  /**
   * Clear all queued (not running) tasks
   */
  clearQueue(): number {
    const count = this.queue.length;
    for (const task of this.queue) {
      task.reject(new Error('Task queue cleared'));
    }
    this.queue = [];
    return count;
  }

  /**
   * Force clear a specific running task (for admin/debugging)
   */
  forceStopRunningTask(taskId: string): boolean {
    const task = this.running.get(taskId);
    if (task) {
      this.running.delete(taskId);
      task.reject(new Error('Task force-stopped by admin'));
      this.processQueue();
      return true;
    }
    return false;
  }

  /**
   * Force clear all running and queued tasks (for admin/debugging)
   */
  forceReset(): { clearedRunning: number; clearedQueued: number } {
    const clearedRunning = this.running.size;
    const clearedQueued = this.queue.length;

    for (const task of this.running.values()) {
      task.reject(new Error('Queue force-reset'));
    }
    this.running.clear();

    for (const task of this.queue) {
      task.reject(new Error('Queue force-reset'));
    }
    this.queue = [];

    return { clearedRunning, clearedQueued };
  }
}

// Singleton instance for agent tasks
let agentTaskQueue: TaskQueue | null = null;

/**
 * Get or create the singleton agent task queue
 */
export function getAgentTaskQueue(config?: Partial<TaskQueueConfig>): TaskQueue {
  if (!agentTaskQueue) {
    agentTaskQueue = new TaskQueue(config);
    debug.info('queue', 'Agent task queue singleton initialized', {
      maxConcurrent: agentTaskQueue.getConfig().maxConcurrentTasks,
      queueTimeoutMs: agentTaskQueue.getConfig().queueTimeoutMs,
    });
  } else if (config) {
    agentTaskQueue.updateConfig(config);
  }
  return agentTaskQueue;
}

/**
 * Reset the singleton (for testing)
 */
export function resetAgentTaskQueue(): void {
  agentTaskQueue = null;
}
