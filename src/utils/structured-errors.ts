/**
 * Structured Error Utilities for MCP Local LLM
 *
 * Provides consistent, machine-readable error payloads across all tools.
 * Addresses Black-box evaluation feedback for standardized errors.
 *
 * @example
 * ```typescript
 * return createStructuredError({
 *   errorType: 'FILE_NOT_FOUND',
 *   message: 'The specified file does not exist',
 *   resolvedPath: '/path/to/file.ts',
 *   suggestions: ['Verify the file path', 'Check file permissions'],
 * });
 * ```
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename, isAbsolute, relative, resolve } from 'path';
import { levenshteinDistance } from './string-distance.js';

/**
 * Error types for programmatic handling across all tools.
 * Each tool should map its errors to one of these types.
 */
export type StructuredErrorType =
  | 'FILE_NOT_FOUND'
  | 'PATH_ACCESS_DENIED'
  | 'INVALID_PARAMETER'
  | 'VALIDATION_ERROR'
  | 'SCAN_EMPTY'
  | 'SCAN_INCOMPLETE'
  | 'SEARCH_NO_RESULTS'
  | 'LLM_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'TOOL_HIDDEN'
  | 'PARSE_ERROR';

/**
 * Structured error payload for consistent tool responses.
 * All tools should return this shape on failure.
 */
export interface StructuredError {
  /** Error type for programmatic handling */
  errorType: StructuredErrorType;
  /** Human-readable error message */
  message: string;
  /** Resolved/actual path (for path-related errors) */
  resolvedPath?: string;
  /** Actionable suggestions for resolving the error */
  suggestions?: string[];
  /** Link to relevant documentation */
  helpLink?: string;
  /** Additional context for debugging */
  context?: Record<string, unknown>;
  /** Timestamp when error occurred */
  timestamp?: string;
}

/**
 * Tool response with error status.
 */
export interface StructuredErrorResponse {
  status: 'error';
  error: StructuredError;
}

/**
 * Create a structured error payload.
 *
 * @param params - Error parameters
 * @returns Structured error object
 */
