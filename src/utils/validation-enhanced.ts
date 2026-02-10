/**
 * Enhanced Validation Utilities
 *
 * Provides additional validation helpers for:
 * - Runtime-required parameters (action-specific requirements)
 * - Enum validation for action parameters (Plan V4.1)
 * - Numeric validation with constraints (security: prevent bypass)
 * - Type coercion detection (consistency improvement)
 * - Standardized success response wrapping
 *
 * These complement the existing validation-errors.ts
 */

import { ValidationErrorResponse, FormattedIssue } from './validation-errors.js';

// ============================================
// Plan V4.1: Enum Validation for Action Parameters
// ============================================

/**
 * Map of tool -> parameter -> allowed enum values
 * This ensures enum validation is enforced at runtime
 */
export const ACTION_ENUM_VALUES: Record<string, Record<string, string[]>> = {
  summarize: {
    action: ['path', 'repo'],
  },
  search: {
    action: ['intelligent', 'structured', 'gather', 'filenames'],
  },
  workspace: {
    action: ['metadata', 'snapshot', 'explore'],
  },
  todos: {
    action: ['find', 'implement', 'find_and_implement'],
  },
  security: {
    action: ['scan', 'risk', 'redact', 'fix'],
  },
  linter: {
    action: ['validate', 'fix', 'run'],
  },
  formatter: {
    action: ['run', 'fix'],
  },
  find_duplicates: {
    action: ['files', 'functions', 'code'],
  },
  code_helper: {
    action: ['explain', 'optimize', 'simplify'],
  },
  regex_helper: {
    action: ['explain', 'generate'],
  },
  refactor_helper: {
    action: ['suggest_names', 'extract_function'],
  },
  mcp_server: {
    action: ['connect', 'disconnect', 'list', 'call', 'status', 'listLocal', 'describeTool'],
  },
  analyze_file: {
    analysisType: ['quality', 'security', 'performance', 'documentation', 'full'],
  },
  local_code_review: {
    reviewType: ['security', 'performance', 'style', 'comprehensive'],
  },
  // generate_tests - REMOVED V21 (QA_feedback_8: unreliable output quality)
};

/**
 * Validate that enum parameters have valid values
 * Returns null if valid, or a ValidationErrorResponse if invalid
 *
 * Plan V4.1: Parameter Validation Hardening
 */
export function validateEnumParam(
  tool: string,
  paramName: string,
  value: unknown
): ValidationErrorResponse | null {
  const toolEnums = ACTION_ENUM_VALUES[tool];
  if (!toolEnums) return null;

  const allowedValues = toolEnums[paramName];
  if (!allowedValues) return null;

  // If value is undefined, skip enum validation (required param validation handles this)
  if (value === undefined || value === null) return null;

  // Value must be a string for enum validation
  if (typeof value !== 'string') {
    return {
      success: false,
      errorType: 'validation_error',
      tool,
      message: `Invalid type for '${paramName}': expected string, received ${typeof value}`,
      issues: [
        {
          path: paramName,
          message: `Must be one of: ${allowedValues.map((v) => `'${v}'`).join(', ')}`,
          code: 'invalid_type',
          expected: 'string',
          received: value,
        },
      ],
      hint: `'${paramName}' must be a string with one of these values: ${allowedValues.join(', ')}`,
    };
  }

  // Compatibility alias: analyze_file analysisType="detailed" maps to "full".
  if (tool === 'analyze_file' && paramName === 'analysisType' && value === 'detailed') {
    return null;
  }

  // Check if value is in allowed values
  if (!allowedValues.includes(value)) {
    return {
      success: false,
      errorType: 'invalid_enum',
      tool,
      message: `Invalid value for '${paramName}': '${value}' is not a valid option`,
      issues: [
        {
          path: paramName,
          message: `Must be one of: ${allowedValues.map((v) => `'${v}'`).join(', ')}`,
          code: 'invalid_enum',
          expected: allowedValues,
          received: value,
        },
      ],
      hint: `Valid values for '${paramName}' are: ${allowedValues.join(', ')}. You provided: '${value}'`,
    };
  }

  return null;
}

/**
 * Validate all enum parameters for a tool at once
 * Returns null if all valid, or the first ValidationErrorResponse if invalid
 */
export function validateAllEnumParams(
  tool: string,
  params: Record<string, unknown>
): ValidationErrorResponse | null {
  // Handle null/undefined params gracefully
  if (!params || typeof params !== 'object') return null;

  const toolEnums = ACTION_ENUM_VALUES[tool];
  if (!toolEnums) return null;

  for (const paramName of Object.keys(toolEnums)) {
    if (params[paramName] !== undefined) {
      const error = validateEnumParam(tool, paramName, params[paramName]);
      if (error) return error;
    }
  }

  return null;
}

