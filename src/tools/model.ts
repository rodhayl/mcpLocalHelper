/**
 * Model Information Tool
 *
 * Provides model capability detection and analysis for local LLM backends.
 * Exposes a tool to get model info and capabilities.
 */

import { ConfigManager } from '../config/index.js';
import { BackendManager } from '../adapters/factory.js';
import { ModelCapabilities } from '../types/index.js';
import {
  analyzeModel,
  analyzeModels,
  getTaskSuitability,
  parseParameterSize,
  isCodeSpecialized,
} from '../utils/model-analyzer.js';
import { diagnoseConnectionError } from '../utils/llm-error-helper.js';

export interface ModelInfoResult {
  success: boolean;
  backendId: string;
  backendKind: 'local' | 'sota';
  available: boolean;
  models?: ModelCapabilities[];
  currentModel?: ModelCapabilities;
  error?: string;
}

export interface TaskSuitabilityResult {
  modelId: string;
  modelName: string;
  taskType: string;
  suitable: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  capabilities: ModelCapabilities;
}

export class ModelInfoTool {
  constructor(
    private config: ConfigManager,
    private backendManager: BackendManager
  ) {}

  /**
   * Get model info for a specific backend
   */
  async getBackendModels(backendId?: string): Promise<ModelInfoResult> {
    try {
      // If no backend specified, use the default local backend
      const targetId = backendId || this.getDefaultLocalBackendId();
      const port = this.config.getConfig().server?.port ?? 3000;
      const configUrl = `http://localhost:${port}/`;

      if (!targetId) {
        return {
          success: false,
          backendId: 'unknown',
          backendKind: 'local',
          available: false,
          error: diagnoseConnectionError(
            new Error('No local backend configured'),
            'local',
            configUrl
          ).message,
        };
      }

      const backend = this.backendManager.getBackend(targetId);
      if (!backend) {
        return {
          success: false,
          backendId: targetId,
          backendKind: 'local',
          available: false,
          error: diagnoseConnectionError(
            new Error(`Backend '${targetId}' not found`),
            targetId,
            configUrl
          ).message,
        };
      }

      // Probe backend availability
      const probeResult = await backend.probe();
      if (!probeResult.available) {
        return {
          success: false,
          backendId: targetId,
          backendKind: backend.kind,
          available: false,
          error: diagnoseConnectionError(
            new Error(probeResult.error || 'Backend not available'),
            targetId,
            configUrl
          ).message,
        };
      }

      // List and analyze models
      let modelList;
      try {
        modelList = await backend.listModels();
      } catch (err) {
        throw diagnoseConnectionError(err, targetId, configUrl);
      }

      const analyzedModels = analyzeModels(modelList.map((m) => ({ id: m.id, name: m.name })));

      // Determine current/default model
      const currentModelId = this.getCurrentModelId(targetId);
      const currentModel = currentModelId
        ? analyzedModels.find((m) => m.id === currentModelId) || analyzedModels[0]
        : analyzedModels[0];

      return {
        success: true,
        backendId: targetId,
        backendKind: backend.kind,
        available: true,
        models: analyzedModels,
        currentModel,
      };
    } catch (error) {
      return {
        success: false,
        backendId: backendId || 'unknown',
        backendKind: 'local',
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get all backend models across all configured backends
   */
  async getAllBackendModels(): Promise<Record<string, ModelInfoResult>> {
    const results: Record<string, ModelInfoResult> = {};
    const backends = this.backendManager.getAllBackends();

    for (const backend of backends) {
      results[backend.id] = await this.getBackendModels(backend.id);
    }

    return results;
  }

  /**
   * Get capability analysis for a specific model
   */
  getModelCapabilities(modelId: string, modelName?: string): ModelCapabilities {
    return analyzeModel(modelId, modelName);
  }

  /**
   * Check if a task is suitable for a given model
   */
  checkTaskSuitability(
    modelId: string,
    taskType: string,
    modelName?: string
  ): TaskSuitabilityResult {
    const capabilities = analyzeModel(modelId, modelName);
    const suitability = getTaskSuitability(capabilities, taskType);

    return {
      modelId,
      modelName: modelName || modelId,
      taskType,
      ...suitability,
      capabilities,
    };
  }

  /**
   * Get the best model for a specific task type from available models
   */
  async recommendModelForTask(
    taskType: string,
    backendId?: string
  ): Promise<{
    recommended: ModelCapabilities | null;
    alternatives: ModelCapabilities[];
    reason: string;
  }> {
    const result = await this.getBackendModels(backendId);

    if (!result.success || !result.models || result.models.length === 0) {
      return {
        recommended: null,
        alternatives: [],
        reason: result.error || 'No models available',
      };
    }

    // Sort models by capability level and code specialization
    const sorted = [...result.models].sort((a, b) => {
      // Prefer code-specialized models for code tasks
      const isCodeTask = /code|program|debug|refactor/i.test(taskType);
      if (isCodeTask) {
        if (a.isCodeSpecialized && !b.isCodeSpecialized) return -1;
        if (!a.isCodeSpecialized && b.isCodeSpecialized) return 1;
      }

      // Sort by capability level
      const levels = { basic: 0, standard: 1, advanced: 2 };
      const levelDiff = levels[b.estimatedCapability] - levels[a.estimatedCapability];
      if (levelDiff !== 0) return levelDiff;

      // Tie-breaker: parameter count
      return (b.parameterBillions ?? 0) - (a.parameterBillions ?? 0);
    });

    const recommended = sorted[0];
    const suitability = getTaskSuitability(recommended, taskType);

    return {
      recommended,
      alternatives: sorted.slice(1),
      reason: suitability.reason,
    };
  }

  /**
   * Quick analysis of a model name (without backend access)
   */
  quickAnalyze(modelName: string): {
    parameterSize: string | null;
    parameterBillions: number | null;
    isCodeSpecialized: boolean;
  } {
    const { size, billions } = parseParameterSize(modelName);
    return {
      parameterSize: size,
      parameterBillions: billions,
      isCodeSpecialized: isCodeSpecialized(modelName),
    };
  }

  private getDefaultLocalBackendId(): string | null {
    const backends = this.backendManager.getAllBackends();
    const localBackend = backends.find((b) => b.kind === 'local');
    return localBackend?.id || null;
  }

  private getCurrentModelId(backendId: string): string | null {
    const config = this.config.getConfig();
    const defaults = config.defaults;

    // Check if this is the local backend
    if (defaults.localBackendId === backendId) {
      return defaults.localModel || null;
    }

    // Check if this is the SOTA backend
    if (defaults.sotaBackendId === backendId) {
      return defaults.sotaModel || null;
    }

    return null;
  }
}

/**
 * Tool handler for model_info MCP tool
 */
export async function handleModelInfoTool(
  tool: ModelInfoTool,
  params: {
    action: 'list' | 'analyze' | 'check_task' | 'recommend';
    backendId?: string;
    modelId?: string;
    modelName?: string;
    taskType?: string;
  }
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    switch (params.action) {
      case 'list': {
        const result = params.backendId
          ? await tool.getBackendModels(params.backendId)
          : await tool.getAllBackendModels();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'analyze': {
        if (!params.modelId) {
          return {
            content: [{ type: 'text', text: 'Error: modelId is required for analyze action' }],
            isError: true,
          };
        }
        const capabilities = tool.getModelCapabilities(params.modelId, params.modelName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(capabilities, null, 2),
            },
          ],
        };
      }

      case 'check_task': {
        if (!params.modelId || !params.taskType) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: modelId and taskType are required for check_task action',
              },
            ],
            isError: true,
          };
        }
        const suitability = tool.checkTaskSuitability(
          params.modelId,
          params.taskType,
          params.modelName
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(suitability, null, 2),
            },
          ],
        };
      }

      case 'recommend': {
        if (!params.taskType) {
          return {
            content: [{ type: 'text', text: 'Error: taskType is required for recommend action' }],
            isError: true,
          };
        }
        const recommendation = await tool.recommendModelForTask(params.taskType, params.backendId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(recommendation, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown action '${params.action}'. Valid actions: list, analyze, check_task, recommend`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
