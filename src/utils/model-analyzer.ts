/**
 * Model Analyzer Utility
 *
 * Analyzes LLM model identifiers to estimate capabilities based on:
 * - Model name patterns
 * - Parameter count
 * - Known model families
 * - Code specialization indicators
 */

import { ModelCapabilities, ModelCapabilityLevel } from '../types/index.js';

// Known code-specialized model patterns
const CODE_MODEL_PATTERNS = [
  /codellama/i,
  /starcoder/i,
  /codegeex/i,
  /codegen/i,
  /deepseek.*coder/i,
  /qwen.*coder/i,
  /phind/i,
  /wizardcoder/i,
  /magicoder/i,
  /codestral/i,
  /stable.*code/i,
  /granite.*code/i,
  /code.*gemma/i,
];

// Model families with known parameter counts
const MODEL_FAMILY_SIZES: Record<string, { minBillions: number; maxBillions: number }> = {
  'phi-2': { minBillions: 2.7, maxBillions: 2.7 },
  'phi-3-mini': { minBillions: 3.8, maxBillions: 3.8 },
  'phi-3-small': { minBillions: 7, maxBillions: 7 },
  'phi-3-medium': { minBillions: 14, maxBillions: 14 },
  tinyllama: { minBillions: 1.1, maxBillions: 1.1 },
  'gemma-2b': { minBillions: 2, maxBillions: 2 },
  'gemma-7b': { minBillions: 7, maxBillions: 7 },
  'gemma2-2b': { minBillions: 2, maxBillions: 2 },
  'gemma2-9b': { minBillions: 9, maxBillions: 9 },
  'gemma2-27b': { minBillions: 27, maxBillions: 27 },
  'llama2-7b': { minBillions: 7, maxBillions: 7 },
  'llama2-13b': { minBillions: 13, maxBillions: 13 },
  'llama2-70b': { minBillions: 70, maxBillions: 70 },
  'llama3-8b': { minBillions: 8, maxBillions: 8 },
  'llama3-70b': { minBillions: 70, maxBillions: 70 },
  'llama3.1-8b': { minBillions: 8, maxBillions: 8 },
  'llama3.1-70b': { minBillions: 70, maxBillions: 70 },
  'llama3.2-1b': { minBillions: 1, maxBillions: 1 },
  'llama3.2-3b': { minBillions: 3, maxBillions: 3 },
  'codellama-7b': { minBillions: 7, maxBillions: 7 },
  'codellama-13b': { minBillions: 13, maxBillions: 13 },
  'codellama-34b': { minBillions: 34, maxBillions: 34 },
  'mistral-7b': { minBillions: 7, maxBillions: 7 },
  'mixtral-8x7b': { minBillions: 46.7, maxBillions: 46.7 }, // MoE total params
  'mixtral-8x22b': { minBillions: 141, maxBillions: 141 },
  'deepseek-coder-1.3b': { minBillions: 1.3, maxBillions: 1.3 },
  'deepseek-coder-6.7b': { minBillions: 6.7, maxBillions: 6.7 },
  'deepseek-coder-33b': { minBillions: 33, maxBillions: 33 },
  'qwen-0.5b': { minBillions: 0.5, maxBillions: 0.5 },
  'qwen-1.8b': { minBillions: 1.8, maxBillions: 1.8 },
  'qwen-4b': { minBillions: 4, maxBillions: 4 },
  'qwen-7b': { minBillions: 7, maxBillions: 7 },
  'qwen-14b': { minBillions: 14, maxBillions: 14 },
  'qwen-72b': { minBillions: 72, maxBillions: 72 },
  'qwen2.5-0.5b': { minBillions: 0.5, maxBillions: 0.5 },
  'qwen2.5-1.5b': { minBillions: 1.5, maxBillions: 1.5 },
  'qwen2.5-3b': { minBillions: 3, maxBillions: 3 },
  'qwen2.5-7b': { minBillions: 7, maxBillions: 7 },
  'qwen2.5-14b': { minBillions: 14, maxBillions: 14 },
  'qwen2.5-32b': { minBillions: 32, maxBillions: 32 },
  'qwen2.5-72b': { minBillions: 72, maxBillions: 72 },
  'starcoder-1b': { minBillions: 1, maxBillions: 1 },
  'starcoder-3b': { minBillions: 3, maxBillions: 3 },
  'starcoder-7b': { minBillions: 7, maxBillions: 7 },
  'starcoder-15b': { minBillions: 15.5, maxBillions: 15.5 },
  'starcoder2-3b': { minBillions: 3, maxBillions: 3 },
  'starcoder2-7b': { minBillions: 7, maxBillions: 7 },
  'starcoder2-15b': { minBillions: 15, maxBillions: 15 },
};

