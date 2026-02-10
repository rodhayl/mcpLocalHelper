/**
 * MCP Local LLM - Typed Error Classes
 *
 * Provides structured error types for consistent error handling across the codebase.
 * Each error type includes:
 * - Unique error code for programmatic handling
 * - HTTP status code for API responses
 * - Retryable flag for automatic retry logic
 * - Context for debugging
 *
 * @example
 * ```typescript
 * try {
 *   await doSomething();
 * } catch (error) {
 *   if (error instanceof RateLimitError) {
 *     await sleep(error.retryAfterMs);
 *     return retry();
 *   }
 *   throw error;
 * }
 * ```
 */

/**
 * Base error class for all MCP Local LLM errors.
 * Provides consistent structure for error handling.
 */
export abstract class McpError extends Error {
  /** Unique error code for programmatic handling */
  abstract readonly code: string;
  /** HTTP status code for API responses */
  abstract readonly statusCode: number;
  /** Whether the operation can be retried */
  abstract readonly retryable: boolean;
  /** Additional context for debugging */
  readonly context?: Record<string, unknown>;
  /** Timestamp when error occurred */
  readonly timestamp: Date;
  /** Original error if this wraps another error */
  readonly cause?: Error;

  constructor(message: string, options?: { cause?: Error; context?: Record<string, unknown> }) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date();
    this.cause = options?.cause;
    this.context = options?.context;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to a structured JSON response.
   */
  toJSON(): Record<string, unknown> {
    return {
      error: true,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      timestamp: this.timestamp.toISOString(),
      context: this.context,
      ...(this.cause && { cause: this.cause.message }),
    };
  }

  /**
   * Create a user-friendly error message.
   */
  toUserMessage(): string {
    return `${this.message} (code: ${this.code})`;
  }
}

/**
 * Rate limit exceeded error.
 * Thrown when a client exceeds their request quota.
 */
export class RateLimitError extends McpError {
  readonly code = 'RATE_LIMIT_EXCEEDED';
  readonly statusCode = 429;
  readonly retryable = true;
  /** Suggested wait time before retry in ms */
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number = 1000, context?: Record<string, unknown>) {
    super(message, { context });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Request timeout error.
 * Thrown when an operation takes too long to complete.
 */
export class TimeoutError extends McpError {
  readonly code = 'TIMEOUT';
  readonly statusCode = 504;
  readonly retryable = true;
  /** Duration before timeout in ms */
  readonly timeoutMs: number;
  /** Actual duration before timeout in ms */
  readonly actualDurationMs?: number;

  constructor(
    message: string,
    timeoutMs: number,
    options?: { actualDurationMs?: number; context?: Record<string, unknown> }
  ) {
    super(message, { context: options?.context });
    this.timeoutMs = timeoutMs;
    this.actualDurationMs = options?.actualDurationMs;
  }
}

/**
 * Backend unavailable error.
 * Thrown when the LLM backend cannot be reached.
 */
export class BackendUnavailableError extends McpError {
  readonly code = 'BACKEND_UNAVAILABLE';
  readonly statusCode = 503;
  readonly retryable = true;
  /** The backend that is unavailable */
  readonly backendId: string;

  constructor(message: string, backendId: string, context?: Record<string, unknown>) {
    super(message, { context });
    this.backendId = backendId;
  }
}

/**
 * Backend configuration error.
 * Thrown when backend configuration is invalid.
 */
export class BackendConfigError extends McpError {
  readonly code = 'BACKEND_CONFIG_ERROR';
  readonly statusCode = 500;
  readonly retryable = false;
  /** The backend with configuration issues */
  readonly backendId: string;

  constructor(message: string, backendId: string, context?: Record<string, unknown>) {
    super(message, { context });
    this.backendId = backendId;
  }
}

/**
 * Validation error.
 * Thrown when input validation fails.
 */
export class ValidationError extends McpError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  readonly retryable = false;
  /** Fields that failed validation */
  readonly fields?: Record<string, string>;

  constructor(
    message: string,
    options?: { fields?: Record<string, string>; context?: Record<string, unknown> }
  ) {
    super(message, { context: options?.context });
    this.fields = options?.fields;
  }
}

/**
 * Path access denied error.
 * Thrown when attempting to access a path outside the allowlist.
 */
export class PathAccessDeniedError extends McpError {
  readonly code = 'PATH_ACCESS_DENIED';
  readonly statusCode = 403;
  readonly retryable = false;
  /** The path that was denied */
  readonly deniedPath: string;
  /** Allowed paths (if safe to expose) */
  readonly allowedPaths?: string[];

  constructor(
    message: string,
    deniedPath: string,
    options?: { allowedPaths?: string[]; context?: Record<string, unknown> }
  ) {
    super(message, { context: options?.context });
    this.deniedPath = deniedPath;
    this.allowedPaths = options?.allowedPaths;
  }
}

/**
 * File not found error.
 * Thrown when a requested file does not exist.
 */
export class FileNotFoundError extends McpError {
  readonly code = 'FILE_NOT_FOUND';
  readonly statusCode = 404;
  readonly retryable = false;
  /** The path that was not found */
  readonly filePath: string;

  constructor(message: string, filePath: string, context?: Record<string, unknown>) {
    super(message, { context });
    this.filePath = filePath;
  }
}

/**
 * Tool not found error.
 * Thrown when a requested tool does not exist.
 */
export class ToolNotFoundError extends McpError {
  readonly code = 'TOOL_NOT_FOUND';
  readonly statusCode = 404;
  readonly retryable = false;
  /** The tool that was not found */
  readonly toolName: string;
  /** Similar tool names for suggestions */
  readonly suggestions?: string[];

