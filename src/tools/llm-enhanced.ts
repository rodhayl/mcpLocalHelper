/**
 * LLM-Enhanced Tools
 *
 * These tools wrap basic file operations with local LLM intelligence,
 * providing unique value that VS Code Copilot's built-in tools cannot replicate.
 *
 * Phase 1 (Plan 1): analyze_file, explore_directory, intelligent_search
 * Phase 2 (Plan 3): local_code_review, generate_docs, generate_tests,
 *                   draft_commit_message, suggest_refactoring
 *
 * Plan 1: Complete Edit Loop - suggest_edit with apply, find_and_fix
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, relative, extname, dirname, basename, isAbsolute, resolve } from 'path';
import { ConfigManager, normalizePath } from '../config/index.js';
import { getLanguageFromExtension as resolveLanguageFromExtension } from '../utils/language-map.js';
import { LlmChatTool } from './llm.js';
import { BackendManager } from '../adapters/factory.js';
import { RedactionEngine, type RedactionSummary } from '../utils/redaction.js';
import { extractJsonFromText } from '../utils/llm-json.js';
import { FileTools } from './file.js';
import { ExecutionTools } from './execution.js';
import { toForwardSlashes } from '../utils/path-normalize.js';
import { INPUT_LIMITS } from '../utils/input-limits.js';
import { generatePathSuggestions } from '../utils/structured-errors.js';
import {
  supportsTemplateGeneration,
  getTestSpecPrompt,
  parseTestSpec,
  renderTestCode,
} from '../utils/test-templates.js';
import * as ts from 'typescript';
import {
  AnalyzeFileResult,
  ExploreDirectoryResult,
  IntelligentSearchResult,
  LocalCodeReviewResult,
  GenerateDocsResult,
  GenerateTestsResult,
  DraftCommitMessageResult,
  SuggestRefactoringResult,
  SuggestEditResult,
  DraftFileResult,
  FixLinterResult,
  FixSyntaxResult,
  ImplementTodosResult,
  FixDifficulty,
  AppliedFix,
  FindAndFixResult,
  GenerateAgentsMdResult,
} from '../types/index.js';

/**
 * Valid test frameworks for generate_tests validation.
 * If a framework is not in this list, it will be rejected with a clear error.
 */
export const VALID_FRAMEWORKS = [
  // JavaScript/TypeScript
  'vitest',
  'jest',
  'mocha',
  'jasmine',
  'ava',
  'tape',
  'qunit',
  // Python
  'pytest',
  'unittest',
  'nose',
  'nose2',
  // Java
  'junit',
  'testng',
  // Go
  'testing',
  // Rust
  'cargo test',
  // Ruby
  'rspec',
  'minitest',
  // PHP
  'phpunit',
  // C#/.NET
  'xunit',
  'nunit',
  'mstest',
  // Swift
  'xctest',
  // Kotlin
  'kotest',
  // C/C++
  'gtest',
  'catch2',
  'ctest',
] as const;

export type ValidFramework = (typeof VALID_FRAMEWORKS)[number];

/**
 * Check if a framework is valid
 */
export function isValidFramework(framework: string): framework is ValidFramework {
  return VALID_FRAMEWORKS.includes(framework.toLowerCase() as ValidFramework);
}

/**
 * Get framework suggestions for error messages (typo detection)
 */
export function getFrameworkSuggestions(invalidFramework: string): string[] {
  const lower = invalidFramework.toLowerCase();
  return (VALID_FRAMEWORKS as readonly string[])
    .filter(
      (f) =>
        f.includes(lower) ||
        lower.includes(f) ||
        (Math.abs(f.length - lower.length) <= 2 && f[0] === lower[0])
    )
    .slice(0, 3);
}

export class LlmEnhancedTools {
  private config: ConfigManager;
  private llmChat: LlmChatTool;
  private redaction: RedactionEngine;
  private fileTools: FileTools;
  private executionTools: ExecutionTools;

  constructor(config: ConfigManager, backendManager: BackendManager) {
    this.config = config;
    this.llmChat = new LlmChatTool(backendManager, config);
    const mode =
      this.config.getConfig().privacy?.secretPatterns === 'strict' ? 'strict' : 'default';
    this.redaction = new RedactionEngine({ mode });
    this.fileTools = new FileTools(config);
    this.executionTools = new ExecutionTools({
      workspaceRoot: config.getDefaultWorkspaceRoot(),
    });
  }

  /**
   * Get safe backup directory path that prevents Windows drive duplication.
   * Uses normalizePath to handle cases where root is already absolute.
   */
  private getSafeBackupDir(root: string): string {
    // Ensure root is absolute and normalized to prevent C:\c:\ duplication
    const normalizedRoot = isAbsolute(root) ? normalizePath(root) : normalizePath(resolve(root));
    return join(normalizedRoot, '.mcp-backups');
  }

  // ============================================
  // Phase 1: Core LLM-Enhanced Tools
  // ============================================

  /**
   * Read and analyze a file using local LLM
   * Returns intelligent analysis of the file.
   *
   * V17: includeContent defaults to false to reduce context bloat.
   * Set includeContent=true only when you need the raw file content in the response.
   */
  async analyzeFile(
    path: string,
    options?: {
      question?: string;
      analysisType?: 'quality' | 'security' | 'performance' | 'documentation' | 'full';
      maxBytes?: number;
      /** Whether to include raw file content in response. Default: false (saves context). */
      includeContent?: boolean;
    }
  ): Promise<AnalyzeFileResult> {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    if (!existsSync(resolvedPath)) {
      throw new Error(
        `File not found: '${path}' does not exist. ` +
          `Please verify the path is correct and within the workspace. ` +
          `Tip: use workspace mode="snapshot" or search action="filenames" to find valid file paths.`
      );
    }
    const resolvedStat = statSync(resolvedPath);
    if (!resolvedStat.isFile()) {
      const candidateFiles = this.getDirectoryFileSuggestions(resolvedPath, 5, 2);
      const suggestionText =
        candidateFiles.length > 0 ? ` Try one of these files: ${candidateFiles.join(', ')}.` : '';
      throw new Error(
        `Path '${path}' is not a file (it is a directory). ` +
          `Use workspace mode="snapshot" or search action="filenames" to find a file path, then call analyze_file again.` +
          suggestionText
      );
    }

    const analysisType = options?.analysisType ?? 'quality';
    const maxBytes = options?.maxBytes ?? this.config.getConfig().policy.maxFileBytes;
    // V17: Default to false - analysis is the value, not raw content
    const includeContent = options?.includeContent ?? false;

    // Read the file content
    const fileResult = this.fileTools.readFile(path, maxBytes);
    const content = fileResult.content;
    const redactedContent = content;

    // Determine file language
    const ext = extname(resolvedPath).toLowerCase();
    const language = this.getLanguageFromExtension(ext);

    // Build analysis prompt based on type
    const analysisPrompt = this.buildAnalysisPrompt(analysisType, language, options?.question);

    // Get file stats
    const stats = statSync(resolvedPath);
    const lineCount = content.split('\n').length;

    let analysis: string;
    let issues: Array<{
      type: string;
      line?: number;
      message: string;
      severity: 'error' | 'warning' | 'info';
    }> = [];
    let suggestions: string[] = [];
    let metrics: Record<string, number> = {};

    try {
      const userPrompt = this.capPromptLength(
        `Analyze this ${language} file:\n\n\`\`\`${language}\n${redactedContent}\n\`\`\`${options?.question ? `\n\nSpecific question: ${options.question}` : ''}`
      );
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: analysisPrompt,
            },
            {
              role: 'user',
              content: userPrompt,
            },
          ],
        },
        'local'
      );

      // Parse the LLM response
      const responseText = response.message.content;

      // Extract structured data from response
      const parsed = this.parseAnalysisResponse(responseText, analysisType);
      analysis = parsed.summary;
      issues = parsed.issues;
      suggestions = parsed.suggestions;
      metrics = parsed.metrics;
    } catch (error) {
      analysis = `Analysis could not be completed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    // Calculate basic metrics
    metrics.lineCount = lineCount;
    metrics.sizeBytes = stats.size;
    metrics.functionCount = this.countFunctions(content, language);
    metrics.classCount = this.countClasses(content, language);

    // V17: Only include content if explicitly requested (saves significant context)
    const result: AnalyzeFileResult = {
      path: resolvedPath,
      truncated: fileResult.truncated,
      ...(fileResult.redaction ? { redaction: fileResult.redaction } : {}),
      language,
      analysis,
      issues,
      suggestions,
      metrics,
      question: options?.question,
      analysisType,
    };

    // Only include raw content if explicitly requested
    if (includeContent) {
      result.content = fileResult.content;
    }

    return result;
  }

  /**
   * Return a short list of candidate files when a directory is passed to analyzeFile.
   * Keeps hints small so small models can recover without extra discovery calls.
   */
  private getDirectoryFileSuggestions(
    directoryPath: string,
    maxFiles: number = 5,
    maxDepth: number = 2
  ): string[] {
    const suggestions: string[] = [];
    const preferredExtensions = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.java',
      '.go',
      '.rs',
      '.md',
      '.json',
      '.yaml',
      '.yml',
    ]);
    const skipDirs = new Set(['node_modules', 'dist', 'build', '__pycache__', '.git']);
    const workspaceRoot = this.config.getDefaultWorkspaceRoot();

    const walk = (currentPath: string, depth: number): void => {
      if (suggestions.length >= maxFiles || depth > maxDepth) return;

      let entries: any[];
      try {
        entries = readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (suggestions.length >= maxFiles) break;
        if (entry.name.startsWith('.')) continue;

        const fullPath = join(currentPath, entry.name);
        if (!this.config.isPathAllowed(fullPath)) continue;

        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(fullPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;
        const extension = extname(entry.name).toLowerCase();
        if (!preferredExtensions.has(extension)) continue;

        const relativePath = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
        suggestions.push(relativePath);
      }
    };

    walk(directoryPath, 0);
    return suggestions;
  }

  /**
   * List directory contents with intelligent analysis
   * LLM provides: directory purpose summary, file organization assessment
   */
  async exploreDirectory(
    path: string,
    options?: {
      question?: string;
      depth?: number;
      maxEntries?: number;
    }
  ): Promise<ExploreDirectoryResult> {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    const depth = options?.depth ?? 1;
    const maxEntries = options?.maxEntries ?? 100;

    // Collect directory structure
    const entries = this.collectDirectoryEntries(resolvedPath, depth, maxEntries);

    // Categorize files
    const categorized = this.categorizeFiles(entries);

    // Build structure summary for LLM
    const structureSummary = this.buildStructureSummary(entries, categorized);

    let analysis: string;
    let purpose: string = 'Unknown';
    let recommendations: string[] = [];
    let keyFiles: Array<{ path: string; description: string }> = [];

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: `You are a code structure analyst. Analyze directory contents and provide:
1. A concise purpose statement (what this directory is for)
2. Key files that seem most important and why
3. Recommendations for navigation or organization
4. Answer any specific question about the directory

Be concise but insightful. Focus on helping developers understand and navigate the codebase.`,
            },
            {
              role: 'user',
              content: `Analyze this directory structure:\n\nPath: ${resolvedPath}\n\n${structureSummary}${options?.question ? `\n\nSpecific question: ${options.question}` : ''}`,
            },
          ],
        },
        'local'
      );

      // Parse response
      const responseText = response.message.content;
      const parsed = this.parseDirectoryAnalysis(responseText);
      analysis = parsed.analysis;
      purpose = parsed.purpose || purpose;
      recommendations = parsed.recommendations;
      keyFiles = parsed.keyFiles;
    } catch (error) {
      analysis = `Analysis could not be completed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }

    return {
      path: resolvedPath,
      entries,
      categorized,
      totalFiles: entries.filter((e) => e.type === 'file').length,
      totalDirectories: entries.filter((e) => e.type === 'directory').length,
      analysis,
      purpose,
      recommendations,
      keyFiles,
      question: options?.question,
    };
  }

  /**
   * Search codebase with LLM-powered relevance ranking
   * Finds matches using pattern or natural language, then ranks by relevance
   */
  async intelligentSearch(
    root: string,
    query: string,
    options?: {
      intent?: string;
      maxResults?: number;
      filePattern?: string;
      rankByRelevance?: boolean;
    }
  ): Promise<IntelligentSearchResult> {
    // QUERY VALIDATION - provide clear feedback for empty/invalid queries
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error(
        `Invalid query: The 'query' parameter is required and cannot be empty. ` +
          `Please provide a search term or phrase.`
      );
    }

    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    // EXPLICIT PATH VALIDATION - provide clear feedback for invalid paths
    if (!existsSync(resolvedRoot)) {
      const workspaceRoots = this.config.getWorkspaceRoots();
      const pathHints = generatePathSuggestions(root, workspaceRoots);
      throw new Error(
        `Path not found: '${root}' does not exist. ` +
          `Please verify the path is correct and accessible within the workspace. ` +
          (pathHints.length > 0 ? pathHints.join(' ') : '')
      );
    }

    const stats = statSync(resolvedRoot);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid path: '${root}' is not a directory. ` +
          `The 'root' parameter must be a directory path to search. ` +
          `For single file analysis, use analyze_file instead.`
      );
    }

    const maxResults = options?.maxResults ?? 20;
    const rankByRelevance = options?.rankByRelevance ?? true;

    // For multi-word queries, search for individual words with OR logic
    // This improves recall for natural language queries
    const queryWords = query.split(/\s+/).filter((word) => word.length >= 3);
    let searchPattern: string;
    let isRegex: boolean;

    if (queryWords.length > 1) {
      // Create a regex that matches any of the words (case-insensitive)
      searchPattern = queryWords
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
      isRegex = true;
    } else {
      // Single word/term - use exact match
      searchPattern = query;
      isRegex = false;
    }

    // First, do a pattern-based search
    // Increase candidate pool to reduce "early stop" truncation where one noisy file/folder
    // consumes the match budget and prevents better matches from being found.
    const candidateMaxMatches = Math.min(2000, Math.max(maxResults * 20, 300));
    let grepResults = this.fileTools.grepRepoV2(root, searchPattern, {
      isRegex,
      maxMatches: candidateMaxMatches,
      contextLines: 2,
      filePattern: options?.filePattern,
    });

    // Plan 1 (V6): Fallback search for zero matches
    // If initial search returns nothing, try a relaxed search with shorter tokens
    let usedFallback = false;
    if (grepResults.totalMatches === 0 && query.trim().length > 0) {
      // Try relaxed search: use the original query as-is (non-regex, case-insensitive)
      const fallbackResults = this.fileTools.grepRepoV2(root, query.trim(), {
        isRegex: false,
        maxMatches: candidateMaxMatches,
        contextLines: 2,
        filePattern: options?.filePattern ?? '**/*.{ts,js,tsx,jsx,py,go,rs,java,md,json,yml,yaml}',
      });

      if (fallbackResults.totalMatches > 0) {
        grepResults = fallbackResults;
        usedFallback = true;
      }
    }

    // Filename/path fallback when content grep finds nothing.
    // This supports queries like "agents_summary.py" where the name may never appear in file content.
    if (grepResults.totalMatches === 0 && query.trim().length > 0) {
      const nameMatches = this.fileTools.findPathsByName(root, query.trim(), {
        maxResults: candidateMaxMatches,
        includeDirectories: false,
      });
      if (nameMatches.totalMatches > 0) {
        grepResults = {
          matches: nameMatches.matches.map((match) => ({
            file: match.path,
            line: 1,
            column: 1,
            preview: [`Filename match: ${match.path}`],
            matchedText: query.trim(),
          })),
          totalMatches: nameMatches.totalMatches,
          filesSearched: Math.max(1, nameMatches.filesScanned),
          truncated: nameMatches.truncated,
        };
        usedFallback = true;
      }
    }

    // Collect unique files with their matches
    // Note: grepRepoV2 returns relative paths in match.file
    const fileMatches: Map<string, Array<{ line: number; preview: string }>> = new Map();
    for (const match of grepResults.matches) {
      // match.file is already relative to the root
      if (!fileMatches.has(match.file)) {
        fileMatches.set(match.file, []);
      }
      fileMatches.get(match.file)!.push({
        line: match.line,
        preview: match.preview.join('\n'),
      });
    }

    // Pre-filter and score files to prioritize implementation code over reports/logs
    // V10: Enhanced scoring to better prioritize implementations over tests (addresses v6 feedback)
    const scoredFiles = Array.from(fileMatches.entries()).map(([file, matches]) => {
      let priority = 50; // Base score
      const lowerFile = file.toLowerCase();
      const ext = extname(file).toLowerCase();

      // Implementation code bonus (V10: increased from +20/+10 to +25/+15)
      if (
        ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.cs'].includes(
          ext
        )
      ) {
        priority += 25;
        // Extra bonus for src/ directories (implementation code)
        if (lowerFile.includes('/src/') || lowerFile.startsWith('src/')) {
          priority += 15;
        }
      }

      // V10: Test files should be lower priority for most queries
      // Changed from +5 to -15 to prioritize actual implementations
      if (
        lowerFile.includes('test') ||
        lowerFile.includes('spec') ||
        lowerFile.includes('__tests__')
      ) {
        priority -= 15;
        // Exception: if the file is in src/ (not tests/), it might be production code
        // that happens to have "test" in the name (e.g., src/test-utils.ts)
        if (
          !lowerFile.includes('/tests/') &&
          !lowerFile.includes('/test/') &&
          !lowerFile.includes('/__tests__/')
        ) {
          priority += 5; // Partial recovery for src/ test utilities
        }
      }

      // NOISE REDUCTION: Penalize generated/output files heavily
      const noisePaths = [
        'test-results',
        'output',
        'logs',
        'log',
        'evidence',
        'artifacts',
        'coverage',
        '.next',
        'dist',
        'build',
      ];
      if (noisePaths.some((p) => lowerFile.includes(`/${p}/`) || lowerFile.startsWith(`${p}/`))) {
        priority -= 40;
      }

      // V11: Penalize patch/migration/fixture files (addresses v7 feedback: search returning irrelevant files)
      const patchPatterns = ['.patch', '.diff', 'migration', 'fixture', 'mock', 'stub', 'seed'];
      if (patchPatterns.some((p) => lowerFile.includes(p))) {
        priority -= 25;
      }

      // V11: Penalize auth-related files when query doesn't mention auth (common false positive)
      // Note: This is a heuristic - files with "auth" in the path often dominate results
      const authPatterns = ['/auth/', '/authentication/', '/login/', '/oauth/'];
      if (authPatterns.some((p) => lowerFile.includes(p))) {
        priority -= 10; // Mild penalty, can be overcome by strong content match
      }

      // Penalize report/analysis JSON files
      if (
        ext === '.json' &&
        (lowerFile.includes('report') ||
          lowerFile.includes('analysis') ||
          lowerFile.includes('result'))
      ) {
        priority -= 30;
      }

      // Markdown/docs penalty for code queries
      if (['.md', '.txt', '.log'].includes(ext)) {
        priority -= 15;
      }

      // Config files moderate penalty
      if (
        ['.json', '.yml', '.yaml', '.toml'].includes(ext) &&
        !lowerFile.includes('package.json') &&
        !lowerFile.includes('tsconfig')
      ) {
        priority -= 10;
      }

      return { file, matches, priority };
    });

    // V9: Filename match boosting - check if query matches a filename exactly
    // This helps when users search for a specific file like "runner.ts"
    const queryBasename = query.trim().toLowerCase();
    const queryWithoutExt = queryBasename.replace(/\.[^.]+$/, '');
    for (const scored of scoredFiles) {
      const fileBasename = basename(scored.file).toLowerCase();
      const fileWithoutExt = fileBasename.replace(/\.[^.]+$/, '');

      // Exact filename match (e.g., query="runner.ts" matches "src/agent/runner.ts")
      if (fileBasename === queryBasename) {
        scored.priority = 100; // Highest priority
      }
      // Filename without extension match (e.g., query="runner" matches "runner.ts")
      else if (fileWithoutExt === queryWithoutExt && queryWithoutExt.length >= 3) {
        scored.priority = Math.max(scored.priority, 90);
      }
      // Filename contains query (e.g., query="runner" matches "agent-runner.ts")
      else if (fileBasename.includes(queryBasename) && queryBasename.length >= 4) {
        scored.priority = Math.max(scored.priority, 80);
      }
    }

    // Sort by priority and take top files for LLM context
    scoredFiles.sort((a, b) => b.priority - a.priority);

    // Build context for LLM ranking (prioritized files first)
    const searchContext = scoredFiles.slice(0, 10).map(({ file, matches }) => ({
      file, // Already relative
      matchCount: matches.length,
      firstMatch: matches[0]?.preview || '',
    }));

    let rankedResults: Array<{
      file: string;
      relevanceScore: number;
      reason: string;
      matches: Array<{ line: number; preview: string }>;
    }> = [];

    const baseSummary =
      `Found ${grepResults.totalMatches} matches in ${grepResults.filesSearched} files.` +
      (grepResults.truncated
        ? ' (Search truncated; narrow root or filePattern for better coverage.)'
        : '');

    const buildEvidenceReason = (matches: Array<{ line: number; preview: string }>): string => {
      const first = matches[0];
      if (!first) return 'Pattern match';
      const firstLine = first.preview.split('\n')[0]?.trim() || '';
      const snippet = firstLine.length > 160 ? firstLine.slice(0, 160) + '…' : firstLine;
      return snippet
        ? `Evidence (line ${first.line}): ${snippet}`
        : `Evidence (line ${first.line})`;
    };

    const suggestedNextSteps: string[] = [];

    if (rankByRelevance && searchContext.length > 0) {
      try {
        const response = await this.llmChat.chat(
          {
            messages: [
              {
                role: 'system',
                content: `You are a code search assistant. Given search results, rank them by relevance to the user's query and intent.

## SCORING RULES (apply these bonuses/penalties):
**File Type Scoring:**
- Implementation code (.ts, .js, .py, .go, .rs, .java, .cpp) in src/: +20 bonus
- Test files in tests/ or __tests__/: +10 if query is about testing, -10 otherwise
- Documentation (.md, .txt): +5 if query is about docs/usage, -15 for code queries
- Config files (.json, .yml, .yaml): +5 if query is about config, -20 for code queries
- Log files, reports, analysis outputs: -30 penalty (these are generated artifacts)
- Generated outputs in test-results/, output/, logs/, evidence/: -40 penalty

**Content Relevance:**
- Direct match in function/class name: +30 bonus
- Match in comments only: +5
- Match in string literals only: +10
- Match in import statements: +15

For each file, provide:
- A relevance score (0-100) after applying the above adjustments
- A brief reason why it's relevant or not
- Suggestions for next steps