// Task recommendations based on capability level
const TASK_RECOMMENDATIONS: Record<
  ModelCapabilityLevel,
  { recommended: string[]; caution: string[] }
> = {
  basic: {
    recommended: [
      'Simple text summarization',
      'Basic code explanation',
      'File content description',
      'Keyword extraction',
      'Simple Q&A about code',
    ],
    caution: [
      'Complex code generation',
      'Multi-file refactoring',
      'Deep logical reasoning',
      'Long context analysis',
      'Architecture planning',
    ],
  },
  standard: {
    recommended: [
      'Code summarization',
      'Single-file code review',
      'Bug explanation',
      'Documentation generation',
      'Test case suggestions',
      'Code pattern identification',
    ],
    caution: [
      'Large codebase analysis',
      'Complex multi-step refactoring',
      'Architectural decisions',
      'Security vulnerability analysis',
    ],
  },
  advanced: {
    recommended: [
      'Complex code generation',
      'Multi-file analysis',
      'Architecture review',
      'Comprehensive refactoring',
      'Deep code reasoning',
      'Security analysis',
      'Test gap identification',
      'Documentation synthesis',
      'Codebase Q&A',
    ],
    caution: ['Very large context (>100 files)', 'Critical security decisions'],
  },
};

// Context length estimates based on parameter size
function estimateContextLength(parameterBillions: number | null): number {
  if (parameterBillions === null) return 4096;
  if (parameterBillions < 2) return 2048;
  if (parameterBillions < 7) return 4096;
  if (parameterBillions < 14) return 8192;
  if (parameterBillions < 30) return 16384;
  if (parameterBillions < 70) return 32768;
  return 65536;
}

/**
 * Parse parameter count from model name
 */
export function parseParameterSize(modelName: string): {
  size: string | null;
  billions: number | null;
} {
  // Normalize name for matching
  const normalized = modelName.toLowerCase().replace(/[_:]/g, '-');

  // Check for known model families first
  for (const [family, sizes] of Object.entries(MODEL_FAMILY_SIZES)) {
    if (normalized.includes(family.toLowerCase())) {
      const avgBillions = (sizes.minBillions + sizes.maxBillions) / 2;
      return {
        size: `${avgBillions}B`,
        billions: avgBillions,
      };
    }
  }

  // Try to extract parameter count from name
  // Patterns: 7b, 7B, 7-b, 7_b, 7.5b, 7.5B
  const patterns = [
    /(\d+\.?\d*)\s*[bB](?:illion)?/, // "7b", "7B", "7.5b", "7 billion"
    /-(\d+\.?\d*)[bB]/, // "-7b"
    /_(\d+\.?\d*)[bB]/, // "_7b"
    /(\d+\.?\d*)x(\d+\.?\d*)[bB]/, // "8x7b" (MoE)
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      // Handle MoE pattern (e.g., 8x7b)
      if (match[2]) {
        const experts = parseFloat(match[1]);
        const expertSize = parseFloat(match[2]);
        const totalBillions = experts * expertSize;
        return {
          size: `${match[1]}x${match[2]}B (MoE ~${totalBillions}B)`,
          billions: totalBillions,
        };
      }

      const billions = parseFloat(match[1]);
      return {
        size: `${billions}B`,
        billions,
      };
    }
  }

  return { size: null, billions: null };
}

/**
 * Check if model is code-specialized
 */
export function isCodeSpecialized(modelName: string): boolean {
  return CODE_MODEL_PATTERNS.some((pattern) => pattern.test(modelName));
}

/**
 * Estimate capability level based on model properties
 */
