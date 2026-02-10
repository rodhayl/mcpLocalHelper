/**
 * Tool Contract System - Plan 5: Tool Contract Standardization
 *
 * Provides formalized input/output schemas with strict validation
 * and test contracts for all tools.
 */

import { z } from 'zod';
import type { ToolContract, ToolContractValidationResult } from '../types/index.js';

/**
 * Registered tool contracts
 * Maps tool name to its contract definition
 */
const TOOL_CONTRACTS: Map<string, ToolContract> = new Map();

/**
 * Register a tool contract
 */
export function registerToolContract(contract: ToolContract): void {
  TOOL_CONTRACTS.set(contract.name, contract);
}

/**
 * Get a tool contract by name
 */
export function getToolContract(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(name);
}

/**
 * Get all registered contracts
 */
export function getAllToolContracts(): ToolContract[] {
  return Array.from(TOOL_CONTRACTS.values());
}

/**
 * Validate input against a tool's contract
 */
export function validateToolInput(toolName: string, input: unknown): ToolContractValidationResult {
  const contract = TOOL_CONTRACTS.get(toolName);

  if (!contract) {
    return {
      valid: true, // No contract = no validation
      errors: [],
      warnings: [
        {
          field: '_contract',
          message: `No contract registered for tool '${toolName}'`,
        },
      ],
    };
  }

  const errors: ToolContractValidationResult['errors'] = [];
  const warnings: ToolContractValidationResult['warnings'] = [];

  // Validate input against schema
  if (contract.inputSchema) {
    try {
      const schema = jsonSchemaToZod(contract.inputSchema);
      const result = schema.safeParse(input);

      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            field: issue.path.join('.') || '_root',
            message: issue.message,
            expected: String(issue.code),
            received:
              typeof input === 'object' && input !== null
                ? String((input as Record<string, unknown>)[issue.path[0] as string])
                : String(input),
          });
        }
      }
    } catch (e) {
      warnings.push({
        field: '_schema',
        message: `Could not validate schema: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate output against a tool's contract
 */
export function validateToolOutput(
  toolName: string,
  output: unknown
): ToolContractValidationResult {
  const contract = TOOL_CONTRACTS.get(toolName);

  if (!contract) {
    return {
      valid: true,
      errors: [],
      warnings: [
        {
          field: '_contract',
          message: `No contract registered for tool '${toolName}'`,
        },
      ],
    };
  }

  const errors: ToolContractValidationResult['errors'] = [];
  const warnings: ToolContractValidationResult['warnings'] = [];

  // Validate output against schema
  if (contract.outputSchema) {
    try {
      const schema = jsonSchemaToZod(contract.outputSchema);
      const result = schema.safeParse(output);

      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            field: issue.path.join('.') || '_root',
            message: issue.message,
            expected: String(issue.code),
            received:
              typeof output === 'object' && output !== null
                ? String((output as Record<string, unknown>)[issue.path[0] as string])
                : String(output),
          });
        }
      }
    } catch (e) {
      warnings.push({
        field: '_schema',
        message: `Could not validate schema: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Convert a simple JSON schema to Zod schema
 * Note: This is a simplified converter for common cases
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string;

  switch (type) {
    case 'string': {
      let strSchema = z.string();
      if (schema.minLength !== undefined) {
        strSchema = strSchema.min(schema.minLength as number);
      }
      if (schema.maxLength !== undefined) {
        strSchema = strSchema.max(schema.maxLength as number);
      }
      if (schema.enum !== undefined) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      return strSchema;
    }

    case 'number':
    case 'integer': {
      let numSchema = z.number();
      if (type === 'integer') numSchema = numSchema.int();
      if (schema.minimum !== undefined) {
        numSchema = numSchema.min(schema.minimum as number);
      }
      if (schema.maximum !== undefined) {
        numSchema = numSchema.max(schema.maximum as number);
      }
      return numSchema;
    }

    case 'boolean':
      return z.boolean();

    case 'array': {
      const itemSchema = schema.items
        ? jsonSchemaToZod(schema.items as Record<string, unknown>)
        : z.unknown();
      return z.array(itemSchema);
    }

    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = schema.required as string[] | undefined;

      if (!properties) {
        return z.record(z.string(), z.unknown());
      }

      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, prop] of Object.entries(properties)) {
        let propSchema = jsonSchemaToZod(prop);
        if (!required?.includes(key)) {
          propSchema = propSchema.optional();
        }
        shape[key] = propSchema;
      }
      return z.object(shape);
    }

    case 'null':
      return z.null();

    default:
      return z.unknown();
  }
}

/**
 * Generate test cases for a tool contract
 */
