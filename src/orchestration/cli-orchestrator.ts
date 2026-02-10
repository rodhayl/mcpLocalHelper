import {
  OrchestrationStep,
  OrchestrationResult,
  VerificationResult,
  QuickVerification,
  CliToolResult,
  OrchestrationTimingMetrics,
} from '../types/index.js';
import type { OrchestratorCliBackend, OrchestratorLlmBackend } from './types.js';

interface OrchestratorConfig {
  cliOrchestrationEnabled: boolean;
  cliOrchestrationBackends: string[];
  cliAutoVerify: boolean;
  cliScoreThreshold: number;
  cliMaxIterations: number;
}

// Default timeout values (in milliseconds)
const LLM_CALL_TIMEOUT_MS = 120000; // 2 minutes for LLM calls
const CLI_CALL_TIMEOUT_MS = 300000; // 5 minutes for CLI execution

/**
 * Wraps a promise with a timeout. Rejects with TimeoutError if timeout exceeded.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`[TIMEOUT] ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    return result;
  } catch (error) {
    clearTimeout(timeoutHandle!);
    throw error;
  }
}

/**
 * Helper to measure execution time of an async operation
 */
async function measureAsync<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - start);
  return { result, durationMs };
}

export class CliOrchestrator {
  private config: OrchestratorConfig;
  private planManager: PlanManager;
  private backends: Map<string, CliBackend>;
  private llm: LlmBackend;

  constructor(
    config: OrchestratorConfig,
    planManager: PlanManager,
    backends: Map<string, CliBackend>,
    llm: LlmBackend
  ) {
    this.config = config;
    this.planManager = planManager;
    this.backends = backends;
    this.llm = llm;
  }

