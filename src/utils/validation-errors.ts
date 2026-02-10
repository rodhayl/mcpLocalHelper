/**
 * Validation Error Utilities
 *
 * Provides consistent, structured error responses for validation failures.
 * Follows the format expected by LLM validation tests:
 * {
 *   success: false,
 *   errorType: 'validation_error' | 'missing_server' | 'invalid_action' | 'tool_error',
 *   tool: string,
 *   message: string,
 *   issues?: [...],
 *   hint?: string
 * }
 */

import { ZodError, ZodIssue } from 'zod';

/**
 * Structured validation error response
 */
export interface ValidationErrorResponse {
  success: false;
  errorType:
    | 'validation_error'
    | 'missing_server'
    | 'invalid_action'
    | 'missing_params'
    | 'tool_error'
    | 'invalid_enum'; // Plan V4.1: Enum validation
  tool: string;
  message: string;
  issues?: FormattedIssue[];
  hint?: string;
  allowedValues?: string[];
  availableServers?: string[];
}

/**
 * Formatted issue with allowed values for enum errors
 */
export interface FormattedIssue {
  path: string;
  message: string;
  code: string;
  expected?: string[] | string;
  received?: unknown;
}

/**
 * Parse ZodError and extract detailed issues with allowed values
 * V10: Updated to handle Zod 4+ which uses 'values' instead of 'options'
 */
export function parseZodError(error: ZodError): FormattedIssue[] {
  return error.issues.map((issue: ZodIssue) => {
    const formatted: FormattedIssue = {
      path: issue.path.join('.') || '(root)',
      message: issue.message,
      code: issue.code,
    };

    // Use dynamic property access to handle different Zod versions
    const issueAny = issue as any;

    // V10: Zod 4+ uses 'values' for enum validation errors (invalid_value code)
    // This is the primary case for enum validation failures
    if ('values' in issueAny && Array.isArray(issueAny.values)) {
      formatted.expected = issueAny.values.map(String);
      if ('received' in issueAny) {
        formatted.received = issueAny.received;
      }
    }
    // Legacy: Zod 3.x used 'options' property for enum values
    else if ('options' in issueAny && Array.isArray(issueAny.options)) {
      formatted.expected = issueAny.options.map(String);
      if ('received' in issueAny) {
        formatted.received = issueAny.received;
      }
    }
    // Check for 'expected' property (literal/type errors)
    else if ('expected' in issueAny) {
      if (Array.isArray(issueAny.expected)) {
        formatted.expected = issueAny.expected.map(String);
      } else if (issueAny.expected !== undefined) {
        formatted.expected = String(issueAny.expected);
      }
      if ('received' in issueAny) {
        formatted.received = issueAny.received;
      }
    }
    // Handle union errors - extract values/options from nested errors
    else if ('unionErrors' in issueAny && Array.isArray(issueAny.unionErrors)) {
      const allOptions: string[] = [];
      for (const ue of issueAny.unionErrors) {
        if (ue && Array.isArray(ue.issues)) {
          for (const nestedIssue of ue.issues) {
            // V10: Check both 'values' (Zod 4+) and 'options' (Zod 3.x)
            if ('values' in nestedIssue && Array.isArray(nestedIssue.values)) {
              allOptions.push(...nestedIssue.values.map(String));
            } else if ('options' in nestedIssue && Array.isArray(nestedIssue.options)) {
              allOptions.push(...nestedIssue.options.map(String));
            }
          }
        }
      }
      if (allOptions.length > 0) {
        formatted.expected = [...new Set(allOptions)];
      }
    }

    return formatted;
  });
}

/**
 * Format a ZodError into a structured validation error response
 * V12: Enhanced message format to always show allowed values prominently
 */
export function formatZodValidationError(tool: string, error: ZodError): ValidationErrorResponse {
  const issues = parseZodError(error);

  // Build a user-friendly message that prominently shows allowed values
  const messageParts = issues.map((issue) => {
    // Extract parameter name for clearer messages
    const paramName = issue.path || 'input';

    // If we have expected values (enum), show them prominently
    if (Array.isArray(issue.expected) && issue.expected.length > 0) {
      const allowedStr = issue.expected.join(', ');
      // V12: Clear, explicit message format for enum errors
      return `'${paramName}' must be one of: ${allowedStr}. Received: ${JSON.stringify(issue.received)}`;
    } else if (typeof issue.expected === 'string') {
      return `'${paramName}': expected ${issue.expected}, received ${JSON.stringify(issue.received)}`;
    }
    // Fallback to original message with param name
    return `'${paramName}': ${issue.message}`;
  });

  // Extract all allowed values from enum issues for hint
  const allAllowedValues = issues
    .filter((i) => Array.isArray(i.expected))
    .flatMap((i) => i.expected as string[]);

  const uniqueAllowed = [...new Set(allAllowedValues)];

  return {
    success: false,
    errorType: 'validation_error',
    tool,
    message: messageParts.join('; '),
    issues,
    ...(uniqueAllowed.length > 0 ? { allowedValues: uniqueAllowed } : {}),
    hint:
      uniqueAllowed.length > 0
        ? `Valid values: ${uniqueAllowed.join(', ')}. Example: { "action": "${uniqueAllowed[0]}" }`
        : 'Check the parameter types and required fields',
  };
}

// NOTE: Dead code removed (V13 cleanup):
// - formatMissingServerError, formatInvalidActionError, formatMissingParamsError
// - formatToolError, isZodError, formatRuntimeRequiredError, formatNumericError
// - wrapSuccessResponse (also duplicated in validation-enhanced.ts)
// These were exported but never imported anywhere in production code.
