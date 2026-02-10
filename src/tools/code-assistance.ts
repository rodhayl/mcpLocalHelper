/**
 * Code Assistance Tools - LLM-Powered Developer Assistance
 *
 * New tools that provide unique SOTA value by leveraging local LLM:
 * - explain_code: Explain code in plain English
 * - suggest_optimizations: Performance and efficiency suggestions
 * - explain_diff: Summarize code diffs in plain language
 * - explain_error: Diagnose runtime errors and stack traces
 * - suggest_names: Better variable/function/class names
 * - extract_function: Extract code block into a new function
 * - simplify_code: Rewrite complex code in simpler style
 * - translate_code: Translate code between programming languages
 * - plan_implementation: Break down feature into implementation steps
 * - explain_regex: Explain regex patterns in plain English
 * - generate_regex: Generate regex from natural language description
 * - estimate_complexity: Estimate Big-O time complexity
 * - summarize_logs: Summarize and highlight issues in log output
 * - suggest_command: Suggest shell commands for a task
 */

import { ConfigManager } from '../config/index.js';
import { LlmChatTool } from './llm.js';
import { BackendManager } from '../adapters/factory.js';
import { RedactionEngine } from '../utils/redaction.js';
import { extractJsonFromText } from '../utils/llm-json.js';
import { ToolLlmWrapper } from '../orchestration/tool-llm-wrapper.js';

// ============================================
// Types
// ============================================

export interface ExplainCodeResult {
  success: boolean;
  explanation: string;
  keyPoints: string[];
  complexity?: string;
  potentialIssues?: string[];
  error?: string;
}

export interface SuggestOptimizationsResult {
  success: boolean;
  suggestions: Array<{
    type: 'performance' | 'memory' | 'readability' | 'algorithm';
    description: string;
    impact: 'high' | 'medium' | 'low';
    before?: string;
    after?: string;
    lineRange?: { start: number; end: number };
  }>;
  summary: string;
  error?: string;
}

export interface ExplainDiffResult {
  success: boolean;
  summary: string;
  changes: Array<{
    type: 'added' | 'removed' | 'modified';
    description: string;
    impact: string;
  }>;
  risks?: string[];
  error?: string;
}

export interface ExplainErrorResult {
  success: boolean;
  rootCause: string;
  explanation: string;
  suggestedFixes: Array<{
    description: string;
    code?: string;
  }>;
  relatedDocs?: string[];
  error?: string;
}

export interface SuggestNamesResult {
  success: boolean;
  suggestions: Array<{
    original: string;
    suggested: string[];
    reasoning: string;
    type: 'variable' | 'function' | 'class' | 'parameter';
  }>;
  error?: string;
}

export interface ExtractFunctionResult {
  success: boolean;
  functionName: string;
  functionCode: string;
  callSite: string;
  parameters: Array<{ name: string; type?: string }>;
  returnType?: string;
  explanation: string;
  error?: string;
}

export interface SimplifyCodeResult {
  success: boolean;
  originalComplexity: string;
  simplifiedCode: string;
  simplifiedComplexity: string;
  changes: string[];
  error?: string;
}

export interface TranslateCodeResult {
  success: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  translatedCode: string;
  notes: string[];
  warnings?: string[];
  error?: string;
}

export interface PlanImplementationResult {
  success: boolean;
  plan: Array<{
    step: number;
    title: string;
    description: string;
    files?: string[];
    estimatedEffort?: 'small' | 'medium' | 'large';
    dependencies?: number[];
  }>;
  summary: string;
  estimatedTotalEffort: string;
  risks?: string[];
  error?: string;
}

export interface ExplainRegexResult {
  success: boolean;
  pattern: string;
  explanation: string;
  breakdown: Array<{
    part: string;
    meaning: string;
  }>;
  examples: Array<{
    input: string;
    matches: boolean;
    matchedPart?: string;
  }>;
  error?: string;
}