export function createStructuredError(params: {
  errorType: StructuredErrorType;
  message: string;
  resolvedPath?: string;
  suggestions?: string[];
  helpLink?: string;
  context?: Record<string, unknown>;
}): StructuredError {
  return {
    errorType: params.errorType,
    message: params.message,
    resolvedPath: params.resolvedPath,
    suggestions: params.suggestions,
    helpLink: params.helpLink,
    context: params.context,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a full error response with status.
 *
 * @param error - Structured error object
 * @returns Error response with status
 */
export function createErrorResponse(error: StructuredError): StructuredErrorResponse {
  return {
    status: 'error',
    error,
  };
}

/**
 * Standard suggestions for common error types.
 */
export const ERROR_SUGGESTIONS: Record<StructuredErrorType, string[]> = {
  FILE_NOT_FOUND: [
    'Verify the file path is correct',
    'Check if the file exists in the workspace',
    'Use list_dir to explore available files',
  ],
  PATH_ACCESS_DENIED: [
    'Ensure the path is within the allowed workspace',
    'Check workspace configuration for allowed paths',
    'Use a relative path from the workspace root',
  ],
  INVALID_PARAMETER: [
    'Check the parameter type and format',
    'Review the tool schema for valid values',
    'Use discover_tools to see parameter examples',
  ],
  VALIDATION_ERROR: [
    'Review the input against the tool schema',
    'Ensure all required parameters are provided',
    'Check parameter types match expected types',
  ],
  SCAN_EMPTY: [
    'Widen the scan scope with scanAllFiles option',
    'Check if files match the include patterns',
    'Verify the directory contains scannable files',
  ],
  SCAN_INCOMPLETE: [
    'Some files were skipped due to exclusion rules',
    'Use includeHidden option to scan hidden files',
    'Check skippedReasons in the response for details',
  ],
  SEARCH_NO_RESULTS: [
    'Try different keywords or fewer words',
    'Use action="filenames" for file name searches',
    'Narrow root to a specific folder (e.g., "src")',
  ],
  LLM_ERROR: [
    'Check if the LLM backend is running',
    'Verify the model is loaded correctly',
    'Try with a simpler prompt or smaller input',
  ],
  TIMEOUT: [
    'Try with a smaller input or simpler query',
    'Check if the LLM backend is responding',
    'Increase timeout in configuration if needed',
  ],
  INTERNAL_ERROR: [
    'This is an unexpected error - please report it',
    'Check server logs for more details',
    'Try the operation again',
  ],
  TOOL_HIDDEN: [
    'Use discover_tools to expand available tools',
    'Use agent_task to access infrastructure tools',
    'Check tool visibility tier documentation',
  ],
  PARSE_ERROR: [
    'The LLM response could not be parsed',
    'Try with a different model or simpler prompt',
    'Check if the expected format is correct',
  ],
};

/**
 * Get default suggestions for an error type.
 *
 * @param errorType - The error type
 * @returns Array of suggestions
 */
export function getDefaultSuggestions(errorType: StructuredErrorType): string[] {
  return ERROR_SUGGESTIONS[errorType] || ERROR_SUGGESTIONS.INTERNAL_ERROR;
}

/**
 * Create a file not found error with standard suggestions.
 */
export function createFileNotFoundError(
  originalPath: string,
  resolvedPath: string,
  extraSuggestions?: string[]
): StructuredError {
  return createStructuredError({
    errorType: 'FILE_NOT_FOUND',
    message: `Path not found: '${originalPath}' does not exist.`,
    resolvedPath,
    suggestions: [...getDefaultSuggestions('FILE_NOT_FOUND'), ...(extraSuggestions || [])],
  });
}

/**
 * Create a path access denied error with standard suggestions.
 */
export function createPathAccessDeniedError(path: string, resolvedPath?: string): StructuredError {
  return createStructuredError({
    errorType: 'PATH_ACCESS_DENIED',
    message: `Access denied: Path '${path}' is not in the allowlist.`,
    resolvedPath,
    suggestions: getDefaultSuggestions('PATH_ACCESS_DENIED'),
  });
}

/**
 * Create a scan empty error for security scans with low coverage.
 */
export function createScanEmptyError(
  filesScanned: number,
  minimumExpected: number,
  skippedReasons?: Record<string, number>
): StructuredError {
  const suggestions = [...getDefaultSuggestions('SCAN_EMPTY')];
  if (skippedReasons && Object.keys(skippedReasons).length > 0) {
    suggestions.push(
      `Skipped reasons: ${Object.entries(skippedReasons)
        .map(([k, v]) => `${k}(${v})`)
        .join(', ')}`
    );
  }
  return createStructuredError({
    errorType: 'SCAN_EMPTY',
    message: `Scan coverage too low: scanned ${filesScanned} files, expected at least ${minimumExpected}.`,
    suggestions,
    context: { filesScanned, minimumExpected, skippedReasons },
  });
}

/**
 * Create a search no results error with fallback suggestions.
 */
export function createSearchNoResultsError(query: string, usedFallback?: boolean): StructuredError {
  const suggestions = [...getDefaultSuggestions('SEARCH_NO_RESULTS')];
  if (usedFallback) {
    suggestions.unshift('Fallback search was attempted but found no matches.');
  }
  return createStructuredError({
    errorType: 'SEARCH_NO_RESULTS',
    message: `No results found for query: "${query}"`,
    suggestions,
    context: { query, usedFallback },
  });
}

/**
 * Find similar valid paths when a requested path doesn't exist.
 * Uses Levenshtein distance and directory structure heuristics.
 *
 * @param requestedPath - The path that was not found
 * @param workspaceRoots - Array of workspace root directories to search
 * @param maxSuggestions - Maximum number of suggestions to return (default: 3)
 * @returns Array of suggested paths that exist
 */
export function findClosestValidPaths(
  requestedPath: string,
  workspaceRoots: string[],
  maxSuggestions: number = 3
): string[] {
  const suggestions: Array<{ path: string; score: number }> = [];
  const requestedName = basename(requestedPath).toLowerCase();

  // Collect candidate directories from workspace roots
  function collectDirectories(dir: string, depth: number = 0): string[] {
    if (depth > 3) return []; // Limit depth to avoid scanning too deep
    const dirs: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip hidden and common non-source directories
          if (
            entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === 'dist' ||
            entry.name === '__pycache__' ||
            entry.name === 'venv' ||
            entry.name === '.venv'
          ) {
            continue;
          }
          const fullPath = join(dir, entry.name);
          dirs.push(fullPath);
          dirs.push(...collectDirectories(fullPath, depth + 1));
        }
      }
    } catch {
      // Ignore permission errors
    }
    return dirs;
  }

  // Collect all valid directories
  const candidatePaths: string[] = [];
  for (const root of workspaceRoots) {
    if (existsSync(root)) {
      candidatePaths.push(root);
      candidatePaths.push(...collectDirectories(root));
    }
  }

  // Score each candidate based on similarity
  for (const candidatePath of candidatePaths) {
    const candidateName = basename(candidatePath).toLowerCase();
    const nameDistance = levenshteinDistance(requestedName, candidateName);

    // Also check if the requested path is a substring or contains common parts
    const containsMatch =
      candidateName.includes(requestedName) || requestedName.includes(candidateName);

    // Calculate a combined score (lower is better)
    let score = nameDistance;
    if (containsMatch) score -= 5; // Bonus for substring matches
    if (requestedName === candidateName) score -= 10; // Exact name match (different location)

    suggestions.push({ path: candidatePath, score });
  }

  // Sort by score (lower is better) and return top suggestions
  suggestions.sort((a, b) => a.score - b.score);

  // Filter to only include reasonable matches (score below threshold)
  const threshold = Math.max(requestedName.length * 0.6, 5);
  const filtered = suggestions
    .filter((s) => s.score < threshold)
    .slice(0, maxSuggestions)
    .map((s) => s.path);

  // Always include workspace roots as fallback suggestions if we have few matches
  if (filtered.length < maxSuggestions) {
    for (const root of workspaceRoots) {
      if (existsSync(root) && !filtered.includes(root)) {
        filtered.push(root);
        if (filtered.length >= maxSuggestions) break;
      }
    }
  }

  return filtered;
}