  async orchestrate(task: string): Promise<OrchestrationResult> {
    // Initialize timing metrics
    const startTime = new Date().toISOString();
    const orchestrationStartMs = performance.now();
    const timing: OrchestrationTimingMetrics = {
      llmPlanningMs: 0,
      llmVerificationMs: 0,
      llmFinalVerificationMs: 0,
      llmTotalMs: 0,
      llmCallCount: 0,
      cliExecutionMs: 0,
      cliCallCount: 0,
      cliBackendUsed: '',
      cliModelUsed: '',
      totalMs: 0,
      stepsExecuted: 0,
      startTime,
      endTime: '',
    };

    if (!this.config.cliOrchestrationEnabled) {
      timing.endTime = new Date().toISOString();
      timing.totalMs = Math.round(performance.now() - orchestrationStartMs);
      return {
        success: false,
        planId: '',
        score: 0,
        verification: {
          score: 0,
          reasoning: 'CLI orchestration is not enabled',
          completedAreas: [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 0,
        error: 'CLI orchestration is not enabled',
        timing,
      };
    }

    const plan = this.planManager.createPlan(
      task,
      this.config.cliScoreThreshold,
      this.config.cliMaxIterations
    );

    try {
      // ⏱️ Measure LLM planning time
      const { result: steps, durationMs: planningMs } = await measureAsync(() =>
        this.buildSteps(task, plan.id)
      );
      timing.llmPlanningMs = planningMs;
      timing.llmCallCount++;
      this.log('info', `⏱️ [TIMING] LLM planning took ${planningMs}ms`);

      let currentSteps = steps;
      for (const step of currentSteps) {
        this.planManager.addStep(plan.id, step);
      }

      let currentStep = 0;

      while (currentStep < currentSteps.length) {
        const step = currentSteps[currentStep];
        const backendMeta = this.backends.get(step.cliBackend) as any;
        if (backendMeta?.model && !timing.cliModelUsed) {
          timing.cliModelUsed = String(backendMeta.model);
        }

        // ⏱️ Measure CLI execution time
        const { result, durationMs: execMs } = await measureAsync(() => this.executeStep(step));
        timing.cliExecutionMs += execMs;
        timing.cliCallCount++;
        timing.stepsExecuted++;
        timing.cliBackendUsed = step.cliBackend;
        this.log('info', `⏱️ [TIMING] CLI execution step ${step.id} took ${execMs}ms`);

        this.planManager.updateStep(plan.id, step.id, {
          status: result.success ? 'completed' : 'failed',
          result,
        });
        this.planManager.saveResult(plan.id, step.id, result);

        if (!result.success) {
          this.log('warn', `Step ${step.id} failed`, { error: result.error });
        }

        if (this.config.cliAutoVerify) {
          // ⏱️ Measure quick verification time
          const { result: llmAssessment, durationMs: quickVerifyMs } = await measureAsync(() =>
            this.quickVerify(step, result)
          );
          timing.llmVerificationMs += quickVerifyMs;
          timing.llmCallCount++;
          this.log('info', `⏱️ [TIMING] LLM quick verify took ${quickVerifyMs}ms`);

          if (llmAssessment.isComplete) {
            // ⏱️ Measure final verification time
            const { result: verification, durationMs: finalVerifyMs } = await measureAsync(() =>
              this.cliFinalVerify(step, result)
            );
            timing.llmFinalVerificationMs += finalVerifyMs;
            timing.llmCallCount++;
            this.log('info', `⏱️ [TIMING] LLM final verify took ${finalVerifyMs}ms`);

            this.planManager.updateStep(plan.id, step.id, { verification });

            if (verification.score >= this.config.cliScoreThreshold) {
              currentStep++;
            } else {
              const updatedPlan = this.planManager.getPlan(plan.id);
              if (updatedPlan && updatedPlan.iterations >= this.config.cliMaxIterations) {
                timing.endTime = new Date().toISOString();
                timing.totalMs = Math.round(performance.now() - orchestrationStartMs);
                timing.llmTotalMs =
                  timing.llmPlanningMs + timing.llmVerificationMs + timing.llmFinalVerificationMs;
                return {
                  success: false,
                  planId: plan.id,
                  score: verification.score,
                  verification,
                  iterations: updatedPlan.iterations,
                  error: 'Max iterations reached',
                  timing,
                };
              }

              await this.updatePlanWithCorrections(plan.id, verification);
              timing.llmCallCount++; // Correction planning uses LLM

              const newPlan = this.planManager.getPlan(plan.id);
              if (newPlan) {
                currentSteps = newPlan.steps;
              }
            }
          } else {
            currentStep++;
          }
        } else {
          currentStep++;
        }
      }

      // ⏱️ Measure full task verification time
      const { result: finalVerification, durationMs: fullVerifyMs } = await measureAsync(() =>
        this.verifyFullTaskCompletion(plan.id)
      );
      timing.llmFinalVerificationMs += fullVerifyMs;
      timing.llmCallCount++;
      this.log('info', `⏱️ [TIMING] LLM full verification took ${fullVerifyMs}ms`);

      this.planManager.updatePlan(plan.id, {
        status: finalVerification.score >= this.config.cliScoreThreshold ? 'completed' : 'failed',
        score: finalVerification.score,
      });

      // Finalize timing metrics
      timing.endTime = new Date().toISOString();
      timing.totalMs = Math.round(performance.now() - orchestrationStartMs);
      timing.llmTotalMs =
        timing.llmPlanningMs + timing.llmVerificationMs + timing.llmFinalVerificationMs;

      this.log('info', '⏱️ [TIMING] === ORCHESTRATION TIMING SUMMARY ===');
      this.log('info', `⏱️ [TIMING] LLM Planning: ${timing.llmPlanningMs}ms`);
      this.log('info', `⏱️ [TIMING] LLM Verification: ${timing.llmVerificationMs}ms`);
      this.log('info', `⏱️ [TIMING] LLM Final Verification: ${timing.llmFinalVerificationMs}ms`);
      this.log(
        'info',
        `⏱️ [TIMING] LLM Total: ${timing.llmTotalMs}ms (${timing.llmCallCount} calls)`
      );
      this.log(
        'info',
        `⏱️ [TIMING] CLI Execution: ${timing.cliExecutionMs}ms (${timing.cliCallCount} calls)`
      );
      this.log('info', `⏱️ [TIMING] Total Orchestration: ${timing.totalMs}ms`);
      this.log('info', `⏱️ [TIMING] Steps Executed: ${timing.stepsExecuted}`);

      return {
        success: finalVerification.score >= this.config.cliScoreThreshold,
        planId: plan.id,
        score: finalVerification.score,
        verification: finalVerification,
        iterations: this.planManager.getPlan(plan.id)?.iterations || 0,
        timing,
      };
    } catch (error) {
      this.planManager.updatePlan(plan.id, { status: 'failed' });

      timing.endTime = new Date().toISOString();
      timing.totalMs = Math.round(performance.now() - orchestrationStartMs);
      timing.llmTotalMs =
        timing.llmPlanningMs + timing.llmVerificationMs + timing.llmFinalVerificationMs;

      return {
        success: false,
        planId: plan.id,
        score: 0,
        verification: {
          score: 0,
          reasoning: `Error during orchestration: ${error instanceof Error ? error.message : String(error)}`,
          completedAreas: [],
          missingItems: [],
          suggestions: [],
        },
        iterations: 0,
        error: error instanceof Error ? error.message : String(error),
        timing,
      };
    }
  }

  private async buildSteps(task: string, _planId: string): Promise<OrchestrationStep[]> {
    const backendList: string[] = [];
    for (const [id, backend] of this.backends.entries()) {
      try {
        const probe = await backend.probe();
        if (probe.available) {
          backendList.push(id);
        }
      } catch {
        // Skip backends that fail probing
      }
    }

    if (backendList.length === 0) {
      const configured = Array.from(this.backends.keys());
      throw new Error(
        `No CLI backends are available (probe failed). ` +
          `Configured: ${configured.length > 0 ? configured.join(', ') : '(none)'}. ` +
          `Fix by installing/authing the configured CLI tool(s), or disable CLI orchestration.`
      );
    }

    const backendInfo = backendList.join(', ');
    const exampleBackend = backendList[0] || 'copilot-cli';

    const prompt = `Decompose this task into CLI tool steps:

Task: ${task}

Available CLI backends:
${backendInfo}

For each step, specify:
1. Which CLI backend to use
2. A human-readable description
3. The detailed task prompt for the CLI tool

Requirements:
- Break into logical steps (typically 2-5 steps)
- Each step should be CLI-executable
- Consider dependencies between steps

Important: The CLI task prompt MUST request a refactoring plan for the mcpLocalLLM project. This plan should include:
- A prioritized list of refactorings with a numeric priority rating (1-10) for each item
- For every refactoring item: a before code snippet and an after code snippet showing the exact changes
- Affected file paths for each change
- The plan should be output in a structured JSON form that the CLI can apply (do not include extraneous prose)

Respond ONLY with valid JSON:
{
  "steps": [
    {
      "description": "Human-readable step description",
      "cliBackend": "${exampleBackend}",
      "taskPrompt": "Detailed prompt to send to CLI tool. It must include the refactoring plan request with priority and before/after snippets."
    }
  ]
}`;

    this.log('info', '📋 [LLM-PLANNING] Calling LLM to decompose task into steps', {
      llmId: this.llm.id,
    });
    const llmCallStart = Date.now();
    console.log(`[ORCHESTRATOR] 🚀 LLM buildSteps START at ${new Date().toISOString()}`);
    const response = await withTimeout(
      this.llm.invokeChat({
        messages: [{ role: 'user', content: prompt }],
      }),
      LLM_CALL_TIMEOUT_MS,
      'LLM planning'
    );
    console.log(`[ORCHESTRATOR] ✅ LLM buildSteps END after ${Date.now() - llmCallStart}ms`);
    this.log('info', '📋 [LLM-PLANNING] LLM returned step decomposition', {
      responseLength: response.message.content.length,
    });

    return this.parseStepsResponse(response.message.content, backendList);
  }

  private async executeStep(step: OrchestrationStep): Promise<CliToolResult> {
    const backend = this.backends.get(step.cliBackend);

    if (!backend) {
      return {
        success: false,
        content: '',
        files_modified: [],
        tools_used: [],
        error: `Backend not found: ${step.cliBackend}`,
      };
    }

    this.log('info', `🔧 [CLI-EXECUTION] Executing step via CLI tool: ${step.cliBackend}`, {
      stepDescription: step.description,
      taskPromptLength: step.taskPrompt.length,
    });
    const cliCallStart = Date.now();
    console.log(
      `[ORCHESTRATOR] 🚀 CLI executeStep START (${step.cliBackend}) at ${new Date().toISOString()}`
    );
    const result = await withTimeout(
      backend.executeTask(step.taskPrompt),
      CLI_CALL_TIMEOUT_MS,
      `CLI execution (${step.cliBackend})`
    );
    console.log(
      `[ORCHESTRATOR] ✅ CLI executeStep END after ${Date.now() - cliCallStart}ms | success=${result.success}`
    );
    this.log('info', `🔧 [CLI-EXECUTION] CLI tool returned result`, {
      success: result.success,
      filesModified: result.files_modified,
      contentLength: result.content?.length || 0,
    });
    return result;
  }

  private async quickVerify(
    step: OrchestrationStep,
    result: CliToolResult
  ): Promise<QuickVerification> {
    const prompt = `Quick verification of task completion:

Task: ${step.description}
Files Modified: ${result.files_modified.join(', ') || 'None'}
Output: ${result.content.substring(0, 300)}${result.content.length > 300 ? '...' : ''}

Is this step complete? (yes/no) Answer briefly with just "yes" or "no".`;

    this.log('info', '✅ [LLM-VERIFY] Calling LLM for quick verification', { llmId: this.llm.id });
    const response = await withTimeout(
      this.llm.invokeChat({
        messages: [{ role: 'user', content: prompt }],
      }),
      LLM_CALL_TIMEOUT_MS,
      'LLM quick verification'
    );
    this.log('info', '✅ [LLM-VERIFY] LLM verification result', {
      response: response.message.content.substring(0, 50),
    });

    return {
      isComplete: response.message.content.toLowerCase().includes('yes'),
      assessment: response.message.content,
    };
  }

  private async cliFinalVerify(
    step: OrchestrationStep,
    result: CliToolResult
  ): Promise<VerificationResult> {
    const prompt = `Final verification of task completion:

Original Task: ${step.taskPrompt}
Files Modified: ${result.files_modified.join(', ') || 'None'}
Tools Used: ${result.tools_used.join(', ') || 'None'}
Output: ${result.content}

Please verify:

1. **Completed Areas**: List all areas that were successfully completed (be specific)
2. **Missing Items**: List any requirements that were NOT met (be specific)
3. **Score**: Rate overall completion 1-10 (10 = perfect, 1 = completely failed)
4. **Suggestions**: Provide specific, actionable suggestions for improvements

Respond ONLY with valid JSON (no markdown, no explanation outside JSON):
{
  "score": 9,
  "reasoning": "Detailed explanation of why this score was given",
  "completedAreas": ["specific thing that was completed", "another thing"],
  "missingItems": ["specific thing that was missed", "another missing thing"],
  "suggestions": ["specific suggestion 1", "specific suggestion 2"]
}`;

    const response = await withTimeout(
      this.llm.invokeChat({
        messages: [{ role: 'user', content: prompt }],
      }),
      LLM_CALL_TIMEOUT_MS,
      'LLM final verification'
    );

    return this.parseVerificationResponse(response.message.content);
  }

  private async verifyFullTaskCompletion(planId: string): Promise<VerificationResult> {
    const plan = this.planManager.getPlan(planId);
    if (!plan) {
      return {
        score: 0,
        reasoning: 'Plan not found',
        completedAreas: [],
        missingItems: [],
        suggestions: [],
      };
    }

    const completedSteps = plan.steps.filter((s) => s.status === 'completed').length;
    const totalSteps = plan.steps.length;

    const prompt = `Final verification of orchestration task completion:

Original Task: ${plan.originalTask}
Steps Completed: ${completedSteps} of ${totalSteps}

Step Summaries:
${plan.steps.map((s, i) => `${i + 1}. ${s.description}: ${s.status}`).join('\n')}

Please provide final verification:

1. **Completed Areas**: What was successfully accomplished overall?
2. **Missing Items**: What was NOT accomplished across all steps?
3. **Overall Score**: Rate the entire task completion 1-10
4. **Final Suggestions**: Any last recommendations?

Respond ONLY with valid JSON:
{
  "score": 9,
  "reasoning": "Overall assessment",
  "completedAreas": ["area1", "area2"],
  "missingItems": ["area3"],
  "suggestions": ["suggestion1"]
}`;

    const response = await withTimeout(
      this.llm.invokeChat({
        messages: [{ role: 'user', content: prompt }],
      }),
      LLM_CALL_TIMEOUT_MS,
      'LLM full task verification'
    );

    return this.parseVerificationResponse(response.message.content);
  }

  private async updatePlanWithCorrections(
    planId: string,
    verification: VerificationResult
  ): Promise<void> {
    const plan = this.planManager.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    this.planManager.updatePlan(planId, {
      iterations: plan.iterations + 1,
    });

    const prompt = `Update the orchestration plan based on verification feedback:

Original Task: ${plan.originalTask}
Current Progress: ${plan.currentStep + 1} of ${plan.steps.length} steps completed
Verification Score: ${verification.score}/10
Missing Items: ${verification.missingItems.join(', ') || 'None'}
Suggestions: ${verification.suggestions.join(', ') || 'None'}

Generate a plan update with:
1. Corrections to existing steps (if any)
2. New steps to address missing items
3. Updated order if needed

Respond ONLY with valid JSON:
{
  "stepCorrections": [
    {
      "stepId": "step_001",
      "correction": "Description of what needs to change"
    }
  ],
  "additionalSteps": [
    {
      "description": "New step to address missing items",
      "cliBackend": "opencode-cli",
      "taskPrompt": "Detailed task prompt"
    }
  ],
  "notes": "Any notes about the corrections"
}`;

    const response = await withTimeout(
      this.llm.invokeChat({
        messages: [{ role: 'user', content: prompt }],
      }),
      LLM_CALL_TIMEOUT_MS,
      'LLM plan correction'
    );

    this.applyCorrections(planId, response.message.content);
  }

  private parseStepsResponse(response: string, availableBackends: string[]): OrchestrationStep[] {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!parsed.steps || !Array.isArray(parsed.steps)) {
        throw new Error('No steps array in response');
      }

      let stepId = 1;
      return parsed.steps.map(
        (s: { description: string; cliBackend: string; taskPrompt: string }) => ({
          id: `step_${String(stepId++).padStart(3, '0')}`,
          description: s.description || `Step ${stepId}`,
          cliBackend: availableBackends.includes(s.cliBackend)
            ? s.cliBackend
            : availableBackends[0] || 'copilot-cli',
          taskPrompt: s.taskPrompt || s.description,
          status: 'pending' as const,
        })
      );
    } catch {
      return [
        {
          id: 'step_001',
          description: 'Execute task',
          cliBackend: availableBackends[0] || 'copilot-cli',
          taskPrompt: response,
          status: 'pending',
        },
      ];
    }
  }