CRITICAL: Output ONLY valid JSON with no other text, no markdown, no explanation. Just the raw JSON object:
{"rankings": [{"file": "path/to/file", "score": 85, "reason": "explanation"}], "summary": "brief summary", "nextSteps": ["step1", "step2"]}`,
              },
              {
                role: 'user',
                content: `Query: "${query}"${options?.intent ? `\nIntent: ${options.intent}` : ''}\n\nSearch results:\n${JSON.stringify(searchContext, null, 2)}`,
              },
            ],
          },
          'local'
        );

        // Parse LLM response
        const parsed = this.parseSearchRanking(response.message.content);

        // Apply rankings to results if we got any
        if (parsed.rankings.length > 0) {
          // ranking.file should match the keys in fileMatches (both are relative paths)
          // CRITICAL: Normalize paths to handle any platform-specific differences
          // LLMs return forward slashes, but fileMatches keys now also use forward slashes
          for (const ranking of parsed.rankings) {
            const normalizedFile = toForwardSlashes(ranking.file);
            const matches = fileMatches.get(normalizedFile) || [];
            if (matches.length === 0 && !fileMatches.has(normalizedFile)) continue;
            rankedResults.push({
              file: normalizedFile,
              relevanceScore: ranking.score,
              reason: buildEvidenceReason(matches),
              matches,
            });
          }
        } else {
          // Fallback: heuristic ranking without LLM reasons
          rankedResults = scoredFiles.map(({ file, matches, priority }) => ({
            file,
            relevanceScore: Math.max(0, Math.min(100, priority + Math.min(10, matches.length))),
            reason: buildEvidenceReason(matches),
            matches,
          }));
        }
      } catch {
        // Fall back to heuristic ranking
        rankedResults = scoredFiles.map(({ file, matches, priority }) => ({
          file,
          relevanceScore: Math.max(0, Math.min(100, priority + Math.min(10, matches.length))),
          reason: buildEvidenceReason(matches),
          matches,
        }));
      }
    } else {
      rankedResults = scoredFiles.map(({ file, matches, priority }) => ({
        file,
        relevanceScore: Math.max(0, Math.min(100, priority + Math.min(10, matches.length))),
        reason: buildEvidenceReason(matches),
        matches,
      }));
    }

    // Sort by relevance score
    rankedResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Deterministic next steps (avoid hallucinated guidance from small models)
    if (grepResults.totalMatches === 0) {
      suggestedNextSteps.push(
        'Try different keywords or fewer words.',
        'Try action="filenames" if you are looking for a file by name.',
        'Narrow root to a specific folder (e.g., "src").'
      );
      if (usedFallback) {
        suggestedNextSteps.unshift('Fallback search was attempted but found no matches.');
      }
    } else if (grepResults.truncated) {
      suggestedNextSteps.push(
        'Narrow root to reduce noise (e.g., "src").',
        'Use filePattern to limit extensions (e.g., "**/*.ts" or "**/*.py").',
        'Increase maxResults if you need more candidates.'
      );
    } else {
      suggestedNextSteps.push(
        'Open the top result with analyze_file for deeper analysis.',
        'Use action="structured" to find relevant symbols (functions/classes).',
        'Use action="gather" to collect a small set of related files.'
      );
    }

    const searchSummaryWithFallback = usedFallback
      ? `${baseSummary} (Used fallback search)`
      : baseSummary;

    // V12: Add diagnostic object when 0 files found to help debug search issues
    const diagnostic =
      grepResults.totalMatches === 0
        ? {
            resolvedRoot,
            queryUsed: searchPattern,
            isRegex,
            filePatternUsed: options?.filePattern ?? '(default)',
            fallbackAttempted: usedFallback,
            suggestions: [
              `Resolved path: ${resolvedRoot}`,
              `Check if the path exists and contains searchable files`,
              `Try a simpler query (single word) or verify spelling`,
              options?.filePattern
                ? `Current pattern: ${options.filePattern} - try removing to search all files`
                : null,
            ].filter(Boolean) as string[],
          }
        : undefined;

    // QA_feedback_7 CRITICAL FIX: Ensure results array is NEVER empty when totalMatches > 0
    // Bug: ranking/pagination logic was returning empty results[] despite finding matches
    // Fix: If we have matches but empty rankedResults, return top scoredFiles as fallback
    if (grepResults.totalMatches > 0 && rankedResults.length === 0 && scoredFiles.length > 0) {
      // Emergency fallback: return top scored files without LLM ranking
      rankedResults = scoredFiles.slice(0, maxResults).map(({ file, matches, priority }) => ({
        file,
        relevanceScore: Math.max(0, Math.min(100, priority + Math.min(10, matches.length))),
        reason: buildEvidenceReason(matches),
        matches,
      }));
    }

    return {
      query,
      intent: options?.intent,
      results: rankedResults.slice(0, maxResults),
      totalMatches: grepResults.totalMatches,
      filesSearched: grepResults.filesSearched,
      searchSummary: searchSummaryWithFallback,
      suggestedNextSteps,
      usedFallback,
      diagnostic,
    };
  }

  // ============================================
  // Phase 2: Advanced LLM-Enhanced Tools
  // ============================================

  /**
   * Privacy-preserving code review using local LLM
   */
  async localCodeReview(
    files: string[],
    options?: {
      reviewType?: 'security' | 'performance' | 'style' | 'comprehensive';
      context?: string;
      focusAreas?: string[];
      includeHidden?: boolean;
    }
  ): Promise<LocalCodeReviewResult> {
    const reviewType = options?.reviewType ?? 'comprehensive';
    const fileContents: Array<{ path: string; content: string; language: string }> = [];
    const includeHidden = options?.includeHidden ?? false;
    const reviewTargets = this.expandCodeReviewTargets(files, 50, includeHidden);

    // Read all files
    for (const resolved of reviewTargets) {
      try {
        const content = readFileSync(resolved, 'utf-8');
        const redacted = this.redaction.redact(content);
        const ext = extname(resolved).toLowerCase();
        fileContents.push({
          path: relative(this.config.getDefaultWorkspaceRoot(), resolved),
          // Plan 3 (V4): Increased from 8000 to 12000 for deeper analysis
          content: redacted.substring(0, 12000),
          language: this.getLanguageFromExtension(ext),
        });
      } catch {
        // Skip unreadable files
      }
    }

    if (fileContents.length === 0) {
      return {
        success: false,
        error:
          'No readable files found. Verify paths are inside the workspace and contain files. ' +
          'Tip: set includeHidden=true for dot folders, or run workspace mode="snapshot" / search action="filenames" to find valid paths.',
        filesReviewed: 0,
        issues: [],
        summary: '',
        recommendations: [],
      };
    }

    // Build review prompt
    const reviewPrompt = this.buildReviewPrompt(reviewType, options?.focusAreas);

    try {
      const reviewPayload = `Review these files:\n${options?.context ? `Context: ${options.context}\n\n` : ''}${fileContents.map((f) => `### ${f.path} (${f.language})\n\`\`\`${f.language}\n${f.content}\n\`\`\``).join('\n\n')}`;
      const boundedReviewPayload = this.capPromptLength(reviewPayload);
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: reviewPrompt,
            },
            {
              role: 'user',
              content: boundedReviewPayload,
            },
          ],
        },
        'local'
      );

      const parsed = this.parseCodeReview(response.message.content);

      return {
        success: true,
        filesReviewed: fileContents.length,
        issues: parsed.issues,
        summary: parsed.summary,
        recommendations: parsed.recommendations,
        overallScore: parsed.score,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        filesReviewed: fileContents.length,
        issues: [],
        summary: '',
        recommendations: [],
      };
    }
  }

  /**
   * Generate documentation using local LLM
   */
  async generateDocs(
    path: string,
    options?: {
      docType?: 'jsdoc' | 'readme' | 'api' | 'usage-examples';
      style?: string;
      includeExamples?: boolean;
    }
  ): Promise<GenerateDocsResult> {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    const docType = options?.docType ?? 'jsdoc';

    let content: string;
    let language: string;

    try {
      content = readFileSync(resolvedPath, 'utf-8');
      const redacted = this.redaction.redact(content);
      content = redacted.substring(0, 12000); // Limit for context
      const ext = extname(resolvedPath).toLowerCase();
      language = this.getLanguageFromExtension(ext);
    } catch (error) {
      return {
        success: false,
        error: `Could not read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        documentation: '',
        docType,
      };
    }

    const docPrompt = this.buildDocPrompt(
      docType,
      language,
      options?.style,
      options?.includeExamples
    );

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: docPrompt,
            },
            {
              role: 'user',
              content: `Generate ${docType} documentation for this ${language} code:\n\n\`\`\`${language}\n${content}\n\`\`\``,
            },
          ],
        },
        'local'
      );

      return {
        success: true,
        documentation: response.message.content,
        docType,
        path: resolvedPath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        documentation: '',
        docType,
      };
    }
  }

  /**
   * Generate test cases using local LLM
   *
   * V18: Large file guard - files >300 lines without focusFunctions return soft error.
   * This prevents poor-quality test generation and wasted LLM calls.
   */
  async generateTests(
    path: string,
    options?: {
      framework?: string;
      coverage?: 'basic' | 'comprehensive' | 'edge-cases';
      testStyle?: 'unit' | 'integration' | 'e2e' | 'real-implementation';
      focusFunctions?: string[];
    }
  ): Promise<GenerateTestsResult> {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    if (!existsSync(resolvedPath)) {
      throw new Error(
        `File not found: '${path}' does not exist. ` +
          `Resolved to: '${resolvedPath}'. ` +
          `Please verify the path is correct and within the workspace.`
      );
    }

    // QA_feedback_11: File type guard - reject non-code files with clear error
    // Prevents attempting test generation for JSON, Markdown, and other non-code files
    const ext = extname(resolvedPath).toLowerCase();
    const NON_CODE_EXTENSIONS = [
      '.json',
      '.md',
      '.txt',
      '.yaml',
      '.yml',
      '.xml',
      '.html',
      '.css',
      '.svg',
      '.png',
      '.jpg',
      '.gif',
      '.ico',
      '.pdf',
      '.doc',
      '.docx',
      '.lock',
      '.log',
    ];
    if (NON_CODE_EXTENSIONS.includes(ext)) {
      return {
        success: false,
        error:
          `Cannot generate tests for '${ext}' files. ` +
          `generate_tests only supports source code files (e.g., .py, .ts, .js, .java, .go, .rs). ` +
          `File: ${path}`,
        tests: '',
        framework: options?.framework || 'unknown',
        coverage: options?.coverage ?? 'comprehensive',
        testCount: 0,
        syntaxValid: false,
      };
    }

    const coverage = options?.coverage ?? 'comprehensive';
    const testStyle = options?.testStyle ?? 'unit';

    let content: string;
    let language: string;
    let redactionSummary: RedactionSummary | undefined;
    let largeFileHint: string | undefined;

    try {
      content = readFileSync(resolvedPath, 'utf-8');
      const lineCount = content.split('\n').length;

      // V18: Large file guard - return soft error for files >300 lines without focusFunctions
      // This prevents poor-quality test generation from context overflow
      // QA_feedback_7.md: "generate_tests produces syntax errors on large files"
      const LARGE_FILE_THRESHOLD = 300;
      const hasFocusFunctions = options?.focusFunctions && options.focusFunctions.length > 0;

      if (lineCount > LARGE_FILE_THRESHOLD && !hasFocusFunctions) {
        return {
          success: false,
          error:
            `File too large for comprehensive test generation (${lineCount} lines). ` +
            `For files over ${LARGE_FILE_THRESHOLD} lines, use the 'focusFunctions' parameter to target specific functions. ` +
            `Example: { "focusFunctions": ["myFunction", "anotherFunction"] }. ` +
            `This improves test quality and prevents context overflow errors.`,
          tests: '',
          framework: options?.framework || 'unknown',
          coverage,
          testCount: 0,
          syntaxValid: false,
          largeFileHint: `Tip: Use 'focusFunctions' to generate tests for specific functions in large files.`,
        };
      }

      // V15: Large file hint - suggest focus parameter for files >250 lines (still under threshold)
      if (lineCount > 250 && !hasFocusFunctions) {
        largeFileHint =
          `Note: This file has ${lineCount} lines. For better test quality, consider using the 'focusFunctions' parameter ` +
          `to target specific functions (e.g., focusFunctions=["functionName"]). Large files may produce less accurate tests ` +
          `due to context window limitations.`;
      }

      const { text: redacted, summary } = this.redaction.redactWithSummary(content);
      content = redacted.substring(0, 10000);
      redactionSummary = summary.totalReplacements > 0 ? summary : undefined;
      const ext = extname(resolvedPath).toLowerCase();
      language = this.getLanguageFromExtension(ext);
    } catch (error) {
      return {
        success: false,
        error: `Could not read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        tests: '',
        framework: options?.framework || 'unknown',
        coverage,
        testCount: 0,
      };
    }

    // Validate framework if specified (Black-box V3: strict enum validation)
    if (options?.framework) {
      const frameworkLower = options.framework.toLowerCase();
      if (!isValidFramework(frameworkLower)) {
        const suggestions = getFrameworkSuggestions(options.framework);
        const suggestionText =
          suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(', ')}?`
            : ` Valid frameworks: ${VALID_FRAMEWORKS.slice(0, 10).join(', ')}, ...`;
        return {
          success: false,
          error: `Invalid framework: '${options.framework}' is not a supported test framework.${suggestionText}`,
          tests: '',
          framework: options.framework,
          coverage,
          testCount: 0,
          syntaxValid: false,
        };
      }
    }

    // Auto-detect framework if not specified
    const framework = options?.framework || this.detectTestFramework(language);

    // V18: Template-based test generation for supported frameworks
    // LLM returns JSON test spec, server generates code from template
    // This produces more consistent, syntactically correct test code
    if (supportsTemplateGeneration(framework)) {
      try {
        const templateResult = await this.generateTestsWithTemplate(
          content,
          language,
          framework,
          coverage,
          options?.focusFunctions,
          testStyle,
          path
        );
        if (templateResult.success) {
          return {
            ...templateResult,
            largeFileHint,
            ...(redactionSummary ? { redaction: redactionSummary } : {}),
          };
        }
        // Template generation failed, fall through to legacy approach
        console.log(
          `Template generation failed: ${templateResult.error}, falling back to legacy approach`
        );
      } catch (e) {
        // Template generation threw, fall through to legacy approach
        console.log(`Template generation error: ${e}, falling back to legacy approach`);
      }
    }

    // Legacy approach: LLM generates raw test code directly
    const testPrompt = this.buildTestPrompt(
      framework,
      coverage,
      options?.focusFunctions,
      testStyle,
      path
    );

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: testPrompt,
            },
            {
              role: 'user',
              content:
                `Source file (workspace-relative): ${path.replace(/\\\\/g, '/')}\n\n` +
                `Generate tests for this ${language} code:\n\n\`\`\`${language}\n${content}\n\`\`\``,
            },
          ],
        },
        'local'
      );

      // Extract code from markdown blocks if the LLM wrapped the output
      let tests = response.message.content;
      tests = this.redaction.stripThinkTags(tests);

      // QA_feedback_9: Fix HTML entity encoding in generated code
      // Some LLMs/templates output HTML entities that corrupt code syntax
      // Apply BEFORE any other processing to restore raw characters
      tests = this.decodeHtmlEntities(tests);

      // Black-box V5/V9: Fix newlines lost in JSON transport
      // LLMs may return escaped newlines that survive JSON parsing as literals
      // Apply BEFORE code block extraction to handle corruption in raw LLM output
      tests = tests.replace(/\\n/g, '\n');
      tests = tests.replace(/\\r\\n/g, '\n');
      tests = tests.replace(/\\t/g, '    '); // Convert escaped tabs to spaces

      // If response contains markdown code blocks, extract the code
      const codeBlockMatch = tests.match(
        /```(?:typescript|javascript|python|java|go|rust)?\s*\n([\s\S]*?)```/
      );
      if (codeBlockMatch) {
        tests = codeBlockMatch[1].trim();
      } else {
        // Remove any markdown artifacts but preserve the code
        tests = tests
          .replace(/^```\w*\n?/gm, '')
          .replace(/```$/gm, '')
          .trim();
      }

      // Black-box V9: Second pass newline normalization AFTER code block extraction
      // Some LLMs double-escape newlines inside code blocks
      tests = tests.replace(/\\n/g, '\n');
      tests = tests.replace(/\\r\\n/g, '\n');
      tests = tests.replace(/\\t/g, '    ');

      // Black-box V9: Python-specific indentation normalization
      // Ensure consistent 4-space indentation for Python code
      if (language === 'python') {
        tests = this.normalizePythonIndentation(tests);
        // V12: Repair collapsed Python lines (common LLM error: "def foo():return x")
        tests = this.repairCollapsedPythonLines(tests);
      }

      // Sanitize and post-process generated code (small-model hardening)
      const sanitized = this.sanitizeGeneratedCode(tests);
      tests = this.cleanGeneratedTestCode(sanitized.code, path);

      // Black-box V5: Additional newline normalization after all processing
      // Ensure proper line breaks are preserved in final output
      tests = tests.replace(
        /;(\s*)(?=import|const|let|var|function|class|describe|it|test)/g,
        ';\n$1'
      );

      // V15: Format Python code with black if available (addresses persistent syntax issues)
      // This is run AFTER all other normalization to fix any remaining formatting issues
      let blackFormatResult: { formatted: boolean; error?: string } | undefined;
      if (language === 'python') {
        const formatResult = await this.formatPythonWithBlack(tests);
        tests = formatResult.code;
        blackFormatResult = { formatted: formatResult.formatted, error: formatResult.error };
      }

      const testCount = (tests.match(/it\(|test\(|def test_|@Test/g) || []).length;

      // Quality check: warn if output appears to have issues
      const qualityWarnings: string[] = [];

      // V15: Add info about black formatting status
      if (language === 'python' && blackFormatResult) {
        if (blackFormatResult.formatted) {
          // Successfully formatted - no warning needed
        } else if (blackFormatResult.error) {
          qualityWarnings.push(`Python formatting skipped: ${blackFormatResult.error}`);
        }
      }

      if (sanitized.removedChars > 0) {
        qualityWarnings.push(
          `Removed ${sanitized.removedChars} non-printable/zero-width characters from generated output`
        );
      }
      const parseErrorSummary = this.getTypeScriptParseErrorSummary(tests, language);
      if (parseErrorSummary) {
        qualityWarnings.push(parseErrorSummary);
      }
      if (tests.includes('TODO') || tests.includes('FIXME')) {
        qualityWarnings.push('Generated tests contain TODO/FIXME placeholders');
      }
      if (!/^(import|const|let|var|describe|it|test|function|class|def |from )/m.test(tests)) {
        qualityWarnings.push('Generated output may not be valid test code');
      }

      // Plan 3 (V6): Check for potential hallucinated assertions
      // Warn about hard-coded numeric values that may not be from source
      const numericAssertionMatches = tests.match(
        /(?:expect|assert|toBe|toEqual|assertEqual)\s*\([^)]*\d{3,}[^)]*\)/g
      );
      if (numericAssertionMatches && numericAssertionMatches.length > 0) {
        qualityWarnings.push(
          `Found ${numericAssertionMatches.length} assertion(s) with hard-coded numeric values. ` +
            'Verify these values match the actual source code before trusting.'
        );
      }

      // Warn about specific string literals that may be hallucinated
      const stringAssertionMatches = tests.match(
        /(?:toBe|toEqual|assertEqual)\s*\(\s*['"][^'"]{20,}['"]\s*\)/g
      );
      if (stringAssertionMatches && stringAssertionMatches.length > 0) {
        qualityWarnings.push(
          `Found ${stringAssertionMatches.length} assertion(s) with long string literals. ` +
            'These may be hallucinated - verify against source.'
        );
      }

      // Determine syntax validity based on parse errors (Black-box V3: syntaxValid field)
      // Black-box V5: Add Python syntax validation via AST check
      // V11: Enhanced syntax validation with simple heuristics
      let hasSyntaxErrors = parseErrorSummary !== null;
      let pythonParseError: string | null = null;
      const syntaxErrors: string[] = [];

      if (language === 'python') {
        pythonParseError = await this.getPythonSyntaxErrorSummary(tests);
        if (pythonParseError) {
          hasSyntaxErrors = true;
          syntaxErrors.push(pythonParseError);
          qualityWarnings.push(pythonParseError);
        }
      }

      // V11: Simple heuristic-based syntax validation (addresses v7 feedback)
      const heuristicErrors = this.validateGeneratedTestSyntax(tests, language);
      if (heuristicErrors.length > 0) {
        hasSyntaxErrors = true;
        syntaxErrors.push(...heuristicErrors);
        qualityWarnings.push(...heuristicErrors);
      }

      const syntaxValid =
        !hasSyntaxErrors &&
        /^(import|const|let|var|describe|it|test|function|class|def |from )/m.test(tests);

      // V15: Include large file hint in warnings if present
      if (largeFileHint) {
        qualityWarnings.unshift(largeFileHint);
      }

      // V17: Graceful fallback when syntax is invalid - wrap in comment block
      // Addresses QA feedback: "generate_tests produced malformed code...would be unusable without heavy cleanup"
      let finalTests = tests;
      if (!syntaxValid && hasSyntaxErrors && syntaxErrors.length > 0) {
        const errorList = syntaxErrors.slice(0, 3).join('; ');
        const lang =
          language === 'python' ? 'python' : language === 'typescript' ? 'typescript' : language;
        const commentStart = lang === 'python' ? '"""' : '/*';
        const commentEnd = lang === 'python' ? '"""' : '*/';
        finalTests = `${commentStart}\n⚠️ GENERATED CODE HAS SYNTAX ERRORS - Manual review required\nErrors detected: ${errorList}\nRun through a formatter (black for Python, prettier for TS/JS) before use.\n${commentEnd}\n\n${tests}`;
        qualityWarnings.unshift(
          `Code wrapped in comment block due to syntax errors. Run through formatter before use.`
        );
      }

      // V18 (QA_feedback_5): Validate imports against actual repo modules
      // Addresses: "Add a validate_imports check to ensure the generated test file does not import non-existent modules"
      const importValidationResult = await this.validateGeneratedImports(
        finalTests,
        language,
        resolvedPath
      );
      if (importValidationResult.warnings.length > 0) {
        qualityWarnings.push(...importValidationResult.warnings);
      }

      if (language === 'python') {
        const semanticWarnings = this.validatePythonTestSemantics(finalTests);
        if (semanticWarnings.length > 0) {
          qualityWarnings.push(...semanticWarnings);
        }
      }

      return {
        success: true,
        tests: finalTests,
        framework,
        coverage,
        testCount,
        path: resolvedPath,
        syntaxValid,
        ...(redactionSummary ? { redaction: redactionSummary } : {}),
        ...(qualityWarnings.length > 0 && { warnings: qualityWarnings }),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        tests: '',
        framework,
        coverage,
        testCount: 0,
        syntaxValid: false,
      };
    }
  }

  /**
   * Generate commit message using local LLM based on changes
   */
  async draftCommitMessage(options?: {
    style?: 'conventional' | 'detailed' | 'simple';
    includeBody?: boolean;
    changedFiles?: string[];
    diff?: string;
  }): Promise<DraftCommitMessageResult> {
    const style = options?.style ?? 'conventional';
    const includeBody = options?.includeBody ?? true;

    // If no diff provided, we can't generate
    if (!options?.diff && (!options?.changedFiles || options.changedFiles.length === 0)) {
      return {
        success: false,
        error: 'No changes provided. Please provide diff or changedFiles.',
        message: '',
        style,
      };
    }

    const commitPrompt = this.buildCommitPrompt(style, includeBody);

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: commitPrompt,
            },
            {
              role: 'user',
              content: options?.diff
                ? `Generate a commit message for these changes:\n\n${options.diff.substring(0, 8000)}`
                : `Generate a commit message for changes to these files:\n\n${options.changedFiles?.join('\n')}`,
            },
          ],
        },
        'local'
      );

      return {
        success: true,
        message: response.message.content,
        style,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: '',
        style,
      };
    }
  }

  /**
   * Get refactoring suggestions using local LLM
   */
  async suggestRefactoring(
    path: string,
    options?: {
      focus?: 'duplication' | 'complexity' | 'naming' | 'architecture' | 'all';
      maxSuggestions?: number;
    }
  ): Promise<SuggestRefactoringResult> {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    const focus = options?.focus ?? 'all';

    let content: string;
    let language: string;

    try {
      content = readFileSync(resolvedPath, 'utf-8');
      const redacted = this.redaction.redact(content);
      content = redacted.substring(0, 10000);
      const ext = extname(resolvedPath).toLowerCase();
      language = this.getLanguageFromExtension(ext);
    } catch (error) {
      return {
        success: false,
        error: `Could not read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        suggestions: [],
        summary: '',
      };
    }

    const refactorPrompt = this.buildRefactorPrompt(focus, language);

    try {
      const timeoutRaw = process.env.SUGGEST_REFACTORING_LLM_TIMEOUT_MS;
      const timeoutMs = timeoutRaw ? Math.max(1000, Number.parseInt(timeoutRaw, 10)) : 60000;
      const controller = new AbortController();
      // Abort slightly before the adapter's per-attempt timeout to ensure the adapter sees `signal.aborted`
      // and does not proceed with additional internal retries.
      const abortAfterMs = Math.max(0, timeoutMs - 25);
      const timer = setTimeout(() => controller.abort(), abortAfterMs);

      const response = await (async () => {
        try {
          return await this.llmChat.chat(
            {
              messages: [
                {
                  role: 'system',
                  content: refactorPrompt,
                },
                {
                  role: 'user',
                  content: `Analyze this ${language} code for refactoring opportunities:\n\n\`\`\`${language}\n${content}\n\`\`\``,
                },
              ],
            },
            'local',
            // Avoid long retry loops / hangs that can exceed MCP/client timeouts.
            { maxRetries: 0, timeoutMs, signal: controller.signal }
          );
        } finally {
          clearTimeout(timer);
        }
      })();

      const parsed = this.parseRefactoringSuggestions(response.message.content);

      return {
        success: true,
        suggestions: parsed.suggestions.slice(0, options?.maxSuggestions ?? 10),
        summary: parsed.summary,
        path: resolvedPath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        suggestions: [],
        summary: '',
      };
    }
  }

  // ============================================
  // Plan 1: Complete Edit Loop - Enhanced Tools
  // ============================================

  /**
   * Get LLM-powered edit suggestions for a file
   * Analyzes current code and intent, suggests specific edits with explanations
   *
   * Plan 1 Enhancement: Can optionally apply edits directly with apply=true
   */
  async suggestEdit(
    filePath: string,
    intent: string,
    options?: {
      context?: string;
      maxSuggestions?: number;
      /** Plan 1: If true, apply the suggested edits automatically */
      apply?: boolean;
      /** Minimum confidence level to apply (default: 'high') */
      minConfidence?: 'high' | 'medium' | 'low';
    }
  ): Promise<SuggestEditResult & { applied?: number; applyErrors?: string[] }> {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    if (!existsSync(resolvedPath)) {
      throw new Error(
        `File not found: '${filePath}' does not exist. ` +
          `Resolved to: '${resolvedPath}'. ` +
          `Please verify the path is correct and within the workspace.`
      );
    }

    let content: string;
    let language: string;

    try {
      content = readFileSync(resolvedPath, 'utf-8');
      const redacted = this.redaction.redact(content);
      content = redacted.substring(0, 12000);
      const ext = extname(resolvedPath).toLowerCase();
      language = this.getLanguageFromExtension(ext);
    } catch (error) {
      return {
        success: false,
        error: `Could not read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        path: resolvedPath,
        intent,
        suggestions: [],
        summary: '',
      };
    }

    const editPrompt = `You are an expert code editor. Analyze the provided code and the user's intent, then suggest specific edits.

IMPORTANT: You MUST respond with ONLY valid JSON, no markdown, no explanation outside the JSON.

For each edit suggestion:
1. Describe what change you're suggesting
2. Show the BEFORE code (exact lines to replace)
3. Show the AFTER code (the replacement)
4. Specify the line range if possible
5. Rate your confidence (high/medium/low)
6. Explain why this change accomplishes the intent

Your response MUST be valid JSON in this exact format:
{
  "suggestions": [
    {
      "description": "Brief description of the change",
      "before": "The exact code to replace",
      "after": "The replacement code",
      "lineRange": { "start": 10, "end": 15 },
      "confidence": "high",
      "explanation": "Why this change helps"
    }
  ],
  "summary": "Overall summary of suggested edits"
}

If you cannot suggest any edits, return: {"suggestions": [], "summary": "No applicable edits found for this intent."}

Be specific and actionable. Only suggest changes that directly address the intent.`;

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: editPrompt,
            },
            {
              role: 'user',
              content: `Intent: ${intent}${options?.context ? `\nContext: ${options.context}` : ''}\n\nFile (${language}):\n\`\`\`${language}\n${content}\n\`\`\``,
            },
          ],
        },
        'local'
      );

      const parsed = this.parseEditSuggestions(response.message.content);
      const suggestions = parsed.suggestions.slice(0, options?.maxSuggestions ?? 5);

      // Plan 1: Apply edits if requested
      let applied = 0;
      const applyErrors: string[] = [];

      if (options?.apply && suggestions.length > 0) {
        const minConfidence = options.minConfidence ?? 'high';
        const confidenceOrder = { high: 0, medium: 1, low: 2 };
        const minConfidenceLevel = confidenceOrder[minConfidence];

        // Read current content for applying edits
        let currentContent = readFileSync(resolvedPath, 'utf-8');

        for (const suggestion of suggestions) {
          // Skip if below confidence threshold
          const suggestionConfidence = confidenceOrder[suggestion.confidence];
          if (suggestionConfidence > minConfidenceLevel) {
            continue;
          }

          // Skip if no before/after
          if (!suggestion.before || !suggestion.after) {
            continue;
          }

          // Try to apply the edit
          try {
            if (currentContent.includes(suggestion.before)) {
              currentContent = currentContent.replace(suggestion.before, suggestion.after);
              applied++;
            } else {
              applyErrors.push(`Could not find exact match for: ${suggestion.description}`);
            }
          } catch (e) {
            applyErrors.push(
              `Error applying: ${suggestion.description} - ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }

        // Write back if any edits were applied
        if (applied > 0) {
          // Create backup
          const backupDir = this.getSafeBackupDir(dirname(resolvedPath));
          if (!existsSync(backupDir)) {
            mkdirSync(backupDir, { recursive: true });
          }
          const backupPath = join(backupDir, `${basename(resolvedPath)}.${Date.now()}.bak`);
          writeFileSync(backupPath, readFileSync(resolvedPath));

          // Write updated content
          writeFileSync(resolvedPath, currentContent, 'utf-8');
        }
      }

      return {
        success: true,
        path: resolvedPath,
        intent,
        suggestions,
        summary: parsed.summary,
        applied: options?.apply ? applied : undefined,
        applyErrors: applyErrors.length > 0 ? applyErrors : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        path: resolvedPath,
        intent,
        suggestions: [],
        summary: '',
      };
    }
  }

  /**
   * Plan 1: Find and Fix - chains search → analyze → suggest_edit with optional apply
   * Finds code matching a query, analyzes it, and suggests/applies fixes
   */
  async findAndFix(
    query: string,
    intent: string,
    options?: {
      root?: string;
      apply?: boolean;
      maxFiles?: number;
      maxSuggestions?: number;
      minConfidence?: 'high' | 'medium' | 'low';
    }
  ): Promise<FindAndFixResult> {
    const root = options?.root ?? this.config.getDefaultWorkspaceRoot();
    const resolvedRoot = this.config.resolveWorkspacePath(root);
    const maxFiles = options?.maxFiles ?? 10;
    const apply = options?.apply ?? false;

    if (!this.config.isPathAllowed(resolvedRoot)) {
      return {
        success: false,
        error: `Access denied: Path '${root}' is not in the allowlist`,
        query,
        intent,
        filesAnalyzed: 0,
        suggestionsGenerated: 0,
        suggestionsApplied: 0,
        results: [],
        summary: '',
      };
    }

    // Step 1: Search for matching files
    let searchResults: { file: string; matches: Array<{ line: number; preview: string }> }[];
    try {
      const search = await this.intelligentSearch(root, query, {
        maxResults: maxFiles * 2,
        rankByRelevance: true,
      });
      searchResults = search.results.slice(0, maxFiles);
    } catch (e) {
      return {
        success: false,
        error: `Search failed: ${e instanceof Error ? e.message : String(e)}`,
        query,
        intent,
        filesAnalyzed: 0,
        suggestionsGenerated: 0,
        suggestionsApplied: 0,
        results: [],
        summary: '',
      };
    }

    if (searchResults.length === 0) {
      return {
        success: true,
        query,
        intent,
        filesAnalyzed: 0,
        suggestionsGenerated: 0,
        suggestionsApplied: 0,
        results: [],
        summary: `No files found matching query: "${query}"`,
      };
    }

    // Step 2: For each file, generate and optionally apply suggestions
    const results: Array<{
      file: string;
      suggestions: Array<{
        description: string;
        before?: string;
        after: string;
        lineRange?: { start: number; end: number };
        confidence: 'high' | 'medium' | 'low';
        applied: boolean;
        applyError?: string;
      }>;
    }> = [];
    const backupPaths: string[] = [];
    let totalSuggestions = 0;
    let totalApplied = 0;

    for (const { file } of searchResults) {
      const filePath = join(resolvedRoot, file);

      try {
        const editResult = await this.suggestEdit(filePath, intent, {
          context: `Found via search query: "${query}"`,
          maxSuggestions: options?.maxSuggestions ?? 3,
          apply,
          minConfidence: options?.minConfidence,
        });

        if (editResult.success && editResult.suggestions.length > 0) {
          const fileResult = {
            file,
            suggestions: editResult.suggestions.map((s, idx) => ({
              description: s.description,
              before: s.before,
              after: s.after,
              lineRange: s.lineRange,
              confidence: s.confidence,
              applied: apply && editResult.applied ? idx < editResult.applied : false,
              applyError: editResult.applyErrors?.[idx],
            })),
          };
          results.push(fileResult);
          totalSuggestions += editResult.suggestions.length;
          totalApplied += editResult.applied ?? 0;
        }
      } catch {
        // Skip files that fail
      }
    }

    return {
      success: true,
      query,
      intent,
      filesAnalyzed: searchResults.length,
      suggestionsGenerated: totalSuggestions,
      suggestionsApplied: totalApplied,
      results,
      summary: `Analyzed ${searchResults.length} files, generated ${totalSuggestions} suggestions${apply ? `, applied ${totalApplied}` : ''}`,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
    };
  }

  /**
   * Generate a new file using local LLM based on intent and project context
   * Analyzes existing codebase patterns and generates appropriate content
   * Returns draft for review - does NOT create the file
   */
  async draftFile(
    filePath: string,
    intent: string,
    options?: {
      similarFiles?: string[];
      template?: string;
    }
  ): Promise<DraftFileResult> {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);
    const ext = extname(resolvedPath).toLowerCase();
    const language = this.getLanguageFromExtension(ext);

    // Read similar files for style context
    const styleExamples: string[] = [];
    if (options?.similarFiles) {
      for (const similarPath of options.similarFiles.slice(0, 3)) {
        try {
          const similarResolved = this.config.resolveWorkspacePath(similarPath);
          if (this.config.isPathAllowed(similarResolved)) {
            const content = readFileSync(similarResolved, 'utf-8');
            const redacted = this.redaction.redact(content);
            styleExamples.push(
              `### ${similarPath}\n\`\`\`${language}\n${redacted.substring(0, 3000)}\n\`\`\``
            );
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    const draftPrompt = `You are an expert ${language} developer. Generate a new file based on the user's intent.

Requirements:
1. Follow the coding style and patterns from the example files (if provided)
2. Include appropriate imports/dependencies
3. Add documentation/comments as needed
4. Make the code production-ready
5. Follow best practices for ${language}

Output the complete file content ready to save. Include a brief explanation of what you created.`;

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: draftPrompt,
            },
            {
              role: 'user',
              content: `Create a new ${language} file at: ${filePath}

Intent: ${intent}${options?.template ? `\nTemplate/Structure: ${options.template}` : ''}${styleExamples.length > 0 ? `\n\nExample files for style reference:\n${styleExamples.join('\n\n')}` : ''}`,
            },
          ],
        },
        'local'
      );

      const parsed = this.parseDraftFile(response.message.content, language);

      return {
        success: true,
        path: resolvedPath,
        intent,
        content: parsed.content,
        language,
        explanation: parsed.explanation,
        warnings: parsed.warnings,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        path: resolvedPath,
        intent,
        content: '',
        language,
        explanation: '',
      };
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  private getLanguageFromExtension(ext: string): string {
    return resolveLanguageFromExtension(ext) ?? 'text';
  }

  private capPromptLength(
    prompt: string,
    maxLength: number = INPUT_LIMITS.MAX_PROMPT_LENGTH
  ): string {
    if (prompt.length <= maxLength) return prompt;
    const suffix = '\n\n[...truncated to fit prompt limits...]';
    const head = prompt.slice(0, Math.max(0, maxLength - suffix.length));
    return head + suffix;
  }

  private expandCodeReviewTargets(
    inputs: string[],
    maxFiles: number,
    includeHidden: boolean
  ): string[] {
    const reviewableExts = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.java',
      '.go',
      '.rs',
      '.rb',
      '.php',
      '.cs',
      '.kt',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.ini',
      '.md',
      '.txt',
      '.sh',
      '.ps1',
    ]);
    const skipDirs = new Set([
      'node_modules',
      'dist',
      'build',
      'out',
      'output',
      'coverage',
      'test-results',
      '.git',
      '.next',
      '.nuxt',
      '__pycache__',
      '.venv',
      'venv',
      'vendor',
      'tmp',
      'temp',
    ]);

    const selected: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [];

    for (const input of inputs) {
      try {
        const resolved = this.config.resolveWorkspacePath(input);
        if (!this.config.isPathAllowed(resolved) || !existsSync(resolved)) continue;
        stack.push(resolved);
      } catch {
        // Skip invalid inputs
      }
    }

    while (stack.length > 0 && selected.length < maxFiles) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);

      let currentStats;
      try {
        currentStats = statSync(current);
      } catch {
        continue;
      }

      if (currentStats.isFile()) {
        const ext = extname(current).toLowerCase();
        if (!reviewableExts.has(ext) && ext !== '') continue;
        selected.push(current);
        continue;
      }

      if (!currentStats.isDirectory()) continue;

      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (selected.length >= maxFiles) break;
        if (!includeHidden && entry.name.startsWith('.')) continue;
        if (entry.isDirectory() && skipDirs.has(entry.name)) continue;

        const fullPath = join(current, entry.name);
        if (!this.config.isPathAllowed(fullPath)) continue;

        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = extname(entry.name).toLowerCase();
        if (!reviewableExts.has(ext) && ext !== '') continue;
        selected.push(fullPath);
      }
    }

    return selected;
  }

  /**
   * QA_feedback_9: Decode HTML entities in generated code
   * Some LLMs or template engines output HTML-escaped entities like &quot; &amp; &#x3D;
   * that corrupt code syntax. This restores the original characters.
   */
  private decodeHtmlEntities(text: string): string {
    // Common HTML entities that appear in generated code
    const entities: Record<string, string> = {
      '&quot;': '"',
      '&apos;': "'",
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&#x3D;': '=',
      '&#x27;': "'",
      '&#x2F;': '/',
      '&#x60;': '`',
      '&#39;': "'",
      '&#34;': '"',
      '&#61;': '=',
      '&#47;': '/',
      '&#96;': '`',
      '&nbsp;': ' ',
    };

    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
      decoded = decoded.split(entity).join(char);
    }

    // Also handle numeric entities (&#NNN; and &#xHHH;)
    decoded = decoded.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
    decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    );

    return decoded;
  }

  /**
   * Clean up common LLM typos and artifacts in generated test code
   */
  private sanitizeGeneratedCode(code: string): { code: string; removedChars: number } {
    let cleaned = code;
    let removedChars = 0;

    // Normalize line endings early
    cleaned = cleaned.replace(/\r\n?/g, '\n');

    // Remove common zero-width characters that can break identifiers (seen in some LLM outputs)
    const zeroWidth = /[\u200B-\u200D\uFEFF]/g;
    const zwMatches = cleaned.match(zeroWidth);
    if (zwMatches) removedChars += zwMatches.length;
    cleaned = cleaned.replace(zeroWidth, '');

    // Replace non-breaking spaces with regular spaces
    const nbsp = /\u00A0/g;
    const nbspMatches = cleaned.match(nbsp);
    if (nbspMatches) removedChars += nbspMatches.length;
    cleaned = cleaned.replace(nbsp, ' ');

    // Strip control characters except tab/newline
    const controlChars = /\p{Cc}/gu;
    const controlMatches = cleaned.match(controlChars);
    if (controlMatches)
      removedChars += controlMatches.filter((c) => c !== '\n' && c !== '\t').length;
    cleaned = cleaned.replace(controlChars, (c) => (c === '\n' || c === '\t' ? c : ''));

    // Convert leading tabs to spaces (safer for Python)
    cleaned = cleaned.replace(/^\t+/gm, (m) => '    '.repeat(m.length));

    // Trim trailing whitespace per-line
    cleaned = cleaned.replace(/[ \t]+$/gm, '');

    return { code: cleaned.trim(), removedChars };
  }

  private getTypeScriptParseErrorSummary(code: string, language: string): string | null {
    if (language !== 'typescript' && language !== 'javascript') return null;

    const fileName = language === 'typescript' ? 'generated.test.ts' : 'generated.test.js';
    const scriptKind = language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(
      fileName,
      code,
      ts.ScriptTarget.ES2020,
      true,
      scriptKind
    );

    // parseDiagnostics exists at runtime but isn't part of the public SourceFile type.
    const diags = ((sourceFile as any).parseDiagnostics as ts.Diagnostic[] | undefined) ?? [];
    if (diags.length === 0) return null;

    const summarize = (d: ts.Diagnostic): string => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ').trim();
      if (typeof d.start !== 'number') return msg;
      const pos = sourceFile.getLineAndCharacterOfPosition(d.start);
      return `${pos.line + 1}:${pos.character + 1} ${msg}`;
    };

    const details = diags.slice(0, 3).map(summarize).join(' | ');
    return `TypeScript parse errors detected (${diags.length}): ${details}`;
  }

  /**
   * V15: Format Python code using black formatter.
   * This fixes common LLM output issues like inconsistent indentation and line breaks.
   *
   * Addresses test feedback: "generate_tests produces Python tests with syntax errors"
   *
   * @param code The Python code to format
   * @returns Formatted code, or original code if black is not available/fails
   */
  private async formatPythonWithBlack(
    code: string
  ): Promise<{ code: string; formatted: boolean; error?: string }> {
    const { spawn } = await import('child_process');
    const { writeFileSync, readFileSync, unlinkSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    // Write code to temp file for black formatting
    const tempFile = join(tmpdir(), `mcp_black_fmt_${Date.now()}.py`);

    try {
      writeFileSync(tempFile, code, 'utf-8');

      return new Promise((resolve) => {
        // Run black formatter with --quiet to suppress status output
        // --line-length 100 for reasonable line length
        // --safe to skip files that have syntax errors black can't parse
        const proc = spawn('black', ['--quiet', '--line-length', '100', tempFile], {
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', (exitCode) => {
          if (exitCode === 0) {
            // Read back formatted code
            try {
              const formattedCode = readFileSync(tempFile, 'utf-8');
              unlinkSync(tempFile);
              resolve({ code: formattedCode, formatted: true });
            } catch {
              unlinkSync(tempFile);
              resolve({ code, formatted: false, error: 'Could not read formatted file' });
            }
          } else {
            // Black failed (syntax error it couldn't fix, etc.)
            try {
              unlinkSync(tempFile);
            } catch {
              /* ignore */
            }
            // Extract error message
            const errorMsg = stderr.includes('cannot parse')
              ? 'black could not parse the code (severe syntax error)'
              : stderr.trim().slice(0, 100) || 'black formatting failed';
            resolve({ code, formatted: false, error: errorMsg });
          }
        });

        proc.on('error', (err) => {
          // Black not available
          try {
            unlinkSync(tempFile);
          } catch {
            /* ignore */
          }
          const errorMsg = err.message.includes('ENOENT')
            ? 'black formatter not installed (pip install black)'
            : err.message;
          resolve({ code, formatted: false, error: errorMsg });
        });

        // Timeout fallback
        setTimeout(() => {
          proc.kill();
          try {
            unlinkSync(tempFile);
          } catch {
            /* ignore */
          }
          resolve({ code, formatted: false, error: 'black formatting timed out' });
        }, 10000);
      });
    } catch (e) {
      // If we can't write temp file, return original
      try {
        unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
      return { code, formatted: false, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  /**
   * Black-box V5: Validate Python syntax using AST parsing via subprocess.
   * This catches indentation errors and syntax issues that break generated tests.
   */
  private async getPythonSyntaxErrorSummary(code: string): Promise<string | null> {
    const { spawn } = await import('child_process');
    const { writeFileSync, unlinkSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    // Write code to temp file for AST parsing
    const tempFile = join(tmpdir(), `mcp_pytest_check_${Date.now()}.py`);

    try {
      writeFileSync(tempFile, code, 'utf-8');

      return new Promise((resolve) => {
        // Use python -m py_compile for syntax validation
        const proc = spawn('python', ['-m', 'py_compile', tempFile], {
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        proc.on('close', (exitCode) => {
          // Clean up temp file
          try {
            unlinkSync(tempFile);
          } catch {
            /* ignore */
          }

          if (exitCode === 0) {
            resolve(null); // No syntax errors
          } else {
            // Extract line number and error from stderr
            // Format: "  File "X.py", line N\n    <code>\n    ^\nSyntaxError: <message>"
            const lineMatch = stderr.match(/line (\d+)/);
            const errorMatch =
              stderr.match(/SyntaxError:\s*(.+)/i) || stderr.match(/IndentationError:\s*(.+)/i);

            const lineNum = lineMatch ? lineMatch[1] : '?';
            const errorMsg = errorMatch ? errorMatch[1].trim() : 'invalid syntax';

            resolve(`Python syntax error at line ${lineNum}: ${errorMsg}`);
          }
        });

        proc.on('error', () => {
          // Python not available, clean up and skip validation
          try {
            unlinkSync(tempFile);
          } catch {
            /* ignore */
          }
          resolve(null);
        });

        // Timeout fallback
        setTimeout(() => {
          proc.kill();
          try {
            unlinkSync(tempFile);
          } catch {
            /* ignore */
          }
          resolve(null);
        }, 5000);
      });
    } catch {
      // If we can't write temp file, skip validation
      try {
        unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  /**
   * V11: Simple heuristic-based syntax validation for generated tests.
   * Uses pattern matching to detect common syntax issues without requiring
   * language-specific parsers or external dependencies.
   *
   * Addresses v7 feedback: "generate_tests output has syntax/formatting issues"
   */
  private validateGeneratedTestSyntax(code: string, language: string): string[] {
    const errors: string[] = [];
    const lines = code.split('\n');

    // Check for empty or minimal output
    if (code.trim().length < 50) {
      errors.push('Generated output is too short to be valid test code');
      return errors;
    }

    // Check for unbalanced brackets/braces/parentheses (common LLM error)
    let braceCount = 0;
    let bracketCount = 0;
    let parenCount = 0;
    for (const char of code) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
      else if (char === '(') parenCount++;
      else if (char === ')') parenCount--;
    }
    if (braceCount !== 0)
      errors.push(
        `Unbalanced braces: ${braceCount > 0 ? 'missing }' : 'extra }'} (${Math.abs(braceCount)})`
      );
    if (bracketCount !== 0)
      errors.push(
        `Unbalanced brackets: ${bracketCount > 0 ? 'missing ]' : 'extra ]'} (${Math.abs(bracketCount)})`
      );
    if (parenCount !== 0)
      errors.push(
        `Unbalanced parentheses: ${parenCount > 0 ? 'missing )' : 'extra )'} (${Math.abs(parenCount)})`
      );

    // Language-specific checks
    if (language === 'python') {
      // Check for inconsistent indentation (mixing tabs and spaces)
      const hasTabIndent = lines.some((l) => l.startsWith('\t'));
      const hasSpaceIndent = lines.some((l) => /^[ ]{2,}[^\s]/.test(l));
      if (hasTabIndent && hasSpaceIndent) {
        errors.push(
          'Mixed tabs and spaces for indentation (Python requires consistent indentation)'
        );
      }

      // Check for unterminated strings in Python
      const tripleQuoteCount = (code.match(/"""/g) || []).length;
      if (tripleQuoteCount % 2 !== 0) {
        errors.push('Unterminated triple-quoted string');
      }

      // Check for missing colons after def/class/if/for/while
      const missingColon = lines.find(
        (l) =>
          /^\s*(def|class|if|elif|else|for|while|try|except|finally|with)\s+[^:]+$/.test(l) &&
          !l.trim().endsWith(':')
      );
      if (missingColon) {
        const lineNum = lines.indexOf(missingColon) + 1;
        errors.push(`Missing colon at line ${lineNum}: ${missingColon.trim().slice(0, 50)}`);
      }

      // V11: Check for collapsed/concatenated lines (common LLM error)
      // Pattern: "def test_foo():pass" or "import pytestdef test_"
      const collapsedDefLine = lines.find(
        (l) => /def\s+\w+\([^)]*\):\s*\w/.test(l) && !/def\s+\w+\([^)]*\):\s*$/.test(l.trim())
      );
      if (
        collapsedDefLine &&
        !collapsedDefLine.includes('lambda') &&
        !collapsedDefLine.includes('pass')
      ) {
        const lineNum = lines.indexOf(collapsedDefLine) + 1;
        errors.push(
          `Python syntax error at line ${lineNum}: code on same line as def (needs newline after colon)`
        );
      }

      // V11: Check for missing newline between import and def/class
      const importDefCollision = lines.find((l) =>
        /^(?:import|from)\s+.*(?:def|class)\s+\w/.test(l)
      );
      if (importDefCollision) {
        const lineNum = lines.indexOf(importDefCollision) + 1;
        errors.push(`Python syntax error at line ${lineNum}: import and def/class on same line`);
      }

      // V11: Check for invalid indentation (sudden outdent)
      let prevIndent = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) continue; // Skip empty lines
        const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;
        // Check for invalid outdent (not a multiple of expected indent and not 0)
        if (currentIndent > 0 && prevIndent > 0 && currentIndent < prevIndent) {
          // Outdent should be to a valid level (multiple of 4 or 2)
          if (currentIndent % 2 !== 0 && currentIndent % 4 !== 0) {
            errors.push(
              `Python indentation error at line ${i + 1}: invalid indentation level (${currentIndent} spaces)`
            );
          }
        }
        if (line.trim().length > 0) {
          prevIndent = currentIndent;
        }
      }
    } else if (language === 'typescript' || language === 'javascript') {
      // Check for unclosed template literals
      const backtickCount = (code.match(/`/g) || []).length;
      if (backtickCount % 2 !== 0) {
        errors.push('Unterminated template literal (unclosed backtick)');
      }

      // Check for obvious syntax errors: statements on same line without semicolon
      const multiStatement = lines.find((l) => {
        const trimmed = l.trim();
        // Detect patterns like "const x = 1const y = 2" or "import x from 'y'import z from 'w'"
        return (
          /(?:const|let|var|import)\s+\w+.*(?:const|let|var|import)\s+\w+/.test(trimmed) &&
          !trimmed.includes(';')
        );
      });
      if (multiStatement) {
        errors.push('Multiple statements on same line without semicolons');
      }

      // Check for arrow function syntax errors
      const badArrow = code.match(/=>\s*=>/);
      if (badArrow) {
        errors.push('Invalid arrow function syntax (=> =>)');
      }
    }

    // Check for common LLM output artifacts that indicate broken generation
    if (code.includes('```')) {
      errors.push(
        'Generated code contains markdown code fence markers (```) - these should be removed'
      );
    }
    if (code.includes('[object Object]')) {
      errors.push('Generated code contains "[object Object]" - JSON serialization error');
    }
    if (code.includes('undefined')) {
      // Check if it's the literal "undefined" as a string value (not the keyword)
      const undefinedAsString = /"undefined"|'undefined'|`undefined`/.test(code);
      if (undefinedAsString) {
        errors.push(
          'Generated code contains "undefined" as a string literal - possible template error'
        );
      }
    }

    return errors;
  }

  /**
   * QA_feedback_1: Lightweight semantic validation for generated Python tests.
   *
   * These checks are intentionally heuristic (no AST / runtime dependency):
   * - Detect common stdlib symbols used without the necessary import.
   * - Detect common pytest fixtures used without being declared as parameters.
   */
  private validatePythonTestSemantics(code: string): string[] {
    const warnings: string[] = [];

    const hasImport = (re: RegExp) => re.test(code);
    const uses = (re: RegExp) => re.test(code);

    // datetime
    if (
      (uses(/\bdatetime\./) || uses(/\bdatetime\s*\(/)) &&
      !hasImport(/\bimport\s+datetime\b/) &&
      !hasImport(/\bfrom\s+datetime\s+import\b/)
    ) {
      warnings.push(
        `Potentially undefined: datetime (missing import). Add 'import datetime' or 'from datetime import ...'.`
      );
    }

    // timedelta (commonly imported from datetime)
    if (uses(/\btimedelta\s*\(/) && !hasImport(/\bfrom\s+datetime\s+import\s+.*\btimedelta\b/)) {
      warnings.push(
        `Potentially undefined: timedelta (missing import). Add 'from datetime import timedelta'.`
      );
    }

    // Path (commonly imported from pathlib)
    if (
      uses(/\bPath\s*\(/) &&
      !hasImport(/\bfrom\s+pathlib\s+import\s+.*\bPath\b/) &&
      !hasImport(/\bimport\s+pathlib\b/) &&
      !uses(/\bpathlib\.Path\s*\(/)
    ) {
      warnings.push(
        `Potentially undefined: Path (missing import). Add 'from pathlib import Path'.`
      );
    }

    // pytest fixture args (monkeypatch is a common one)
    if (uses(/\bmonkeypatch\./)) {
      const defMatches = [...code.matchAll(/^\s*def\s+test_[^(]*\(([^)]*)\)\s*:/gm)];
      const hasParam = defMatches.some((m) =>
        (m[1] || '').split(',').some((p) => p.trim() === 'monkeypatch')
      );

      if (!hasParam) {
        warnings.push(
          `Potentially undefined: monkeypatch (pytest fixture). Add 'monkeypatch' to the test function parameters.`
        );
      }
    }

    return warnings;
  }

  /**
   * Split Python import statements that were merged onto one line by an LLM.
   * Examples:
   * - import os import sys
   * - from pathlib import Path import pytest
   * - import os from pathlib import Path
   */
  private fixMergedPythonImports(code: string): string {
    const splitLine = (line: string): string[] => {
      const indent = (line.match(/^(\s*)/) || [''])[0];
      let remaining = line.trim();

      if (!/^(import|from)\s+/.test(remaining)) {
        return [line];
      }

      const output: string[] = [];
      for (let i = 0; i < 20; i++) {
        const fromMatch = remaining.match(
          /^(from\s+\S+\s+import\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)(?:\s+(.*))?$/
        );
        if (fromMatch && fromMatch[2] && /^(import|from)\s+/.test(fromMatch[2])) {
          output.push(`${indent}${fromMatch[1]}`);
          remaining = fromMatch[2].trim();
          continue;
        }

        const importMatch = remaining.match(
          /^(import\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?)(?:\s+(.*))?$/
        );
        if (importMatch && importMatch[2] && /^(import|from)\s+/.test(importMatch[2])) {
          output.push(`${indent}${importMatch[1]}`);
          remaining = importMatch[2].trim();
          continue;
        }

        output.push(`${indent}${remaining}`);
        break;
      }

      if (output.length === 0) {
        return [line];
      }
      return output;
    };

    return code.split('\n').flatMap(splitLine).join('\n');
  }

  /**
   * Convert JavaScript literals to Python literals, excluding quoted strings.
   */
  private fixPythonLiterals(code: string): string {
    const replacements: Record<string, string> = {
      true: 'True',
      false: 'False',
      null: 'None',
    };

    return code.replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null)\b/g,
      (match) => replacements[match] ?? match
    );
  }

  private looksLikePythonCode(code: string): boolean {
    const lines = code.split('\n').slice(0, 60);
    return lines.some(
      (line) =>
        /^\s*def\s+\w+\s*\(/.test(line) ||
        /^\s*from\s+\S+\s+import\s+/.test(line) ||
        /^\s*class\s+\w+[^:]*:\s*$/.test(line) ||
        /^\s*if\s+.+:\s*$/.test(line) ||
        /^\s*for\s+.+:\s*$/.test(line) ||
        /^\s*import\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*$/.test(line)
    );
  }

  private cleanGeneratedTestCode(code: string, sourcePath?: string): string {
    // QA_feedback_10: Fix class names with spaces (e.g., "class TestFocus Ring" -> "class TestFocusRing")
    // LLMs sometimes generate invalid Python/JS class names with spaces
    let cleaned = code.replace(
      /^(\s*class\s+)([A-Z][a-zA-Z0-9_]*)(\s+[A-Z][a-zA-Z0-9_]*)+(:)/gm,
      (match, prefix, _firstWord, _rest, colon) => {
        // Remove spaces between words in class name, keep prefix and colon
        const classNameParts = match.slice(prefix.length, -1).trim().split(/\s+/);
        const sanitizedName = classNameParts.join('');
        return `${prefix}${sanitizedName}${colon}`;
      }
    );

    // Common LLM typos observed in blackbox testing
    const typoFixes: Array<[RegExp, string]> = [
      // Double letter typos
      [/\broroots\b/g, 'roots'],
      [/\breadEnhments\b/g, 'readEnhancements'],
      [/\bfunctionion\b/g, 'function'],
      [/\breturrn\b/g, 'return'],
      [/\bconssole\b/g, 'console'],
      [/\bimporrt\b/g, 'import'],
      [/\bexporrt\b/g, 'export'],
      [/\bdescribee\b/g, 'describe'],
      // Common hallucinated imports - TypeScript/JavaScript
      [/from ['"]\.\.\/\.\.\/(?:src\/)?([^'"]+)['"]/g, "from './$1'"],
      [/from ['"]\.\.\/\.\.\/\.\.\/(?:src\/)?([^'"]+)['"]/g, "from '../$1'"],
      // Common hallucinated imports - Python (incorrect src. prefix)
      [/^from src\.([a-zA-Z0-9_]+) import/gm, 'from $1 import'],
      [/^from src\.([a-zA-Z0-9_.]+) import/gm, 'from $1 import'],
      [/^import src\.([a-zA-Z0-9_]+)/gm, 'import $1'],
      // QA_feedback_9: Fix Python imports using file paths instead of module notation
      // Pattern: "from utils/file.py import X" -> "from utils.file import X"
      // Pattern: "from auth/models.py import X" -> "from auth.models import X"
      [/^from\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\.py\s+import/gm, 'from $1.$2 import'],
      [
        /^from\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\.py\s+import/gm,
        'from $1.$2.$3 import',
      ],
      // Also handle "import utils/file" -> "import utils.file"
      [/^import\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\.py/gm, 'import $1.$2'],
      [/^import\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)/gm, 'import $1.$2'],
      // QA_feedback_11: Fix "from filename.py import X" -> "from filename import X" (single file)
      // This is the most common LLM error: importing with .py extension
      [/^from\s+([a-zA-Z0-9_]+)\.py\s+import\s+/gm, 'from $1 import '],
      // Also handle "import filename.py" -> "import filename"
      [/^import\s+([a-zA-Z0-9_]+)\.py$/gm, 'import $1'],
      // Fix "from ./filename.py import X" -> "from filename import X"
      [/^from\s+\.\/([a-zA-Z0-9_]+)\.py\s+import\s+/gm, 'from $1 import '],
      // Fix "from ./subdir/filename.py import X" -> "from subdir.filename import X"
      [/^from\s+\.\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\.py\s+import\s+/gm, 'from $1.$2 import '],
      // Fix absolute path imports: "from C:\\path\\module.py import X" -> "from module import X"
      [
        /^from\s+[A-Za-z]:[\\/]+(?:[^\\/:\n]+[\\/]+)*([A-Za-z_][A-Za-z0-9_]*)\.py\s+import\s+/gm,
        'from $1 import ',
      ],
      [/^from\s+\/+(?:[^/\n]+\/+)*([A-Za-z_][A-Za-z0-9_]*)\.py\s+import\s+/gm, 'from $1 import '],
      // Strip explanatory text before actual code
      [/^(?:Here(?:'s| is| are)|The following|Below is)[^`\n]*\n/gm, ''],
      // Strip trailing explanatory text after code
      [/\n(?:This test|These tests|The above|Note:)[^\n]*$/gm, ''],
    ];

    // Apply typo fixes (cleaned was already initialized with class name sanitization above)
    for (const [pattern, replacement] of typoFixes) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    // Compatibility helpers used directly by tests and generate_tests post-processing.
    cleaned = this.fixMergedPythonImports(cleaned);
    const isPythonBySourcePath = sourcePath ? sourcePath.toLowerCase().endsWith('.py') : false;
    const shouldApplyPythonLiteralFix = sourcePath
      ? isPythonBySourcePath
      : this.looksLikePythonCode(cleaned);
    if (shouldApplyPythonLiteralFix) {
      cleaned = this.fixPythonLiterals(cleaned);
    }

    // NEW: Split concatenated Python imports (LLM artifact)
    // Pattern: "from pathlib import Path import pytest" -> two separate lines
    const pythonImportSplitters: Array<[RegExp, string]> = [
      // "from X import Y import Z" -> two lines (most common error)
      // IMPORTANT: Only match when "import" follows a complete import like "from x import Something"
      // Use lookahead to ensure we're matching "import module" not "import Something" in same line
      [
        /^(from\s+\S+\s+import\s+[A-Z][A-Za-z0-9_]*(?:\s*,\s*[A-Z][A-Za-z0-9_]*)*)(\s+import\s+[a-z])/gm,
        '$1\n$2',
      ],
      // "from X import Y from Z import W" -> two lines
      [/^(from\s+\S+\s+import\s+[^f\n]+?)(\s+from\s+\S+\s+import)/gm, '$1\n$2'],
      // "import X import Y" -> two lines
      [/^(import\s+[A-Za-z0-9_]+)(\s+import\s+)/gm, '$1\n$2'],
      // Missing newline after import before def/class (Black-box V10 fix)
      // Handles "import pytest def test_" and "from X import Y def func"
      [/((?:^|\n)(?:from\s+\S+\s+import\s+[^\n]+|import\s+[^\n]+?))(\s*def\s+\w)/gm, '$1\n\n$2'],
      [/((?:^|\n)(?:from\s+\S+\s+import\s+[^\n]+|import\s+[^\n]+?))(\s*class\s+\w)/gm, '$1\n\n$2'],
      // Missing newline after import before @pytest.fixture or @decorator
      [/((?:^|\n)(?:from\s+\S+\s+import\s+[^\n]+|import\s+[^\n]+?))(\s*@\w)/gm, '$1\n\n$2'],
      // Fix "import pytest@pytest.fixture" (no space)
      [/(import\s+\w+)(@\w)/gm, '$1\n\n$2'],
      // Fix "import pytestdef " (no space before def)
      [/(import\s+\w+)(def\s+)/gm, '$1\n\n$2'],
      // Fix "from X import Ydef " (no space)
      [/(from\s+\S+\s+import\s+[A-Za-z0-9_,\s]+?)(def\s+)/gm, '$1\n\n$2'],
    ];

    for (const [pattern, replacement] of pythonImportSplitters) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    // NEW: Fix common pytest import issues
    const pytestFixes: Array<[RegExp, string]> = [
      // Duplicate "import pytest" lines
      [/(import pytest\n)import pytest\n/g, '$1'],
      // "from pytest import *" is bad practice
      [/^from pytest import \*$/gm, 'import pytest'],
      // Fix "import pytest\nimport pytest" at start of file
      [/^import pytest\nimport pytest$/m, 'import pytest'],
    ];

    for (const [pattern, replacement] of pytestFixes) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    // QA_feedback_10: Also fix function/method names with spaces (rare but seen)
    // Pattern: "def test focus ring(" -> "def test_focus_ring("
    cleaned = cleaned.replace(
      /^(\s*def\s+)([a-z_][a-z0-9_]*)(\s+[a-z_][a-z0-9_]*)+(\s*\()/gm,
      (match, prefix, _firstWord, _rest, paren) => {
        const funcNameParts = match.slice(prefix.length).replace(paren, '').trim().split(/\s+/);
        const sanitizedName = funcNameParts.join('_');
        return `${prefix}${sanitizedName}${paren}`;
      }
    );

    // NEW: Fix TypeScript/JavaScript import concatenation issues
    const tsImportSplitters: Array<[RegExp, string]> = [
      // "import { X } from 'a' import { Y } from 'b'" -> two lines
      [/(import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"])\s*(import\s)/g, '$1;\n$2'],
      // "import X from 'a' import Y from 'b'" -> two lines
      [/(import\s+\w+\s+from\s*['"][^'"]+['"])\s*(import\s)/g, '$1;\n$2'],
    ];

    for (const [pattern, replacement] of tsImportSplitters) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    // If sourcePath is provided, try to fix import paths based on it
    if (sourcePath) {
      // Extract module name from source path for Python
      const isPython = sourcePath.endsWith('.py');
      if (isPython) {
        // Get the module name (filename without .py)
        const moduleName =
          sourcePath.replace(/\\/g, '/').split('/').pop()?.replace('.py', '') || 'module';
        // Fix imports that reference the wrong module
        cleaned = cleaned.replace(/^from module import/gm, `from ${moduleName} import`);
        cleaned = cleaned.replace(/^from src\.module import/gm, `from ${moduleName} import`);

        // V12: Normalize Python indentation to 4 spaces (PEP 8)
        cleaned = this.normalizePythonIndentation(cleaned);
      }
    }

    return cleaned.trim();
  }

  /**
   * V12: Normalize Python indentation to 4 spaces per PEP 8
   * Handles tab-to-space conversion and inconsistent space counts
   */
  private normalizePythonIndentation(code: string): string {
    const lines = code.split('\n');
    const normalizedLines: string[] = [];

    // Detect current indentation style by sampling indented lines
    let detectedIndent = 4; // Default to 4 spaces
    const indentSamples: number[] = [];

    for (const line of lines) {
      const match = line.match(/^(\s+)\S/);
      if (match && match[1]) {
        const indent = match[1];
        // Convert tabs to spaces for measurement (assuming 1 tab = 4 spaces)
        const spaceCount = indent.replace(/\t/g, '    ').length;
        if (spaceCount > 0 && spaceCount <= 16) {
          indentSamples.push(spaceCount);
        }
      }
    }

    // Find the most common smallest indentation unit
    if (indentSamples.length > 0) {
      const minIndent = Math.min(...indentSamples);
      // Common cases: 2 spaces, 3 spaces, 4 spaces, 8 spaces (2 tabs)
      if (minIndent === 2 || minIndent === 3 || minIndent === 8) {
        detectedIndent = minIndent;
      }
    }

    for (const line of lines) {
      if (line.trim() === '') {
        // Preserve empty lines
        normalizedLines.push('');
        continue;
      }

      const match = line.match(/^(\s*)(.*)$/);
      if (!match) {
        normalizedLines.push(line);
        continue;
      }

      const [, leadingWhitespace, content] = match;

      if (!leadingWhitespace || leadingWhitespace.length === 0) {
        // No indentation
        normalizedLines.push(content);
        continue;
      }

      // Convert tabs to spaces first (1 tab = detectedIndent spaces)
      const spacesOnly = leadingWhitespace.replace(/\t/g, ' '.repeat(detectedIndent));

      // Calculate indent level
      const currentIndentLevel = Math.round(spacesOnly.length / detectedIndent);

      // Apply 4-space indentation
      const newIndent = ' '.repeat(currentIndentLevel * 4);
      normalizedLines.push(newIndent + content);
    }

    return normalizedLines.join('\n');
  }

  /**
   * V12/V13: Repair collapsed Python lines that LLMs often produce
   * Handles patterns like:
   * - "def foo():return x" -> "def foo():\n    return x"
   * - "if x:y = 1" -> "if x:\n    y = 1"
   * - "class Foo:def bar" -> "class Foo:\n    def bar"
   * - "import X import Y" -> "import X\nimport Y"
   * - "import X def test_" -> "import X\ndef test_"
   * - "def foo():assert X assert Y" -> multi-line asserts
   */
  private repairCollapsedPythonLines(code: string): string {
    // First pass: split imports that are on same line
    let processedCode = code;

    // V14: Split decorator + def on same line (e.g., "@pytest.fixture def test_" -> newline)
    // LLM feedback: "missing newlines between decorators and functions"
    // Note: [\w.]+ handles decorator names like @pytest.fixture, @mock.patch
    processedCode = processedCode.replace(
      /^(\s*)(@[\w.]+(?:\([^)]*\))?)\s+(def\s+)/gm,
      '$1$2\n$1$3'
    );

    // V14: Split multiple decorators on same line (e.g., "@fixture @mock def" -> each on newline)
    processedCode = processedCode.replace(
      /^(\s*)(@[\w.]+(?:\([^)]*\))?)\s+(@[\w.]+)/gm,
      '$1$2\n$1$3'
    );

    // F3-003: Split "import X import Y" patterns
    processedCode = processedCode.replace(/^(\s*)(import\s+\S+)\s+(import\s+)/gm, '$1$2\n$1$3');

    // F3-003: Split "from X import Y import Z" patterns
    processedCode = processedCode.replace(
      /^(\s*)(from\s+\S+\s+import\s+[^#\n]+)\s+(import\s+)/gm,
      '$1$2\n$1$3'
    );

    // F3-003: Split "import X def " or "from X import Y def " patterns
    processedCode = processedCode.replace(
      /^(\s*)((?:import|from)\s+[^\n]+?)\s+(def\s+)/gm,
      '$1$2\n$1$3'
    );

    // F3-003: Split "import X class " patterns
    processedCode = processedCode.replace(
      /^(\s*)((?:import|from)\s+[^\n]+?)\s+(class\s+)/gm,
      '$1$2\n$1$3'
    );

    const lines = processedCode.split('\n');
    const repairedLines: string[] = [];

    for (const line of lines) {
      // Skip empty lines and comments
      if (line.trim() === '' || line.trim().startsWith('#')) {
        repairedLines.push(line);
        continue;
      }

      // Get leading whitespace for proper indentation
      const leadingMatch = line.match(/^(\s*)/);
      const leadingWhitespace = leadingMatch ? leadingMatch[1] : '';
      const nextIndent = leadingWhitespace + '    '; // 4-space indent increase

      let repairedLine = line;

      // Pattern 1: "def name(...):code" -> "def name(...):\n    code"
      // Exclude lambda and single-statement pass/...
      const defMatch = repairedLine.match(
        /^(\s*def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*)([^\s#].+)$/
      );
      if (defMatch && !defMatch[2].match(/^\s*(pass|\.\.\.|lambda|$)/)) {
        const [, defPart, codePart] = defMatch;
        // F3-003: Handle multiple statements after def (assert X assert Y)
        const splitStatements = this.splitMultipleStatements(codePart.trimStart(), nextIndent);
        repairedLine = defPart.trimEnd() + '\n' + splitStatements;
      }

      // Pattern 2: "class Name:def " -> "class Name:\n    def "
      const classDefMatch = repairedLine.match(/^(\s*class\s+\w+[^:]*:\s*)(def\s+.+)$/);
      if (classDefMatch) {
        const [, classPart, defPart] = classDefMatch;
        repairedLine = classPart.trimEnd() + '\n' + nextIndent + defPart.trimStart();
      }

      // Pattern 3: "if/elif/else/while/for/with/try/except:code" -> split
      const controlMatch = repairedLine.match(
        /^(\s*(?:if|elif|else|while|for|with|try|except|finally)\s*[^:]*:\s*)([^\s#].+)$/
      );
      if (controlMatch && !controlMatch[2].match(/^\s*(pass|\.\.\.|$)/)) {
        const [, controlPart, codePart] = controlMatch;
        const splitStatements = this.splitMultipleStatements(codePart.trimStart(), nextIndent);
        repairedLine = controlPart.trimEnd() + '\n' + splitStatements;
      }

      // Pattern 4: "async def name(...):code" -> split
      const asyncDefMatch = repairedLine.match(
        /^(\s*async\s+def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*)([^\s#].+)$/
      );
      if (asyncDefMatch && !asyncDefMatch[2].match(/^\s*(pass|\.\.\.|$)/)) {
        const [, defPart, codePart] = asyncDefMatch;
        const splitStatements = this.splitMultipleStatements(codePart.trimStart(), nextIndent);
        repairedLine = defPart.trimEnd() + '\n' + splitStatements;
      }

      repairedLines.push(repairedLine);
    }

    return repairedLines.join('\n');
  }

  /**
   * V18 (QA_feedback_5): Validate imports in generated test code against actual repo modules
   * Addresses: "Add a validate_imports check to ensure the generated test file does not import non-existent modules"
   *
   * This checks:
   * 1. Python relative imports (from . or from ..) against actual directory structure
   * 2. Local module imports that reference non-existent files
   * 3. Common hallucinated paths like 'src.module' when it should be just 'module'
   */
  private async validateGeneratedImports(
    code: string,
    language: string,
    sourceFilePath: string
  ): Promise<{ warnings: string[]; invalidImports: string[] }> {
    const warnings: string[] = [];
    const invalidImports: string[] = [];

    const sourceDir = dirname(sourceFilePath);

    if (language === 'python') {
      // Extract Python imports
      const importPatterns = [
        /^from\s+(\S+)\s+import/gm, // from X import Y
        /^import\s+(\S+)/gm, // import X
      ];

      const localModules: string[] = [];

      for (const pattern of importPatterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
          const modulePath = match[1];

          // Skip standard library and known third-party packages
          const knownPackages = [
            'pytest',
            'unittest',
            'os',
            'sys',
            'pathlib',
            'typing',
            'json',
            'io',
            're',
            'datetime',
            'collections',
            'functools',
            'itertools',
            'math',
            'mock',
            'unittest.mock',
            'pytest_mock',
            'asyncio',
            'aiohttp',
            'numpy',
            'pandas',
            'requests',
            'flask',
            'django',
            'fastapi',
          ];

          const baseModule = modulePath.split('.')[0];
          if (knownPackages.includes(baseModule) || knownPackages.includes(modulePath)) {
            continue;
          }

          // Check for hallucinated 'src.' prefix
          if (modulePath.startsWith('src.')) {
            const withoutSrc = modulePath.replace(/^src\./, '');
            invalidImports.push(modulePath);
            warnings.push(
              `Import '${modulePath}' uses 'src.' prefix which is likely hallucinated. ` +
                `Try 'from ${withoutSrc} import ...' instead.`
            );
            continue;
          }

          // Check for relative imports that reference non-existent files
          if (modulePath.startsWith('.')) {
            // Relative import - check if file exists
            const relativeParts = modulePath.replace(/^\.+/, '').split('.');
            const dotsCount = (modulePath.match(/^\.*/) || [''])[0].length;

            let checkDir = sourceDir;
            for (let i = 1; i < dotsCount; i++) {
              checkDir = dirname(checkDir);
            }

            if (relativeParts[0]) {
              const potentialFile = join(checkDir, relativeParts[0] + '.py');
              const potentialDir = join(checkDir, relativeParts[0]);

              if (!existsSync(potentialFile) && !existsSync(potentialDir)) {
                invalidImports.push(modulePath);
                warnings.push(
                  `Relative import '${modulePath}' may reference a non-existent module. ` +
                    `Neither '${potentialFile}' nor '${potentialDir}/' exists.`
                );
              }
            }
          } else {
            // Absolute local import - check if it's a local module
            localModules.push(modulePath);
          }
        }
      }

      // Check local modules against workspace
      for (const mod of localModules) {
        const parts = mod.split('.');
        const baseModule = parts[0];

        // Check if module exists in same directory or parent
        const potentialPaths = [
          join(sourceDir, baseModule + '.py'),
          join(sourceDir, baseModule, '__init__.py'),
          join(dirname(sourceDir), baseModule + '.py'),
          join(dirname(sourceDir), baseModule, '__init__.py'),
        ];

        const exists = potentialPaths.some((p) => existsSync(p));
        if (!exists && !baseModule.startsWith('_')) {
          // Only warn for likely local modules (not standard lib or third-party)
          // Don't warn if it looks like a third-party package name
          const looksLikeThirdParty =
            /^[a-z][a-z0-9_]*$/.test(baseModule) && baseModule.length <= 15;
          if (!looksLikeThirdParty || parts.length > 1) {
            invalidImports.push(mod);
            warnings.push(
              `Import '${mod}' may reference a non-existent local module. ` +
                `Verify this module exists in the project.`
            );
          }
        }
      }
    } else if (language === 'typescript' || language === 'javascript') {
      // Extract TypeScript/JavaScript imports
      const importPattern = /(?:import|from)\s+['"]([^'"]+)['"]/g;

      let match;
      while ((match = importPattern.exec(code)) !== null) {
        const importPath = match[1];

        // Skip node_modules imports and bare specifiers
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
          continue;
        }

        // Check relative imports
        if (importPath.startsWith('.')) {
          const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '', '/index.ts', '/index.js'];
          const basePath = join(sourceDir, importPath);

          const exists = extensions.some((ext) => existsSync(basePath + ext));
          if (!exists) {
            invalidImports.push(importPath);
            warnings.push(
              `Import '${importPath}' may reference a non-existent file. ` +
                `Verify the path is correct relative to the test file location.`
            );
          }
        }
      }
    }

    // Summarize if many invalid imports found
    if (invalidImports.length > 3) {
      warnings.length = 0; // Clear individual warnings
      warnings.push(
        `Found ${invalidImports.length} potentially invalid imports: ${invalidImports.slice(0, 3).join(', ')}... ` +
          `Review and fix import paths before running tests.`
      );
    }

    return { warnings, invalidImports };
  }

  /**
   * F3-003: Split multiple Python statements that are on the same line
   * e.g., "assert X assert Y return Z" -> each on its own line
   */
  private splitMultipleStatements(code: string, indent: string): string {
    // Statement keywords that typically start new statements
    const statementKeywords = [
      'assert',
      'return',
      'raise',
      'yield',
      'pass',
      'break',
      'continue',
      'print',
      'del',
    ];

    let result = code;

    // Split at statement keywords (but not the first one if it starts with a keyword)
    for (const kw of statementKeywords) {
      // Match keyword that is preceded by non-word char (end of previous statement)
      const pattern = new RegExp(`(\\S)\\s+(${kw}\\s+)`, 'gi');
      result = result.replace(pattern, `$1\n${indent}$2`);
    }

    // Ensure proper indentation for first line
    if (!result.startsWith(indent)) {
      result = indent + result;
    }

    return result;
  }

  private buildAnalysisPrompt(
    analysisType: 'quality' | 'security' | 'performance' | 'documentation' | 'full',
    language: string,
    question?: string
  ): string {
    const basePrompt = `You are an expert ${language} code analyst. Analyze the provided code and provide structured feedback.`;

    const typePrompts: Record<string, string> = {
      quality: `Focus on: code quality, best practices, maintainability, readability, and potential bugs.`,
      security: `Focus on: security vulnerabilities, unsafe patterns, input validation, authentication issues, and secrets exposure.`,
      performance: `Focus on: performance bottlenecks, memory usage, algorithmic efficiency, and optimization opportunities.`,
      documentation: `Focus on: missing documentation, unclear code, suggested comments, and documentation quality.`,
      full: `Provide comprehensive analysis including: quality, security, performance, and documentation.`,
    };

    // Language-specific import handling rules to prevent hallucinations
    const importRules: Record<string, string> = {
      typescript: `\n## IMPORT ANALYSIS RULES (TypeScript/JavaScript):
- Do NOT flag imports as "missing" - the bundler/compiler handles resolution
- Imports from 'node_modules' packages are valid if they appear in package.json
- Imports with path aliases (e.g., '@/utils', '#lib') are configured in tsconfig.json
- Dynamic imports: import() expressions are lazy-loaded and valid
- Conditional requires: require() inside try/catch blocks are intentionally optional
- Type-only imports: \`import type { X }\` have no runtime presence
- NEVER report "module not found" errors - that's the compiler's job`,
      javascript: `\n## IMPORT ANALYSIS RULES (JavaScript):
- Do NOT flag requires/imports as "missing" - the bundler handles this
- CommonJS require() and ES6 import are both valid
- Dynamic imports are intentionally lazy-loaded
- NEVER report "module not found" errors`,
      python: `\n## IMPORT ANALYSIS RULES (Python):
- Do NOT flag imports as "missing" unless you're CERTAIN the module doesn't exist in pip/conda
- Conditional imports (inside try/except) are intentionally optional
- TYPE_CHECKING imports are only for static analysis
- Local relative imports (.module) depend on package structure
- NEVER report "ModuleNotFoundError" - that's the runtime's job`,
    };

    // YAML-specific anti-false-positive rules
    const yamlRules: Record<string, string> = {
      yaml: `\n## YAML ANALYSIS RULES (CRITICAL - avoid false positives):
- YAML plain scalars CAN contain colons in these valid cases:
  * URLs: \`http://localhost:1234\` or \`https://example.com:443\` are VALID unquoted
  * Docker/model tags: \`image:tag\`, \`model:version\`, \`granite4:3b\` are VALID unquoted
  * Only flag colons that are followed by a SPACE and could be confused with key:value pairs
- Do NOT suggest quoting values that are already syntactically correct
- Port numbers in URLs (e.g., :1234, :8080) are NOT syntax errors
- Model identifiers like \`llama:7b\` or \`model:latest\` are standard and valid`,
      yml: '', // Will be set to same as yaml
    };
    yamlRules.yml = yamlRules.yaml;

    const importGuidance = importRules[language] || '';
    const yamlGuidance = yamlRules[language] || '';

    return `${basePrompt}

${typePrompts[analysisType]}
${importGuidance}
${yamlGuidance}

## CRITICAL ANTI-HALLUCINATION RULES:
1. Only report issues you can DIRECTLY observe in the provided code
2. Do NOT assume missing dependencies - import/require statements are valid until proven otherwise
3. Do NOT flag architectural decisions as "issues" - focus on clear bugs/problems
4. If code references external modules, assume they exist unless obviously incorrect
5. V11: EVIDENCE-BASED CLAIMS - For ANY issue you report:
   - CITE the specific LINE NUMBER where the issue occurs
   - QUOTE the relevant code snippet as evidence
   - If you cannot cite a line number, the issue is likely a hallucination - DO NOT report it
6. V11: DOCSTRING CHECK - Before claiming a docstring is "missing":
   - Check the FIRST 10 lines for module-level docstrings (Python: triple-quoted strings, JS/TS: JSDoc)
   - Check immediately above functions/classes for docstrings
   - If you see a docstring/JSDoc comment, the documentation EXISTS - do not claim it's missing
7. V12: FACT VS INFERENCE SEPARATION - Clearly distinguish between:
   - FACTS: Things directly observable in the code (e.g., "Line 42 has an unused variable 'x'")
   - INFERENCES: Suggestions or potential improvements (e.g., "Consider using a more descriptive name")
   - Mark each issue as either "fact" (observable) or "inference" (suggestion)

## Plan 4 (V4): Structured JSON Output Required
Respond ONLY with valid JSON in this exact format:
\`\`\`json
{
  "summary": "Brief 2-3 sentence overview of the analysis",
  "issues": [
    {
      "type": "security|performance|style|bug|documentation",
      "line": 42,
      "message": "Description of the specific issue found",
      "severity": "error|warning|info",
      "evidence": "fact|inference"
    }
  ],
  "suggestions": ["Actionable suggestion 1", "Actionable suggestion 2"],
  "metrics": {
    "complexity": 5,
    "linesOfCode": 100
  }
}
\`\`\`

IMPORTANT:
- Return ONLY the JSON object, no additional text before or after
- If no issues found, use empty array: "issues": []
- Line numbers are optional but highly encouraged
- Severity must be one of: error, warning, info
- V12: evidence field is required: "fact" for directly observable issues, "inference" for suggestions

${question ? `Also address this specific question in the summary: ${question}` : ''}`;
  }

  private parseAnalysisResponse(
    response: string,
    _analysisType: string
  ): {
    summary: string;
    issues: Array<{
      type: string;
      line?: number;
      message: string;
      severity: 'error' | 'warning' | 'info';
    }>;
    suggestions: string[];
    metrics: Record<string, number>;
  } {
    // Remove <think> blocks and model control tokens from response
    const cleanedResponse = response
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\|[a-z_]+\|>/gi, '') // Remove model control tokens
      .trim();

    // Normalize the issue type/severity
    const normalizeIssue = (raw: {
      type?: string;
      line?: number;
      message?: string;
      severity?: string;
    }): {
      type: string;
      line?: number;
      message: string;
      severity: 'error' | 'warning' | 'info';
    } => {
      const severityMap: Record<string, 'error' | 'warning' | 'info'> = {
        critical: 'error',
        high: 'error',
        error: 'error',
        medium: 'warning',
        warning: 'warning',
        low: 'info',
        info: 'info',
        suggestion: 'info',
      };
      return {
        type: raw.type || 'general',
        line: typeof raw.line === 'number' ? raw.line : undefined,
        message: raw.message || '',
        severity: severityMap[(raw.severity || 'warning').toLowerCase()] || 'warning',
      };
    };

    // STRATEGY 1: Try to extract JSON from response
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const issues = Array.isArray(parsed.issues)
          ? parsed.issues.map(normalizeIssue).filter((i: { message: string }) => i.message)
          : [];
        const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
        const metrics =
          typeof parsed.metrics === 'object' && parsed.metrics !== null ? parsed.metrics : {};

        return {
          summary: parsed.summary || cleanedResponse.split('\n')[0] || '',
          issues,
          suggestions: suggestions.filter((s: unknown) => typeof s === 'string' && s.length > 0),
          metrics,
        };
      } catch {
        // JSON parse failed, fall through to text parsing
      }
    }

    // STRATEGY 2: Enhanced text parsing with multiple formats
    return this.parseAnalysisResponseText(cleanedResponse);
  }

  /**
   * Parse analysis response from plain text when JSON extraction fails.
   * Handles multiple formats:
   * - Bullet points: "- Issue: ..." or "* Bug: ..."
   * - Numbered lists: "1. Issue..." or "2) Problem..."
   * - Markdown bold: "**Issue**: ..."
   * - Line markers: "Line 42: error..."
   */
  private parseAnalysisResponseText(text: string): {
    summary: string;
    issues: Array<{
      type: string;
      line?: number;
      message: string;
      severity: 'error' | 'warning' | 'info';
    }>;
    suggestions: string[];
    metrics: Record<string, number>;
  } {
    const issues: Array<{
      type: string;
      line?: number;
      message: string;
      severity: 'error' | 'warning' | 'info';
    }> = [];
    const suggestions: string[] = [];
    const seenMessages = new Set<string>(); // Dedup

    // Extract summary from first non-empty line
    const summaryLine = text.split('\n').find((l) => l.trim().length > 10) || '';
    const summary = summaryLine.substring(0, 200);

    // Patterns for extracting issues
    const issuePatterns: Array<{
      pattern: RegExp;
      severity: 'error' | 'warning' | 'info';
      type: string;
    }> = [
      // "Line 42: error message" or "line 42 - bug description"
      {
        pattern: /[Ll]ine\s+(\d+)\s*[:–-]\s*(?:error|bug|issue)?[:\s]*(.+)/g,
        severity: 'error',
        type: 'line-error',
      },
      // "- **Bug**: message" or "- **Issue**: message"
      {
        pattern: /^[-*]\s*\*\*(?:Bug|Issue|Problem|Error|Warning)\*\*[:\s]*(.+)/gim,
        severity: 'warning',
        type: 'markdown-issue',
      },
      // "1. Issue: message" or "2) Bug: message"
      {
        pattern: /^\d+[.)]\s*(?:Issue|Bug|Problem|Error|Warning)[:\s]+(.+)/gim,
        severity: 'warning',
        type: 'numbered-issue',
      },
      // "- Issue: message" or "* Bug: message"
      {
        pattern: /^[-*]\s*(?:Issue|Bug|Problem|Error|Warning)[:\s]+(.+)/gim,
        severity: 'warning',
        type: 'bullet-issue',
      },
      // Lines containing "error:" or "warning:" or "bug:"
      { pattern: /\b(?:error|bug)\s*:\s*(.+)/gim, severity: 'error', type: 'inline-error' },
      { pattern: /\bwarning\s*:\s*(.+)/gim, severity: 'warning', type: 'inline-warning' },
      // Simple bullet under ISSUES section
      { pattern: /^[-*]\s+([A-Z][^.]+(?:\.|$))/gm, severity: 'warning', type: 'general-bullet' },
    ];

    // Patterns for extracting suggestions
    const suggestionPatterns: RegExp[] = [
      /^[-*]\s*(?:Suggestion|Recommend|Consider)[:\s]+(.+)/gim,
      /^\d+[.)]\s*(?:Suggestion|Recommend|Consider)[:\s]+(.+)/gim,
      /^[-*]\s*\*\*(?:Suggestion|Recommendation)\*\*[:\s]*(.+)/gim,
    ];

    // Track if we're in an ISSUES or SUGGESTIONS section
    let inIssuesSection = false;
    let inSuggestionsSection = false;
    const lines = text.split('\n');

    for (const line of lines) {
      const lowerLine = line.toLowerCase();

      // Detect section headers
      if (
        lowerLine.includes('issues:') ||
        lowerLine.includes('problems:') ||
        lowerLine.match(/^#+\s*issues?\b/i) ||
        lowerLine.match(/^#+\s*problems?\b/i)
      ) {
        inIssuesSection = true;
        inSuggestionsSection = false;
        continue;
      }
      if (
        lowerLine.includes('suggestions:') ||
        lowerLine.includes('recommendations:') ||
        lowerLine.match(/^#+\s*suggestions?\b/i) ||
        lowerLine.match(/^#+\s*recommendations?\b/i)
      ) {
        inSuggestionsSection = true;
        inIssuesSection = false;
        continue;
      }

      // If in issues section, capture any bullet point
      if (inIssuesSection && line.trim().match(/^[-*]\s+(.+)/)) {
        const match = line.trim().match(/^[-*]\s+(.+)/);
        if (match && match[1].length > 5) {
          const msg = match[1].trim();
          if (!seenMessages.has(msg.toLowerCase())) {
            seenMessages.add(msg.toLowerCase());
            issues.push({
              type: 'general',
              message: msg,
              severity: 'warning',
            });
          }
        }
      }

      // If in suggestions section, capture bullet points
      if (inSuggestionsSection && line.trim().match(/^[-*]\s+(.+)/)) {
        const match = line.trim().match(/^[-*]\s+(.+)/);
        if (match && match[1].length > 5) {
          suggestions.push(match[1].trim());
        }
      }
    }

    // Also apply pattern-based extraction (catches issues outside sections)
    for (const { pattern, severity, type } of issuePatterns) {
      let match;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(text)) !== null) {
        // For line-error pattern, capture line number
        const hasLineNum = type === 'line-error';
        const lineNum = hasLineNum ? parseInt(match[1], 10) : undefined;
        const message = (hasLineNum ? match[2] : match[1])?.trim();

        if (message && message.length > 3 && !seenMessages.has(message.toLowerCase())) {
          seenMessages.add(message.toLowerCase());
          issues.push({
            type,
            line: lineNum,
            message,
            severity,
          });
        }
      }
    }

    // Extract suggestions via patterns
    for (const pattern of suggestionPatterns) {
      let match;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(text)) !== null) {
        const suggestion = match[1]?.trim();
        if (suggestion && suggestion.length > 5 && !suggestions.includes(suggestion)) {
          suggestions.push(suggestion);
        }
      }
    }

    return { summary, issues, suggestions, metrics: {} };
  }

  private countFunctions(content: string, language: string): number {
    const patterns: Record<string, RegExp[]> = {
      typescript: [
        /\bfunction\s+\w+/g,
        /\bconst\s+\w+\s*=\s*(?:async\s*)?\(/g,
        /\b\w+\s*\([^)]*\)\s*{/g,
      ],
      javascript: [/\bfunction\s+\w+/g, /\bconst\s+\w+\s*=\s*(?:async\s*)?\(/g],
      python: [/\bdef\s+\w+/g],
      java: [/\b(?:public|private|protected)?\s*\w+\s+\w+\s*\([^)]*\)\s*{/g],
    };

    const langPatterns = patterns[language] || patterns.javascript || [];
    let count = 0;
    for (const pattern of langPatterns) {
      const matches = content.match(pattern);
      count += matches?.length || 0;
    }
    return count;
  }

  private countClasses(content: string, language: string): number {
    const patterns: Record<string, RegExp> = {
      typescript: /\bclass\s+\w+/g,
      javascript: /\bclass\s+\w+/g,
      python: /\bclass\s+\w+/g,
      java: /\bclass\s+\w+/g,
    };

    const pattern = patterns[language] || patterns.javascript;
    const matches = content.match(pattern);
    return matches?.length || 0;
  }

  private collectDirectoryEntries(
    dir: string,
    depth: number,
    maxEntries: number,
    currentDepth: number = 0
  ): Array<{ name: string; type: 'file' | 'directory'; path: string; size?: number }> {
    const entries: Array<{
      name: string;
      type: 'file' | 'directory';
      path: string;
      size?: number;
    }> = [];

    if (currentDepth > depth || entries.length >= maxEntries) {
      return entries;
    }

    try {
      const items = readdirSync(dir, { withFileTypes: true });

      for (const item of items) {
        if (entries.length >= maxEntries) break;
        if (item.name.startsWith('.')) continue;
        if (['node_modules', 'dist', 'build', '__pycache__', '.git'].includes(item.name)) continue;

        const fullPath = join(dir, item.name);

        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            type: 'directory',
            path: fullPath,
          });

          if (currentDepth < depth) {
            const subEntries = this.collectDirectoryEntries(
              fullPath,
              depth,
              maxEntries - entries.length,
              currentDepth + 1
            );
            entries.push(...subEntries);
          }
        } else if (item.isFile()) {
          const stats = statSync(fullPath);
          entries.push({
            name: item.name,
            type: 'file',
            path: fullPath,
            size: stats.size,
          });
        }
      }
    } catch {
      // Skip directories we can't read
    }

    return entries;
  }

  private categorizeFiles(
    entries: Array<{ name: string; type: 'file' | 'directory'; path: string }>
  ): Record<string, string[]> {
    const categories: Record<string, string[]> = {
      source: [],
      test: [],
      config: [],
      documentation: [],
      assets: [],
      other: [],
    };

    for (const entry of entries) {
      if (entry.type !== 'file') continue;

      const ext = extname(entry.name).toLowerCase();
      const name = entry.name.toLowerCase();

      if (name.includes('.test.') || name.includes('.spec.') || name.includes('_test.')) {
        categories.test.push(entry.name);
      } else if (
        ['.ts', '.js', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp'].includes(ext)
      ) {
        categories.source.push(entry.name);
      } else if (
        ['.json', '.yml', '.yaml', '.toml', '.ini', '.env'].includes(ext) ||
        name.includes('config')
      ) {
        categories.config.push(entry.name);
      } else if (['.md', '.txt', '.rst', '.adoc'].includes(ext) || name === 'readme') {
        categories.documentation.push(entry.name);
      } else if (['.png', '.jpg', '.svg', '.gif', '.ico', '.css', '.scss'].includes(ext)) {
        categories.assets.push(entry.name);
      } else {
        categories.other.push(entry.name);
      }
    }

    return categories;
  }

  private buildStructureSummary(
    entries: Array<{ name: string; type: 'file' | 'directory'; path: string; size?: number }>,
    categorized: Record<string, string[]>
  ): string {
    const lines: string[] = [];
    lines.push('## Directory Structure\n');

    for (const entry of entries.slice(0, 50)) {
      const prefix = entry.type === 'directory' ? '📁' : '📄';
      const size = entry.size ? ` (${Math.round(entry.size / 1024)}KB)` : '';
      lines.push(`${prefix} ${entry.name}${size}`);
    }

    lines.push('\n## File Categories\n');
    for (const [category, files] of Object.entries(categorized)) {
      if (files.length > 0) {
        lines.push(`- ${category}: ${files.length} files`);
      }
    }

    return lines.join('\n');
  }

  private parseDirectoryAnalysis(response: string): {
    analysis: string;
    purpose: string;
    recommendations: string[];
    keyFiles: Array<{ path: string; description: string }>;
  } {
    // Remove <think> blocks from response
    const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const analysis = cleanedResponse;
    let purpose = '';
    const recommendations: string[] = [];
    const keyFiles: Array<{ path: string; description: string }> = [];

    // Simple extraction
    const lines = cleanedResponse.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (line.includes('purpose') && lines[i + 1]) {
        purpose = lines[i + 1].trim();
      }
      if (line.includes('recommend') && lines[i + 1]?.trim().startsWith('-')) {
        recommendations.push(lines[i + 1].trim().substring(1).trim());
      }
    }

    return { analysis, purpose, recommendations, keyFiles };
  }

  private parseSearchRanking(response: string): {
    rankings: Array<{ file: string; score: number; reason: string }>;
    summary: string;
    nextSteps: string[];
  } {
    const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const coerce = (
      parsed: unknown
    ): {
      rankings: Array<{ file: string; score: number; reason: string }>;
      summary: string;
      nextSteps: string[];
    } | null => {
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;

      const rawRankings = Array.isArray(obj.rankings) ? (obj.rankings as unknown[]) : [];
      const rankings = rawRankings
        .map((r) => {
          const it = (r && typeof r === 'object' ? (r as any) : {}) as any;
          const file = typeof it.file === 'string' ? it.file.trim() : '';
          const scoreRaw = it.score;
          const score =
            typeof scoreRaw === 'number'
              ? scoreRaw
              : typeof scoreRaw === 'string' && scoreRaw.trim()
                ? Number(scoreRaw)
                : 0;
          const reason =
            typeof it.reason === 'string'
              ? it.reason.trim()
              : typeof it.explanation === 'string'
                ? it.explanation.trim()
                : '';

          return {
            file,
            score: Number.isFinite(score) ? score : 0,
            reason,
          };
        })
        .filter((r) => r.file);

      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const nextSteps = Array.isArray(obj.nextSteps)
        ? (obj.nextSteps as unknown[])
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      return { rankings, summary, nextSteps };
    };

    try {
      const parsed = extractJsonFromText(cleanedResponse);
      const coerced = coerce(parsed);
      if (coerced) return coerced;
    } catch {
      // fall through
    }

    // Backup: bias extraction toward objects that contain "rankings".
    const rankingObjMatch = cleanedResponse.match(/\{[\s\S]*"rankings"[\s\S]*\}/);
    if (rankingObjMatch) {
      try {
        const parsed = extractJsonFromText(rankingObjMatch[0]);
        const coerced = coerce(parsed);
        if (coerced) return coerced;
      } catch {
        // fall through
      }
    }

    // Fallback: return empty rankings with summary from response
    return {
      rankings: [],
      summary: cleanedResponse.substring(0, 200) || response.substring(0, 200),
      nextSteps: [],
    };
  }

  private buildReviewPrompt(
    reviewType: 'security' | 'performance' | 'style' | 'comprehensive',
    focusAreas?: string[]
  ): string {
    const focuses: Record<string, string> = {
      security:
        'Focus on: SQL injection, XSS, path traversal, command injection, authentication flaws, exposed secrets, insecure data handling.',
      performance:
        'Focus on: O(n²) loops, memory leaks, unnecessary allocations, blocking I/O, missing caching, unoptimized queries.',
      style:
        'Focus on: naming clarity, function length (>50 lines), nesting depth (>3), missing types, magic numbers, dead code.',
      comprehensive:
        'Review for security vulnerabilities, performance bottlenecks, code smells, and maintainability issues.',
    };

    return `You are a senior code reviewer with 15+ years of experience. ${focuses[reviewType]}
${focusAreas ? `\nPrioritize: ${focusAreas.join(', ')}` : ''}

## CRITICAL RULES TO PREVENT HALLUCINATIONS:
1. **ONLY report issues you can SEE in the actual code provided**
2. **NEVER assume database/SQL usage** - only report SQL injection if you see actual SQL query strings
3. **NEVER assume network/HTTP usage** - only report XSS if you see actual HTML rendering
4. **Match the LANGUAGE of the file** - do NOT suggest TypeScript fixes for Python files or vice versa
5. **Quote the EXACT problematic code** from the file in your message
6. **If no real issues exist, report an empty issues array** - do NOT invent problems

## LANGUAGE-SPECIFIC GUIDANCE:
- For .py files: Focus on Python-specific issues (f-strings, type hints, async patterns)
- For .ts/.js files: Focus on TypeScript/JavaScript issues (type safety, null checks, async/await)
- For .go files: Focus on Go issues (error handling, goroutine leaks, defer patterns)
- NEVER mix language-specific fixes (e.g., no TypeScript colon-type syntax for Python files)

For EACH issue found, you MUST provide:
1. The exact file path
2. Line number (or line range) where the issue occurs
3. Severity based on real-world impact (critical=security breach/data loss, high=bugs/crashes, medium=maintainability, low=style)
4. A SPECIFIC message that QUOTES the problematic code from the file
5. A CONCRETE fix in the SAME LANGUAGE as the file - show the actual code change

Return ONLY valid JSON:
{
  "issues": [
    {
      "file": "src/module.ts",
      "line": 42,
      "severity": "high",
      "message": "Unsafe user input: The code 'userId = req.params.id' is passed directly to query at line 45",
      "fix": "Validate and sanitize: const userId = parseInt(req.params.id, 10); if (isNaN(userId)) throw new Error('Invalid ID');"
    }
  ],
  "recommendations": ["Add input validation middleware", "Enable TypeScript strict mode"],
  "summary": "Found 3 security issues and 2 performance problems requiring immediate attention",
  "score": 4
}

## VALIDATION CHECKLIST (apply before returning):
- Did I quote actual code from the provided files? If not, remove the issue.
- Is my fix in the correct programming language? If not, rewrite it.
- Can I point to a specific line number? If not, remove the issue.
- Am I assuming capabilities not shown in the code? If yes, remove the issue.

If the code looks good, return {"issues": [], "recommendations": [], "summary": "Code is well-structured with no significant issues", "score": 9}.
It is better to return NO issues than to hallucinate issues that don't exist.`;
  }

  private parseCodeReview(response: string): {
    issues: Array<{ file: string; line?: number; severity: string; message: string; fix?: string }>;
    summary: string;
    recommendations: string[];
    score?: number;
  } {
    // Remove <think> blocks from response
    const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const normalizeReviewPayload = (obj: Record<string, unknown>) => {
      const rawIssues = Array.isArray(obj.issues) ? (obj.issues as unknown[]) : [];
      const issues = rawIssues
        .map((issue) => {
          const it = (issue && typeof issue === 'object' ? (issue as any) : {}) as any;
          const file = typeof it.file === 'string' ? it.file.trim() : '';
          const message =
            typeof it.message === 'string'
              ? it.message.trim()
              : typeof it.description === 'string'
                ? it.description.trim()
                : '';
          const severity = typeof it.severity === 'string' ? it.severity.trim() : 'medium';
          const fix = typeof it.fix === 'string' ? it.fix.trim() : undefined;
          const line =
            typeof it.line === 'number'
              ? it.line
              : typeof it.line === 'string' && it.line.trim()
                ? Number(it.line)
                : undefined;

          return {
            file,
            line: Number.isFinite(line as number) ? (line as number) : undefined,
            severity,
            message,
            fix,
          };
        })
        .filter((i) => i.file && i.message);

      const recommendations = Array.isArray(obj.recommendations)
        ? (obj.recommendations as unknown[])
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      const summary =
        typeof obj.summary === 'string' && obj.summary.trim()
          ? obj.summary.trim()
          : cleanedResponse.substring(0, 200);

      const scoreRaw = (obj as any).score;
      const scoreNum =
        typeof scoreRaw === 'number'
          ? scoreRaw
          : typeof scoreRaw === 'string' && scoreRaw.trim()
            ? Number(scoreRaw)
            : undefined;
      const score = Number.isFinite(scoreNum as number)
        ? Math.max(1, Math.min(10, Math.round(scoreNum as number)))
        : undefined;

      return { issues, recommendations, summary, score };
    };

    const recoverEmbeddedPayloadFromSummary = (summaryText: string) => {
      const trimmed = String(summaryText || '').trim();
      if (!trimmed || !trimmed.includes('{')) return null;

      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
      const candidates = [fenced, trimmed].filter((v): v is string => Boolean(v && v.trim()));

      for (const candidate of candidates) {
        try {
          const extracted = extractJsonFromText(candidate);
          if (extracted && typeof extracted === 'object') {
            const normalized = normalizeReviewPayload(extracted as Record<string, unknown>);
            if (normalized.issues.length > 0 || normalized.recommendations.length > 0) {
              return normalized;
            }
          }
        } catch {
          // ignore and continue searching
        }
      }

      return null;
    };

    // Preferred: JSON response (enforced by buildReviewPrompt).
    try {
      const parsed = extractJsonFromText(cleanedResponse);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        let { issues, summary, recommendations, score } = normalizeReviewPayload(obj);

        // Some models embed a second JSON payload in summary text.
        // Recover structured issues to keep output stable for clients.
        if (issues.length === 0 && summary) {
          const recovered = recoverEmbeddedPayloadFromSummary(summary);
          if (recovered && recovered.issues.length > 0) {
            issues = recovered.issues;
            if (recommendations.length === 0 && recovered.recommendations.length > 0) {
              recommendations = recovered.recommendations;
            }
            if (recovered.summary) {
              summary = recovered.summary;
            }
            if (score === undefined && recovered.score !== undefined) {
              score = recovered.score;
            }
          }
        }

        return { issues, summary, recommendations, score };
      }
    } catch {
      // fall back to heuristic parsing below
    }

    // Fallback: simple heuristics (kept for model/dev variance)
    const issues: Array<{
      file: string;
      line?: number;
      severity: string;
      message: string;
      fix?: string;
    }> = [];
    const recommendations: string[] = [];
    let summary = '';
    let score: number | undefined;

    const lines = cleanedResponse.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes('score') && line.match(/\d+/)) {
        score = parseInt(line.match(/\d+/)?.[0] || '5', 10);
      }
      if (line.toLowerCase().includes('summary')) {
        summary = line.trim();
      }
    }

    if (!summary) summary = cleanedResponse.substring(0, 200);
    return { issues, summary, recommendations, score };
  }

  private buildDocPrompt(
    docType: 'jsdoc' | 'readme' | 'api' | 'usage-examples',
    language: string,
    style?: string,
    includeExamples?: boolean
  ): string {
    const typeInstructions: Record<string, string> = {
      jsdoc: 'Generate JSDoc/docstring comments for all functions, classes, and methods.',
      readme: 'Generate a README.md section describing this code, its purpose, and how to use it.',
      api: 'Generate API documentation describing all public interfaces, parameters, and return values.',
      'usage-examples': 'Generate practical usage examples showing how to use this code.',
    };

    return `You are a technical documentation writer for ${language} code.
${typeInstructions[docType]}
${style ? `Follow this documentation style: ${style}` : ''}
${includeExamples ? 'Include practical code examples.' : ''}

Be clear, concise, and comprehensive.`;
  }

  private buildTestPrompt(
    framework: string,
    coverage: 'basic' | 'comprehensive' | 'edge-cases',
    focusFunctions?: string[],
    testStyle?: 'unit' | 'integration' | 'e2e' | 'real-implementation',
    sourcePath?: string
  ): string {
    const coverageInstructions: Record<string, string> = {
      basic: 'Generate basic happy-path tests for main functionality.',
      comprehensive:
        'Generate comprehensive tests including happy paths, error handling, and boundary conditions.',
      'edge-cases': 'Focus on edge cases, error conditions, and unusual inputs.',
    };

    // Test style instructions (Plan 5 enhancement)
    const testStyleInstructions: Record<string, string> = {
      unit: `
## MOCKING STRATEGY: Unit tests with isolated mocks
- Mock ALL external dependencies (file system, network, databases, other classes)
- Each test should test exactly ONE unit of code in isolation
- Use vi.mock() or jest.mock() for module mocking
- Use vi.fn() or jest.fn() for function mocking
- Verify mock calls with expect(mock).toHaveBeenCalledWith()`,
      integration: `
## MOCKING STRATEGY: Integration tests with real dependencies
- Use REAL implementations for internal dependencies
- Only mock external services (APIs, databases)
- Test how components work together
- Set up real data fixtures for testing`,
      e2e: `
## MOCKING STRATEGY: End-to-end tests with minimal mocking
- NO mocking of internal code
- Only mock external third-party services if needed
- Test complete user workflows from start to finish
- Use realistic data and scenarios`,
      'real-implementation': `
## MOCKING STRATEGY: NO MOCKS - Real implementation tests
- DO NOT use vi.mock(), jest.mock(), or any mocking
- Test against REAL implementations only
- Use actual file system, actual configs, actual dependencies
- These tests verify actual behavior, not mocked behavior
- If external services are needed, either skip or use test instances`,
    };

    // Detailed framework-specific templates with complete, runnable examples
    const normalizedSourcePath = (sourcePath || 'path/to/my_module.py').replace(/\\/g, '/');
    const pythonModuleStem =
      normalizedSourcePath.split('/').pop()?.replace(/\.py$/i, '') || 'my_module';
    const pythonModuleId = pythonModuleStem.replace(/[^a-zA-Z0-9_]/g, '_');

    const frameworkExamples: Record<string, string> = {
      vitest: `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Import the module under test - use relative path from test file location
import { myFunction, MyClass } from '../src/module';

describe('MyClass', () => {
  let instance: MyClass;
  
  beforeEach(() => {
    instance = new MyClass();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('myFunction', () => {
    it('should return expected value for valid input', () => {
      const result = instance.myFunction('test');
      expect(result).toBe('expected');
    });

    it('should throw error for invalid input', () => {
      expect(() => instance.myFunction(null)).toThrow('Invalid input');
    });

    it('should handle edge case', () => {
      const result = instance.myFunction('');
      expect(result).toBe('default');
    });
  });
});`,
      jest: `const { myFunction, MyClass } = require('../src/module');

describe('MyClass', () => {
  let instance;
  
  beforeEach(() => {
    instance = new MyClass();
  });

  describe('myFunction', () => {
    it('should return expected value for valid input', () => {
      const result = instance.myFunction('test');
      expect(result).toBe('expected');
    });

    it('should throw error for invalid input', () => {
      expect(() => instance.myFunction(null)).toThrow('Invalid input');
    });
  });
});`,
      pytest: `import importlib.util
from pathlib import Path

import pytest


def _load_module():
    rel = Path("${normalizedSourcePath}")
    candidates = [Path.cwd() / rel]
    for parent in Path(__file__).resolve().parents:
        candidates.append(parent / rel)

    for c in candidates:
        if c.exists():
            spec = importlib.util.spec_from_file_location("${pythonModuleId}", c)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(module)
            return module
    raise FileNotFoundError(f"Could not locate source file: {rel}")


module = _load_module()


class TestModule:
    def test_smoke(self):
        assert module is not None`,
      unknown: 'Follow standard testing patterns for the language.',
    };

    const styleInstruction =
      testStyleInstructions[testStyle || 'unit'] || testStyleInstructions.unit;

    return `You are an expert test engineer. Generate COMPLETE, RUNNABLE tests using ${framework}.
${coverageInstructions[coverage]}
${focusFunctions ? `Focus on these functions: ${focusFunctions.join(', ')}` : ''}
${styleInstruction}

## CRITICAL REQUIREMENTS - Tests MUST be immediately runnable:

### 1. IMPORTS (most common failure point)
- Include ALL necessary imports at the TOP of the file
- Use CORRECT relative import paths based on typical project structure
- For TypeScript/JavaScript: import from relative path like '../src/module' or './module'
- For Python: DO NOT guess package prefixes like 'src.'. If unsure, use a robust dynamic import-by-path fallback using the provided source file path and reference code as module.<name>.
- Include test framework imports (describe, it, expect, pytest, etc.)

### 2. TEST STRUCTURE
- Use proper ${framework} syntax and assertions
- Group related tests in describe blocks or test classes
- Include setup/teardown (beforeEach, afterEach, fixtures) when needed
- Each test should be independent and isolated

### 3. TEST DATA
- Use REALISTIC test values, never placeholders like "input" or "expected"
- Include concrete values: numbers, strings, objects that match the code's types
- Test actual return types and error messages from the code

### 4. OUTPUT FORMAT (CRITICAL FOR SYNTAX VALIDITY)
- Output ONLY the complete test file code
- NO markdown code fences, NO explanations, NO comments about what you're doing
- The first line should be an import statement
- Code must compile and run without any modification
- Do NOT include zero-width or non-printable characters

### 5. PYTHON FORMATTING (MANDATORY - NEVER COLLAPSE LINES)
- NEVER put code on the same line as def/class/if/for/while colon
- WRONG: "def test_foo():assert True"
- RIGHT: "def test_foo():\n    assert True"
- Each statement MUST be on its own line with proper 4-space indentation
- After a colon (:), ALWAYS start a new line before the body code

## EXAMPLE for ${framework}:
${frameworkExamples[framework] || frameworkExamples.unknown}

Remember: Analyze the source code carefully to:
- Identify the correct module path for imports
- Use actual function/class names from the source
- Test actual behavior, not hypothetical behavior`;
  }

  /**
   * V18: Template-based test generation
   *
   * Uses a two-phase approach:
   * 1. LLM generates a JSON test specification
   * 2. Server renders test code from Handlebars templates
   *
   * Benefits:
   * - Consistent syntax (no LLM hallucination issues)
   * - Framework-specific best practices built into templates
   * - Easy to maintain and update
   */
  private async generateTestsWithTemplate(
    content: string,
    language: string,
    framework: string,
    coverage: 'basic' | 'comprehensive' | 'edge-cases',
    focusFunctions?: string[],
    testStyle?: 'unit' | 'integration' | 'e2e' | 'real-implementation',
    sourcePath?: string
  ): Promise<GenerateTestsResult> {
    const normalizedPath = toForwardSlashes(sourcePath || 'module');

    // Get the template-based prompt that asks for JSON
    const templatePrompt = getTestSpecPrompt(framework, coverage, focusFunctions, testStyle);

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: templatePrompt,
            },
            {
              role: 'user',
              content: `Analyze this ${language} code and generate a JSON test specification:\n\n\`\`\`${language}\n${content}\n\`\`\`\n\nSource file path: ${normalizedPath}`,
            },
          ],
        },
        'local'
      );

      // Parse the JSON test specification from LLM response
      const specContent = this.redaction.stripThinkTags(response.message.content);
      const testSpec = parseTestSpec(specContent);

      if (!testSpec) {
        return {
          success: false,
          error:
            'Failed to parse test specification from LLM response. The LLM did not return valid JSON.',
          tests: '',
          framework,
          coverage,
          testCount: 0,
          syntaxValid: false,
        };
      }

      // Render the test code from the template
      let testCode = renderTestCode(testSpec, framework);

      // V15: Format Python code with black if available
      let blackFormatResult: { formatted: boolean; error?: string } | undefined;
      if (language === 'python') {
        const formatResult = await this.formatPythonWithBlack(testCode);
        testCode = formatResult.code;
        blackFormatResult = { formatted: formatResult.formatted, error: formatResult.error };
      }

      // Count tests in generated code
      const testCount = testSpec.testCases.length;

      // Validate syntax
      const qualityWarnings: string[] = [];
      let hasSyntaxErrors = false;

      if (language === 'python') {
        const pythonParseError = await this.getPythonSyntaxErrorSummary(testCode);
        if (pythonParseError) {
          hasSyntaxErrors = true;
          qualityWarnings.push(pythonParseError);
        }
        if (blackFormatResult && !blackFormatResult.formatted && blackFormatResult.error) {
          qualityWarnings.push(`Python formatting skipped: ${blackFormatResult.error}`);
        }
      } else {
        const parseError = this.getTypeScriptParseErrorSummary(testCode, language);
        if (parseError) {
          hasSyntaxErrors = true;
          qualityWarnings.push(parseError);
        }
      }

      return {
        success: true,
        tests: testCode,
        framework,
        coverage,
        testCount,
        path: sourcePath,
        syntaxValid: !hasSyntaxErrors,
        warnings: qualityWarnings.length > 0 ? qualityWarnings : undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: `Template generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        tests: '',
        framework,
        coverage,
        testCount: 0,
        syntaxValid: false,
      };
    }
  }

  private detectTestFramework(language: string): string {
    const frameworkMap: Record<string, string> = {
      typescript: 'vitest',
      javascript: 'jest',
      python: 'pytest',
      java: 'junit',
      go: 'testing',
      rust: 'cargo test',
    };
    return frameworkMap[language] || 'unknown';
  }

  private buildCommitPrompt(
    style: 'conventional' | 'detailed' | 'simple',
    includeBody: boolean
  ): string {
    const styleInstructions: Record<string, string> = {
      conventional: `Use Conventional Commits format: type(scope): description
Types: feat, fix, docs, style, refactor, test, chore
Example: feat(auth): add password reset functionality`,
      detailed:
        'Write a detailed commit message with a clear subject line and comprehensive body explaining the changes.',
      simple: 'Write a clear, concise one-line commit message.',
    };

    return `You are a commit message generator. ${styleInstructions[style]}
${includeBody ? 'Include a body explaining the changes in detail.' : 'Generate only the subject line.'}
Be specific about what changed and why.`;
  }

  private buildRefactorPrompt(
    focus: 'duplication' | 'complexity' | 'naming' | 'architecture' | 'all',
    language: string
  ): string {
    const focusInstructions: Record<string, string> = {
      duplication: 'Focus on code duplication and DRY violations.',
      complexity: 'Focus on reducing complexity, simplifying logic, and improving readability.',
      naming: 'Focus on variable, function, and class naming improvements.',
      architecture:
        'Focus on structural improvements, design patterns, and separation of concerns.',
      all: 'Analyze for all types of refactoring opportunities.',
    };

    return `You are a ${language} refactoring expert. ${focusInstructions[focus]}

For each suggestion:
1. Describe the current problem
2. Explain the refactoring
3. Show before/after examples if helpful
4. Rate the priority (high/medium/low)

Be practical and actionable.`;
  }

  private parseRefactoringSuggestions(response: string): {
    suggestions: Array<{
      type: string;
      description: string;
      priority: 'high' | 'medium' | 'low';
      before?: string;
      after?: string;
    }>;
    summary: string;
  } {
    // Remove <think> blocks from response
    const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const suggestions: Array<{
      type: string;
      description: string;
      priority: 'high' | 'medium' | 'low';
    }> = [];

    // Simple parsing - look for numbered suggestions
    const lines = cleanedResponse.split('\n');
    let currentSuggestion: {
      type: string;
      description: string;
      priority: 'high' | 'medium' | 'low';
    } | null = null;

    for (const line of lines) {
      if (line.match(/^\d+\./)) {
        if (currentSuggestion) {
          suggestions.push(currentSuggestion);
        }
        currentSuggestion = {
          type: 'general',
          description: line.replace(/^\d+\./, '').trim(),
          priority: 'medium',
        };
      } else if (currentSuggestion && line.trim()) {
        currentSuggestion.description += ' ' + line.trim();
      }
    }

    if (currentSuggestion) {
      suggestions.push(currentSuggestion);
    }

    return {
      suggestions,
      summary: cleanedResponse.substring(0, 200),
    };
  }

  private parseEditSuggestions(response: string): {
    suggestions: Array<{
      description: string;
      before?: string;
      after: string;
      lineRange?: { start: number; end: number };
      confidence: 'high' | 'medium' | 'low';
      explanation: string;
    }>;
    summary: string;
  } {
    // First, remove any <think> blocks from the response
    let cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Aggressively strip common LLM conversational artifacts that corrupt JSON output
    // These are common patterns where LLMs add explanatory text before/after JSON
    const artifactPatterns = [
      /^(?:Here'?s?|Here is|Below is|Following is|The following|Sure,?|Okay,?|Certainly,?|Of course,?|I'll)[^{[]*(?={|\[)/gi,
      /^(?:Let me|I will|I can|Based on)[^{[]*(?={|\[)/gi,
      /(?:^|\n)(?:Note:?|Final(?:ly)?:?|Summary:?|Explanation:?)[^\n{]*\n?/gi,
      /\n(?:I hope|Let me know|Feel free|Happy to|Is there anything)[^\n]*$/gi,
      /\n(?:---+|===+)[^\n]*$/g,
    ];

    for (const pattern of artifactPatterns) {
      cleanedResponse = cleanedResponse.replace(pattern, '').trim();
    }

    // Strip trailing non-JSON text after the closing brace/bracket
    const lastBrace = cleanedResponse.lastIndexOf('}');
    const lastBracket = cleanedResponse.lastIndexOf(']');
    const lastClose = Math.max(lastBrace, lastBracket);
    if (lastClose > 0 && lastClose < cleanedResponse.length - 1) {
      const trailing = cleanedResponse.slice(lastClose + 1).trim();
      // Only strip if trailing text looks like conversational artifact, not valid JSON
      if (
        trailing &&
        !trailing.startsWith(',') &&
        !trailing.startsWith('}') &&
        !trailing.startsWith(']')
      ) {
        cleanedResponse = cleanedResponse.slice(0, lastClose + 1);
      }
    }

    // Preferred: robust JSON extraction (schema is requested in prompts).
    try {
      const parsed = extractJsonFromText(cleanedResponse);

      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const raw = Array.isArray(obj.suggestions) ? (obj.suggestions as unknown[]) : [];
        const suggestions = raw.map((s) => {
          const it = (s && typeof s === 'object' ? (s as any) : {}) as any;
          return {
            description: typeof it.description === 'string' ? it.description : '',
            before: it.before ? String(it.before) : undefined,
            after: typeof it.after === 'string' ? it.after : it.after ? String(it.after) : '',
            lineRange: it.lineRange as { start: number; end: number } | undefined,
            confidence: (['high', 'medium', 'low'].includes(String(it.confidence))
              ? it.confidence
              : 'medium') as 'high' | 'medium' | 'low',
            explanation: typeof it.explanation === 'string' ? it.explanation : '',
          };
        });

        const summary = typeof obj.summary === 'string' ? obj.summary : '';
        if (suggestions.length > 0 || summary) {
          return { suggestions, summary };
        }
      }
    } catch {
      // fall through to legacy strategies below
    }

    // Try multiple strategies to extract JSON from LLM response
    const jsonExtractionStrategies = [
      // Strategy 1: Direct JSON parse
      () => JSON.parse(cleanedResponse),
      // Strategy 2: Extract JSON from markdown code block
      () => {
        const match = cleanedResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (match) return JSON.parse(match[1]);
        throw new Error('No code block');
      },
      // Strategy 3: Find JSON object in the response
      () => {
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*"suggestions"[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
        throw new Error('No JSON object');
      },
      // Strategy 4: Clean up common LLM issues and retry
      () => {
        const cleaned = cleanedResponse
          .replace(/^[^{]*/, '') // Remove leading non-JSON text
          .replace(/[^}]*$/, '') // Remove trailing non-JSON text
          .replace(/,\s*}/g, '}') // Remove trailing commas
          .replace(/,\s*]/g, ']'); // Remove trailing commas in arrays
        return JSON.parse(cleaned);
      },
      // Strategy 5: Extract JSON after </think> tag (backup)
      () => {
        const afterThink = response.split(/<\/think>/i)[1];
        if (afterThink) {
          const jsonMatch = afterThink.match(/\{[\s\S]*\}/);
          if (jsonMatch) return JSON.parse(jsonMatch[0]);
        }
        throw new Error('No JSON after think block');
      },
    ];

    for (const strategy of jsonExtractionStrategies) {
      try {
        const parsed = strategy();
        return {
          suggestions: (parsed.suggestions || []).map((s: Record<string, unknown>) => ({
            description: String(s.description || ''),
            before: s.before ? String(s.before) : undefined,
            after: String(s.after || ''),
            lineRange: s.lineRange as { start: number; end: number } | undefined,
            confidence: (['high', 'medium', 'low'].includes(String(s.confidence))
              ? s.confidence
              : 'medium') as 'high' | 'medium' | 'low',
            explanation: String(s.explanation || ''),
          })),
          summary: String(parsed.summary || ''),
        };
      } catch {
        // Try next strategy
      }
    }

    // Final fallback: extract suggestions from plain text
    const suggestions: Array<{
      description: string;
      before?: string;
      after: string;
      confidence: 'high' | 'medium' | 'low';
      explanation: string;
    }> = [];

    // Look for numbered suggestions, bullet points, or "Suggestion:" patterns
    const lines = cleanedResponse.split('\n');
    let currentSuggestion: (typeof suggestions)[0] | null = null;
    let inCodeBlock = false;
    let codeBlockContent = '';
    let codeBlockType: 'before' | 'after' | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track code blocks
      if (line.includes('```')) {
        if (inCodeBlock) {
          // End of code block
          if (currentSuggestion && codeBlockType) {
            if (codeBlockType === 'before') {
              currentSuggestion.before = codeBlockContent.trim();
            } else if (codeBlockType === 'after') {
              currentSuggestion.after = codeBlockContent.trim();
            }
          }
          inCodeBlock = false;
          codeBlockContent = '';
          codeBlockType = null;
        } else {
          // Start of code block - check if previous line indicates before/after
          const prevLine = lines[i - 1]?.toLowerCase() || '';
          if (prevLine.includes('before') || prevLine.includes('original')) {
            codeBlockType = 'before';
          } else if (
            prevLine.includes('after') ||
            prevLine.includes('replacement') ||
            prevLine.includes('new')
          ) {
            codeBlockType = 'after';
          }
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      // Look for suggestion headers
      if (line.match(/^\d+\.|^-\s+|^suggestion|^change|^edit/i)) {
        if (currentSuggestion && currentSuggestion.description) {
          suggestions.push(currentSuggestion);
        }
        currentSuggestion = {
          description: line
            .replace(/^\d+\.|-\s*|suggestion:?\s*|change:?\s*|edit:?\s*/i, '')
            .trim(),
          after: '',
          confidence: 'medium',
          explanation: '',
        };
      } else if (currentSuggestion) {
        // Append to current suggestion's explanation
        if (line.trim() && !line.startsWith('```')) {
          currentSuggestion.explanation += ' ' + line.trim();
        }
      }
    }

    // Don't forget the last suggestion
    if (currentSuggestion && currentSuggestion.description) {
      suggestions.push(currentSuggestion);
    }

    // If no suggestions found, create one from the whole response
    if (suggestions.length === 0 && cleanedResponse.trim().length > 0) {
      const summaryMatch = cleanedResponse.match(/summary[:\s]*([^\n]+)/i);
      suggestions.push({
        description: 'Suggested change based on intent',
        after: cleanedResponse.substring(0, 500),
        confidence: 'low',
        explanation: summaryMatch ? summaryMatch[1] : 'Could not parse structured suggestions',
      });
    }

    return {
      suggestions,
      summary: cleanedResponse.substring(0, 200),
    };
  }

  private parseDraftFile(
    response: string,
    language: string
  ): {
    content: string;
    explanation: string;
    warnings: string[];
  } {
    // Remove <think> blocks from response
    const cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const warnings: string[] = [];
    let content = '';
    let explanation = '';

    // Try to extract code block for the file content
    const codeBlockMatch = cleanedResponse.match(
      new RegExp(`\`\`\`(?:${language})?\\s*\\n([\\s\\S]*?)\`\`\``, 'i')
    );

    if (codeBlockMatch) {
      content = codeBlockMatch[1].trim();
      // Explanation is the text outside the code block
      explanation = cleanedResponse.replace(codeBlockMatch[0], '').trim().substring(0, 500);
    } else {
      // No code block found - might be raw code or mixed content
      // Try to detect if the whole response is code
      const lines = cleanedResponse.split('\n');
      const codeLines: string[] = [];
      const textLines: string[] = [];

      for (const line of lines) {
        // Heuristic: if it looks like code, add to code
        if (
          line.match(
            /^(import|export|const|let|var|function|class|interface|type|def |from |#include|using )/
          )
        ) {
          codeLines.push(line);
        } else if (
          line.trim().startsWith('//') ||
          line.trim().startsWith('#') ||
          line.trim().startsWith('/*')
        ) {
          codeLines.push(line);
        } else if (codeLines.length > 0 && line.trim() !== '') {
          // Once we're in code, continue until we hit clear prose
          if (line.match(/^[A-Z][a-z].*[.!?]$/)) {
            textLines.push(line);
          } else {
            codeLines.push(line);
          }
        } else {
          textLines.push(line);
        }
      }

      content = codeLines.join('\n').trim();
      explanation = textLines.join('\n').trim().substring(0, 500);

      if (!content) {
        warnings.push('Could not extract code block from response');
        content = cleanedResponse; // Use cleaned response as fallback
      }
    }

    return { content, explanation, warnings };
  }

  // ============================================
  // Auto-Fix Tools: fix_linter, fix_syntax, implement_todos
  // ============================================

  /**
   * Fix linter issues using local LLM
   * Runs linter, parses issues, uses LLM to generate fixes, applies them
   */
  async fixLinter(
    root: string,
    options?: {
      difficulty?: FixDifficulty;
      files?: string[];
      dryRun?: boolean;
      maxFixes?: number;
    }
  ): Promise<FixLinterResult> {
    const resolvedRoot = this.config.resolveWorkspacePath(root);
    const difficulty = options?.difficulty ?? 'easy';
    const dryRun = options?.dryRun ?? false;
    const maxFixes = options?.maxFixes ?? 20;

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    // Run linter to get issues
    const linterResult = await this.executionTools.runLinter({
      files: options?.files,
      fix: false, // Don't auto-fix, we want to use LLM
    });

    // Parse linter output to extract issues
    const issues = this.parseLinterOutput(linterResult.stdout + linterResult.stderr);
    const totalIssuesFound = issues.length;

    if (issues.length === 0) {
      return {
        success: true,
        difficulty,
        totalIssuesFound: 0,
        issuesFixed: 0,
        issuesSkipped: 0,
        fixes: [],
        skippedIssues: [],
        filesModified: [],
        summary: 'No linter issues found.',
      };
    }

    // Classify issues by difficulty
    const classifiedIssues = await this.classifyLinterIssues(issues);

    // Filter issues by difficulty
    const issuesToFix = classifiedIssues.filter((issue) => {
      if (difficulty === 'all') return true;
      if (difficulty === 'easy') return issue.difficulty === 'easy';
      if (difficulty === 'medium')
        return issue.difficulty === 'easy' || issue.difficulty === 'medium';
      if (difficulty === 'hard') return true; // hard includes all
      return false;
    });

    const skippedIssues = classifiedIssues
      .filter((issue) => !issuesToFix.includes(issue))
      .map((issue) => ({
        file: issue.file,
        line: issue.line,
        rule: issue.rule,
        difficulty: issue.difficulty as FixDifficulty,
        reason: `Skipped: difficulty '${issue.difficulty}' is above requested level '${difficulty}'`,
      }));

    const fixes: AppliedFix[] = [];
    const backupPaths: string[] = [];
    const filesModified = new Set<string>();

    // Process issues in batches by file
    const issuesByFile = new Map<string, typeof issuesToFix>();
    for (const issue of issuesToFix.slice(0, maxFixes)) {
      if (!issuesByFile.has(issue.file)) {
        issuesByFile.set(issue.file, []);
      }
      issuesByFile.get(issue.file)!.push(issue);
    }

    for (const [file, fileIssues] of issuesByFile) {
      try {
        const filePath = join(resolvedRoot, file);
        if (!existsSync(filePath)) continue;

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        // Generate fixes using LLM
        const fixedContent = await this.generateLinterFixes(file, content, fileIssues);

        if (fixedContent && fixedContent !== content && !dryRun) {
          // Create backup - use getSafeBackupDir to prevent Windows drive duplication
          const backupDir = this.getSafeBackupDir(resolvedRoot);
          if (!existsSync(backupDir)) {
            mkdirSync(backupDir, { recursive: true });
          }
          const backupPath = join(backupDir, `${file.replace(/\//g, '_')}.${Date.now()}.bak`);
          const backupFileDir = dirname(backupPath);
          if (!existsSync(backupFileDir)) {
            mkdirSync(backupFileDir, { recursive: true });
          }
          writeFileSync(backupPath, content);
          backupPaths.push(backupPath);

          // Write fixed content
          writeFileSync(filePath, fixedContent);
          filesModified.add(file);
        }

        // Record fixes
        for (const issue of fileIssues) {
          const before = lines[issue.line - 1] || '';
          const fixedLines = fixedContent?.split('\n') || lines;
          const after = fixedLines[issue.line - 1] || before;

          fixes.push({
            file: issue.file,
            line: issue.line,
            rule: issue.rule,
            difficulty: issue.difficulty as FixDifficulty,
            description: issue.message,
            before,
            after,
          });
        }
      } catch {
        // Skip files we can't process
      }
    }

    return {
      success: true,
      difficulty,
      totalIssuesFound,
      issuesFixed: fixes.length,
      issuesSkipped: skippedIssues.length + (totalIssuesFound - issuesToFix.length),
      fixes,
      skippedIssues,
      filesModified: Array.from(filesModified),
      summary: `Fixed ${fixes.length} of ${totalIssuesFound} linter issues (difficulty: ${difficulty})${dryRun ? ' [DRY RUN]' : ''}`,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
    };
  }

  /**
   * Fix syntax errors using local LLM
   * Parses files for syntax errors, uses LLM to generate fixes
   */
  async fixSyntax(
    paths: string[],
    options?: {
      difficulty?: FixDifficulty;
      dryRun?: boolean;
      maxFixes?: number;
    }
  ): Promise<FixSyntaxResult> {
    const difficulty = options?.difficulty ?? 'easy';
    const dryRun = options?.dryRun ?? false;
    const maxFixes = options?.maxFixes ?? 10;

    const fixes: AppliedFix[] = [];
    const skippedErrors: FixSyntaxResult['skippedErrors'] = [];
    const backupPaths: string[] = [];
    const filesModified = new Set<string>();
    let totalErrorsFound = 0;

    for (const path of paths.slice(0, maxFixes)) {
      const resolvedPath = this.config.resolveWorkspacePath(path);

      if (!this.config.isPathAllowed(resolvedPath)) {
        continue;
      }

      if (!existsSync(resolvedPath)) {
        continue;
      }

      try {
        const content = readFileSync(resolvedPath, 'utf-8');
        const ext = extname(resolvedPath).toLowerCase();
        const language = this.getLanguageFromExtension(ext);

        // Validate syntax to find errors
        const syntaxErrors = this.detectSyntaxErrors(content, language);
        totalErrorsFound += syntaxErrors.length;

        if (syntaxErrors.length === 0) continue;

        // Classify errors by difficulty
        const classifiedErrors = await this.classifySyntaxErrors(syntaxErrors, language);

        // Filter by difficulty
        const errorsToFix = classifiedErrors.filter((err) => {
          if (difficulty === 'all') return true;
          if (difficulty === 'easy') return err.difficulty === 'easy';
          if (difficulty === 'medium')
            return err.difficulty === 'easy' || err.difficulty === 'medium';
          return true;
        });

        const skipped = classifiedErrors
          .filter((err) => !errorsToFix.includes(err))
          .map((err) => ({
            file: path,
            line: err.line,
            message: err.message,
            difficulty: err.difficulty as FixDifficulty,
            reason: `Skipped: difficulty '${err.difficulty}' is above requested level '${difficulty}'`,
          }));
        skippedErrors.push(...skipped);

        if (errorsToFix.length === 0) continue;

        // Generate fix using LLM
        const fixedContent = await this.generateSyntaxFixes(path, content, errorsToFix, language);

        if (fixedContent && fixedContent !== content) {
          const lines = content.split('\n');

          for (const err of errorsToFix) {
            fixes.push({
              file: path,
              line: err.line,
              rule: 'syntax',
              difficulty: err.difficulty as FixDifficulty,
              description: err.message,
              before: lines[err.line - 1] || '',
              after: fixedContent.split('\n')[err.line - 1] || '',
            });
          }

          if (!dryRun) {
            // Create backup - use getSafeBackupDir to prevent Windows drive duplication
            const backupDir = this.getSafeBackupDir(dirname(resolvedPath));
            if (!existsSync(backupDir)) {
              mkdirSync(backupDir, { recursive: true });
            }
            const backupPath = join(backupDir, `${path.replace(/\//g, '_')}.${Date.now()}.bak`);
            writeFileSync(backupPath, content);
            backupPaths.push(backupPath);

            writeFileSync(resolvedPath, fixedContent);
            filesModified.add(path);
          }
        }
      } catch {
        // Skip files we can't process
      }
    }

    return {
      success: true,
      difficulty,
      totalErrorsFound,
      errorsFixed: fixes.length,
      errorsSkipped: skippedErrors.length,
      fixes,
      skippedErrors,
      filesModified: Array.from(filesModified),
      summary: `Fixed ${fixes.length} of ${totalErrorsFound} syntax errors (difficulty: ${difficulty})${dryRun ? ' [DRY RUN]' : ''}`,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
    };
  }

  /**
   * Implement TODOs using local LLM
   * Finds TODOs in codebase, uses LLM to generate implementations
   */
  async implementTodos(
    root: string,
    options?: {
      difficulty?: FixDifficulty;
      todoTypes?: Array<
        'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE' | 'BUG' | 'OPTIMIZE' | 'REFACTOR'
      >;
      maxTodos?: number;
      dryRun?: boolean;
      files?: string[];
    }
  ): Promise<ImplementTodosResult> {
    const resolvedRoot = this.config.resolveWorkspacePath(root);
    const difficulty = options?.difficulty ?? 'easy';
    const dryRun = options?.dryRun ?? false;
    const maxTodos = options?.maxTodos ?? 5;
    const todoTypes = options?.todoTypes ?? ['TODO', 'FIXME'];

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    // Find all TODOs in the codebase
    const maxScanTodos = Math.min(200, Math.max(20, maxTodos * 20));
    const todos = this.findTodos(resolvedRoot, todoTypes, options?.files, maxScanTodos);
    const totalTodosFound = todos.length;

    if (todos.length === 0) {
      return {
        success: true,
        difficulty,
        totalTodosFound: 0,
        todosImplemented: 0,
        todosSkipped: 0,
        implementations: [],
        skippedTodos: [],
        filesModified: [],
        summary: 'No TODOs found matching the specified types.',
      };
    }

    // Classify TODOs by difficulty using LLM
    const classifiedTodos = await this.classifyTodos(todos);

    // Filter by difficulty
    const todosToImplement = classifiedTodos.filter((todo) => {
      if (difficulty === 'all') return true;
      if (difficulty === 'easy') return todo.difficulty === 'easy';
      if (difficulty === 'medium')
        return todo.difficulty === 'easy' || todo.difficulty === 'medium';
      return true;
    });

    const skippedTodos = classifiedTodos
      .filter((todo) => !todosToImplement.includes(todo))
      .map((todo) => ({
        file: todo.file,
        line: todo.line,
        todoType: todo.type,
        content: todo.content,
        difficulty: todo.difficulty as FixDifficulty,
        reason: `Skipped: difficulty '${todo.difficulty}' is above requested level '${difficulty}'`,
      }));

    const implementations: ImplementTodosResult['implementations'] = [];
    const backupPaths: string[] = [];
    const filesModified = new Set<string>();
    const maxFileBytes = this.config.getConfig().policy.maxFileBytes;

    // Implement TODOs (limit to maxTodos)
    for (const todo of todosToImplement.slice(0, maxTodos)) {
      try {
        const filePath = join(resolvedRoot, todo.file);
        if (!existsSync(filePath)) continue;

        const size = statSync(filePath).size;
        if (size > maxFileBytes) {
          skippedTodos.push({
            file: todo.file,
            line: todo.line,
            todoType: todo.type,
            content: todo.content,
            difficulty: todo.difficulty as FixDifficulty,
            reason: `Skipped: file too large (${size} bytes > ${maxFileBytes} maxFileBytes policy)`,
          });
          continue;
        }

        const content = readFileSync(filePath, 'utf-8');
        const language = this.getLanguageFromExtension(extname(filePath).toLowerCase());

        // Generate implementation using LLM
        const result = await this.generateTodoImplementation(todo, content, language);

        if (result.implementation && result.implementation !== content) {
          implementations.push({
            file: todo.file,
            line: todo.line,
            todoType: todo.type as ImplementTodosResult['implementations'][0]['todoType'],
            originalTodo: todo.content,
            difficulty: todo.difficulty as FixDifficulty,
            description: result.description,
            codeAdded: result.codeAdded,
            linesAdded: result.linesAdded,
          });

          if (!dryRun) {
            // Create backup - use getSafeBackupDir to prevent Windows drive duplication
            const backupDir = this.getSafeBackupDir(resolvedRoot);
            if (!existsSync(backupDir)) {
              mkdirSync(backupDir, { recursive: true });
            }
            const backupPath = join(
              backupDir,
              `${todo.file.replace(/\//g, '_')}.${Date.now()}.bak`
            );
            const backupFileDir = dirname(backupPath);
            if (!existsSync(backupFileDir)) {
              mkdirSync(backupFileDir, { recursive: true });
            }
            writeFileSync(backupPath, content);
            backupPaths.push(backupPath);

            writeFileSync(filePath, result.implementation);
            filesModified.add(todo.file);
          }
        }
      } catch (error) {
        skippedTodos.push({
          file: todo.file,
          line: todo.line,
          todoType: todo.type,
          content: todo.content,
          difficulty: todo.difficulty as FixDifficulty,
          reason: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }

    // Add remaining todos to skipped
    for (const todo of todosToImplement.slice(maxTodos)) {
      skippedTodos.push({
        file: todo.file,
        line: todo.line,
        todoType: todo.type,
        content: todo.content,
        difficulty: todo.difficulty as FixDifficulty,
        reason: `Skipped: exceeded max TODOs limit (${maxTodos})`,
      });
    }

    return {
      success: true,
      difficulty,
      totalTodosFound,
      todosImplemented: implementations.length,
      todosSkipped: skippedTodos.length,
      implementations,
      skippedTodos,
      filesModified: Array.from(filesModified),
      summary: `Implemented ${implementations.length} of ${totalTodosFound} TODOs (difficulty: ${difficulty})${dryRun ? ' [DRY RUN]' : ''}`,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
    };
  }

  // ============================================
  // Helper Methods for Auto-Fix Tools
  // ============================================

  private parseLinterOutput(
    output: string
  ): Array<{ file: string; line: number; column: number; rule?: string; message: string }> {
    const issues: Array<{
      file: string;
      line: number;
      column: number;
      rule?: string;
      message: string;
    }> = [];

    // ESLint format: /path/to/file.ts:10:5: error Message (rule-name)
    const eslintPattern = /^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)(?:\s+\(([^)]+)\))?$/gm;
    let match;
    while ((match = eslintPattern.exec(output)) !== null) {
      issues.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        message: match[5],
        rule: match[6],
      });
    }

    // Also try JSON format
    try {
      const jsonMatch = output.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const fileResult of parsed) {
          if (fileResult.messages) {
            for (const msg of fileResult.messages) {
              issues.push({
                file: fileResult.filePath || 'unknown',
                line: msg.line || 1,
                column: msg.column || 1,
                message: msg.message || '',
                rule: msg.ruleId,
              });
            }
          }
        }
      }
    } catch {
      // Not JSON format
    }

    return issues;
  }

  private async classifyLinterIssues(
    issues: Array<{ file: string; line: number; column: number; rule?: string; message: string }>
  ): Promise<
    Array<{
      file: string;
      line: number;
      column: number;
      rule?: string;
      message: string;
      difficulty: string;
    }>
  > {
    // Classify issues by rule patterns
    // Easy: formatting, missing semicolons, unused variables
    // Medium: missing type annotations, deprecated APIs
    // Hard: complex refactoring, security issues, architectural changes
    const easyRules = [
      'semi',
      'quotes',
      'indent',
      'comma-dangle',
      'no-trailing-spaces',
      'eol-last',
      'no-multiple-empty-lines',
      'space-before-function-paren',
      'object-curly-spacing',
      'array-bracket-spacing',
      'no-extra-semi',
      'no-unused-vars',
      '@typescript-eslint/no-unused-vars',
      'prefer-const',
      'no-var',
    ];

    const mediumRules = [
      '@typescript-eslint/explicit-function-return-type',
      '@typescript-eslint/no-explicit-any',
      'no-console',
      'prefer-arrow-callback',
      'arrow-body-style',
      'prefer-template',
      'no-param-reassign',
    ];

    return issues.map((issue) => {
      let difficulty = 'hard';
      const rule = issue.rule?.toLowerCase() || '';
      const message = issue.message.toLowerCase();

      if (
        easyRules.some((r) => rule.includes(r.toLowerCase())) ||
        message.includes('semicolon') ||
        message.includes('spacing') ||
        message.includes('indent') ||
        message.includes('quote')
      ) {
        difficulty = 'easy';
      } else if (
        mediumRules.some((r) => rule.includes(r.toLowerCase())) ||
        message.includes('type') ||
        message.includes('deprecated')
      ) {
        difficulty = 'medium';
      }

      return { ...issue, difficulty };
    });
  }

  private async generateLinterFixes(
    file: string,
    content: string,
    issues: Array<{
      file: string;
      line: number;
      column: number;
      rule?: string;
      message: string;
      difficulty: string;
    }>
  ): Promise<string | null> {
    const language = this.getLanguageFromExtension(extname(file).toLowerCase());
    const issuesList = issues
      .map((i) => `Line ${i.line}: ${i.message}${i.rule ? ` (${i.rule})` : ''}`)
      .join('\n');

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: `You are an expert ${language} developer. Fix the following linter issues in the code.
Output ONLY the complete fixed code, no explanations. The code should be ready to save directly.
Do not add any markdown code blocks or other formatting.`,
            },
            {
              role: 'user',
              content: `Fix these linter issues:\n${issuesList}\n\nOriginal code:\n${content}`,
            },
          ],
        },
        'local'
      );

      // Extract code from response (remove any markdown if present)
      let fixedCode = response.message.content;
      fixedCode = fixedCode.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      // Remove markdown code blocks if present
      const codeBlockMatch = fixedCode.match(/```(?:\w+)?\n?([\s\S]*?)```/);
      if (codeBlockMatch) {
        fixedCode = codeBlockMatch[1].trim();
      }

      return fixedCode;
    } catch {
      return null;
    }
  }

  private detectSyntaxErrors(
    content: string,
    language: string
  ): Array<{ line: number; column: number; message: string }> {
    const errors: Array<{ line: number; column: number; message: string }> = [];
    const lines = content.split('\n');

    // Basic syntax error detection patterns
    if (language === 'typescript' || language === 'javascript') {
      let braceCount = 0;
      let bracketCount = 0;
      let parenCount = 0;
      let inString = false;
      let stringChar = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (let j = 0; j < line.length; j++) {
          const char = line[j];
          const prevChar = j > 0 ? line[j - 1] : '';

          // Handle strings
          if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
            if (!inString) {
              inString = true;
              stringChar = char;
            } else if (char === stringChar) {
              inString = false;
            }
            continue;
          }

          if (inString) continue;

          // Count brackets
          if (char === '{') braceCount++;
          else if (char === '}') braceCount--;
          else if (char === '[') bracketCount++;
          else if (char === ']') bracketCount--;
          else if (char === '(') parenCount++;
          else if (char === ')') parenCount--;

          // Check for mismatches
          if (braceCount < 0) {
            errors.push({ line: i + 1, column: j + 1, message: 'Unexpected closing brace' });
            braceCount = 0;
          }
          if (bracketCount < 0) {
            errors.push({ line: i + 1, column: j + 1, message: 'Unexpected closing bracket' });
            bracketCount = 0;
          }
          if (parenCount < 0) {
            errors.push({ line: i + 1, column: j + 1, message: 'Unexpected closing parenthesis' });
            parenCount = 0;
          }
        }
      }

      // Check for unclosed
      if (braceCount > 0) errors.push({ line: lines.length, column: 1, message: 'Unclosed brace' });
      if (bracketCount > 0)
        errors.push({ line: lines.length, column: 1, message: 'Unclosed bracket' });
      if (parenCount > 0)
        errors.push({ line: lines.length, column: 1, message: 'Unclosed parenthesis' });
    }

    return errors;
  }

  private async classifySyntaxErrors(
    errors: Array<{ line: number; column: number; message: string }>,
    _language: string
  ): Promise<Array<{ line: number; column: number; message: string; difficulty: string }>> {
    // Classify by message patterns
    return errors.map((err) => {
      const message = err.message.toLowerCase();
      let difficulty = 'medium';

      if (
        message.includes('semicolon') ||
        message.includes('unexpected') ||
        message.includes('missing comma')
      ) {
        difficulty = 'easy';
      } else if (
        message.includes('unclosed') ||
        message.includes('expected') ||
        message.includes('unexpected token')
      ) {
        difficulty = 'medium';
      } else if (
        message.includes('type') ||
        message.includes('declaration') ||
        message.includes('cannot')
      ) {
        difficulty = 'hard';
      }

      return { ...err, difficulty };
    });
  }

  private async generateSyntaxFixes(
    _path: string,
    content: string,
    errors: Array<{ line: number; column: number; message: string; difficulty: string }>,
    language: string
  ): Promise<string | null> {
    const errorsList = errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n');

    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: `You are an expert ${language} developer. Fix the following syntax errors in the code.
Output ONLY the complete fixed code, no explanations. The code should be ready to save directly.
Do not add any markdown code blocks or other formatting.`,
            },
            {
              role: 'user',
              content: `Fix these syntax errors:\n${errorsList}\n\nOriginal code:\n${content}`,
            },
          ],
        },
        'local'
      );

      let fixedCode = response.message.content;
      fixedCode = fixedCode.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      const codeBlockMatch = fixedCode.match(/```(?:\w+)?\n?([\s\S]*?)```/);
      if (codeBlockMatch) {
        fixedCode = codeBlockMatch[1].trim();
      }

      return fixedCode;
    } catch {
      return null;
    }
  }

  private findTodos(
    root: string,
    todoTypes: string[],
    specificFiles?: string[],
    maxResults?: number
  ): Array<{ file: string; line: number; type: string; content: string; context: string }> {
    const todos: Array<{
      file: string;
      line: number;
      type: string;
      content: string;
      context: string;
    }> = [];

    const limit = Math.max(1, maxResults ?? 200);
    const maxFileBytes = this.config.getConfig().policy.maxFileBytes;

    // Only implement TODOs inside source-like files by default.
    // This prevents attempting to "implement" TODOs inside logs, large reports, or generated artifacts.
    const allowedExts = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.java',
      '.c',
      '.cpp',
      '.cs',
      '.go',
      '.rs',
      '.rb',
      '.php',
      '.swift',
      '.kt',
      '.scala',
      '.sql',
      '.sh',
      '.ps1',
    ]);

    // Keep this in sync with other repo-scanning tools to avoid huge slowdowns from artifacts/logs.
    const skipDirs = new Set([
      'node_modules',
      'dist',
      'dist_package',
      'build',
      'out',
      'output',
      'artifacts',
      'logs',
      'log',
      'tmp',
      'temp',
      'test-results',
      'phase3_test_output',
      'stress_test',
      'evidence',
      'repo',
      '__pycache__',
      'venv',
      '.venv',
      '.git',
      '.mypy_cache',
      '.pytest_cache',
      'coverage',
      '.next',
      '.nuxt',
      '.tox',
      'vendor',
      'site-packages',
      'lib64',
      '.eggs',
    ]);

    const typesPattern = todoTypes.join('|');
    const todoRegex = new RegExp(`\\b(${typesPattern})[:\\s]+(.+?)(?:\\n|$)`, 'gi');

    const scanDir = (dir: string) => {
      if (todos.length >= limit) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (todos.length >= limit) break;
          if (entry.name.startsWith('.')) continue;
          if (skipDirs.has(entry.name)) continue;

          const fullPath = join(dir, entry.name);

          if (!this.config.isPathAllowed(fullPath)) continue;

          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const relativePath = relative(root, fullPath);
            const ext = extname(fullPath).toLowerCase();
            if (!allowedExts.has(ext)) continue;

            // Filter by specific files if provided
            if (specificFiles && !specificFiles.some((f) => relativePath.includes(f))) {
              continue;
            }

            try {
              const size = statSync(fullPath).size;
              if (size > maxFileBytes) continue;
              const content = readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');

              for (let i = 0; i < lines.length; i++) {
                if (todos.length >= limit) break;
                const line = lines[i];
                let match;
                todoRegex.lastIndex = 0;

                while ((match = todoRegex.exec(line)) !== null) {
                  if (todos.length >= limit) break;
                  const context = lines
                    .slice(Math.max(0, i - 2), Math.min(lines.length, i + 3))
                    .join('\n');

                  todos.push({
                    file: relativePath,
                    line: i + 1,
                    type: match[1].toUpperCase(),
                    content: match[2].trim(),
                    context,
                  });
                }
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    scanDir(root);
    return todos;
  }

  private async classifyTodos(
    todos: Array<{ file: string; line: number; type: string; content: string; context: string }>
  ): Promise<
    Array<{
      file: string;
      line: number;
      type: string;
      content: string;
      context: string;
      difficulty: string;
    }>
  > {
    // Classify based on keywords and complexity indicators
    return todos.map((todo) => {
      const content = todo.content.toLowerCase();
      let difficulty = 'medium';

      // Easy: simple tasks like adding comments, logging, small fixes
      if (
        content.includes('add comment') ||
        content.includes('add logging') ||
        content.includes('rename') ||
        content.includes('remove unused') ||
        content.includes('fix typo') ||
        content.includes('update message') ||
        content.length < 30
      ) {
        difficulty = 'easy';
      }
      // Hard: complex refactoring, architecture changes, major features
      else if (
        content.includes('refactor') ||
        content.includes('rewrite') ||
        content.includes('implement') ||
        content.includes('architecture') ||
        content.includes('performance') ||
        content.includes('security') ||
        content.includes('feature') ||
        todo.type === 'REFACTOR' ||
        todo.type === 'OPTIMIZE'
      ) {
        difficulty = 'hard';
      }

      return { ...todo, difficulty };
    });
  }

  private async generateTodoImplementation(
    todo: { file: string; line: number; type: string; content: string; context: string },
    fileContent: string,
    language: string
  ): Promise<{
    implementation: string;
    description: string;
    codeAdded: string;
    linesAdded: number;
  }> {
    const timeoutRaw = process.env.TODOS_IMPLEMENT_LLM_TIMEOUT_MS;
    const retriesRaw = process.env.TODOS_IMPLEMENT_LLM_RETRIES;
    const timeoutMs = timeoutRaw ? Math.max(1000, Number.parseInt(timeoutRaw, 10)) : 10000;
    const maxRetries = retriesRaw ? Math.max(0, Number.parseInt(retriesRaw, 10)) : 0;

    // IMPORTANT: LM Studio adapter has its own retry loop; ensure we abort at the overall timeout
    // to prevent multi-attempt hangs inside a single tool call.
    const controller = new AbortController();
    // Abort slightly before the adapter's per-attempt timeout to ensure the adapter sees `signal.aborted`
    // and does not proceed with additional internal retries.
    const abortAfterMs = Math.max(0, timeoutMs - 25);
    const timer = setTimeout(() => controller.abort(), abortAfterMs);
    try {
      const response = await this.llmChat.chat(
        {
          messages: [
            {
              role: 'system',
              content: `You are an expert ${language} developer. Implement the TODO comment in the code.
Replace or complement the TODO with actual working code.
Output the complete updated file content, not just the changed part.
Do not add any markdown code blocks or other formatting.
Keep the implementation minimal and focused on what the TODO asks for.`,
            },
            {
              role: 'user',
              content: `Implement this ${todo.type}:\n"${todo.content}"\n\nContext around line ${todo.line}:\n${todo.context}\n\nFull file:\n${fileContent}`,
            },
          ],
        },
        'local',
        { timeoutMs, maxRetries, signal: controller.signal }
      );

      let implementation = response.message.content;
      implementation = implementation.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      const codeBlockMatch = implementation.match(/```(?:\w+)?\n?([\s\S]*?)```/);
      if (codeBlockMatch) {
        implementation = codeBlockMatch[1].trim();
      }

      // Calculate lines added
      const originalLines = fileContent.split('\n').length;
      const newLines = implementation.split('\n').length;
      const linesAdded = Math.max(0, newLines - originalLines);

      // Extract the added code (difference)
      const originalLineSet = new Set(fileContent.split('\n'));
      const addedLines = implementation
        .split('\n')
        .filter((line) => !originalLineSet.has(line))
        .join('\n');

      return {
        implementation,
        description: `Implemented ${todo.type}: ${todo.content}`,
        codeAdded: addedLines || 'Code modified in-place',
        linesAdded,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================
  // Plan V6: AGENTS.md Generation
  // ============================================

  /**
   * Generate AGENTS.md file from project structure and configuration.
   * Follows the https://agents.md/ specification used by 60k+ GitHub repos.
   *
   * This tool analyzes package.json, README.md, test configs, lint configs,
   * and generates a structured AGENTS.md following the industry standard format.
   *
   * @param root - Project root directory
   * @param options - Generation options
   */
  async generateAgentsMd(
    root: string,
    options?: {
      outputPath?: string; // Default: .mcp-local-llm/AGENTS.md
      overwrite?: boolean; // Whether to overwrite existing file
      sections?: string[]; // Which sections to include
      useLlm?: boolean; // Whether to use LLM for enhancement (default: true)
    }
  ): Promise<GenerateAgentsMdResult> {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    const outputSubdir = '.mcp-local-llm';
    const outputFile = options?.outputPath || join(outputSubdir, 'AGENTS.md');
    const outputPath = join(resolvedRoot, outputFile);
    const existedBefore = existsSync(outputPath);

    if (existedBefore && !options?.overwrite) {
      // Read existing content and return it
      const content = readFileSync(outputPath, 'utf-8');
      return {
        success: true,
        path: outputPath,
        content,
        sections: this.parseAgentsMdSections(content),
        existedBefore: true,
        warnings: ['File already exists. Use overwrite: true to regenerate.'],
      };
    }

    const warnings: string[] = [];

    // Gather project information
    const projectInfo = await this.gatherProjectInfo(resolvedRoot);

    // Build AGENTS.md content
    let content = this.buildAgentsMdContent(projectInfo, warnings);

    // Optionally enhance with LLM
    if (options?.useLlm !== false && projectInfo.readme) {
      try {
        content = await this.enhanceAgentsMdWithLlm(content, projectInfo);
      } catch (error) {
        warnings.push(
          `LLM enhancement failed: ${error instanceof Error ? error.message : 'Unknown error'}. Using static generation.`
        );
      }
    }

    // Ensure output directory exists
    const outputDir = dirname(outputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Write the file
    writeFileSync(outputPath, content, 'utf-8');

    return {
      success: true,
      path: outputPath,
      content,
      sections: this.parseAgentsMdSections(content),
      existedBefore,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  /**
   * Gather project information from various config files
   */
  private async gatherProjectInfo(root: string): Promise<ProjectInfo> {
    const info: ProjectInfo = {
      name: basename(root),
      root,
      languages: [],
      frameworks: [],
      testCommand: null,
      buildCommand: null,
      lintCommand: null,
      packageManager: null,
      readme: null,
      hasTypeScript: false,
      hasEslint: false,
      hasPrettier: false,
      excludeDirs: [],
    };

    // Check package.json
    const packageJsonPath = join(root, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        info.name = pkg.name || info.name;
        info.languages.push('JavaScript');
        info.packageManager = existsSync(join(root, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(join(root, 'yarn.lock'))
            ? 'yarn'
            : existsSync(join(root, 'bun.lockb'))
              ? 'bun'
              : 'npm';

        // Extract scripts
        if (pkg.scripts) {
          info.testCommand = pkg.scripts.test ? `${info.packageManager} test` : null;
          info.buildCommand = pkg.scripts.build ? `${info.packageManager} run build` : null;
          info.lintCommand = pkg.scripts.lint ? `${info.packageManager} run lint` : null;
        }

        // Detect frameworks from dependencies
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.typescript) {
          info.hasTypeScript = true;
          info.languages = ['TypeScript', ...info.languages.filter((l) => l !== 'JavaScript')];
        }
        if (allDeps.eslint) info.hasEslint = true;
        if (allDeps.prettier) info.hasPrettier = true;
        if (allDeps.react || allDeps['react-dom']) info.frameworks.push('React');
        if (allDeps.vue) info.frameworks.push('Vue');
        if (allDeps.next) info.frameworks.push('Next.js');
        if (allDeps.express) info.frameworks.push('Express');
        if (allDeps.vitest) info.frameworks.push('Vitest');
        if (allDeps.jest) info.frameworks.push('Jest');
        if (allDeps.mocha) info.frameworks.push('Mocha');
      } catch {
        // Ignore parse errors
      }
    }

    // Check for Python
    const requirementsTxt = join(root, 'requirements.txt');
    const pyprojectToml = join(root, 'pyproject.toml');
    const setupPy = join(root, 'setup.py');
    if (existsSync(requirementsTxt) || existsSync(pyprojectToml) || existsSync(setupPy)) {
      info.languages.push('Python');
      info.excludeDirs.push('venv', '.venv', '__pycache__');
      if (!info.testCommand) info.testCommand = 'pytest';
    }

    // Check for Go
    const goMod = join(root, 'go.mod');
    if (existsSync(goMod)) {
      info.languages.push('Go');
      if (!info.testCommand) info.testCommand = 'go test ./...';
      if (!info.buildCommand) info.buildCommand = 'go build';
    }

    // Check for Rust
    const cargoToml = join(root, 'Cargo.toml');
    if (existsSync(cargoToml)) {
      info.languages.push('Rust');
      info.excludeDirs.push('target');
      if (!info.testCommand) info.testCommand = 'cargo test';
      if (!info.buildCommand) info.buildCommand = 'cargo build';
    }

    // Check for Java/Kotlin
    const pomXml = join(root, 'pom.xml');
    const buildGradle = join(root, 'build.gradle');
    const buildGradleKts = join(root, 'build.gradle.kts');
    if (existsSync(pomXml)) {
      info.languages.push('Java');
      if (!info.testCommand) info.testCommand = 'mvn test';
      if (!info.buildCommand) info.buildCommand = 'mvn package';
    }
    if (existsSync(buildGradle) || existsSync(buildGradleKts)) {
      if (!info.languages.includes('Java')) info.languages.push('Java');
      if (existsSync(buildGradleKts)) info.languages.push('Kotlin');
      if (!info.testCommand) info.testCommand = './gradlew test';
      if (!info.buildCommand) info.buildCommand = './gradlew build';
    }

    // Common exclude dirs
    info.excludeDirs.push('node_modules', '.git', 'dist', 'build', 'coverage');

    // Read README
    for (const readmeName of ['README.md', 'readme.md', 'Readme.md']) {
      const readmePath = join(root, readmeName);
      if (existsSync(readmePath)) {
        info.readme = readFileSync(readmePath, 'utf-8').substring(0, 5000);
        break;
      }
    }

    return info;
  }

  /**
   * Build AGENTS.md content from project info
   */
  private buildAgentsMdContent(info: ProjectInfo, warnings: string[]): string {
    const sections: string[] = [];

    // Header
    sections.push(`# AGENTS.md - ${info.name}\n`);
    sections.push(`> Auto-generated by MCP Local LLM. See https://agents.md/ for specification.\n`);

    // Project Overview
    sections.push(`## Project Overview\n`);
    sections.push(`- **Name**: ${info.name}`);
    if (info.languages.length > 0) {
      sections.push(`- **Languages**: ${info.languages.join(', ')}`);
    }
    if (info.frameworks.length > 0) {
      sections.push(`- **Frameworks**: ${info.frameworks.join(', ')}`);
    }
    if (info.packageManager) {
      sections.push(`- **Package Manager**: ${info.packageManager}`);
    }
    sections.push('');

    // Setup Instructions
    sections.push(`## Setup\n`);
    if (info.packageManager) {
      sections.push(`\`\`\`bash`);
      sections.push(`${info.packageManager} install`);
      sections.push(`\`\`\``);
    } else if (info.languages.includes('Python')) {
      sections.push(`\`\`\`bash`);
      sections.push(`python -m venv venv`);
      sections.push(`source venv/bin/activate  # or venv\\Scripts\\activate on Windows`);
      sections.push(`pip install -r requirements.txt`);
      sections.push(`\`\`\``);
    } else if (info.languages.includes('Go')) {
      sections.push(`\`\`\`bash`);
      sections.push(`go mod download`);
      sections.push(`\`\`\``);
    } else if (info.languages.includes('Rust')) {
      sections.push(`\`\`\`bash`);
      sections.push(`cargo build`);
      sections.push(`\`\`\``);
    } else {
      sections.push(`_Setup instructions not auto-detected. Please add manually._`);
      warnings.push('Setup instructions could not be auto-detected');
    }
    sections.push('');

    // Build & Test
    sections.push(`## Build & Test\n`);
    if (info.buildCommand) {
      sections.push(`### Build`);
      sections.push(`\`\`\`bash`);
      sections.push(info.buildCommand);
      sections.push(`\`\`\``);
      sections.push('');
    }
    if (info.testCommand) {
      sections.push(`### Test`);
      sections.push(`\`\`\`bash`);
      sections.push(info.testCommand);
      sections.push(`\`\`\``);
      sections.push('');
      sections.push(`**Important**: Always run \`${info.testCommand}\` after making changes.`);
    } else {
      sections.push(`_Test command not detected. Please add manually._`);
      warnings.push('Test command could not be auto-detected');
    }
    sections.push('');

    // Code Style
    sections.push(`## Code Style\n`);
    const styleNotes: string[] = [];
    if (info.hasTypeScript) {
      styleNotes.push('- Use TypeScript strict mode');
      styleNotes.push('- Prefer `const` over `let`, avoid `var`');
    }
    if (info.hasEslint) {
      styleNotes.push(
        `- Follow ESLint rules (run \`${info.lintCommand || 'npm run lint'}\` to check)`
      );
    }
    if (info.hasPrettier) {
      styleNotes.push('- Code is auto-formatted with Prettier');
    }
    if (info.languages.includes('Python')) {
      styleNotes.push('- Follow PEP 8 style guide');
      styleNotes.push('- Use type hints where applicable');
    }
    if (styleNotes.length > 0) {
      sections.push(styleNotes.join('\n'));
    } else {
      sections.push(`_Code style guidelines not detected. Please add manually._`);
    }
    sections.push('');

    // Excluded Directories
    if (info.excludeDirs.length > 0) {
      sections.push(`## Excluded Directories\n`);
      sections.push(`The following directories should be excluded from searches and analysis:\n`);
      sections.push(info.excludeDirs.map((d) => `- \`${d}/\``).join('\n'));
      sections.push('');
    }

    // Agent Guidelines
    sections.push(`## Agent Guidelines\n`);
    sections.push(`When working on this codebase:\n`);
    sections.push(`1. **Read before writing**: Understand existing patterns before making changes`);
    sections.push(`2. **Test your changes**: Run tests after any modification`);
    sections.push(`3. **Follow conventions**: Match existing code style and naming patterns`);
    sections.push(`4. **Minimize scope**: Make focused changes; avoid unrelated modifications`);
    if (info.excludeDirs.length > 0) {
      sections.push(
        `5. **Exclude noise**: Skip these directories: ${info.excludeDirs.slice(0, 5).join(', ')}`
      );
    }
    sections.push('');

    return sections.join('\n');
  }

  /**
   * Enhance AGENTS.md content using LLM
   */
  private async enhanceAgentsMdWithLlm(baseContent: string, info: ProjectInfo): Promise<string> {
    const prompt = `You are enhancing an AGENTS.md file for a software project. The AGENTS.md format is an industry standard used by AI coding assistants like GitHub Copilot, Cursor, and others.

Current auto-generated content:
\`\`\`markdown
${baseContent}
\`\`\`

${info.readme ? `Project README (for context):\n${info.readme.substring(0, 2000)}\n` : ''}

Please enhance the AGENTS.md by:
1. Adding any project-specific guidelines inferred from the README
2. Improving the Setup section if you can detect additional steps
3. Adding a "Common Tasks" section with typical development workflows
4. Making the Agent Guidelines more specific to this project

Rules:
- Keep the same section structure
- Be concise - agents have limited context windows
- Focus on actionable instructions
- Do not invent features not mentioned in the project info
- Output ONLY the complete enhanced markdown, no explanations`;

    const response = await this.llmChat.chat(
      {
        messages: [
          {
            role: 'system',
            content: 'You are an expert at creating AGENTS.md files for AI coding assistants.',
          },
          { role: 'user', content: prompt },
        ],
      },
      'local'
    );

    let enhanced = response.message.content;
    enhanced = this.redaction.stripThinkTags(enhanced);

    // Remove markdown code blocks if LLM wrapped the output
    const codeBlockMatch = enhanced.match(/```(?:markdown)?\s*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      enhanced = codeBlockMatch[1].trim();
    }

    return enhanced;
  }

  /**
   * Parse sections from existing AGENTS.md content
   */
  private parseAgentsMdSections(content: string): Array<{ name: string; present: boolean }> {
    const expectedSections = [
      'Project Overview',
      'Setup',
      'Build & Test',
      'Code Style',
      'Excluded Directories',
      'Agent Guidelines',
      'Common Tasks',
    ];

    return expectedSections.map((name) => ({
      name,
      present:
        content.toLowerCase().includes(`## ${name.toLowerCase()}`) ||
        content.toLowerCase().includes(`# ${name.toLowerCase()}`),
    }));
  }
}

/**
 * Internal type for project information gathering
 */
interface ProjectInfo {
  name: string;
  root: string;
  languages: string[];
  frameworks: string[];
  testCommand: string | null;
  buildCommand: string | null;
  lintCommand: string | null;
  packageManager: string | null;
  readme: string | null;
  hasTypeScript: boolean;
  hasEslint: boolean;
  hasPrettier: boolean;
  excludeDirs: string[];
}
