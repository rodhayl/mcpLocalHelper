/**
 * Input Limits and Resource Protection
 *
 * Centralized constants for input validation to prevent:
 * - Resource exhaustion attacks (100KB+ strings, 1000+ parameters)
 * - Memory exhaustion from massive inputs
 * - DoS via compute-intensive operations on large inputs
 *
 * These limits were identified as critical gaps in production readiness testing.
 */

import { z } from 'zod';

// ============================================
// RESOURCE LIMITS CONSTANTS
// ============================================

/**
 * Maximum lengths for various input types
 */
export const INPUT_LIMITS = {
  // String lengths
  QUERY_MAX_LENGTH: 10_000, // 10KB max for search queries
  PATH_MAX_LENGTH: 1_000, // 1KB max for file paths
  CONTENT_MAX_LENGTH: 100_000, // 100KB max for code content
  CODE_SNIPPET_MAX_LENGTH: 50_000, // 50KB for code snippets (for analyze, review, etc.)
  INTENT_MAX_LENGTH: 2_000, // 2KB for intent/description strings
  QUESTION_MAX_LENGTH: 5_000, // 5KB for questions

  // Array limits
  MAX_ARRAY_LENGTH: 100, // Max items in arrays (files, patterns, etc.)
  MAX_ENTRY_POINTS: 50, // Max entry points for cross_file_links
  MAX_CHANGED_FILES: 100, // Max files for impact analysis
  MAX_SEARCH_SCOPE: 20, // Max search scope paths

  // Numeric limits
  MAX_RESULTS_LIMIT: 1000, // Max results that can be requested
  MAX_DEPTH: 50, // Max directory depth
  MAX_CONTEXT_LINES: 100, // Max context lines
  MAX_TIMEOUT_MS: 300_000, // 5 minutes max timeout
  MAX_SUGGESTIONS: 50, // Max suggestions to return

  // LLM-specific
  MAX_PROMPT_LENGTH: 50_000, // Max prompt length for LLM calls
} as const;

// ============================================
// REUSABLE ZOD SCHEMAS WITH LIMITS
// ============================================

/**
 * Bounded string schemas
 */
export const BoundedStrings = {
  /** File/directory path with max length */
  path: z
    .string()
    .min(1, 'Path cannot be empty')
    .max(
      INPUT_LIMITS.PATH_MAX_LENGTH,
      `Path exceeds maximum length of ${INPUT_LIMITS.PATH_MAX_LENGTH} characters`
    ),

  /** Search query with max length */
  query: z
    .string()
    .min(1, 'Query cannot be empty')
    .max(
      INPUT_LIMITS.QUERY_MAX_LENGTH,
      `Query exceeds maximum length of ${INPUT_LIMITS.QUERY_MAX_LENGTH} characters`
    ),

  /** Code content with max length */
  content: z
    .string()
    .max(
      INPUT_LIMITS.CONTENT_MAX_LENGTH,
      `Content exceeds maximum length of ${INPUT_LIMITS.CONTENT_MAX_LENGTH} characters`
    ),

  /** Code snippet for analysis */
  codeSnippet: z
    .string()
    .min(1, 'Code cannot be empty')
    .max(
      INPUT_LIMITS.CODE_SNIPPET_MAX_LENGTH,
      `Code exceeds maximum length of ${INPUT_LIMITS.CODE_SNIPPET_MAX_LENGTH} characters`
    ),

  /** Intent/description string */
  intent: z
    .string()
    .min(1, 'Intent cannot be empty')
    .max(
      INPUT_LIMITS.INTENT_MAX_LENGTH,
      `Intent exceeds maximum length of ${INPUT_LIMITS.INTENT_MAX_LENGTH} characters`
    ),

  /** Question for Q&A */
  question: z
    .string()
    .min(1, 'Question cannot be empty')
    .max(
      INPUT_LIMITS.QUESTION_MAX_LENGTH,
      `Question exceeds maximum length of ${INPUT_LIMITS.QUESTION_MAX_LENGTH} characters`
    ),

  /** Optional path */
  optionalPath: z
    .string()
    .max(
      INPUT_LIMITS.PATH_MAX_LENGTH,
      `Path exceeds maximum length of ${INPUT_LIMITS.PATH_MAX_LENGTH} characters`
    )
    .optional(),

  /** Optional query */
  optionalQuery: z
    .string()
    .max(
      INPUT_LIMITS.QUERY_MAX_LENGTH,
      `Query exceeds maximum length of ${INPUT_LIMITS.QUERY_MAX_LENGTH} characters`
    )
    .optional(),

  /** Optional content */
  optionalContent: z
    .string()
    .max(
      INPUT_LIMITS.CONTENT_MAX_LENGTH,
      `Content exceeds maximum length of ${INPUT_LIMITS.CONTENT_MAX_LENGTH} characters`
    )
    .optional(),
};