// ============================================
// Runtime-Required Parameter Validation
// ============================================

/**
 * Map of tool -> action -> required parameters
 * This ensures runtime requirements are caught at schema level
 */
export const ACTION_REQUIRED_PARAMS: Record<string, Record<string, string[]>> = {
  summarize: {
    path: ['path'],
    repo: ['root'],
  },
  search: {
    // V14: Root now defaults to '.' when omitted (LLM feedback: common friction point)
    // Previously required root explicitly, but LLMs consistently requested defaulting to workspace
    // gather action still requires path which scopes the search
    intelligent: ['query'], // root defaults to '.'
    structured: ['query'], // root defaults to '.'
    gather: ['query', 'path'], // path explicitly scopes the gather
    filenames: ['query'], // root defaults to '.'
  },
  workspace: {
    metadata: ['path'],
    snapshot: ['path'],
    explore: ['path'],
  },
  todos: {
    find: ['root'],
    implement: ['root'],
  },
  security: {
    scan: ['root'],
    risk: ['content'],
    redact: ['content'],
  },
  linter: {
    // Note: validate can use 'files' OR 'content' - handled specially in mcp.ts
    validate: [],
    fix: ['root'],
    run: [],
  },
  formatter: {
    run: [],
    fix: ['files'],
  },
  find_duplicates: {
    files: [],
    functions: [],
    code: [],
  },
  code_helper: {
    explain: ['code'],
    optimize: ['code'],
    simplify: ['code'],
  },
  regex_helper: {
    explain: ['pattern'],
    generate: ['description'],
  },
  refactor_helper: {
    suggest_names: ['code'],
    extract_function: ['code'],
  },
  mcp_server: {
    connect: ['serverName'],
    disconnect: ['serverName'],
    list: [],
    call: ['serverName', 'toolName'],
    status: [],
    listLocal: [],
    describeTool: ['toolName'],
  },
};

/**
 * Validate that action-specific required parameters are present
 * Returns null if valid, or a ValidationErrorResponse if invalid
 */
export function validateActionRequiredParams(
  tool: string,
  action: string,
  params: Record<string, unknown>
): ValidationErrorResponse | null {
  const toolRequirements = ACTION_REQUIRED_PARAMS[tool];
  if (!toolRequirements) return null;

  const actionRequirements = toolRequirements[action];
  if (!actionRequirements || actionRequirements.length === 0) return null;

  const missingParams: string[] = [];
  for (const requiredParam of actionRequirements) {
    if (params[requiredParam] === undefined || params[requiredParam] === null) {
      missingParams.push(requiredParam);
    }
  }

  if (missingParams.length === 0) return null;

  const issues: FormattedIssue[] = missingParams.map((param) => ({
    path: param,
    message: `Required when action='${action}'`,
    code: 'required_for_action',
  }));

  return {
    success: false,
    errorType: 'missing_params',
    tool,
    message: `Missing required parameter(s) for action='${action}': ${missingParams.join(', ')}`,
    issues,
    hint: `When using action='${action}', you must provide: ${missingParams.map((p) => `"${p}"`).join(', ')}. Example: { "action": "${action}", ${missingParams.map((p) => `"${p}": "your_value"`).join(', ')} }`,
  };
}

// ============================================
// Numeric Validation (Security Fix)
// ============================================