export interface GenerateRegexResult {
  success: boolean;
  pattern: string;
  flags?: string;
  explanation: string;
  examples: Array<{
    input: string;
    shouldMatch: boolean;
  }>;
  alternativePatterns?: string[];
  error?: string;
}

export interface EstimateComplexityResult {
  success: boolean;
  timeComplexity: string;
  spaceComplexity: string;
  reasoning: string;
  bottlenecks?: Array<{
    location: string;
    description: string;
    suggestion?: string;
  }>;
  error?: string;
}

export interface SummarizeLogsResult {
  success: boolean;
  summary: string;
  keyEvents: Array<{
    type: 'error' | 'warning' | 'info' | 'event';
    message: string;
    timestamp?: string;
    count?: number;
  }>;
  issues: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    recommendation?: string;
  }>;
  statistics?: {
    totalLines: number;
    errorCount: number;
    warningCount: number;
    timeRange?: string;
  };
  error?: string;
}

export interface SuggestCommandResult {
  success: boolean;
  commands: Array<{
    command: string;
    explanation: string;
    platform?: 'unix' | 'windows' | 'cross-platform';
    risk?: 'safe' | 'moderate' | 'dangerous';
    alternatives?: string[];
  }>;
  warning?: string;
  error?: string;
}

// ============================================
// Code Assistance Tools Class
// ============================================

export class CodeAssistanceTools {
  // Keep config and redaction for future extensibility
  private _config: ConfigManager;
  private llmChat: LlmChatTool;
  private _redaction: RedactionEngine;
  private llmWrapper: ToolLlmWrapper;

  constructor(config: ConfigManager, backendManager: BackendManager) {
    this._config = config;
    this.llmChat = new LlmChatTool(backendManager, config);
    this._redaction = new RedactionEngine();
    this.llmWrapper = new ToolLlmWrapper(this.llmChat);
  }

  // ============================================
  // Helper Methods
  // ============================================

  private parseJsonResponse(response: string, defaultValue: any): any {
    try {
      const parsed = extractJsonFromText(response);
      if (parsed === null) return defaultValue;
      if (typeof parsed !== 'object') return defaultValue;
      return parsed;
    } catch {
      return defaultValue;
    }
  }

  // ============================================
  // Code Explanation
  // ============================================

