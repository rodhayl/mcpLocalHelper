/**
 * Agent Progress Streaming
 *
 * Provides real-time progress updates for agent tasks via Server-Sent Events (SSE).
 * Features:
 * - SSE endpoint for streaming task progress
 * - Event broadcasting to multiple clients
 * - Task-specific subscriptions
 * - Automatic cleanup on disconnect
 */

import { EventEmitter } from 'events';
import type { Response } from 'express';

export interface ProgressEvent {
  taskId: string;
  type: 'started' | 'step' | 'tool_call' | 'tool_result' | 'completed' | 'error';
  timestamp: Date;
  data: {
    stepNumber?: number;
    totalSteps?: number;
    description?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    status?: 'running' | 'completed' | 'failed';
    durationMs?: number;
  };
}

export interface ProgressSubscriber {
  id: string;
  taskId: string | null; // null = subscribe to all tasks
  response: Response;
  subscribedAt: Date;
}

/**
 * ProgressBroadcaster - Manages SSE connections and broadcasts progress events
 */
export class ProgressBroadcaster extends EventEmitter {
  private subscribers: Map<string, ProgressSubscriber> = new Map();
  private eventHistory: Map<string, ProgressEvent[]> = new Map();
  private maxHistoryPerTask = 100;
  private subscriberCounter = 0;

  /**
   * Subscribe a client to progress events
   */
  subscribe(res: Response, taskId: string | null = null): string {
    const id = `sub_${++this.subscriberCounter}_${Date.now()}`;

    const subscriber: ProgressSubscriber = {
      id,
      taskId,
      response: res,
      subscribedAt: new Date(),
    };

    this.subscribers.set(id, subscriber);

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connection event
    this.sendToSubscriber(subscriber, {
      taskId: taskId || '*',
      type: 'started',
      timestamp: new Date(),
      data: {
        description: `Subscribed to ${taskId ? `task ${taskId}` : 'all tasks'}`,
        status: 'running',
      },
    });

    // Send any recent history for this task
    if (taskId) {
      const history = this.eventHistory.get(taskId);
      if (history) {
        for (const event of history.slice(-10)) {
          // Last 10 events
          this.sendToSubscriber(subscriber, event);
        }
      }
    }

    // Handle client disconnect
    res.on('close', () => {
      this.subscribers.delete(id);
      this.emit('subscriber:disconnected', { id, taskId });
    });

    this.emit('subscriber:connected', { id, taskId });
    return id;
  }

  /**
   * Unsubscribe a client
   */
  unsubscribe(id: string): boolean {
    const subscriber = this.subscribers.get(id);
    if (subscriber) {
      try {
        subscriber.response.end();
      } catch {
        // Response may already be closed
      }
      this.subscribers.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Broadcast a progress event to relevant subscribers
   */
  broadcast(event: ProgressEvent): void {
    // Store in history
    let history = this.eventHistory.get(event.taskId);
    if (!history) {
      history = [];
      this.eventHistory.set(event.taskId, history);
    }
    history.push(event);
    if (history.length > this.maxHistoryPerTask) {
      history.shift();
    }

    // Broadcast to subscribers
    for (const subscriber of this.subscribers.values()) {
      // Send if subscriber is watching all tasks or this specific task
      if (subscriber.taskId === null || subscriber.taskId === event.taskId) {
        this.sendToSubscriber(subscriber, event);
      }
    }

    // Clean up history for completed/failed tasks after a delay
    if (event.type === 'completed' || event.type === 'error') {
      setTimeout(() => {
        this.eventHistory.delete(event.taskId);
      }, 60000); // Keep history for 1 minute after completion
    }
  }

  /**
   * Send event to a specific subscriber
   */
  private sendToSubscriber(subscriber: ProgressSubscriber, event: ProgressEvent): void {
    try {
      const data = JSON.stringify({
        ...event,
        timestamp: event.timestamp.toISOString(),
      });
      subscriber.response.write(`event: progress\n`);
      subscriber.response.write(`data: ${data}\n\n`);
    } catch {
      // Client likely disconnected, remove subscriber
      this.subscribers.delete(subscriber.id);
    }
  }

  /**
   * Get current subscriber count
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Get subscribers for a specific task
   */
  getTaskSubscribers(taskId: string): number {
    let count = 0;
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.taskId === null || subscriber.taskId === taskId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all active subscriptions
   */
  getSubscriptions(): Array<{ id: string; taskId: string | null; subscribedAt: Date }> {
    return Array.from(this.subscribers.values()).map((s) => ({
      id: s.id,
      taskId: s.taskId,
      subscribedAt: s.subscribedAt,
    }));
  }

  /**
   * Clean up all subscriptions
   */
  shutdown(): void {
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.response.end();
      } catch {
        // Ignore
      }
    }
    this.subscribers.clear();
    this.eventHistory.clear();
  }
}

// Singleton instance
let globalBroadcaster: ProgressBroadcaster | null = null;

/**
 * Get or create the global progress broadcaster
 */
export function getProgressBroadcaster(): ProgressBroadcaster {
  if (!globalBroadcaster) {
    globalBroadcaster = new ProgressBroadcaster();
  }
  return globalBroadcaster;
}

/**
 * Emit a progress event for an agent task (convenience function)
 */
export function emitProgress(
  taskId: string,
  type: ProgressEvent['type'],
  data: ProgressEvent['data']
): void {
  const broadcaster = getProgressBroadcaster();
  broadcaster.broadcast({
    taskId,
    type,
    timestamp: new Date(),
    data,
  });
}

/**
 * Create progress callback for AgentRunner
 * This adapter converts AgentRunner's onProgress callback to SSE events
 */
export function createProgressCallback(
  taskId: string
): (info: { step: number; action: string; details?: Record<string, unknown> }) => void {
  return (info) => {
    emitProgress(taskId, 'step', {
      stepNumber: info.step,
      description: info.action,
      ...info.details,
    });
  };
}