export function generateContractTestCases(contract: ToolContract): Array<{
  name: string;
  input: unknown;
  shouldPass: boolean;
}> {
  const testCases: Array<{ name: string; input: unknown; shouldPass: boolean }> = [];
  const properties = contract.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = contract.inputSchema.required as string[] | undefined;

  if (!properties) {
    // No input schema - just test with empty object
    testCases.push({
      name: `${contract.name}: empty input`,
      input: {},
      shouldPass: true,
    });
    return testCases;
  }

  // Test with all required fields
  const validInput: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (required?.includes(key)) {
      validInput[key] = getDefaultValue(prop);
    }
  }
  testCases.push({
    name: `${contract.name}: valid input with required fields`,
    input: validInput,
    shouldPass: true,
  });

  // Test with missing required fields
  if (required && required.length > 0) {
    testCases.push({
      name: `${contract.name}: missing required field '${required[0]}'`,
      input: {},
      shouldPass: false,
    });
  }

  // Test with invalid types
  for (const [key, prop] of Object.entries(properties)) {
    if (required?.includes(key)) {
      const invalidInput = { ...validInput };
      invalidInput[key] = getInvalidValue(prop);
      testCases.push({
        name: `${contract.name}: invalid type for '${key}'`,
        input: invalidInput,
        shouldPass: false,
      });
    }
  }

  return testCases;
}

/**
 * Get a default value for a JSON schema property
 */
function getDefaultValue(prop: Record<string, unknown>): unknown {
  const type = prop.type as string;
  const defaultVal = prop.default;

  if (defaultVal !== undefined) return defaultVal;

  switch (type) {
    case 'string':
      if (prop.enum) return (prop.enum as string[])[0];
      return 'test_value';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/**
 * Get an invalid value for a JSON schema property
 */
function getInvalidValue(prop: Record<string, unknown>): unknown {
  const type = prop.type as string;

  switch (type) {
    case 'string':
      return 12345; // Number instead of string
    case 'number':
    case 'integer':
      return 'not_a_number';
    case 'boolean':
      return 'not_a_boolean';
    case 'array':
      return 'not_an_array';
    case 'object':
      return 'not_an_object';
    default:
      return undefined;
  }
}

/**
 * Default tool contracts for core tools
 */
export function registerDefaultContracts(): void {
  // suggest_edit contract
  registerToolContract({
    name: 'suggest_edit',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path to edit' },
        intent: { type: 'string', description: 'What changes to make' },
        apply: { type: 'boolean', description: 'Whether to apply changes' },
        context: { type: 'string', description: 'Additional context' },
      },
      required: ['file_path', 'intent'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        path: { type: 'string' },
        intent: { type: 'string' },
        suggestions: { type: 'array' },
        summary: { type: 'string' },
        applied: { type: 'number' },
      },
      required: ['success', 'path', 'intent', 'suggestions', 'summary'],
    },
    sideEffects: ['read', 'write'],
    timeout: 60000,
    retryable: true,
  });

  // security contract
  registerToolContract({
    name: 'security',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'risk', 'redact', 'fix'] },
        root: { type: 'string' },
        content: { type: 'string' },
        apply: { type: 'boolean' },
      },
      required: ['action'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        findings: { type: 'array' },
        statistics: { type: 'object' },
        fixes: { type: 'array' },
      },
    },
    sideEffects: ['read', 'write'],
    timeout: 120000,
    retryable: true,
  });

  // search contract
  registerToolContract({
    name: 'search',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['intelligent', 'structured', 'gather', 'filenames'] },
        query: { type: 'string' },
        root: { type: 'string' },
        exhaustive: { type: 'boolean' },
        // outputFormat kept for backward compatibility with older callers
        outputFormat: { type: 'string', enum: ['compact', 'dense', 'detailed', 'json'] },
        format: { type: 'string', enum: ['compact', 'dense', 'detailed', 'json'] },
      },
      required: ['action', 'query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array' },
        totalMatches: { type: 'number' },
        summary: { type: 'string' },
      },
    },
    sideEffects: ['read'],
    timeout: 60000,
    retryable: true,
  });

  // find_and_fix contract
  registerToolContract({
    name: 'find_and_fix',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        intent: { type: 'string', description: 'What fix to apply' },
        root: { type: 'string', description: 'Directory to search' },
        apply: { type: 'boolean', description: 'Whether to apply fixes' },
        maxFiles: { type: 'number', description: 'Maximum files to process' },
      },
      required: ['query', 'intent'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        filesAnalyzed: { type: 'number' },
        suggestionsGenerated: { type: 'number' },
        suggestionsApplied: { type: 'number' },
        results: { type: 'array' },
        summary: { type: 'string' },
      },
      required: ['success'],
    },
    sideEffects: ['read', 'write'],
    timeout: 180000,
    retryable: true,
  });
}

// Initialize default contracts
registerDefaultContracts();
