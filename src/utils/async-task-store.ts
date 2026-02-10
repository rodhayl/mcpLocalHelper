/**
 * Async Task Store
 *
 * Manages asynchronous agent_task executions.
 * - Stores task state and results
 * - Tracks progress for each task
 * - Provides polling interface for results
 */

export interface AsyncTaskProgress {
  step: number;
  totalSteps?: number;
  action: string;
  status: 'pending' | 'running' | 'done' | 'error';
  details?: string;
  timestamp: Date;
}

export interface AsyncTask {
  id: string;
  task: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'timeout';
  progress: AsyncTaskProgress[];
  result?: unknown;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  options?: Record<string, unknown>;
  /** Optional client session ID for task isolation */
  clientId?: string;
}

export interface AsyncTaskStoreConfig {
  /** Max tasks to keep in memory (default: 100) */
  maxTasks: number;
  /** TTL for completed tasks in ms (default: 1 hour) */
  completedTaskTtlMs: number;
}

const DEFAULT_CONFIG: AsyncTaskStoreConfig = {
  maxTasks: 100, // Increased from 50 to support more concurrent async tasks (Analysis_2 feedback)
  completedTaskTtlMs: 60 * 60 * 1000, // 1 hour - increased from 30min for better result retrieval (Analysis_2)
};

export class AsyncTaskStore {
  private tasks: Map<string, AsyncTask> = new Map();
  private config: AsyncTaskStoreConfig;
  private taskCounter = 0;