export interface NumericConstraints {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Validate numeric parameters with constraints
 * This prevents numeric validation bypass (security risk flagged in audit)
 */
export function validateNumericParam(
  value: unknown,
  paramName: string,
  constraints?: NumericConstraints
): { valid: true; value: number } | { valid: false; error: string } {
  // Strict type check - reject strings like "123"
  if (typeof value !== 'number') {
    return {
      valid: false,
      error: `'${paramName}' must be a number, received ${typeof value}: ${JSON.stringify(value)}`,
    };
  }

  // Check for NaN
  if (isNaN(value)) {
    return {
      valid: false,
      error: `'${paramName}' received NaN (not a valid number)`,
    };
  }

  // Check for Infinity
  if (!isFinite(value)) {
    return {
      valid: false,
      error: `'${paramName}' must be a finite number, received ${value}`,
    };
  }

  // Check constraints
  if (constraints) {
    if (constraints.integer && !Number.isInteger(value)) {
      return {
        valid: false,
        error: `'${paramName}' must be an integer, received ${value}`,
      };
    }
    if (constraints.min !== undefined && value < constraints.min) {
      return {
        valid: false,
        error: `'${paramName}' must be >= ${constraints.min}, received ${value}`,
      };
    }
    if (constraints.max !== undefined && value > constraints.max) {
      return {
        valid: false,
        error: `'${paramName}' must be <= ${constraints.max}, received ${value}`,
      };
    }
  }

  return { valid: true, value };
}

/**
 * Format a numeric validation error as ValidationErrorResponse
 */
export function formatNumericValidationError(
  tool: string,
  paramName: string,
  received: unknown,
  constraints?: NumericConstraints
): ValidationErrorResponse {
  let constraintStr = 'Must be a valid number';
  if (constraints) {
    const parts: string[] = [];
    if (constraints.integer) parts.push('integer');
    if (constraints.min !== undefined) parts.push(`>= ${constraints.min}`);
    if (constraints.max !== undefined) parts.push(`<= ${constraints.max}`);
    if (parts.length > 0) constraintStr = `Must be ${parts.join(' and ')}`;
  }

  return {
    success: false,
    errorType: 'validation_error',
    tool,
    message: `Invalid numeric value for '${paramName}': received ${typeof received} (${JSON.stringify(received)})`,
    issues: [
      {
        path: paramName,
        message: constraintStr,
        code: 'invalid_type',
        expected: 'number',
        received,
      },
    ],
    hint: `'${paramName}' must be a number. ${constraintStr}. Received: ${typeof received}`,
  };
}

// NOTE: Dead code removed (V13 cleanup):
// - wrapSuccessResponse, hasSuccessFlag, CoercionResult, coerceBoolean
// These were exported but never imported anywhere in production code.

// ============================================
// Binary File Detection (for security scanner)
// ============================================

/**
 * File extensions that are known to be binary (not text)
 * Used to filter out false positives in security scanning
 */
export const BINARY_FILE_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.svg',
  '.webp',
  '.tiff',
  '.tif',
  // Audio
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  // Video
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  // Executables
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  // Documents (binary)
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // Database
  '.db',
  '.sqlite',
  '.sqlite3',
  // Compiled
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.a',
  // Other binary
  '.lock',
  '.wasm',
]);

/**
 * Check if a file extension indicates a binary file
 */
export function isBinaryFileExtension(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return BINARY_FILE_EXTENSIONS.has(ext);
}

/**
 * Check if content appears to be binary (contains null bytes or high ratio of non-printable chars)
 */
export function appearsBinaryContent(content: string, sampleSize = 1000): boolean {
  const sample = content.slice(0, sampleSize);

  // Check for null bytes
  if (sample.includes('\0')) {
    return true;
  }

  // Count non-printable characters (excluding common whitespace)
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Non-printable and not tab, newline, carriage return
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
    // High bytes (potential binary)
    if (code > 126 && code < 160) {
      nonPrintable++;
    }
  }

  // If more than 10% non-printable, likely binary
  return nonPrintable / sample.length > 0.1;
}

// ============================================
// Language Mapping Enhancement
// ============================================

/**
 * Extended language extension mappings
 * Fixes the issue where "ts" wouldn't match TypeScript files
 */
export const LANGUAGE_ALIASES: Record<string, string[]> = {
  // TypeScript
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  ts: ['ts', 'tsx', 'mts', 'cts'],
  tsx: ['tsx'],

  // JavaScript
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  js: ['js', 'jsx', 'mjs', 'cjs'],
  jsx: ['jsx'],

  // Python
  python: ['py', 'pyw', 'pyi'],
  py: ['py', 'pyw', 'pyi'],

  // Other common languages
  java: ['java'],
  go: ['go'],
  rust: ['rs'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'c++', 'h++'],
  csharp: ['cs'],
  ruby: ['rb'],
  php: ['php'],
  swift: ['swift'],
  kotlin: ['kt', 'kts'],
  scala: ['scala'],
  r: ['r', 'R'],
  shell: ['sh', 'bash', 'zsh'],
  powershell: ['ps1', 'psm1', 'psd1'],
};

/**
 * Normalize a language name to get its file extensions
 */
export function getLanguageExtensions(language: string): string[] {
  const normalized = language.toLowerCase().trim();

  // Check if it's already an extension
  if (normalized.startsWith('.')) {
    return [normalized];
  }

  // Check aliases
  const aliases = LANGUAGE_ALIASES[normalized];
  if (aliases) {
    return aliases.map((ext) => `.${ext}`);
  }

  // Fallback: treat as extension
  return [`.${normalized}`];
}