/**
 * Bounded array schemas
 */
export const BoundedArrays = {
  /** Array of file paths */
  paths: z
    .array(BoundedStrings.path)
    .max(
      INPUT_LIMITS.MAX_ARRAY_LENGTH,
      `Array exceeds maximum length of ${INPUT_LIMITS.MAX_ARRAY_LENGTH} items`
    ),

  /** Array of strings (generic) */
  strings: z
    .array(z.string().max(INPUT_LIMITS.PATH_MAX_LENGTH))
    .max(
      INPUT_LIMITS.MAX_ARRAY_LENGTH,
      `Array exceeds maximum length of ${INPUT_LIMITS.MAX_ARRAY_LENGTH} items`
    ),

  /** Entry points for cross_file_links */
  entryPoints: z
    .array(BoundedStrings.path)
    .min(1, 'At least one entry point is required')
    .max(
      INPUT_LIMITS.MAX_ENTRY_POINTS,
      `Entry points exceed maximum of ${INPUT_LIMITS.MAX_ENTRY_POINTS}`
    ),

  /** Changed files for impact analysis */
  changedFiles: z
    .array(BoundedStrings.path)
    .min(1, 'At least one changed file is required')
    .max(
      INPUT_LIMITS.MAX_CHANGED_FILES,
      `Changed files exceed maximum of ${INPUT_LIMITS.MAX_CHANGED_FILES}`
    ),

  /** Search scope paths */
  searchScope: z
    .array(BoundedStrings.path)
    .max(
      INPUT_LIMITS.MAX_SEARCH_SCOPE,
      `Search scope exceeds maximum of ${INPUT_LIMITS.MAX_SEARCH_SCOPE} paths`
    )
    .optional(),

  /** Optional array of patterns */
  patterns: z.array(z.string().max(500)).max(INPUT_LIMITS.MAX_ARRAY_LENGTH).optional(),
};

/**
 * Bounded numeric schemas
 */
export const BoundedNumbers = {
  /** Max results limit */
  maxResults: z
    .number()
    .int('Must be an integer')
    .min(1, 'Must be at least 1')
    .max(INPUT_LIMITS.MAX_RESULTS_LIMIT, `Cannot exceed ${INPUT_LIMITS.MAX_RESULTS_LIMIT}`)
    .optional(),

  /** Directory depth */
  depth: z
    .number()
    .int('Must be an integer')
    .min(0, 'Must be non-negative')
    .max(INPUT_LIMITS.MAX_DEPTH, `Cannot exceed ${INPUT_LIMITS.MAX_DEPTH}`)
    .optional(),

  /** Context lines */
  contextLines: z
    .number()
    .int('Must be an integer')
    .min(0, 'Must be non-negative')
    .max(INPUT_LIMITS.MAX_CONTEXT_LINES, `Cannot exceed ${INPUT_LIMITS.MAX_CONTEXT_LINES}`)
    .optional(),

  /** Timeout in milliseconds */
  timeoutMs: z
    .number()
    .int('Must be an integer')
    .min(1000, 'Minimum timeout is 1000ms')
    .max(INPUT_LIMITS.MAX_TIMEOUT_MS, `Cannot exceed ${INPUT_LIMITS.MAX_TIMEOUT_MS}ms (5 minutes)`)
    .optional(),

  /** Max suggestions */
  maxSuggestions: z
    .number()
    .int('Must be an integer')
    .min(1, 'Must be at least 1')
    .max(INPUT_LIMITS.MAX_SUGGESTIONS, `Cannot exceed ${INPUT_LIMITS.MAX_SUGGESTIONS}`)
    .optional(),

  /** Positive integer with reasonable max */
  positiveInt: z
    .number()
    .int('Must be an integer')
    .min(1, 'Must be positive')
    .max(10000, 'Value too large'),
};

