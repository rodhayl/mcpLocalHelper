import {
  VerifyPlanRequest,
  VerifyPlanResponse,
  StepResult,
  StepVerdict,
  PlanStep,
  ChatMessage,
} from '../types/index.js';
import { FileTools } from './file.js';
import { GrepTools } from './grep.js';
import { LlmChatTool } from './llm.js';
import { SummarizationTools } from './summarize.js';
import { join } from 'path';
import { ToolLlmWrapper } from '../orchestration/tool-llm-wrapper.js';

// Evidence item from target analysis
interface Evidence {
  path: string;
  summary: string;
  relevant_lines?: number[];
}

// Target analysis result
interface TargetAnalysisResult {
  status: 'ok' | 'found' | 'not_found' | 'error';
  evidence: Evidence[];
  error?: string;
}

// LLM evaluation result
interface LLMEvaluationResult {
  status: StepVerdict;
  reasons: string[];
  suggested_changes?: string[];
}

export class VerifyPlanTool {
  private fileTools: FileTools;
  private grepTools: GrepTools;
  private summarization: SummarizationTools;
  private llmWrapper: ToolLlmWrapper;

  constructor(
    fileTools: FileTools,
    grepTools: GrepTools,
    llmChat: LlmChatTool,
    summarization: SummarizationTools
  ) {
    this.fileTools = fileTools;
    this.grepTools = grepTools;
    this.summarization = summarization;
    this.llmWrapper = new ToolLlmWrapper(llmChat);
  }

  async verifyPlan(request: VerifyPlanRequest): Promise<VerifyPlanResponse> {
    const { context_root, steps, mode } = request;

    // Validate context root
    if (!this.fileTools.isPathAllowed(context_root)) {
      throw new Error(`Context root '${context_root}' is not in the allowlist`);
    }

    const stepResults: StepResult[] = [];
    let overallVerdict: 'ok' | 'needs_changes' | 'high_risk' = 'ok';

    // Pre-compute repository summary for deep mode
    let repoSummary = '';
    if (mode === 'deep') {
      try {
        const repoSummaryResult = await this.summarization.summarizeRepo(context_root, 'extended');
        repoSummary = repoSummaryResult.summary;
      } catch (error) {
        console.warn('Failed to generate repository summary for deep mode:', error);
      }
    }

    for (const step of steps) {
      const stepResult = await this.verifyStep(step, context_root, mode, repoSummary);
      stepResults.push(stepResult);

      // Update overall verdict
      if (stepResult.status === 'blocked') {
        overallVerdict = 'high_risk';
      } else if (stepResult.status === 'needs_changes' && overallVerdict === 'ok') {
        overallVerdict = 'needs_changes';
      }
    }

    return {
      plan_id: request.plan_id,
      overall_verdict: overallVerdict,
      steps: stepResults,
    };
  }

