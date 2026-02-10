export { PlanManager } from './plan-manager.js';
export { CliOrchestrator } from './cli-orchestrator.js';
export {
  OrchestrationService,
  initOrchestrationService,
  getOrchestrationService,
} from './orchestration-service.js';
export * from './types.js';

// Unified CLI executor (V25)
export {
  DirectCliExecutor,
  createDirectCliExecutor,
  createOpenCodeExecutor,
  createCopilotExecutor,
  CLI_BACKEND_DEFAULTS,
  type CliBackendType,
  type CliBackendConfig,
  type DirectExecutionResult,
  type BatchExecutionRequest,
  type BatchExecutionResult,
} from './direct-cli-executor.js';

// Per-tool orchestration
export {
  ToolOrchestrationManager,
  getToolOrchestrationManager,
  initToolOrchestrationManager,
  ALL_LLM_TOOLS,
  TOOL_CATEGORIES,
  // V21 (QA_feedback_8): Export routing log functions for mcp_health visibility
  getRoutingLogs,
  getRoutingStats,
  addRoutingLog,
  type RoutingLogEntry,
  type ToolOrchestrationConfig,
  type GlobalOrchestrationSettings,
  type ToolOrchestrationResult,
  type ToolOrchestrationContext,
  type LlmToolName,
  type ToolCategory,
} from './tool-orchestration-manager.js';

export {
  ToolLlmWrapper,
  getToolLlmWrapper,
  shouldUseOrchestration,
  logToolExecutionMode,
  type ToolChatOptions,
  type ToolChatResult,
} from './tool-llm-wrapper.js';
