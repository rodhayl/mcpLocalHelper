/**
 * Model Capability Tests - Phase 2
 *
 * Tests for model capability detection and analysis.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  analyzeModel,
  parseParameterSize,
  isCodeSpecialized,
  estimateCapabilityLevel,
  selectPromptTemplate,
  getTaskSuitability,
} from '../src/utils/model-analyzer.js';
import { ModelInfoTool } from '../src/tools/model.js';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';

describe('Model Analyzer', () => {
  describe('parseParameterSize', () => {
    it('should parse standard billion parameter notation', () => {
      expect(parseParameterSize('llama2-7b').billions).toBe(7);
      expect(parseParameterSize('llama2-13b').billions).toBe(13);
      expect(parseParameterSize('codellama-34B').billions).toBe(34);
    });

    it('should parse decimal parameter sizes', () => {
      expect(parseParameterSize('qwen-1.8b').billions).toBe(1.8);
      expect(parseParameterSize('deepseek-coder-6.7b').billions).toBe(6.7);
    });

    it('should parse MoE models from known families', () => {
      const result = parseParameterSize('mixtral-8x7b');
      expect(result.billions).toBe(46.7); // Known value from MODEL_FAMILY_SIZES
      expect(result.size).toBe('46.7B');
    });

    it('should return null for unknown formats', () => {
      const result = parseParameterSize('gpt-4');
      expect(result.billions).toBeNull();
    });

    it('should handle known model families', () => {
      expect(parseParameterSize('phi-3-mini').billions).toBe(3.8);
      expect(parseParameterSize('tinyllama').billions).toBe(1.1);
    });
  });

  describe('isCodeSpecialized', () => {
    it('should identify code models', () => {
      expect(isCodeSpecialized('codellama-7b')).toBe(true);
      expect(isCodeSpecialized('starcoder2-15b')).toBe(true);
      expect(isCodeSpecialized('deepseek-coder-33b')).toBe(true);
      expect(isCodeSpecialized('wizardcoder-python-34b')).toBe(true);
    });

    it('should not flag general models', () => {
      expect(isCodeSpecialized('llama2-7b')).toBe(false);
      expect(isCodeSpecialized('mistral-7b')).toBe(false);
      expect(isCodeSpecialized('gemma-7b')).toBe(false);
    });
  });

  describe('estimateCapabilityLevel', () => {
    it('should classify basic models', () => {
      expect(estimateCapabilityLevel(1.5, false)).toBe('basic');
      expect(estimateCapabilityLevel(2, false)).toBe('basic');
    });

    it('should classify standard models', () => {
      expect(estimateCapabilityLevel(7, false)).toBe('standard');
      expect(estimateCapabilityLevel(13, false)).toBe('standard');
    });

    it('should classify advanced models', () => {
      expect(estimateCapabilityLevel(34, false)).toBe('advanced');
      expect(estimateCapabilityLevel(70, false)).toBe('advanced');
    });

    it('should boost code-specialized models', () => {
      // 7B code model gets ~10.5B effective, still standard
      expect(estimateCapabilityLevel(7, true)).toBe('standard');
      // 13B code model gets ~19.5B effective, advanced
      expect(estimateCapabilityLevel(13, true)).toBe('advanced');
    });
  });

  describe('analyzeModel', () => {
    it('should return complete capabilities for a known model', () => {
      const result = analyzeModel('codellama-7b');

      expect(result.id).toBe('codellama-7b');
      expect(result.parameterBillions).toBe(7);
      expect(result.isCodeSpecialized).toBe(true);
      expect(result.estimatedCapability).toBe('standard');
      expect(result.recommendedTasks).toBeInstanceOf(Array);
      expect(result.cautionTasks).toBeInstanceOf(Array);
      expect(result.contextLength).toBeGreaterThan(0);
    });

    it('should handle custom model name', () => {
      const result = analyzeModel('my-custom-model', 'Custom Model 70B');

      expect(result.id).toBe('my-custom-model');
      expect(result.name).toBe('Custom Model 70B');
      expect(result.parameterBillions).toBe(70);
    });

    it('should handle unknown models gracefully', () => {
      const result = analyzeModel('unknown-model');

      expect(result.id).toBe('unknown-model');
      expect(result.parameterBillions).toBeNull();
      expect(result.isCodeSpecialized).toBe(false);
      expect(result.estimatedCapability).toBe('basic');
    });
  });

  describe('getTaskSuitability', () => {
    it('should return suitability info for basic models', () => {
      const basicModel = analyzeModel('tinyllama');
      const result = getTaskSuitability(basicModel, 'text summarization');

      // Basic models should have suitability info regardless of task
      expect(result.suitable).toBeDefined();
      expect(result.confidence).toBeDefined();
      expect(result.reason).toBeDefined();
    });

    it('should caution against complex tasks for basic models', () => {
      const basicModel = analyzeModel('tinyllama');
      const result = getTaskSuitability(basicModel, 'complex refactoring');

      // Basic models should not be suitable for complex tasks
      expect(result.suitable).toBe(false);
    });

    it('should recommend code tasks for code-specialized models', () => {
      const codeModel = analyzeModel('codellama-34b');
      const result = getTaskSuitability(codeModel, 'code generation');

      expect(result.suitable).toBe(true);
    });
  });

  describe('selectPromptTemplate', () => {
    it('should select concise prompts for basic models', () => {
      const basicModel = analyzeModel('tinyllama');

      expect(selectPromptTemplate(basicModel, 'summarize')).toBe('concise');
      expect(selectPromptTemplate(basicModel, 'analyze')).toBe('concise');
    });

    it('should select detailed prompts for advanced models', () => {
      const advancedModel = analyzeModel('llama2-70b');

      expect(selectPromptTemplate(advancedModel, 'analyze')).toBe('detailed');
      expect(selectPromptTemplate(advancedModel, 'verify')).toBe('detailed');
    });
  });
});

describe('ModelInfoTool', () => {
  let configManager: ConfigManager;
  let backendManager: BackendManager;
  let modelInfoTool: ModelInfoTool;

  beforeEach(() => {
    // Create config manager with test config
    configManager = new ConfigManager();
    backendManager = new BackendManager(configManager.getConfig().backends);
    modelInfoTool = new ModelInfoTool(configManager, backendManager);
  });

  describe('quickAnalyze', () => {
    it('should analyze model name without backend access', () => {
      const result = modelInfoTool.quickAnalyze('codellama-13b');

      expect(result.parameterSize).toBe('13B');
      expect(result.parameterBillions).toBe(13);
      expect(result.isCodeSpecialized).toBe(true);
    });
  });

  describe('getModelCapabilities', () => {
    it('should return full capability analysis', () => {
      const result = modelInfoTool.getModelCapabilities('qwen2.5-7b', 'Qwen 2.5 7B');

      expect(result.id).toBe('qwen2.5-7b');
      expect(result.name).toBe('Qwen 2.5 7B');
      expect(result.parameterBillions).toBe(7);
      expect(result.recommendedTasks.length).toBeGreaterThan(0);
    });
  });

  describe('checkTaskSuitability', () => {
    it('should check task suitability', () => {
      const result = modelInfoTool.checkTaskSuitability(
        'starcoder2-15b',
        'code review',
        'StarCoder 2 15B'
      );

      expect(result.modelId).toBe('starcoder2-15b');
      expect(result.taskType).toBe('code review');
      expect(result.suitable).toBeDefined();
      expect(result.confidence).toBeDefined();
      expect(result.capabilities).toBeDefined();
    });
  });

  describe('getBackendModels', () => {
    it('should handle unavailable backend gracefully', async () => {
      const result = await modelInfoTool.getBackendModels('non-existent-backend');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
