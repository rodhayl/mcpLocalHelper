/**
 * Orchestration types - Re-exports from main types file
 *
 * V25 cleanup: Removed unused interfaces (OrchestratorOptions, StepBuildResponse,
 * PlanCorrectionResponse) that were designed but never integrated.
 *
 * Phase 2 cleanup: Consolidated duplicate interface definitions from cli-orchestrator.ts
 * and orchestration-service.ts. Renamed to avoid collision with src/types/index.ts interfaces.
 */
import type {
  OrchestrationStatus,
  OrchestrationStep,
  OrchestrationPlan,
  VerificationResult,
  OrchestrationResult,
  QuickVerification,
  CliToolResult,
} from '../types/index.js';

export type {
  OrchestrationStatus,
  OrchestrationStep,
  OrchestrationPlan,
  VerificationResult,
  OrchestrationResult,
  QuickVerification,
  CliToolResult,
};

/**
 * CLI Backend interface for CliOrchestrator
 *
 * This is a simplified interface used internally by the orchestrator.
 * Different from CliToolAdapter in src/adapters/cli-tool.ts which is the base class.
 * The OrchestrationService wraps adapters to match this interface.
 */
export interface OrchestratorCliBackend {
  id: string;
  model?: string;
  executeTask(prompt: string): Promise<CliToolResult>;
  probe(): Promise<{ available: boolean; error?: string }>;
}

/**
 * LLM Backend interface for CliOrchestrator
 *
 * This is a simplified interface used internally by the orchestrator for planning/verification.
 * Different from LlmBackend in src/types/index.ts which is the full adapter interface.
 * The OrchestrationService wraps LlmChatTool to match this interface.
 */
export interface OrchestratorLlmBackend {
  id: string;
  invokeChat(req: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  }): Promise<{
    message: { role: 'assistant'; content: string };
  }>;
}
