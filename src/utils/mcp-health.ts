import { ProbeResult } from '../types/index.js';

export type McpHealthStatus = 'healthy' | 'degraded';

export interface McpHealthComputation {
  healthy: boolean;
  status: McpHealthStatus;
  llmAvailable: boolean;
  defaultLocalBackendHealthy: boolean;
  workingBackendNames: string[];
  backendIssues: string[];
  warning?: string;
  nextSteps?: string[];
}

export function computeMcpHealthFromProbes(options: {
  probeResults: Map<string, ProbeResult>;
  defaultLocalBackendId?: string | null;
}): McpHealthComputation {
  const { probeResults, defaultLocalBackendId } = options;

  const allBackendIssues: string[] = [];
  const workingBackendNames: string[] = [];

  for (const [backendId, probe] of probeResults.entries()) {
    if (probe.available) {
      workingBackendNames.push(backendId);
    } else {
      allBackendIssues.push(`${backendId}: ${probe.error || 'unavailable'}`);
    }
  }

  const llmAvailable = workingBackendNames.length > 0;
  // Preserve partial-outage diagnostics even when at least one backend is available.
  // Overall health remains "healthy" while clients can still detect fallback scenarios.
  const backendIssues = allBackendIssues;
  const defaultLocalProbe = defaultLocalBackendId
    ? probeResults.get(defaultLocalBackendId)
    : undefined;
  const defaultLocalBackendHealthy =
    defaultLocalBackendId == null ? llmAvailable : (defaultLocalProbe?.available ?? false);

  // V21 (QA_feedback_8): Health status is 'healthy' if ANY backend is available
  // The system is functional as long as we have at least one working backend
  // We only show 'degraded' if NO backends are available at all
  const status: McpHealthStatus = llmAvailable ? 'healthy' : 'degraded';
  let warning: string | undefined;
  let nextSteps: string[] | undefined;

  if (!llmAvailable) {
    warning = `No LLM backends available: ${backendIssues.join('; ')}. Please start LM Studio or Ollama and load a model.`;
    nextSteps = [
      'Start LM Studio and load a model, OR',
      'Run "ollama serve" and pull a model (e.g., "ollama pull llama3.2")',
    ];
  }

  return {
    healthy: llmAvailable,
    status,
    llmAvailable,
    defaultLocalBackendHealthy,
    workingBackendNames,
    backendIssues,
    ...(warning ? { warning } : {}),
    ...(nextSteps ? { nextSteps } : {}),
  };
}
