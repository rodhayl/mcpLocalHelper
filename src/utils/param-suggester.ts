/**
 * Parameter Suggester
 *
 * Provides fuzzy matching and suggestions for incorrectly spelled parameters.
 * Uses Levenshtein distance to find the closest valid parameter name.
 */
import { levenshteinDistance } from './string-distance.js';

/**
 * Calculate Levenshtein distance between two strings
 * Lower = more similar (0 = identical)
 */
/** Calculate similarity score (0-1) between two strings. */
function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

export interface SuggestionResult {
  match?: string;
  similarity: number;
  alternatives: Array<{ param: string; similarity: number }>;
}

/**
 * Find the best matching parameter from a list of valid parameters
 */
export function suggestParameter(input: string, validParams: string[]): SuggestionResult {
  if (validParams.length === 0) {
    return { similarity: 0, alternatives: [] };
  }

  // Calculate similarity for each valid parameter
  const scored = validParams.map((param) => ({
    param,
    similarity: similarityScore(input, param),
    // Also check case-insensitive exact match
    exactLower: input.toLowerCase() === param.toLowerCase(),
  }));

  // Sort by similarity (best first)
  scored.sort((a, b) => b.similarity - a.similarity);

  const best = scored[0];
  const alternatives = scored.slice(0, 3).map((s) => ({
    param: s.param,
    similarity: s.similarity,
  }));

  // Consider a match if similarity > 0.6 or exact case-insensitive match
  if (best.exactLower || best.similarity > 0.6) {
    return {
      match: best.param,
      similarity: best.similarity,
      alternatives,
    };
  }

  return {
    similarity: best.similarity,
    alternatives,
  };
}

/**
 * Format a helpful error message for an unknown parameter
 */
export function formatParameterError(
  invalidParam: string,
  validParams: string[],
  value?: unknown
): string {
  const suggestion = suggestParameter(invalidParam, validParams);

  let message = `Unknown parameter '${invalidParam}'.`;

  if (suggestion.match) {
    message = `Unknown parameter '${invalidParam}'. Did you mean '${suggestion.match}'?`;
    if (value !== undefined) {
      message += ` Try: { "${suggestion.match}": ${JSON.stringify(value).substring(0, 50)} }`;
    }
  } else {
    message += ` Valid parameters: ${validParams.slice(0, 5).join(', ')}`;
    if (validParams.length > 5) {
      message += `, ... (${validParams.length - 5} more)`;
    }
  }

  return message;
}

/**
 * Extract unknown parameters from an input object
 * Returns a map of invalid params to valid suggestions
 * Also flags case mismatches (e.g., TASK should be task)
 */
export function findUnknownParams(
  input: Record<string, unknown>,
  validParams: string[]
): Record<string, SuggestionResult> {
  const unknown: Record<string, SuggestionResult> = {};

  for (const key of Object.keys(input)) {
    // Check if key is an exact match (case-sensitive)
    const isExactMatch = validParams.includes(key);

    if (isExactMatch) {
      continue; // Perfect match, skip
    }

    // Check for case-insensitive match (wrong case)
    const caseInsensitiveMatch = validParams.find((p) => p.toLowerCase() === key.toLowerCase());

    if (caseInsensitiveMatch) {
      // Case mismatch - suggest the correct case
      unknown[key] = {
        match: caseInsensitiveMatch,
        similarity: 1.0, // It's the same word, just wrong case
        alternatives: [{ param: caseInsensitiveMatch, similarity: 1.0 }],
      };
    } else {
      // Truly unknown parameter - find suggestions
      unknown[key] = suggestParameter(key, validParams);
    }
  }

  return unknown;
}

/**
 * Generate a helpful error message for all unknown parameters
 */
export function formatUnknownParamsError(
  input: Record<string, unknown>,
  validParams: string[]
): string | null {
  const unknown = findUnknownParams(input, validParams);
  const keys = Object.keys(unknown);

  if (keys.length === 0) return null;

  const corrections: string[] = [];
  for (const key of keys) {
    const result = unknown[key];
    if (result.match) {
      corrections.push(`'${key}' → '${result.match}'`);
    } else {
      corrections.push(`'${key}' is unknown`);
    }
  }

  return `Parameter correction: ${corrections.join(', ')}. Valid parameters: ${validParams.join(', ')}`;
}

/**
 * Return type for structured parameter error
 */
export interface StructuredParamError {
  isError: true;
  errorType: 'invalid_parameters';
  invalidFields: Array<{
    field: string;
    suggestion?: string;
    similarity?: number;
  }>;
  message: string;
  hint: string;
  validParameters: string[];
}

/**
 * Generate a structured JSON error object for invalid parameters
 * This is the recommended format per LLM test feedback
 */
export function getStructuredParamError(
  input: Record<string, unknown>,
  validParams: string[]
): StructuredParamError | null {
  const unknown = findUnknownParams(input, validParams);
  const keys = Object.keys(unknown);

  if (keys.length === 0) return null;

  const invalidFields: StructuredParamError['invalidFields'] = [];
  const corrections: string[] = [];

  for (const key of keys) {
    const result = unknown[key];
    if (result.match) {
      invalidFields.push({
        field: key,
        suggestion: result.match,
        similarity: result.similarity,
      });
      corrections.push(`'${key}' → use '${result.match}'`);
    } else {
      invalidFields.push({
        field: key,
      });
      corrections.push(`'${key}' is not a valid parameter`);
    }
  }

  return {
    isError: true,
    errorType: 'invalid_parameters',
    invalidFields,
    message: `Invalid parameters detected: ${corrections.join(', ')}`,
    hint: `Please check your input. Did you mean: ${
      invalidFields
        .filter((f) => f.suggestion)
        .map((f) => `{ "${f.suggestion}": ... }`)
        .join(' or ') || 'Check valid parameters below'
    }`,
    validParameters: validParams,
  };
}