/**
 * Generate path suggestion strings for error messages.
 *
 * @param requestedPath - The path that was not found
 * @param workspaceRoots - Array of workspace root directories
 * @returns Array of suggestion strings for the error message
 */
export function generatePathSuggestions(requestedPath: string, workspaceRoots: string[]): string[] {
  const closestPaths = findClosestValidPaths(requestedPath, workspaceRoots);
  const cwd = resolve(process.cwd());
  const formattedPaths = Array.from(
    new Set(
      closestPaths
        .map((candidate) => {
          const normalized = candidate.replace(/\\/g, '/');
          if (!isAbsolute(candidate)) {
            return normalized;
          }

          const resolvedCandidate = resolve(candidate);
          const relToCwd = relative(cwd, resolvedCandidate);
          if (relToCwd === '') return '.';
          if (relToCwd && !relToCwd.startsWith('..') && !isAbsolute(relToCwd)) {
            return relToCwd.replace(/\\/g, '/');
          }

          for (const root of workspaceRoots) {
            const relToRoot = relative(resolve(root), resolvedCandidate);
            if (relToRoot === '') return '.';
            if (relToRoot && !relToRoot.startsWith('..') && !isAbsolute(relToRoot)) {
              return relToRoot.replace(/\\/g, '/');
            }
          }

          return basename(resolvedCandidate) || '<workspace>';
        })
        .filter(Boolean)
    )
  );

  if (formattedPaths.length === 0) {
    return ['Check that the path exists and is spelled correctly'];
  }

  const suggestions: string[] = [];
  suggestions.push(`Did you mean one of these paths? ${formattedPaths.join(', ')}`);

  return suggestions;
}