  /**
   * Explain code in plain English
   */
  async explainCode(
    code: string,
    options?: {
      language?: string;
      depth?: 'brief' | 'detailed' | 'comprehensive';
      focusOn?: string;
    }
  ): Promise<ExplainCodeResult> {
    const depth = options?.depth ?? 'detailed';
    const language = options?.language ?? 'code';

    const prompt = `You are an expert code explainer. Explain the following ${language} code in plain English.

Depth level: ${depth}
${options?.focusOn ? `Focus specifically on: ${options.focusOn}` : ''}

Provide your response as JSON with these fields:
{
  "explanation": "Clear explanation of what the code does",
  "keyPoints": ["Key point 1", "Key point 2"],
  "complexity": "Brief complexity assessment",
  "potentialIssues": ["Any potential issues or edge cases"]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'code_helper',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `\`\`\`${language}\n${code}\n\`\`\`` },
        ],
        { type: 'explain_code', language }
      );

      const parsed = this.parseJsonResponse(responseText, {
        explanation: responseText,
        keyPoints: [],
      });

      return {
        success: true,
        explanation: parsed.explanation || responseText,
        keyPoints: parsed.keyPoints || [],
        complexity: parsed.complexity,
        potentialIssues: parsed.potentialIssues,
      };
    } catch (error) {
      return {
        success: false,
        explanation: '',
        keyPoints: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Optimization Suggestions
  // ============================================

  /**
   * Suggest code optimizations
   */
  async suggestOptimizations(
    code: string,
    options?: {
      language?: string;
      focusAreas?: Array<'performance' | 'memory' | 'readability' | 'algorithm'>;
    }
  ): Promise<SuggestOptimizationsResult> {
    const language = options?.language ?? 'code';
    const focusAreas = options?.focusAreas ?? ['performance', 'memory', 'readability', 'algorithm'];

    const prompt = `You are an expert code optimizer. Analyze the following ${language} code and suggest optimizations.

Focus on: ${focusAreas.join(', ')}

Constraints:
- Preserve semantics (same outputs for all inputs). Do NOT propose behavior-changing edits.
- Call out edge cases (e.g., empty arrays/strings, null/undefined, error handling) and keep them correct.
- If an optimization depends on assumptions, state them explicitly.

Provide your response as JSON:
{
  "suggestions": [
    {
      "type": "performance|memory|readability|algorithm",
      "description": "What to optimize",
      "impact": "high|medium|low",
      "before": "Original code snippet (optional)",
      "after": "Optimized code snippet (optional)"
    }
  ],
  "summary": "Overall assessment"
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'code_helper',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `\`\`\`${language}\n${code}\n\`\`\`` },
        ],
        { type: 'optimize_code', language }
      );

      const parsed = this.parseJsonResponse(responseText, {
        suggestions: [],
        summary: responseText,
      });

      return {
        success: true,
        suggestions: parsed.suggestions || [],
        summary: parsed.summary || '',
      };
    } catch (error) {
      return {
        success: false,
        suggestions: [],
        summary: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Diff Explanation
  // ============================================

  /**
   * Explain code diff in plain language
   */
  async explainDiff(
    diff: string,
    options?: {
      context?: string;
    }
  ): Promise<ExplainDiffResult> {
    const prompt = `You are an expert at explaining code changes. Analyze this diff and explain what changed in plain English.
${options?.context ? `Context: ${options.context}` : ''}

Provide your response as JSON:
{
  "summary": "High-level summary of changes",
  "changes": [
    {
      "type": "added|removed|modified",
      "description": "What was changed",
      "impact": "Why this change matters"
    }
  ],
  "risks": ["Any potential risks or concerns"]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_diff_summarizer',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: diff },
        ],
        { type: 'explain_diff' }
      );

      const parsed = this.parseJsonResponse(responseText, {
        summary: responseText,
        changes: [],
      });

      return {
        success: true,
        summary: parsed.summary || '',
        changes: parsed.changes || [],
        risks: parsed.risks,
      };
    } catch (error) {
      return {
        success: false,
        summary: '',
        changes: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Error Explanation
  // ============================================

  /**
   * Diagnose runtime errors and stack traces
   */
  async explainError(
    errorMessage: string,
    options?: {
      stackTrace?: string;
      codeContext?: string;
      language?: string;
    }
  ): Promise<ExplainErrorResult> {
    const language = options?.language ?? 'code';

    const prompt = `You are an expert debugger. Analyze this error and help diagnose the root cause.
${options?.language ? `Language: ${options.language}` : ''}

Provide your response as JSON:
{
  "rootCause": "The fundamental cause of the error",
  "explanation": "Detailed explanation of why this error occurred",
  "suggestedFixes": [
    {
      "description": "How to fix it",
      "code": "Optional code example"
    }
  ],
  "relatedDocs": ["Links or references to relevant documentation"]
}`;

    const userContent = `Error: ${errorMessage}
${options?.stackTrace ? `\nStack Trace:\n${options.stackTrace}` : ''}
${options?.codeContext ? `\nCode Context:\n\`\`\`${language}\n${options.codeContext}\n\`\`\`` : ''}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_error_explainer',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: userContent },
        ],
        { type: 'explain_error', language }
      );

      const parsed = this.parseJsonResponse(responseText, {
        rootCause: '',
        explanation: responseText,
        suggestedFixes: [],
      });

      const rawExplanation =
        typeof (parsed as any)?.explanation === 'string' ? String((parsed as any).explanation) : '';
      const fallbackExplanation = responseText?.trim() || `Error: ${errorMessage}`;
      const explanation = rawExplanation.trim() ? rawExplanation.trim() : fallbackExplanation;

      return {
        success: true,
        rootCause: parsed.rootCause || 'Unable to determine',
        explanation,
        suggestedFixes: parsed.suggestedFixes || [],
        relatedDocs: parsed.relatedDocs,
      };
    } catch (error) {
      return {
        success: false,
        rootCause: '',
        explanation: '',
        suggestedFixes: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Name Suggestions
  // ============================================

  /**
   * Suggest better names for code identifiers
   */
  async suggestNames(
    code: string,
    options?: {
      language?: string;
      focusIdentifiers?: string[];
      style?: 'camelCase' | 'snake_case' | 'PascalCase';
    }
  ): Promise<SuggestNamesResult> {
    const language = options?.language ?? 'code';
    const style = options?.style ?? 'camelCase';

    const prompt = `You are an expert at naming things in code. Analyze this ${language} code and suggest better, more descriptive names for variables, functions, and classes.

Naming style: ${style}
${options?.focusIdentifiers ? `Focus on these identifiers: ${options.focusIdentifiers.join(', ')}` : 'Analyze all identifiers that could be improved'}

Provide your response as JSON:
{
  "suggestions": [
    {
      "original": "Current name",
      "suggested": ["Better name 1", "Better name 2"],
      "reasoning": "Why these names are better",
      "type": "variable|function|class|parameter"
    }
  ]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'refactor_helper',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `\`\`\`${language}\n${code}\n\`\`\`` },
        ],
        { type: 'suggest_names', language, style }
      );

      const parsed = this.parseJsonResponse(responseText, {
        suggestions: [],
      });

      return {
        success: true,
        suggestions: parsed.suggestions || [],
      };
    } catch (error) {
      return {
        success: false,
        suggestions: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Function Extraction
  // ============================================

  /**
   * Extract code block into a new function
   */
  async extractFunction(
    code: string,
    codeBlock: string,
    options?: {
      language?: string;
      suggestedName?: string;
    }
  ): Promise<ExtractFunctionResult> {
    const language = options?.language ?? 'code';

    const prompt = `You are an expert at refactoring code. Extract the marked code block into a new, well-named function.

Language: ${language}
${options?.suggestedName ? `Suggested function name: ${options.suggestedName}` : ''}

Provide your response as JSON:
{
  "functionName": "Name for the extracted function",
  "functionCode": "The complete extracted function",
  "callSite": "How to call the new function at the original location",
  "parameters": [{"name": "param1", "type": "string"}],
  "returnType": "What the function returns",
  "explanation": "Brief explanation of the extraction"
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'refactor_helper',
        [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `Full code:\n\`\`\`${language}\n${code}\n\`\`\`\n\nCode block to extract:\n\`\`\`${language}\n${codeBlock}\n\`\`\``,
          },
        ],
        { type: 'extract_function', language }
      );

      const parsed = this.parseJsonResponse(responseText, {
        functionName: 'extractedFunction',
        functionCode: codeBlock,
        callSite: '',
        parameters: [],
        explanation: '',
      });

      return {
        success: true,
        functionName: parsed.functionName || 'extractedFunction',
        functionCode: parsed.functionCode || codeBlock,
        callSite: parsed.callSite || '',
        parameters: parsed.parameters || [],
        returnType: parsed.returnType,
        explanation: parsed.explanation || '',
      };
    } catch (error) {
      return {
        success: false,
        functionName: '',
        functionCode: '',
        callSite: '',
        parameters: [],
        explanation: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Code Simplification
  // ============================================

  /**
   * Simplify complex code
   */
  async simplifyCode(
    code: string,
    options?: {
      language?: string;
      preserveComments?: boolean;
    }
  ): Promise<SimplifyCodeResult> {
    const language = options?.language ?? 'code';

    const prompt = `You are an expert at simplifying code. Rewrite this ${language} code to be cleaner, more readable, and easier to maintain while preserving its functionality.

${options?.preserveComments ? 'Preserve existing comments.' : ''}

Provide your response as JSON:
{
  "originalComplexity": "Brief assessment of original complexity",
  "simplifiedCode": "The simplified code",
  "simplifiedComplexity": "Brief assessment of new complexity",
  "changes": ["Description of each simplification made"]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'code_helper',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `\`\`\`${language}\n${code}\n\`\`\`` },
        ],
        { type: 'simplify_code', language }
      );

      const parsed = this.parseJsonResponse(responseText, {
        originalComplexity: '',
        simplifiedCode: code,
        simplifiedComplexity: '',
        changes: [],
      });

      return {
        success: true,
        originalComplexity: parsed.originalComplexity || '',
        simplifiedCode: parsed.simplifiedCode || code,
        simplifiedComplexity: parsed.simplifiedComplexity || '',
        changes: parsed.changes || [],
      };
    } catch (error) {
      return {
        success: false,
        originalComplexity: '',
        simplifiedCode: '',
        simplifiedComplexity: '',
        changes: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Code Translation
  // ============================================

  /**
   * Translate code between programming languages
   */
  async translateCode(
    code: string,
    targetLanguage: string,
    options?: {
      sourceLanguage?: string;
      preserveComments?: boolean;
    }
  ): Promise<TranslateCodeResult> {
    const sourceLanguage = options?.sourceLanguage ?? 'auto-detect';

    const prompt = `You are an expert polyglot programmer. Translate this code from ${sourceLanguage} to ${targetLanguage}.

Guidelines:
- Use idiomatic patterns in the target language
- Include equivalent library imports where needed
- ${options?.preserveComments ? 'Preserve and translate comments' : 'Add comments explaining key differences'}

Provide your response as JSON:
{
  "sourceLanguage": "Detected or specified source language",
  "targetLanguage": "${targetLanguage}",
  "translatedCode": "The translated code",
  "notes": ["Important translation notes"],
  "warnings": ["Any caveats or things that couldn't be directly translated"]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_translate_code',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `\`\`\`${sourceLanguage}\n${code}\n\`\`\`` },
        ],
        { type: 'translate_code', sourceLanguage, targetLanguage }
      );

      const parsed = this.parseJsonResponse(responseText, {
        sourceLanguage: sourceLanguage,
        targetLanguage: targetLanguage,
        translatedCode: '',
        notes: [],
      });

      return {
        success: true,
        sourceLanguage: parsed.sourceLanguage || sourceLanguage,
        targetLanguage: parsed.targetLanguage || targetLanguage,
        translatedCode: parsed.translatedCode || '',
        notes: parsed.notes || [],
        warnings: parsed.warnings,
      };
    } catch (error) {
      return {
        success: false,
        sourceLanguage: sourceLanguage,
        targetLanguage: targetLanguage,
        translatedCode: '',
        notes: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Implementation Planning
  // ============================================

  /**
   * Plan implementation of a feature
   */
  async planImplementation(
    taskDescription: string,
    options?: {
      codebaseContext?: string;
      existingFiles?: string[];
      constraints?: string[];
    }
  ): Promise<PlanImplementationResult> {
    const prompt = `You are an expert software architect. Create a step-by-step implementation plan for the following task.

${options?.codebaseContext ? `Codebase context:\n${options.codebaseContext}` : ''}
${options?.existingFiles ? `Existing files to consider:\n${options.existingFiles.join('\n')}` : ''}
${options?.constraints ? `Constraints:\n${options.constraints.join('\n')}` : ''}

Provide your response as JSON:
{
  "plan": [
    {
      "step": 1,
      "title": "Step title",
      "description": "Detailed description",
      "files": ["files to modify or create"],
      "estimatedEffort": "small|medium|large",
      "dependencies": [0]
    }
  ],
  "summary": "Overall summary of the plan",
  "estimatedTotalEffort": "Total time estimate",
  "risks": ["Potential risks or challenges"]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_plan_implementation',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `Task: ${taskDescription}` },
        ],
        { type: 'plan_implementation' }
      );

      const parsed = this.parseJsonResponse(responseText, {
        plan: [],
        summary: responseText,
        estimatedTotalEffort: 'Unknown',
      });

      return {
        success: true,
        plan: parsed.plan || [],
        summary: parsed.summary || '',
        estimatedTotalEffort: parsed.estimatedTotalEffort || 'Unknown',
        risks: parsed.risks,
      };
    } catch (error) {
      return {
        success: false,
        plan: [],
        summary: '',
        estimatedTotalEffort: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Regex Tools
  // ============================================

  /**
   * Explain a regex pattern in plain English
   */
  async explainRegex(
    pattern: string,
    options?: {
      flags?: string;
      generateExamples?: boolean;
    }
  ): Promise<ExplainRegexResult> {
    const flags = options?.flags ?? '';
    const includeExamples = options?.generateExamples ?? true;

    const prompt = `You are a regex expert. Explain this regular expression in plain English.

Pattern: ${pattern}
${flags ? `Flags: ${flags}` : ''}
${includeExamples ? 'Include example matches and non-matches.' : ''}

Provide your response as JSON:
{
  "pattern": "${pattern}",
  "explanation": "Plain English explanation",
  "breakdown": [
    {"part": "regex part", "meaning": "what it matches"}
  ],
  "examples": [
    {"input": "example text", "matches": true, "matchedPart": "matched portion"}
  ]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'regex_helper',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `Explain this regex: /${pattern}/${flags}` },
        ],
        { type: 'explain_regex', pattern, flags }
      );

      const parsed = this.parseJsonResponse(responseText, {
        pattern,
        explanation: responseText,
        breakdown: [],
        examples: [],
      });

      return {
        success: true,
        pattern,
        explanation: parsed.explanation || '',
        breakdown: parsed.breakdown || [],
        examples: parsed.examples || [],
      };
    } catch (error) {
      return {
        success: false,
        pattern,
        explanation: '',
        breakdown: [],
        examples: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate regex from natural language description
   */
  async generateRegex(
    description: string,
    options?: {
      flavor?: 'javascript' | 'python' | 'pcre';
      examples?: string[];
    }
  ): Promise<GenerateRegexResult> {
    const flavor = options?.flavor ?? 'javascript';

    const prompt = `You are a regex expert. Generate a regular expression based on this description.

Regex flavor: ${flavor}
${options?.examples ? `Examples that should match:\n${options.examples.join('\n')}` : ''}

Provide your response as JSON:
{
  "pattern": "the regex pattern (without delimiters)",
  "flags": "any flags like 'gi'",
  "explanation": "How the pattern works",
  "examples": [
    {"input": "example", "shouldMatch": true}
  ],
  "alternativePatterns": ["simpler or alternative patterns"]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'regex_helper',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `Generate a regex that matches: ${description}` },
        ],
        { type: 'generate_regex', flavor }
      );

      const parsed = this.parseJsonResponse(responseText, {
        pattern: '',
        explanation: responseText,
        examples: [],
      });

      return {
        success: true,
        pattern: parsed.pattern || '',
        flags: parsed.flags,
        explanation: parsed.explanation || '',
        examples: parsed.examples || [],
        alternativePatterns: parsed.alternativePatterns,
      };
    } catch (error) {
      return {
        success: false,
        pattern: '',
        explanation: '',
        examples: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Complexity Analysis
  // ============================================

  /**
   * Estimate Big-O time and space complexity
   */
  async estimateComplexity(
    code: string,
    options?: {
      language?: string;
      functionName?: string;
    }
  ): Promise<EstimateComplexityResult> {
    const language = options?.language ?? 'code';

    const prompt = `You are an expert at algorithm analysis. Analyze this ${language} code and estimate its time and space complexity.

${options?.functionName ? `Focus on function: ${options.functionName}` : ''}

Provide your response as JSON:
{
  "timeComplexity": "O(n), O(n^2), O(log n), etc.",
  "spaceComplexity": "O(1), O(n), etc.",
  "reasoning": "Step-by-step explanation of the analysis",
  "bottlenecks": [
    {
      "location": "Line or code section",
      "description": "What causes the complexity",
      "suggestion": "How to improve it (optional)"
    }
  ]
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_analyze_complexity',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `\`\`\`${language}\n${code}\n\`\`\`` },
        ],
        { type: 'estimate_complexity', language }
      );

      const parsed = this.parseJsonResponse(responseText, {
        timeComplexity: 'Unknown',
        spaceComplexity: 'Unknown',
        reasoning: responseText,
      });

      return {
        success: true,
        timeComplexity: parsed.timeComplexity || 'Unknown',
        spaceComplexity: parsed.spaceComplexity || 'Unknown',
        reasoning: parsed.reasoning || '',
        bottlenecks: parsed.bottlenecks,
      };
    } catch (error) {
      return {
        success: false,
        timeComplexity: '',
        spaceComplexity: '',
        reasoning: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Log Summarization
  // ============================================

  /**
   * Summarize and highlight issues in log output
   */
  async summarizeLogs(
    logs: string,
    options?: {
      focusOnErrors?: boolean;
      maxEvents?: number;
    }
  ): Promise<SummarizeLogsResult> {
    const focusOnErrors = options?.focusOnErrors ?? true;
    const maxEvents = options?.maxEvents ?? 20;

    const prompt = `You are an expert at log analysis. Analyze these logs and provide a summary.

${focusOnErrors ? 'Focus especially on errors and warnings.' : ''}
Limit to ${maxEvents} most important events.

Provide your response as JSON:
{
  "summary": "High-level summary of the logs",
  "keyEvents": [
    {
      "type": "error|warning|info|event",
      "message": "Event description",
      "timestamp": "if available",
      "count": 1
    }
  ],
  "issues": [
    {
      "severity": "critical|high|medium|low",
      "description": "Issue description",
      "recommendation": "How to fix"
    }
  ],
  "statistics": {
    "totalLines": 0,
    "errorCount": 0,
    "warningCount": 0,
    "timeRange": "if determinable"
  }
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_summarize_logs',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: logs.substring(0, 30000) }, // Limit log size
        ],
        { type: 'summarize_logs', focusOnErrors, maxEvents }
      );

      const parsed = this.parseJsonResponse(responseText, {
        summary: responseText,
        keyEvents: [],
        issues: [],
      });

      return {
        success: true,
        summary: parsed.summary || '',
        keyEvents: (parsed.keyEvents || []).slice(0, maxEvents),
        issues: parsed.issues || [],
        statistics: parsed.statistics,
      };
    } catch (error) {
      return {
        success: false,
        summary: '',
        keyEvents: [],
        issues: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============================================
  // Terminal Command Assistant
  // ============================================

  /**
   * Suggest shell commands for a task
   */
  async suggestCommand(
    taskDescription: string,
    options?: {
      platform?: 'unix' | 'windows' | 'cross-platform';
      shell?: 'bash' | 'powershell' | 'cmd' | 'zsh';
      safeMode?: boolean;
    }
  ): Promise<SuggestCommandResult> {
    const platform = options?.platform ?? 'cross-platform';
    const shell = options?.shell ?? 'bash';
    const safeMode = options?.safeMode ?? true;

    const prompt = `You are an expert at shell commands. Suggest command(s) to accomplish the user's task.

Platform: ${platform}
Shell: ${shell}
${safeMode ? 'IMPORTANT: Only suggest safe commands. Avoid destructive operations like rm -rf, format, etc. Always explain risks.' : ''}

Provide your response as JSON:
{
  "commands": [
    {
      "command": "The command to run",
      "explanation": "What the command does",
      "platform": "unix|windows|cross-platform",
      "risk": "safe|moderate|dangerous",
      "alternatives": ["Alternative commands"]
    }
  ],
  "warning": "Any important warnings (optional)"
}`;

    try {
      const responseText = await this.llmWrapper.callToolLlm(
        'mcp_terminal_command',
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `Task: ${taskDescription}` },
        ],
        { type: 'suggest_command', platform, shell, safeMode }
      );

      const parsed = this.parseJsonResponse(responseText, {
        commands: [],
      });

      return {
        success: true,
        commands: parsed.commands || [],
        warning: parsed.warning,
      };
    } catch (error) {
      return {
        success: false,
        commands: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
