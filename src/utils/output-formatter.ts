/**
 * Output Formatter - Plan 2: Output Density Controls
 *
 * Transforms tool outputs between dense, detailed, and JSON formats.
 * Dense format strips metadata and keeps only essential fields.
 */

import { randomUUID } from 'crypto';
import type { OutputFormat, DenseOutput } from '../types/index.js';

/**
 * Execution metadata for traceability (Plan 4)
 */
export interface ExecutionMetadata {
  executionId: string;
  timestamp: string;
  durationMs?: number;
  toolName?: string;
}

/**
 * Generate execution metadata for tool responses
 */
export function generateExecutionMetadata(
  toolName?: string,
  startTime?: number
): ExecutionMetadata {
  return {
    executionId: randomUUID(),
    timestamp: new Date().toISOString(),
    durationMs: startTime ? Date.now() - startTime : undefined,
    toolName,
  };
}

/**
 * Add execution metadata to a result object
 */
export function withExecutionMetadata<T extends object>(
  result: T,
  metadata: ExecutionMetadata
): T & { _meta: ExecutionMetadata } {
  return {
    ...result,
    _meta: metadata,
  };
}

/**
 * Transform output to dense format
 * Strips metadata and keeps only essential code/path/action fields
 *
 * Black-box V4: Special handling for AnalyzeFileResult to prioritize
 * analysis/summary over raw content (prevents "dumping file content" UX issue)
 */