// ============================================
// VALIDATION HELPERS
// ============================================

/**
 * Validate input against resource limits and return error message if exceeded
 * Returns null if valid
 */
export function checkInputLimits(args: Record<string, unknown>): string | null {
  // Check string lengths
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      // Check query-like fields
      if (
        (key === 'query' || key === 'pattern' || key === 'searchQuery') &&
        value.length > INPUT_LIMITS.QUERY_MAX_LENGTH
      ) {
        return `Parameter '${key}' exceeds maximum length of ${INPUT_LIMITS.QUERY_MAX_LENGTH} characters (received ${value.length})`;
      }

      // Check path fields
      if (
        (key === 'path' || key === 'root' || key.endsWith('Path') || key.endsWith('_path')) &&
        value.length > INPUT_LIMITS.PATH_MAX_LENGTH
      ) {
        return `Parameter '${key}' exceeds maximum length of ${INPUT_LIMITS.PATH_MAX_LENGTH} characters (received ${value.length})`;
      }

      // Check content fields
      if (
        (key === 'content' || key === 'code' || key === 'snippet') &&
        value.length > INPUT_LIMITS.CONTENT_MAX_LENGTH
      ) {
        return `Parameter '${key}' exceeds maximum length of ${INPUT_LIMITS.CONTENT_MAX_LENGTH} characters (received ${value.length})`;
      }

      // Generic string limit check
      if (value.length > INPUT_LIMITS.CONTENT_MAX_LENGTH) {
        return `Parameter '${key}' exceeds maximum string length of ${INPUT_LIMITS.CONTENT_MAX_LENGTH} characters (received ${value.length})`;
      }
    }

    // Check array lengths
    if (Array.isArray(value) && value.length > INPUT_LIMITS.MAX_ARRAY_LENGTH) {
      return `Parameter '${key}' exceeds maximum array length of ${INPUT_LIMITS.MAX_ARRAY_LENGTH} items (received ${value.length})`;
    }
  }

  return null;
}

/**
 * Create a resource limit error response
 */
export function createResourceLimitError(tool: string, message: string) {
  return {
    success: false,
    isError: true,
    errorType: 'resource_limit' as const,
    tool,
    message,
    hint: 'Reduce the size of your input parameters to stay within resource limits.',
  };
}

// ============================================
// COMMON TOOL SCHEMAS (with resource limits)
// ============================================

/**
 * Pre-built schemas for common tool patterns
 */
export const CommonToolSchemas = {
  /** Simple path-based tool */
  pathOnly: z.object({
    path: BoundedStrings.path,
  }),

  /** Path with optional options */
  pathWithOptions: z.object({
    path: BoundedStrings.path,
    maxBytes: BoundedNumbers.positiveInt.optional(),
    question: BoundedStrings.optionalQuery,
  }),

  /** Search tool */
  search: z.object({
    root: BoundedStrings.path,
    query: BoundedStrings.query,
    maxResults: BoundedNumbers.maxResults,
    intent: BoundedStrings.intent.optional(),
    filePattern: z.string().max(500).optional(),
    rankByRelevance: z.boolean().optional(),
  }),

  /** Code analysis tool */
  codeAnalysis: z.object({
    path: BoundedStrings.path,
    question: BoundedStrings.optionalQuery,
    analysisType: z
      .enum(['quality', 'security', 'performance', 'documentation', 'full'])
      .optional(),
    maxBytes: BoundedNumbers.positiveInt.optional(),
  }),

  /** Q&A tool */
  qa: z.object({
    question: BoundedStrings.question,
    searchScope: BoundedArrays.searchScope,
    maxSources: BoundedNumbers.maxResults,
  }),
};