  private async verifyStep(
    step: PlanStep,
    contextRoot: string,
    mode: 'quick' | 'deep',
    repoSummary: string
  ): Promise<StepResult> {
    const evidence: Evidence[] = [];
    const reasons: string[] = [];
    const suggestedChanges: string[] = [];
    let status: StepVerdict = 'ok';

    try {
      // Analyze targets
      for (const target of step.targets) {
        const targetResult = await this.analyzeTarget(target, contextRoot);
        evidence.push(...targetResult.evidence);

        if (targetResult.status === 'not_found') {
          status = 'needs_changes';
          reasons.push(`Target '${target}' not found`);
        } else if (targetResult.status === 'error') {
          status = 'blocked';
          reasons.push(`Error analyzing target '${target}': ${targetResult.error}`);
        }
      }

      // Get step-specific context
      const stepContext = await this.getStepContext(step, mode, repoSummary, evidence);

      // Use LLM to evaluate the step
      const llmEvaluation = await this.evaluateStepWithLLM(stepContext);

      if (llmEvaluation.status !== 'ok') {
        status = llmEvaluation.status;
      }

      reasons.push(...llmEvaluation.reasons);
      if (llmEvaluation.suggested_changes) {
        suggestedChanges.push(...llmEvaluation.suggested_changes);
      }
    } catch (error) {
      status = 'blocked';
      reasons.push(
        `Unexpected error during verification: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    return {
      id: step.id,
      status,
      reasons,
      evidence,
      suggested_changes: suggestedChanges.length > 0 ? suggestedChanges : undefined,
    };
  }

  private async analyzeTarget(target: string, contextRoot: string): Promise<TargetAnalysisResult> {
    const evidence: Evidence[] = [];

    try {
      if (target.startsWith('optional-pattern:')) {
        // Pattern-based target
        const pattern = target.replace('optional-pattern:', '');
        const grepResult = this.grepTools.grepRepo(contextRoot, pattern, 10);

        if (grepResult.matches.length === 0) {
          return { status: 'not_found', evidence };
        }

        evidence.push(
          ...grepResult.matches.map((match) => ({
            path: match.file,
            summary: `Found pattern "${pattern}" at line ${match.line}`,
            relevant_lines: [match.line],
          }))
        );
      } else if (target.endsWith('/')) {
        // Directory target
        // Resolve target path - if absolute, use directly; if relative, join with contextRoot
        const isAbsoluteTarget = /^(?:[A-Za-z]:)?[/\\]/.test(target) || target.startsWith('/');
        const resolvedDirPath = isAbsoluteTarget ? target : join(contextRoot, target);

        // Check if path is allowed
        if (!this.fileTools.isPathAllowed(resolvedDirPath)) {
          throw new Error('Outside workspace');
        }

        try {
          const dirList = this.fileTools.listDirectory(resolvedDirPath, 20);
          evidence.push({
            path: target,
            summary: `Directory contains ${dirList.entries.length} entries`,
          });
        } catch {
          return { status: 'not_found', evidence };
        }
      } else {
        // File target
        // Resolve target path - if absolute, use directly; if relative, join with contextRoot
        const isAbsoluteTarget = /^(?:[A-Za-z]:)?[/\\]/.test(target) || target.startsWith('/');
        const resolvedFilePath = isAbsoluteTarget ? target : join(contextRoot, target);

        // Check if path is allowed
        if (!this.fileTools.isPathAllowed(resolvedFilePath)) {
          throw new Error('Outside workspace');
        }

        try {
          const fileContent = this.fileTools.readFile(resolvedFilePath, 16384); // 16KB limit
          evidence.push({
            path: target,
            summary: `File exists, size: ${fileContent.content.length} characters`,
            relevant_lines: undefined,
          });
        } catch {
          return { status: 'not_found', evidence };
        }
      }

      return { status: 'found', evidence };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        evidence,
      };
    }
  }

  private async getStepContext(
    step: PlanStep,
    mode: 'quick' | 'deep',
    repoSummary: string,
    evidence: Evidence[]
  ): Promise<string> {
    let context = `Plan Step: ${step.title}\n`;
    context += `Description: ${step.description}\n`;
    context += `Targets: ${step.targets.join(', ')}\n\n`;

    if (mode === 'deep' && repoSummary) {
      context += `Repository Context:\n${repoSummary}\n\n`;
    }

    if (evidence.length > 0) {
      context += `Evidence from target analysis:\n`;
      for (const item of evidence) {
        context += `- ${item.path}: ${item.summary}\n`;
      }
      context += '\n';
    }

    return context;
  }

  private async evaluateStepWithLLM(context: string): Promise<LLMEvaluationResult> {
    const systemPrompt = `You are a code review expert. Analyze the following plan step and provide feedback on its feasibility, potential risks, and any missing considerations.

Evaluate based on:
1. Technical feasibility
2. Potential risks or breaking changes
3. Missing prerequisites or dependencies
4. Suggestions for improvement

Respond with a JSON object:
{
  "status": "ok" | "needs_changes" | "blocked",
  "reasons": ["string"],
  "suggested_changes": ["string"] (optional)
}`;

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: `${context}\nPlease evaluate this plan step and provide feedback.`,
      },
    ];

    try {
      const responseText = await this.llmWrapper.callToolLlm('verify_plan', messages, {
        type: 'verify_step',
      });

      // Try to parse JSON response
      try {
        const evaluation = JSON.parse(responseText);
        return {
          status: evaluation.status || 'ok',
          reasons: evaluation.reasons || [],
          suggested_changes: evaluation.suggested_changes,
        };
      } catch {
        // If JSON parsing fails, extract key points from text response
        return {
          status: this.extractStatusFromText(responseText),
          reasons: this.extractReasonsFromText(responseText),
          suggested_changes: this.extractSuggestionsFromText(responseText),
        };
      }
    } catch (error) {
      return {
        status: 'blocked',
        reasons: [
          `LLM evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ],
      };
    }
  }

  private extractStatusFromText(text: string): StepVerdict {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('blocked') || lowerText.includes('not feasible')) {
      return 'blocked';
    }
    if (lowerText.includes('needs changes') || lowerText.includes('issues')) {
      return 'needs_changes';
    }
    return 'ok';
  }

  private extractReasonsFromText(text: string): string[] {
    const reasons: string[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.match(/^\d+./)) {
        reasons.push(trimmed.replace(/^[-•\d+.]+\s*/, ''));
      }
    }

    return reasons.length > 0 ? reasons : [text.trim().slice(0, 200)];
  }

  private extractSuggestionsFromText(text: string): string[] {
    const suggestions: string[] = [];
    const lines = text.split('\n');
    let inSuggestions = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (
        trimmed.toLowerCase().includes('suggestion') ||
        trimmed.toLowerCase().includes('recommend')
      ) {
        inSuggestions = true;
        continue;
      }

      if (
        inSuggestions &&
        (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.match(/^\d+./))
      ) {
        suggestions.push(trimmed.replace(/^[-•\d+.]+\s*/, ''));
      } else if (inSuggestions && trimmed === '') {
        inSuggestions = false;
      }
    }

    return suggestions;
  }
}