export function toDenseOutput(output: unknown): DenseOutput {
  if (output === null || output === undefined) {
    return { message: 'No output' };
  }

  if (typeof output !== 'object') {
    return { message: String(output) };
  }

  const result: DenseOutput = {};
  const obj = output as Record<string, unknown>;

  // Black-box V4: Detect AnalyzeFileResult shape and prioritize analysis
  // This prevents dense output from showing full file content as primary field
  const isAnalyzeFileResult =
    typeof obj.analysis === 'string' &&
    typeof obj.path === 'string' &&
    typeof obj.language === 'string';

  if (isAnalyzeFileResult) {
    // For analyze_file, prioritize analysis and structured data over raw content
    result.path = obj.path as string;
    result.message = obj.analysis as string;

    // Include issues summary if present
    if (Array.isArray(obj.issues) && obj.issues.length > 0) {
      result.results = obj.issues.slice(0, 10).map((issue: unknown) => {
        if (typeof issue !== 'object' || issue === null) return { content: String(issue) };
        const i = issue as Record<string, unknown>;
        return {
          line: typeof i.line === 'number' ? i.line : undefined,
          content:
            typeof i.message === 'string' ? `[${i.severity || 'info'}] ${i.message}` : undefined,
        };
      });
    }

    // Include top suggestions in a compact form
    if (Array.isArray(obj.suggestions) && obj.suggestions.length > 0) {
      const suggestionStr = (obj.suggestions as string[]).slice(0, 3).join('; ');
      result.message = result.message + ' | Suggestions: ' + suggestionStr;
    }

    // Deliberately omit raw content - user asked for analysis, not file dump
    return result;
  }

  // Extract core fields (non-AnalyzeFileResult path)
  if (typeof obj.path === 'string') result.path = obj.path;
  if (typeof obj.file === 'string') result.path = obj.file;
  if (obj.lineRange && typeof obj.lineRange === 'object') {
    const lr = obj.lineRange as { start?: number; end?: number };
    if (typeof lr.start === 'number' && typeof lr.end === 'number') {
      result.lineRange = { start: lr.start, end: lr.end };
    }
  }
  if (typeof obj.code === 'string') result.code = obj.code;
  if (typeof obj.content === 'string') result.code = obj.content;
  if (typeof obj.action === 'string') result.action = obj.action;
  if (typeof obj.message === 'string') result.message = obj.message;
  if (typeof obj.error === 'string') result.message = obj.error;
  if (typeof obj.summary === 'string') result.message = obj.summary;
  // Ensure health/status outputs stay useful in dense mode
  if (result.message === undefined && typeof obj.status === 'string') {
    result.message = obj.status;
  }
  if (result.message === undefined && typeof obj.healthy === 'boolean') {
    result.message = obj.healthy ? 'healthy' : 'unhealthy';
  }
  // Search tools often expose their summary under searchSummary
  if (result.message === undefined && typeof obj.searchSummary === 'string') {
    result.message = obj.searchSummary;
  }

  // Preserve notices in dense mode (e.g., root was defaulted)
  if (typeof obj.notice === 'string') {
    if (typeof result.message === 'string' && result.message.length > 0) {
      if (!result.message.includes(obj.notice)) {
        result.message = `${result.message} | ${obj.notice}`;
      }
    } else {
      result.message = obj.notice;
    }
  }

  // Handle arrays of results
  if (Array.isArray(obj.results)) {
    result.results = obj.results.map((item) => {
      if (typeof item !== 'object' || item === null) return { content: String(item) };
      const i = item as Record<string, unknown>;
      return {
        path: typeof i.path === 'string' ? i.path : typeof i.file === 'string' ? i.file : undefined,
        line: typeof i.line === 'number' ? i.line : undefined,
        content:
          typeof i.content === 'string'
            ? i.content
            : typeof i.preview === 'string'
              ? i.preview
              : undefined,
      };
    });
  }

  // Handle matches array (grep results)
  if (Array.isArray(obj.matches)) {
    result.results = obj.matches.map((item) => {
      if (typeof item !== 'object' || item === null) return { content: String(item) };
      const i = item as Record<string, unknown>;
      return {
        path: typeof i.file === 'string' ? i.file : typeof i.path === 'string' ? i.path : undefined,
        line: typeof i.line === 'number' ? i.line : undefined,
        content:
          typeof i.preview === 'string'
            ? i.preview
            : Array.isArray(i.preview)
              ? i.preview.join('\n')
              : typeof i.type === 'string'
                ? i.type
                : undefined,
      };
    });
  }

  // Handle suggestions array
  if (Array.isArray(obj.suggestions)) {
    result.results = obj.suggestions.map((item) => {
      if (typeof item !== 'object' || item === null) return { content: String(item) };
      const i = item as Record<string, unknown>;
      return {
        path: typeof i.file === 'string' ? i.file : undefined,
        line: typeof i.line === 'number' ? i.line : undefined,
        content:
          typeof i.description === 'string'
            ? i.description
            : typeof i.after === 'string'
              ? i.after
              : undefined,
      };
    });
  }

  // Handle findings array (security)
  if (Array.isArray(obj.findings)) {
    result.results = obj.findings.map((item) => {
      if (typeof item !== 'object' || item === null) return { content: String(item) };
      const i = item as Record<string, unknown>;
      return {
        path: typeof i.file === 'string' ? i.file : undefined,
        line: typeof i.line === 'number' ? i.line : undefined,
        content: typeof i.type === 'string' ? `[${i.type}] ${i.redacted || ''}` : undefined,
      };
    });
  }

  return result;
}

/**
 * Transform output to compact format
 * Keeps only a short summary + unique paths (no previews/content).
 * Intended for small local models to reduce token usage.
 */