export function estimateCapabilityLevel(
  parameterBillions: number | null,
  isCodeModel: boolean
): ModelCapabilityLevel {
  // Code-specialized models get a boost
  const effectiveBillions = isCodeModel ? (parameterBillions ?? 0) * 1.5 : (parameterBillions ?? 0);

  if (effectiveBillions < 3) return 'basic';
  if (effectiveBillions < 15) return 'standard';
  return 'advanced';
}

/**
 * Main function to analyze a model and return capabilities
 */
export function analyzeModel(modelId: string, modelName?: string): ModelCapabilities {
  const nameToAnalyze = modelName || modelId;
  const { size, billions } = parseParameterSize(nameToAnalyze);
  const codeSpecialized = isCodeSpecialized(nameToAnalyze);
  const capabilityLevel = estimateCapabilityLevel(billions, codeSpecialized);
  const tasks = TASK_RECOMMENDATIONS[capabilityLevel];
  const contextLength = estimateContextLength(billions);

  return {
    id: modelId,
    name: modelName || modelId,
    parameterSize: size,
    parameterBillions: billions,
    isCodeSpecialized: codeSpecialized,
    estimatedCapability: capabilityLevel,
    recommendedTasks: tasks.recommended,
    cautionTasks: tasks.caution,
    contextLength,
  };
}

/**
 * Analyze multiple models at once
 */
export function analyzeModels(models: Array<{ id: string; name?: string }>): ModelCapabilities[] {
  return models.map((m) => analyzeModel(m.id, m.name));
}

/**
 * Get task suitability based on model capabilities
 */
export function getTaskSuitability(
  capabilities: ModelCapabilities,
  taskType: string
): { suitable: boolean; confidence: 'high' | 'medium' | 'low'; reason: string } {
  const normalizedTask = taskType.toLowerCase();

  // Check if task is in recommended list
  const isRecommended = capabilities.recommendedTasks.some(
    (t) => normalizedTask.includes(t.toLowerCase()) || t.toLowerCase().includes(normalizedTask)
  );

  // Check if task is in caution list
  const needsCaution = capabilities.cautionTasks.some(
    (t) => normalizedTask.includes(t.toLowerCase()) || t.toLowerCase().includes(normalizedTask)
  );

  if (isRecommended && !needsCaution) {
    return {
      suitable: true,
      confidence: 'high',
      reason: `This task type is well-suited for ${capabilities.estimatedCapability}-level models like ${capabilities.name}`,
    };
  }

  if (needsCaution) {
    return {
      suitable: false,
      confidence: 'medium',
      reason: `This task may exceed the capabilities of a ${capabilities.estimatedCapability}-level model. Consider using a larger model.`,
    };
  }

  // Unknown task - base on capability level
  const baseConfidence = capabilities.estimatedCapability === 'advanced' ? 'medium' : 'low';
  return {
    suitable: capabilities.estimatedCapability !== 'basic',
    confidence: baseConfidence,
    reason: `Task suitability unknown. Model capability: ${capabilities.estimatedCapability}`,
  };
}

/**
 * Get capability-appropriate prompt template selection
 */
export function selectPromptTemplate(
  capabilities: ModelCapabilities,
  taskType: 'summarize' | 'analyze' | 'verify' | 'generate'
): 'concise' | 'standard' | 'detailed' {
  const { estimatedCapability } = capabilities;

  switch (taskType) {
    case 'summarize':
      // All models can summarize, but adjust output expectations
      return estimatedCapability === 'basic' ? 'concise' : 'standard';

    case 'analyze':
      // Analysis needs more capability
      return estimatedCapability === 'advanced'
        ? 'detailed'
        : estimatedCapability === 'standard'
          ? 'standard'
          : 'concise';

    case 'verify':
      // Verification benefits from detailed prompts for capable models
      return estimatedCapability === 'advanced' ? 'detailed' : 'standard';

    case 'generate':
      // Code generation scales with capability
      return estimatedCapability === 'advanced'
        ? 'detailed'
        : estimatedCapability === 'standard'
          ? 'standard'
          : 'concise';

    default:
      return 'standard';
  }
}