  constructor(config?: Partial<AsyncTaskStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a new async task
   * @param taskDescription - Description of the task
   * @param options - Optional configuration options
   * @param clientId - Optional client session ID for isolation
   */
  createTask(
    taskDescription: string,
    options?: Record<string, unknown>,
    clientId?: string
  ): string {
    this.cleanup();

    const id = `task-${++this.taskCounter}-${Date.now()}`;

    const task: AsyncTask = {
      id,
      task: taskDescription,
      status: 'queued',
      progress: [],
      createdAt: new Date(),
      options,
      clientId,
    };

    this.tasks.set(id, task);
    return id;
  }

  /**
   * Start a task (mark as running)
   */
  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'running';
      task.startedAt = new Date();
    }
  }

  /**
   * Add progress to a task
   */
  addProgress(taskId: string, progress: Omit<AsyncTaskProgress, 'timestamp'>): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.progress.push({
        ...progress,
        timestamp: new Date(),
      });
      // Limit progress entries to prevent unbounded growth
      if (task.progress.length > 100) {
        // Keep first 10 and last 80 progress entries
        task.progress = [...task.progress.slice(0, 10), ...task.progress.slice(-80)];
      }
    }
  }

  /**
   * Complete a task with result.
   * Prevents completing already-completed tasks to avoid race conditions.
   */
  completeTask(taskId: string, result: unknown): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    // Guard against completing already-terminal tasks
    if (task.status === 'complete' || task.status === 'failed' || task.status === 'timeout') {
      return false;
    }
    task.status = 'complete';
    task.result = result;
    task.completedAt = new Date();
    return true;
  }

  /**
   * Fail a task with error.
   * Prevents failing already-completed tasks to avoid race conditions.
   */
  failTask(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    // Guard against failing already-terminal tasks
    if (task.status === 'complete' || task.status === 'failed' || task.status === 'timeout') {
      return false;
    }
    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date();
    return true;
  }

  /**
   * Timeout a task.
   * Prevents timing out already-completed tasks to avoid race conditions.
   */
  timeoutTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    // Guard against timing out already-terminal tasks
    if (task.status === 'complete' || task.status === 'failed' || task.status === 'timeout') {
      return false;
    }
    task.status = 'timeout';
    task.error = 'Task execution timed out';
    task.completedAt = new Date();
    return true;
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): AsyncTask | null {
    this.cleanup();
    return this.tasks.get(taskId) || null;
  }

  /**
   * Get task result (for polling)
   */
  getTaskResult(taskId: string): {
    found: boolean;
    status?: AsyncTask['status'];
    progress?: AsyncTaskProgress[];
    progressCount?: number;
    result?: unknown;
    error?: string;
    createdAt?: string;
    startedAt?: string;
    completedAt?: string;
  } {
    this.cleanup();
    const task = this.tasks.get(taskId);

    if (!task) {
      return { found: false };
    }

    return {
      found: true,
      status: task.status,
      progress: task.progress,
      progressCount: task.progress.length,
      result: task.status === 'complete' ? task.result : undefined,
      error: task.error,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString(),
      completedAt: task.completedAt?.toISOString(),
    };
  }

  /**
   * List all tasks (for debugging)
   */
  listTasks(): Array<{
    id: string;
    task: string;
    status: AsyncTask['status'];
    progressCount: number;
    createdAt: string;
  }> {
    this.cleanup();
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      task: t.task.substring(0, 100),
      status: t.status,
      progressCount: t.progress.length,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  /**
   * Get store stats
   */
  getStats(): {
    total: number;
    queued: number;
    running: number;
    complete: number;
    failed: number;
  } {
    this.cleanup();
    let queued = 0,
      running = 0,
      complete = 0,
      failed = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'queued':
          queued++;
          break;
        case 'running':
          running++;
          break;
        case 'complete':
          complete++;
          break;
        case 'failed':
        case 'timeout':
          failed++;
          break;
      }
    }

    return { total: this.tasks.size, queued, running, complete, failed };
  }

  /**
   * Cleanup old completed/failed tasks and stale queued tasks
   */
  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, task] of this.tasks.entries()) {
      // Remove completed/failed tasks older than TTL
      if (
        (task.status === 'complete' || task.status === 'failed' || task.status === 'timeout') &&
        task.completedAt
      ) {
        if (now - task.completedAt.getTime() > this.config.completedTaskTtlMs) {
          toDelete.push(id);
        }
      }
      // Also cleanup tasks stuck in 'queued' status for too long (likely queue timeout)
      // Give queued tasks 2x the TTL before considering them stale
      if (task.status === 'queued' && !task.startedAt) {
        const queueAge = now - task.createdAt.getTime();
        if (queueAge > this.config.completedTaskTtlMs * 2) {
          task.status = 'timeout';
          task.error = 'Task never started (queue timeout or rejection)';
          task.completedAt = new Date();
        }
      }
      // Also cleanup tasks stuck in 'running' status for too long (likely a crash)
      if (task.status === 'running' && task.startedAt) {
        const runAge = now - task.startedAt.getTime();
        // Consider a task stale if it's been running for more than 30 minutes
        if (runAge > 30 * 60 * 1000) {
          task.status = 'timeout';
          task.error = 'Task timed out (ran too long without completion)';
          task.completedAt = new Date();
        }
      }
    }

    for (const id of toDelete) {
      this.tasks.delete(id);
    }

    // If still over max, remove oldest completed tasks
    if (this.tasks.size > this.config.maxTasks) {
      const sorted = Array.from(this.tasks.entries())
        .filter(
          ([, t]) => t.status === 'complete' || t.status === 'failed' || t.status === 'timeout'
        )
        .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());

      const toRemove = this.tasks.size - this.config.maxTasks;
      for (let i = 0; i < Math.min(toRemove, sorted.length); i++) {
        this.tasks.delete(sorted[i][0]);
      }
    }
  }

  /**
   * Clear all tasks (for testing)
   */
  clear(): void {
    this.tasks.clear();
    this.taskCounter = 0;
  }
}

// Singleton instance
let asyncTaskStoreInstance: AsyncTaskStore | null = null;

/**
 * Get or create the singleton async task store
 */
export function getAsyncTaskStore(config?: Partial<AsyncTaskStoreConfig>): AsyncTaskStore {
  if (!asyncTaskStoreInstance) {
    asyncTaskStoreInstance = new AsyncTaskStore(config);
  }
  return asyncTaskStoreInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetAsyncTaskStore(): void {
  asyncTaskStoreInstance = null;
}