export function toCompactOutput(output: unknown): {
  message?: string;
  paths?: string[];
  totalPaths?: number;
  truncated?: boolean;
} {
  if (output === null || output === undefined) {
    return { message: 'No output', paths: [], totalPaths: 0, truncated: false };
  }

  if (typeof output !== 'object') {
    return { message: String(output), paths: [], totalPaths: 0, truncated: false };
  }

  const obj = output as Record<string, unknown>;
  const paths: string[] = [];
  const pushPath = (p: unknown) => {
    if (typeof p !== 'string') return;
    const normalized = p.replace(/\\/g, '/');
    paths.push(normalized);
  };

  // Top-level obvious fields
  pushPath(obj.path);
  pushPath(obj.file);

  const collectFromArray = (value: unknown, pathKeys: string[]) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      for (const k of pathKeys) {
        if (rec[k] !== undefined) {
          pushPath(rec[k]);
          break;
        }
      }
    }
  };

  // Common array-shaped outputs across tools
  collectFromArray(obj.results, ['path', 'file', 'relativePath']);
  collectFromArray(obj.matches, ['file', 'path', 'relativePath']);
  collectFromArray(obj.findings, ['file', 'path', 'relativePath']);
  collectFromArray(obj.files, ['path', 'file', 'relativePath']);
  collectFromArray(obj.suggestions, ['file', 'path', 'relativePath']);

  // Deduplicate and cap
  const unique = Array.from(new Set(paths)).filter(Boolean);
  const limit = 50;
  const truncated = unique.length > limit || obj.truncated === true;

  let message =
    typeof obj.searchSummary === 'string'
      ? obj.searchSummary
      : typeof obj.summary === 'string'
        ? obj.summary
        : typeof obj.analysis === 'string'
          ? obj.analysis
          : typeof obj.message === 'string'
            ? obj.message
            : typeof obj.status === 'string'
              ? obj.status
              : typeof obj.healthy === 'boolean'
                ? obj.healthy
                  ? 'healthy'
                  : 'unhealthy'
                : undefined;

  // Preserve notices in compact mode (e.g., root was defaulted)
  if (typeof obj.notice === 'string') {
    if (typeof message === 'string' && message.length > 0) {
      if (!message.includes(obj.notice)) {
        message = `${message} | ${obj.notice}`;
      }
    } else {
      message = obj.notice;
    }
  }

  return {
    ...(message ? { message } : {}),
    paths: unique.slice(0, limit),
    totalPaths: unique.length,
    truncated,
  };
}

/**

 * Transform output based on format setting
 */
export function formatOutput(output: unknown, format: OutputFormat = 'detailed'): unknown {
  switch (format) {
    case 'compact':
      return toCompactOutput(output);
    case 'dense':
      return toDenseOutput(output);
    case 'json':
      // JSON format returns JSON string
      return JSON.stringify(output, null, 2);
    case 'detailed':
    default:
      // Detailed format returns the original object unchanged
      return output;
  }
}

/**
 * Extract signatures/interfaces from code for dense summarization
 * Used by summarize tool in dense mode
 */
export function extractCodeSignatures(code: string, language: string): string {
  const lines = code.split('\n');
  const signatures: string[] = [];

  // TypeScript/JavaScript patterns
  if (['typescript', 'javascript'].includes(language)) {
    for (const line of lines) {
      const trimmed = line.trim();
      // Export statements
      if (/^export\s+(interface|type|class|function|const|enum)\s+\w+/.test(trimmed)) {
        signatures.push(trimmed.replace(/\s*{.*$/, ' { ... }'));
      }
      // Interface/type definitions
      else if (/^(interface|type)\s+\w+/.test(trimmed)) {
        signatures.push(trimmed.replace(/\s*{.*$/, ' { ... }'));
      }
      // Class definitions
      else if (/^(export\s+)?(abstract\s+)?class\s+\w+/.test(trimmed)) {
        signatures.push(trimmed.replace(/\s*{.*$/, ' { ... }'));
      }
      // Function definitions
      else if (/^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed)) {
        signatures.push(trimmed.replace(/\s*{.*$/, ' { ... }'));
      }
      // Method definitions (public/private/protected)
      else if (/^\s*(public|private|protected|async)\s+\w+\s*\(/.test(trimmed)) {
        signatures.push('  ' + trimmed.replace(/\s*{.*$/, ' { ... }'));
      }
    }
  }
  // Python patterns
  else if (language === 'python') {
    for (const line of lines) {
      const trimmed = line.trim();
      // Class definitions
      if (/^class\s+\w+/.test(trimmed)) {
        signatures.push(trimmed);
      }
      // Function definitions
      else if (/^(async\s+)?def\s+\w+/.test(trimmed)) {
        signatures.push(trimmed);
      }
    }
  }

  return signatures.length > 0 ? signatures.join('\n') : code.substring(0, 500) + '\n...';
}

/**
 * Check if output format is dense
 */
export function isDenseFormat(format?: OutputFormat | string): boolean {
  return format === 'dense';
}

/**
 * Check if output format is JSON
 */
export function isJsonFormat(format?: OutputFormat | string): boolean {
  return format === 'json';
}
