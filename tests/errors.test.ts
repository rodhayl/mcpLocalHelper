/**
 * Error Types Tests
 */
import { describe, it, expect } from 'vitest';
import {
  McpError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  PathAccessDeniedError,
  FileNotFoundError,
  ToolNotFoundError,
  ToolHiddenError,
  QueueFullError,
  AgentTaskError,
  BackendUnavailableError,
  LlmResponseError,
  AbortError,
  InternalError,
  isMcpError,
  wrapError,
  createToolErrorResponse,
} from '../src/utils/errors.js';

describe('Error Types', () => {
  describe('RateLimitError', () => {
    it('should have correct properties', () => {
      const error = new RateLimitError('Too many requests', 5000, { clientId: 'test' });

      expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.statusCode).toBe(429);
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBe(5000);
      expect(error.message).toBe('Too many requests');
      expect(error.context).toEqual({ clientId: 'test' });
      expect(error.name).toBe('RateLimitError');
    });

    it('should serialize to JSON', () => {
      const error = new RateLimitError('Rate limited', 1000);
      const json = error.toJSON();

      expect(json.error).toBe(true);
      expect(json.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(json.statusCode).toBe(429);
      expect(json.retryable).toBe(true);
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('TimeoutError', () => {
    it('should include timeout details', () => {
      const error = new TimeoutError('Request timed out', 30000, {
        actualDurationMs: 30500,
      });

      expect(error.code).toBe('TIMEOUT');
      expect(error.statusCode).toBe(504);
      expect(error.retryable).toBe(true);
      expect(error.timeoutMs).toBe(30000);
      expect(error.actualDurationMs).toBe(30500);
    });
  });

  describe('ValidationError', () => {
    it('should include field errors', () => {
      const error = new ValidationError('Invalid input', {
        fields: {
          path: 'Path is required',
          maxBytes: 'Must be a positive number',
        },
      });

      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.retryable).toBe(false);
      expect(error.fields).toEqual({
        path: 'Path is required',
        maxBytes: 'Must be a positive number',
      });
    });
  });

  describe('PathAccessDeniedError', () => {
    it('should include path details', () => {
      const error = new PathAccessDeniedError('Access denied', '/etc/passwd', {
        allowedPaths: ['/workspace', '/tmp'],
      });

      expect(error.code).toBe('PATH_ACCESS_DENIED');
      expect(error.statusCode).toBe(403);
      expect(error.deniedPath).toBe('/etc/passwd');
      expect(error.allowedPaths).toEqual(['/workspace', '/tmp']);
    });
  });

  describe('FileNotFoundError', () => {
    it('should include file path', () => {
      const error = new FileNotFoundError('File not found', '/path/to/file.ts');

      expect(error.code).toBe('FILE_NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.filePath).toBe('/path/to/file.ts');
    });
  });

  describe('ToolNotFoundError', () => {
    it('should include suggestions', () => {
      const error = new ToolNotFoundError('Tool not found', 'search_code', {
        suggestions: ['search', 'intelligent_search', 'codebase_qa'],
      });

      expect(error.code).toBe('TOOL_NOT_FOUND');
      expect(error.toolName).toBe('search_code');
      expect(error.suggestions).toEqual(['search', 'intelligent_search', 'codebase_qa']);
    });
  });

  describe('ToolHiddenError', () => {
    it('should include access hint', () => {
      const error = new ToolHiddenError('Tool is hidden', 'system_profile', {
        accessHint: 'Use discover_tools with category="system" to access',
      });

      expect(error.code).toBe('TOOL_HIDDEN');
      expect(error.statusCode).toBe(403);
      expect(error.toolName).toBe('system_profile');
      expect(error.accessHint).toContain('discover_tools');
    });
  });

  describe('QueueFullError', () => {
    it('should include queue status', () => {
      const error = new QueueFullError('Queue at capacity', 10, 10, {
        estimatedWaitMs: 30000,
      });

      expect(error.code).toBe('QUEUE_FULL');
      expect(error.statusCode).toBe(503);
      expect(error.retryable).toBe(true);
      expect(error.queueSize).toBe(10);
      expect(error.maxQueueSize).toBe(10);
      expect(error.estimatedWaitMs).toBe(30000);
    });
  });

  describe('AgentTaskError', () => {
    it('should include task details', () => {
      const cause = new Error('JSON parse failed');
      const error = new AgentTaskError('Agent task failed', {
        taskId: 'task-123',
        failedStep: 'planning',
        partialResults: { completed: 2, total: 5 },
        cause,
      });

      expect(error.code).toBe('AGENT_TASK_ERROR');
      expect(error.taskId).toBe('task-123');
      expect(error.failedStep).toBe('planning');
      expect(error.partialResults).toEqual({ completed: 2, total: 5 });
      expect(error.cause).toBe(cause);
    });
  });

  describe('BackendUnavailableError', () => {
    it('should include backend ID', () => {
      const error = new BackendUnavailableError('LM Studio not running', 'lmstudio');

      expect(error.code).toBe('BACKEND_UNAVAILABLE');
      expect(error.statusCode).toBe(503);
      expect(error.retryable).toBe(true);
      expect(error.backendId).toBe('lmstudio');
    });
  });

  describe('LlmResponseError', () => {
    it('should truncate response preview', () => {
      const longResponse = 'x'.repeat(500);
      const error = new LlmResponseError('Invalid LLM response', {
        responsePreview: longResponse,
      });

      expect(error.responsePreview?.length).toBeLessThanOrEqual(200);
    });
  });

  describe('AbortError', () => {
    it('should include abort reason', () => {
      const error = new AbortError('Operation cancelled', {
        reason: 'User requested cancellation',
      });

      expect(error.code).toBe('ABORTED');
      expect(error.statusCode).toBe(499);
      expect(error.retryable).toBe(false);
      expect(error.reason).toBe('User requested cancellation');
    });
  });

  describe('InternalError', () => {
    it('should wrap cause', () => {
      const cause = new Error('Unexpected null');
      const error = new InternalError('Internal error occurred', { cause });

      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.cause).toBe(cause);
    });
  });
});

describe('isMcpError', () => {
  it('should return true for McpError instances', () => {
    expect(isMcpError(new RateLimitError('test', 1000))).toBe(true);
    expect(isMcpError(new ValidationError('test'))).toBe(true);
    expect(isMcpError(new InternalError('test'))).toBe(true);
  });

  it('should return false for non-McpError', () => {
    expect(isMcpError(new Error('test'))).toBe(false);
    expect(isMcpError('error string')).toBe(false);
    expect(isMcpError(null)).toBe(false);
    expect(isMcpError(undefined)).toBe(false);
  });
});

describe('wrapError', () => {
  it('should preserve McpError', () => {
    const original = new RateLimitError('test', 1000);
    const wrapped = wrapError(original);

    expect(wrapped).toBe(original);
  });

  it('should wrap regular Error', () => {
    const original = new Error('Something went wrong');
    const wrapped = wrapError(original);

    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.message).toBe('Something went wrong');
    expect(wrapped.cause).toBe(original);
  });

  it('should wrap non-Error values', () => {
    const wrapped = wrapError('string error');

    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.message).toBe('string error');
  });

  it('should include context', () => {
    const wrapped = wrapError(new Error('test'), { operation: 'readFile' });

    expect(wrapped.context).toEqual({ operation: 'readFile' });
  });
});

describe('createToolErrorResponse', () => {
  it('should create MCP-compatible error response', () => {
    const error = new ValidationError('Invalid path');
    const response = createToolErrorResponse(error);

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('VALIDATION_ERROR');
  });

  it('should wrap non-McpError', () => {
    const response = createToolErrorResponse(new Error('generic error'));

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.code).toBe('INTERNAL_ERROR');
  });
});