  constructor(
    message: string,
    toolName: string,
    options?: { suggestions?: string[]; context?: Record<string, unknown> }
  ) {
    super(message, { context: options?.context });
    this.toolName = toolName;
    this.suggestions = options?.suggestions;
  }
}

/**
 * Tool hidden error.
 * Thrown when a tool exists but is not exposed in the current context.
 */
export class ToolHiddenError extends McpError {
  readonly code = 'TOOL_HIDDEN';
  readonly statusCode = 403;
  readonly retryable = false;
  /** The tool that is hidden */
  readonly toolName: string;
  /** How to access the hidden tool */
  readonly accessHint?: string;

  constructor(
    message: string,
    toolName: string,
    options?: { accessHint?: string; context?: Record<string, unknown> }
  ) {
    super(message, { context: options?.context });
    this.toolName = toolName;
    this.accessHint = options?.accessHint;
  }
}

/**
 * Queue full error.
 * Thrown when the task queue is at capacity.
 */
export class QueueFullError extends McpError {
  readonly code = 'QUEUE_FULL';
  readonly statusCode = 503;
  readonly retryable = true;
  /** Current queue size */
  readonly queueSize: number;
  /** Maximum queue size */
  readonly maxQueueSize: number;
  /** Estimated wait time in ms */
  readonly estimatedWaitMs?: number;

  constructor(
    message: string,
    queueSize: number,
    maxQueueSize: number,
    options?: { estimatedWaitMs?: number; context?: Record<string, unknown> }
  ) {
    super(message, { context: options?.context });
    this.queueSize = queueSize;
    this.maxQueueSize = maxQueueSize;
    this.estimatedWaitMs = options?.estimatedWaitMs;
  }
}

/**
 * Agent task error.
 * Thrown when an agent task fails during execution.
 */
export class AgentTaskError extends McpError {
  readonly code = 'AGENT_TASK_ERROR';
  readonly statusCode = 500;
  readonly retryable = false;
  /** The task ID that failed */
  readonly taskId?: string;
  /** The step that failed */
  readonly failedStep?: string;
  /** Partial results before failure */
  readonly partialResults?: unknown;

  constructor(
    message: string,
    options?: {
      taskId?: string;
      failedStep?: string;
      partialResults?: unknown;
      cause?: Error;
      context?: Record<string, unknown>;
    }
  ) {
    super(message, { cause: options?.cause, context: options?.context });
    this.taskId = options?.taskId;
    this.failedStep = options?.failedStep;
    this.partialResults = options?.partialResults;
  }
}

/**
 * LLM response error.
 * Thrown when the LLM returns an unexpected or invalid response.
 */
export class LlmResponseError extends McpError {
  readonly code = 'LLM_RESPONSE_ERROR';
  readonly statusCode = 502;
  readonly retryable = true;
  /** The problematic response (truncated for safety) */
  readonly responsePreview?: string;

  constructor(
    message: string,
    options?: { responsePreview?: string; cause?: Error; context?: Record<string, unknown> }
  ) {
    super(message, { cause: options?.cause, context: options?.context });
    this.responsePreview = options?.responsePreview
      ? options.responsePreview.substring(0, 200)
      : undefined;
  }
}

/**
 * MCP protocol error.
 * Thrown when there's an issue with MCP protocol communication.
 */
export class McpProtocolError extends McpError {
  readonly code = 'MCP_PROTOCOL_ERROR';
  readonly statusCode = 500;
  readonly retryable = false;
  /** The MCP server that caused the error */
  readonly serverName?: string;
  /** The operation that failed */
  readonly operation?: string;

  constructor(
    message: string,
    options?: {
      serverName?: string;
      operation?: string;
      cause?: Error;
      context?: Record<string, unknown>;
    }
  ) {
    super(message, { cause: options?.cause, context: options?.context });
    this.serverName = options?.serverName;
    this.operation = options?.operation;
  }
}

/**
 * Abort error.
 * Thrown when an operation is cancelled by the user or system.
 */
export class AbortError extends McpError {
  readonly code = 'ABORTED';
  readonly statusCode = 499; // Client Closed Request
  readonly retryable = false;
  /** The reason for abortion */
  readonly reason?: string;

  constructor(message: string, options?: { reason?: string; context?: Record<string, unknown> }) {
    super(message, { context: options?.context });
    this.reason = options?.reason;
  }
}

/**
 * Internal error.
 * Thrown for unexpected internal errors.
 */
export class InternalError extends McpError {
  readonly code = 'INTERNAL_ERROR';
  readonly statusCode = 500;
  readonly retryable = false;

  constructor(message: string, options?: { cause?: Error; context?: Record<string, unknown> }) {
    super(message, options);
  }
}

/**
 * Type guard to check if an error is an McpError.
 */
export function isMcpError(error: unknown): error is McpError {
  return error instanceof McpError;
}

/**
 * Wrap any error as an McpError.
 * Preserves McpErrors, wraps others as InternalError.
 */
export function wrapError(error: unknown, context?: Record<string, unknown>): McpError {
  if (isMcpError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message, { cause: error, context });
  }

  return new InternalError(String(error), { context });
}

/**
 * Create a consistent error response for MCP tool calls.
 */
export function createToolErrorResponse(error: unknown): {
  content: Array<{ type: string; text: string }>;
  isError: true;
} {
  const mcpError = wrapError(error);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(mcpError.toJSON(), null, 2),
      },
    ],
    isError: true,
  };
}