  private parseVerificationResponse(response: string): VerificationResult {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        score: typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5,
        reasoning: parsed.reasoning || 'No reasoning provided',
        completedAreas: Array.isArray(parsed.completedAreas) ? parsed.completedAreas : [],
        missingItems: Array.isArray(parsed.missingItems) ? parsed.missingItems : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch (error) {
      return {
        score: 5,
        reasoning: `Parse error: ${error instanceof Error ? error.message : String(error)}. Response: ${response.substring(0, 200)}`,
        completedAreas: [],
        missingItems: [],
        suggestions: [],
      };
    }
  }

  private applyCorrections(planId: string, response: string): void {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.stepCorrections && Array.isArray(parsed.stepCorrections)) {
        for (const correction of parsed.stepCorrections) {
          if (correction.stepId && correction.correction) {
            this.planManager.updateStep(planId, correction.stepId, {
              taskPrompt: correction.correction,
            });
          }
        }
      }

      if (parsed.additionalSteps && Array.isArray(parsed.additionalSteps)) {
        for (const newStep of parsed.additionalSteps) {
          this.planManager.addStep(planId, {
            description: newStep.description || 'Additional step',
            cliBackend: newStep.cliBackend || 'opencode-cli',
            taskPrompt: newStep.taskPrompt || newStep.description,
            status: 'pending',
          });
        }
      }
    } catch (error) {
      this.log('warn', 'Failed to apply corrections', { error });
    }
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[Orchestrator] ${message}`,
      metadata ? JSON.stringify(metadata) : ''
    );
  }
}

import { PlanManager } from './plan-manager.js';

// Use shared interfaces from types.ts (Phase 2 cleanup)
type CliBackend = OrchestratorCliBackend;
type LlmBackend = OrchestratorLlmBackend;
