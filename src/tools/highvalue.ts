import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative, extname, basename, dirname } from 'path';
import { ConfigManager } from '../config/index.js';
import { RedactionEngine } from '../utils/redaction.js';
import { LlmChatTool } from './llm.js';
import { BackendManager } from '../adapters/factory.js';
import {
  GatherContextResult,
  SecretScanResult,
  SecretScanFinding,
  AggregateTodosResult,
  TodoItem,
  CodebaseQAResult,
  TestGapsResult,
  RedactionPreviewResult,
  RiskScoreResult,
  AnalyzeImpactResult,
  SecurityFixResult,
} from '../types/index.js';
import { ToolLlmWrapper } from '../orchestration/tool-llm-wrapper.js';
import { generatePathSuggestions } from '../utils/structured-errors.js';
import { globToRegexSource } from '../utils/glob-patterns.js';
import { escapeRegexLiteral } from '../utils/regex-escape.js';

/**
 * Directories to skip during scanning - matches code-analysis.ts
 * Prevents false positives from venv, node_modules, and third-party code
 *
 * Black-box V4: Removed test-specific directories that cause under-scanning:
 * - 'repo' (common name for actual source code in monorepos)
 * - 'output' (may contain generated source)
 * - 'evidence', 'stress_test', 'phase3_test_output' (test-repo-specific noise)
 */
const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  'dist',
  'dist_package',
  'build',
  'out',
  'artifacts',
  'logs',
  'log',
  'tmp',
  'temp',
  'test-results',
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

/**
 * V18 (QA_feedback_5): Calculate Shannon entropy of a string
 * Used to distinguish between real secrets (high entropy) and placeholder text (low entropy)
 * Addresses: "Implement an entropy check for suspected secrets to distinguish between hardcoded keys and placeholder text"
 *
 * @param str The string to calculate entropy for
 * @returns Shannon entropy in bits (0-8 for ASCII)
 */
function calculateEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const freq: Record<string, number> = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }

  let entropy = 0;
  const len = str.length;
  for (const char in freq) {
    const p = freq[char] / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * V18: Check if a matched secret is likely a placeholder/example rather than a real secret
 * Low entropy strings like "password123" or "test_api_key" are likely not real secrets
 */
function isLikelyPlaceholder(matchedValue: string): boolean {
  // Minimum entropy threshold - real secrets typically have entropy > 3.5
  const MIN_SECRET_ENTROPY = 3.5;

  // Skip very short values
  if (matchedValue.length < 8) return true;

  // Check entropy
  const entropy = calculateEntropy(matchedValue);
  if (entropy < MIN_SECRET_ENTROPY) return true;

  // Check for common placeholder patterns
  const placeholderPatterns = [
    /^(test|demo|sample|example|fake|dummy|mock|placeholder)/i,
    /^(your|my|the)[_-]?(api|secret|password|key)/i,
    /^(password|secret|key|token)(123|1234|12345|test|demo)?$/i,
    /^x{4,}$/i, // xxxx...
    /^[a-z]+\d{1,4}$/i, // word123
    /^[A-Z_]+$/, // ALL_CAPS_CONSTANT
    /(changeme|please_change|insert|replace)/i,
  ];

  return placeholderPatterns.some((p) => p.test(matchedValue));
}

export class HighValueTools {
  private config: ConfigManager;
  private redaction: RedactionEngine;
  private llmChat: LlmChatTool;
  private llmWrapper: ToolLlmWrapper;

  constructor(config: ConfigManager, backendManager: BackendManager) {
    this.config = config;
    const mode =
      this.config.getConfig().privacy?.secretPatterns === 'strict' ? 'strict' : 'default';
    this.redaction = new RedactionEngine({ mode });
    this.llmChat = new LlmChatTool(backendManager, config);
    this.llmWrapper = new ToolLlmWrapper(this.llmChat);
  }

  /**
   * V12: Auto-detect project type from common indicator files
   * Returns the detected project type for smarter default patterns
   */
  private detectProjectType(rootPath: string): string {
    try {
      // TypeScript project indicators
      if (
        existsSync(join(rootPath, 'tsconfig.json')) ||
        existsSync(join(rootPath, 'tsconfig.base.json'))
      ) {
        return 'typescript';
      }

      // JavaScript project indicators (without TypeScript)
      if (
        existsSync(join(rootPath, 'package.json')) &&
        !existsSync(join(rootPath, 'tsconfig.json'))
      ) {
        return 'javascript';
      }

      // Python project indicators
      if (
        existsSync(join(rootPath, 'pyproject.toml')) ||
        existsSync(join(rootPath, 'setup.py')) ||
        existsSync(join(rootPath, 'requirements.txt')) ||
        existsSync(join(rootPath, 'Pipfile'))
      ) {
        return 'python';
      }

      // Go project indicators
      if (existsSync(join(rootPath, 'go.mod')) || existsSync(join(rootPath, 'go.sum'))) {
        return 'go';
      }

      // Rust project indicators
      if (existsSync(join(rootPath, 'Cargo.toml'))) {
        return 'rust';
      }

      // Java/Kotlin project indicators
      if (
        existsSync(join(rootPath, 'pom.xml')) ||
        existsSync(join(rootPath, 'build.gradle')) ||
        existsSync(join(rootPath, 'build.gradle.kts'))
      ) {
        return 'java';
      }

      // C# project indicators
      if (existsSync(join(rootPath, '*.csproj')) || existsSync(join(rootPath, '*.sln'))) {
        return 'csharp';
      }

      // Ruby project indicators
      if (existsSync(join(rootPath, 'Gemfile'))) {
        return 'ruby';
      }

      // PHP project indicators
      if (existsSync(join(rootPath, 'composer.json'))) {
        return 'php';
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Gather comprehensive context for a query using local LLM
   */
  async gatherContext(
    query: string,
    path: string,
    options?: {
      scope?: 'file' | 'directory' | 'repo';
      maxFiles?: number;
      strategy?: 'relevant' | 'comprehensive' | 'minimal';
      includePatterns?: string[];
      excludePatterns?: string[];
    }
  ): Promise<GatherContextResult> {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    // Check if path exists
    if (!existsSync(resolvedPath)) {
      const workspaceRoots = this.config.getWorkspaceRoots();
      const pathHints = generatePathSuggestions(path, workspaceRoots);
      throw new Error(
        `Path not found: '${path}' does not exist. ` +
          `Resolved to: '${resolvedPath}'. ` +
          `Please verify the path is correct and accessible. ` +
          (pathHints.length > 0 ? pathHints.join(' ') : '')
      );
    }

    const scope = options?.scope ?? 'directory';
    const maxFiles = options?.maxFiles ?? 20;
    const strategy = options?.strategy ?? 'relevant';

    // Check if path is a single file vs directory
    const pathStats = statSync(resolvedPath);
    let files: string[];

    if (pathStats.isFile()) {
      // Single file mode: analyze this file directly
      files = [resolvedPath];
    } else {
      // Directory mode: collect files based on scope
      files = this.collectFiles(
        resolvedPath,
        scope,
        maxFiles,
        options?.includePatterns,
        options?.excludePatterns
      );
    }

    // Analyze each file for relevance to query
    const analyzedFiles: GatherContextResult['files'] = [];
    let totalTokensEstimate = 0;
    let totalOriginalTokens = 0;

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const redactedContent = this.redaction.redact(content);
        totalOriginalTokens += Math.ceil(content.length / 4);

        // For 'minimal' strategy, only include very relevant files
        // For 'comprehensive', include everything
        // For 'relevant', use LLM to assess relevance

        const lines = redactedContent.split('\n');
        const keySnippets: Array<{ lines: string; content: string; reason: string }> = [];

        // Extract relevant snippets based on query keywords
        const queryTerms = query.toLowerCase().split(/\s+/);
        let relevanceScore = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].toLowerCase();
          for (const term of queryTerms) {
            if (term.length > 2 && line.includes(term)) {
              relevanceScore++;
              // Add snippet with context
              const start = Math.max(0, i - 2);
              const end = Math.min(lines.length - 1, i + 2);
              const snippet = lines.slice(start, end + 1).join('\n');

              if (!keySnippets.some((s) => s.content === snippet)) {
                keySnippets.push({
                  lines: `${start + 1}-${end + 1}`,
                  content: snippet,
                  reason: `Contains query term: ${term}`,
                });
              }
              break;
            }
          }
        }

        // Black-box V5: Apply file-type priority scoring
        // Code files are more relevant than docs/reports for code-related queries
        const fileExt = extname(file).toLowerCase();
        const relPath = relative(resolvedPath, file);

        // Boost code files
        const codeExtensions = [
          '.ts',
          '.tsx',
          '.js',
          '.jsx',
          '.py',
          '.java',
          '.go',
          '.rs',
          '.rb',
          '.c',
          '.cpp',
          '.cs',
        ];
        if (codeExtensions.includes(fileExt)) {
          relevanceScore += 20;
        }

        // Penalize documentation files (often not what users want for code queries)
        if (fileExt === '.md') {
          relevanceScore -= 15;
        }

        // Heavily penalize report/output directories (analysis_reports, test-results)
        if (
          relPath.includes('analysis_reports') ||
          relPath.includes('test-results') ||
          relPath.includes('reports/') ||
          relPath.includes('output/')
        ) {
          relevanceScore -= 30;
        }

        // Penalize JSON files in report-like directories
        if (fileExt === '.json' && (relPath.includes('report') || relPath.includes('result'))) {
          relevanceScore -= 25;
        }

        // Determine relevance level
        const relevance: 'high' | 'medium' | 'low' =
          relevanceScore > 5 ? 'high' : relevanceScore > 1 ? 'medium' : 'low';

        // For minimal strategy, skip low relevance files
        if (strategy === 'minimal' && relevance === 'low') {
          continue;
        }

        // Limit snippets
        const limitedSnippets = keySnippets.slice(0, 5);

        // Generate file summary (quick heuristic-based for now)
        const summary = this.generateQuickSummary(file, lines);

        analyzedFiles.push({
          path: pathStats.isFile()
            ? basename(file)
            : relative(resolvedPath, file) || basename(file),
          relevance,
          summary,
          keySnippets: limitedSnippets,
        });

        totalTokensEstimate += Math.ceil(summary.length / 4);
        for (const snippet of limitedSnippets) {
          totalTokensEstimate += Math.ceil(snippet.content.length / 4);
        }
      } catch {
        // Skip files we can't read
      }
    }

    // Sort by relevance
    analyzedFiles.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.relevance] - order[b.relevance];
    });

    // Generate suggested questions
    const suggestedQuestions = this.generateSuggestedQuestions(query, analyzedFiles);

    return {
      summary: `Gathered context for: "${query}". Found ${analyzedFiles.length} relevant files out of ${files.length} scanned.`,
      files: analyzedFiles,
      suggestedQuestions,
      totalTokensEstimate,
      compressionRatio: totalOriginalTokens > 0 ? totalOriginalTokens / totalTokensEstimate : 1,
    };
  }

  /**
   * Scan for secrets and sensitive information
   *
   * Plan 2 (V4): Zero-Files Security Guard
   * - warnOnEmpty: Add warning to result if no files scanned (non-fatal)
   * - minimumFilesExpected: Threshold for expected file count (warn if below)
   * - failOnEmpty: Throw error if no files scanned (existing)
   *
   * Black-box V5: Improved defaults and test exclusion
   * - skipTests: Skip test directories by default (true) - configurable
   * - Fallback: If 0 files match include patterns, try scanning ALL files (minus skip dirs)
   */
  secretScan(
    root: string,
    options?: {
      scanType?: 'secrets' | 'vulnerabilities' | 'both';
      outputFormat?: 'summary' | 'detailed' | 'actionable';
      include?: string[];
      exclude?: string[];
      includeHidden?: boolean;
      failOnEmpty?: boolean;
      warnOnEmpty?: boolean; // Plan 2: Non-fatal warning
      minimumFilesExpected?: number; // Plan 2: Threshold warning
      skipTests?: boolean; // Black-box V5: Skip test directories (default: true)
    }
  ): SecretScanResult {
    const startTime = Date.now();
    const executionId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
          `Please verify the path is correct and accessible. ` +
          (pathHints.length > 0 ? pathHints.join(' ') : '')
      );
    }

    const stats = statSync(resolvedRoot);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid path: '${root}' is not a directory. ` +
          `The 'root' parameter must be a directory path to scan. ` +
          `For single file scanning, use analyze_file instead.`
      );
    }

    const scanType = options?.scanType ?? 'both';
    const includeHidden = options?.includeHidden ?? false;
    const findings: SecretScanFinding[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    const skippedReasons: Record<string, number> = {};
    // F3-005: Track scanned file names for transparency
    const scannedFileList: string[] = [];

    // Helper to track skip reasons
    const trackSkip = (reason: string) => {
      filesSkipped++;
      skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
    };

    // Custom exclude patterns from options (merged with defaults)
    const customExcludes = options?.exclude ?? [];

    // V12: Auto-detect project type for smarter default patterns
    const detectedType = this.detectProjectType(resolvedRoot);

    const includeProvided = !!(options?.include && options.include.length > 0);
    // Black-box V3: Default to common source file patterns when no include specified
    // V12: Use project-type-specific patterns when auto-detected
    const DEFAULT_SOURCE_PATTERNS = [
      '*.ts',
      '*.tsx',
      '*.js',
      '*.jsx',
      '*.mjs',
      '*.cjs', // JavaScript/TypeScript
      '*.py',
      '*.pyw', // Python
      '*.java',
      '*.kt',
      '*.kts', // JVM
      '*.go', // Go
      '*.rs', // Rust
      '*.rb', // Ruby
      '*.php', // PHP
      '*.cs',
      '*.fs', // .NET
      '*.swift', // Swift
      '*.c',
      '*.cpp',
      '*.h',
      '*.hpp', // C/C++
      '*.yaml',
      '*.yml',
      '*.json',
      '*.toml',
      '*.ini', // Config (may have secrets)
      '*.env',
      '.env.*',
      '*.env.*', // Environment files
      '*.sh',
      '*.bash',
      '*.zsh',
      '*.ps1', // Shell scripts
      '*.key',
      '*.pem',
      '*.crt',
      '*.cer',
      '*.p12',
      '*.pfx', // Key material files (critical for secret detection)
    ];

    // V12: Project-type-specific patterns
    // All project types include key-material files for critical secret detection
    const KEY_MATERIAL_PATTERNS = ['*.key', '*.pem', '*.crt', '*.cer', '*.p12', '*.pfx'];
    const projectTypePatterns: Record<string, string[]> = {
      typescript: [
        '*.ts',
        '*.tsx',
        '*.js',
        '*.jsx',
        '*.mjs',
        '*.cjs',
        '*.json',
        '*.yaml',
        '*.yml',
        '*.env',
        '.env.*',
        ...KEY_MATERIAL_PATTERNS,
      ],
      javascript: [
        '*.js',
        '*.jsx',
        '*.mjs',
        '*.cjs',
        '*.json',
        '*.yaml',
        '*.yml',
        '*.env',
        '.env.*',
        ...KEY_MATERIAL_PATTERNS,
      ],
      python: [
        '*.py',
        '*.pyw',
        '*.yaml',
        '*.yml',
        '*.ini',
        '*.cfg',
        '*.env',
        '.env.*',
        ...KEY_MATERIAL_PATTERNS,
      ],
      go: [
        '*.go',
        '*.yaml',
        '*.yml',
        '*.json',
        '*.toml',
        '*.env',
        '.env.*',
        ...KEY_MATERIAL_PATTERNS,
      ],
      rust: ['*.rs', '*.toml', '*.yaml', '*.yml', '*.env', '.env.*', ...KEY_MATERIAL_PATTERNS],
      java: [
        '*.java',
        '*.kt',
        '*.kts',
        '*.xml',
        '*.yaml',
        '*.yml',
        '*.properties',
        '*.env',
        '.env.*',
        ...KEY_MATERIAL_PATTERNS,
      ],
      csharp: [
        '*.cs',
        '*.fs',
        '*.json',
        '*.xml',
        '*.yaml',
        '*.yml',
        '*.env',
        '.env.*',
        ...KEY_MATERIAL_PATTERNS,
      ],
      ruby: ['*.rb', '*.yaml', '*.yml', '*.json', '*.env', '.env.*', ...KEY_MATERIAL_PATTERNS],
      php: ['*.php', '*.json', '*.yaml', '*.yml', '*.env', '.env.*', ...KEY_MATERIAL_PATTERNS],
      unknown: DEFAULT_SOURCE_PATTERNS,
    };

    const includePatterns: string[] = includeProvided
      ? [...(options?.include ?? [])]
      : [
          ...(detectedType !== 'unknown'
            ? projectTypePatterns[detectedType]
            : DEFAULT_SOURCE_PATTERNS),
        ];
    const recommendedInclude = this.getSecurityIncludeGuidance(detectedType, scanType);

    // Helper to check if path matches include patterns
    const matchesInclude = (filePath: string): boolean => {
      if (includePatterns.length === 0) return true;
      const relPath = relative(resolvedRoot, filePath);
      return includePatterns.some((pattern) => {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
          return regex.test(relPath) || regex.test(basename(filePath));
        }
        return relPath.includes(pattern) || basename(filePath).includes(pattern);
      });
    };

    // Helper to check if path matches exclude patterns
    const matchesExclude = (filePath: string): boolean => {
      const relPath = relative(resolvedRoot, filePath);
      return customExcludes.some((pattern) => {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
          return regex.test(relPath) || regex.test(basename(filePath));
        }
        return relPath.includes(pattern) || basename(filePath).includes(pattern);
      });
    };

    const buildSkipFilePatterns = (skipTestsEnabled: boolean) => {
      const basePatterns = [
        // Patterns to SKIP (reduce false positives)
        // These are files/patterns that commonly trigger false positives
        /\.example$/i, // Example files
        /\.sample$/i, // Sample files
        /\.md$/i, // Documentation
        /package-lock\.json$/i, // Lock files
        /yarn\.lock$/i,
      ];

      const testPatterns = [
        // Black-box V5: Added test file patterns to skip by default
        /\.test\.(ts|js|tsx|jsx|py)$/i, // Test files often have mock secrets
        /\.spec\.(ts|js|tsx|jsx|py)$/i, // Spec files
        /fixtures?\//i, // Test fixtures
        // Black-box V5: Test directory patterns (only if skipTests=true)
        // Note: These patterns check for test dirs as the FINAL directory component
        // to avoid skipping all files when workspace is inside a tests/ folder
        /[\\/]tests?[\\/][^/\\]+\.(ts|js|tsx|jsx|py)$/i, // Direct children of tests/ or test/
        /[\\/]__tests__[\\/]/i, // __tests__/ (Jest convention) - any level
        /[\\/]test-results[\\/]/i, // test-results/ - any level
        /[\\/]coverage[\\/]/i, // coverage reports - any level
        /_test\.py$/i, // Python test file convention
        /test_[^/\\]+\.py$/i, // Python test file convention
      ];

      return skipTestsEnabled ? [...basePatterns, ...testPatterns] : basePatterns;
    };

    const skipTests = options?.skipTests ?? true; // Skip tests by default
    let skipFilePatterns = buildSkipFilePatterns(skipTests);

    // Context patterns that indicate a false positive (documentation, comments, examples)
    // Black-box V3: Added ALL_CAPS constant exclusions to reduce noise from error-code enums
    // V10: Enhanced test context patterns for moderate noise reduction (addresses v6 feedback)
    // V15: Added function/method signature patterns to reduce false positives on password-related function names
    const falsePositiveContexts = [
      /\/\/.*example/i, // // example comment
      /\/\*.*example.*\*\//i, // /* example */ comment
      /placeholder/i, // placeholder values
      /your[-_]?api[-_]?key/i, // "your-api-key" placeholder
      /xxx+/i, // xxxxx placeholder
      /test[-_]?key/i, // test-key placeholder
      /fake[-_]?/i, // fake- prefix
      /dummy[-_]?/i, // dummy- prefix
      /sample[-_]?/i, // sample- prefix
      /pass(?:word)?\s*[:=]\s*['"]?(?:test|demo|sample|password|admin|changeme|123456|qwerty|pass123)[^'"]*['"]?/i,
      // Black-box V3: ALL_CAPS constant assignments (e.g., WEAK_PASSWORD = "REG_WEAK_PASSWORD")
      /^[A-Z][A-Z0-9_]+\s*=\s*['"][A-Z][A-Z0-9_]*['"]/, // ALL_CAPS = "ALL_CAPS" patterns
      /(?:REG_|ERR_|STATUS_|ERROR_|CODE_|CONST_|ENUM_)[A-Z0-9_]+/i, // Common enum/error-code prefixes
      /\b[A-Z][A-Z0-9_]{3,}\s*[:=]\s*['"][A-Z][A-Z0-9_]+['"]/, // Generic constant assignment
      /error[_-]?codes?\./i, // error_codes.SOMETHING patterns
      /\.py:\s*[A-Z_]+\s*=/, // Python constant definitions
      // V10: Test context patterns (moderate noise reduction)
      /test[_-]?password/i, // test_password, testPassword
      /mock[_-]?(?:password|secret|key|token)/i, // mock_password, mockSecret
      /fixture[_-]?(?:password|secret|key|token)/i, // fixture_password
      /(?:expect|assert|should).*(?:password|secret|key|token)/i, // assertion contexts
      /describe\s*\(['"]/i, // describe('...' - test block
      /it\s*\(['"]/i, // it('...' - test case
      /test\s*\(['"]/i, // test('...' - test case
      /beforeEach|afterEach|beforeAll|afterAll/i, // test hooks
      /jest\.mock|vi\.mock|sinon\.stub/i, // mocking frameworks
      /['"]password['"]:\s*['"](?:test|password|demo|example|12345)/i, // { "password": "test" }
      // V15: Function/method signature patterns (reduce false positives on password-related method names)
      // These match function definitions that HANDLE passwords, not hardcoded secrets
      /def\s+(?:validate|check|verify|hash|encrypt|compare|reset|change|set|get|update|clear)[_-]?password\s*\(/i, // Python method signatures
      /def\s+\w*password\w*\s*\(/i, // Any Python function with "password" in name
      /function\s+(?:validate|check|verify|hash|encrypt|compare|reset|change|set|get|update|clear)[_-]?password\s*\(/i, // JS function signatures
      /(?:async\s+)?(?:function\s+)?\w*[Pp]assword\w*\s*[=(]/, // JS functions/methods with password in name
      /(?:public|private|protected)?\s*(?:static)?\s*(?:async)?\s*\w*[Pp]assword\w*\s*\([^)]*\)\s*[:{]/, // Class method signatures
      /\.(?:validate|check|verify|hash|encrypt|compare|reset|change|set|get|update|clear)[_-]?password\s*\(/i, // Method calls on objects
      /password\s*[:=]\s*(?:self\.|this\.|req\.|request\.|params\.|body\.|data\.|input\.)/i, // Assignment from request/params (not hardcoded)
      /(?:log(?:ger)?|console|print)\s*\.\s*\w+\s*\([^)]*password/i, // Logging statements mentioning password (not the actual value)
      // V16: Python type hint patterns (QA_feedback_1.md - all testers flagged "password: str" as false positive)
      /password\s*:\s*(?:str|Optional\[str\]|Union\[str|Any|None)/i, // Python type hints: password: str, password: Optional[str]
      /:\s*(?:str|Optional\[str\])\s*(?:=|,|\))/i, // Type annotation context: param: str = or param: str,
      /def\s+\w+\s*\([^)]*password\s*:/i, // Function with password parameter type hint
      /->\s*(?:str|bool|None|Optional)/i, // Return type annotations (context for method signatures)
      // QA_feedback_9: UI label patterns (Gemini 3 Pro identified Label(text="Password:") as false positive)
      /(?:^|[^.\w])(?:tk|ttk)?\.?Label\s*\([^)]*\btext\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // Label(..., text="Password:")
      /\btext\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // text="Password:"
      /label\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // label="Password"
      /placeholder\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // placeholder="Password"
      /hint\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // hint="Enter password"
      /tooltip\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // tooltip="Password required"
      /title\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // title="Password"
      /aria-label\s*=\s*["'][^"']*[Pp]assword[^"']*["']/i, // aria-label="Password field"
      /name\s*=\s*["']password["']/i, // name="password" (form field name, not a secret)
      /id\s*=\s*["'][^"']*password[^"']*["']/i, // id="password-field" (HTML element ID)
      /type\s*=\s*["']password["']/i, // type="password" (input type attribute)
      /<label[^>]*>[^<]*[Pp]assword[^<]*<\/label>/i,
      // UI framework patterns
      /Entry\s*\(\s*show\s*=\s*["']\*["']/i, // Tkinter Entry(show="*") - masked password field
      /QLineEdit\s*::.*[Pp]assword/i, // Qt QLineEdit::Password
      /SecureField|PasswordField|SecureTextEntry/i, // Common password field component names
    ];

    const secretPatternMode = this.config.getConfig().privacy?.secretPatterns ?? 'default';
    const strictPatternsEnabled = secretPatternMode === 'strict';

    // Secret patterns - tuned to reduce false positives by default.
    // Use privacy.secretPatterns=strict to enable broader matching.
    const secretPatterns = [
      {
        name: 'API Key',
        // Require assignment context and exclude placeholders
        regex:
          /(?:api[_-]?key|apikey)\s*[=:]\s*['"]([a-zA-Z0-9_-]{20,})['"](?!.*(?:example|placeholder|your|xxx|test|fake|dummy))/gi,
        severity: 'high' as const,
      },
      {
        name: 'OpenAI/Anthropic Key',
        // sk- followed by specific length and characters
        regex: /['"]?(sk-(?:proj-)?[a-zA-Z0-9]{32,})['"]?/g,
        severity: 'critical' as const,
      },
      {
        name: 'Stripe Key',
        // Stripe keys have specific format
        regex: /['"]?(sk_(?:live|test)_[A-Za-z0-9]{24,})['"]?/g,
        severity: 'critical' as const,
      },
      {
        name: 'Password (code)',
        // Require assignment in code, not in comments
        regex:
          /(?<!\/)(?:password|passwd|pwd)\s*[=:]\s*['"]([^'"\s]{8,})['"](?!.*(?:example|placeholder|your|xxx|test|fake|dummy|\$\{))/gi,
        severity: 'critical' as const,
      },
      {
        name: 'Password (conversational)',
        // F3-007: Detect conversational patterns like "My password is 123456"
        // Reduced min length to 4 chars to catch common weak passwords
        regex: /(?:my|the|your)?\s*password\s+is\s+['"]?([^\s'"]{4,})['"]?/gi,
        severity: 'high' as const,
      },
      {
        name: 'Password (inline)',
        // F3-007: Detect inline password mentions with colon separator
        regex: /password[:\s]+['"]?([^\s'"]{4,})['"]?(?![a-z])/gi,
        severity: 'high' as const,
      },
      {
        name: 'Private Key',
        regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/g,
        severity: 'critical' as const,
      },
      {
        name: 'AWS Key',
        regex: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
        severity: 'critical' as const,
      },
      {
        name: 'AWS Secret Access Key',
        regex:
          /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{30,})['"]?/g,
        severity: 'critical' as const,
      },
      {
        name: 'JWT Token',
        regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
        severity: 'high' as const,
      },
      { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9_\-.]+/gi, severity: 'high' as const },
      {
        name: 'Connection String',
        regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,
        severity: 'high' as const,
      },
      { name: 'GitHub Token', regex: /ghp_[A-Za-z0-9]{36}/g, severity: 'critical' as const },
      { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]+/g, severity: 'high' as const },
      {
        name: 'Generic Secret',
        // Default mode: require an assignment + quoted value and a longer token-like string.
        // Strict mode: allow broader detection (still bounded to avoid noisy matches).
        regex: strictPatternsEnabled
          ? /(?:secret|token)['":\s]*[=:]?\s*['"]?([a-zA-Z0-9_-]{16,})/gi
          : /(?:secret|token)\s*[=:]\s*['"]([A-Za-z0-9_/+=-]{24,})['"]/gi,
        severity: 'medium' as const,
      },
      {
        name: 'Hardcoded Key Assignment',
        // Reduce noise by requiring longer values by default.
        regex: strictPatternsEnabled
          ? /(?:KEY|SECRET|TOKEN|CREDENTIAL)\s*=\s*['"][^'"]{8,}['"]/gi
          : /(?:KEY|SECRET|TOKEN|CREDENTIAL)\s*=\s*['"][^'"]{20,}['"]/gi,
        severity: strictPatternsEnabled ? ('high' as const) : ('medium' as const),
      },
    ];

    // Vulnerability patterns
    const vulnPatterns = [
      {
        name: 'SQL Injection Risk',
        regex: /`.*\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/gi,
        severity: 'high' as const,
      },
      { name: 'Eval Usage', regex: /\beval\s*\(/g, severity: 'medium' as const },
      { name: 'innerHTML Assignment', regex: /\.innerHTML\s*=/g, severity: 'medium' as const },
      {
        name: 'Hardcoded IP',
        regex: /\b(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
        severity: 'low' as const,
      },
    ];

    const patternsToUse =
      scanType === 'secrets'
        ? secretPatterns
        : scanType === 'vulnerabilities'
          ? vulnPatterns
          : [...secretPatterns, ...vulnPatterns];

    // Helper to check if file should be skipped for false positive reduction
    const shouldSkipFile = (filePath: string): boolean => {
      return skipFilePatterns.some((pattern) => pattern.test(filePath));
    };

    // Helper to check if a line is a false positive context
    const isFalsePositiveContext = (line: string): boolean => {
      return falsePositiveContexts.some((pattern) => pattern.test(line));
    };

    // Black-box V5: scanDir now accepts useIncludePatterns for fallback behavior
    const scanDir = (dir: string, useIncludePatterns = true) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip hidden files/dirs unless explicitly included
          if (!includeHidden && entry.name.startsWith('.')) {
            trackSkip('hidden');
            continue;
          }
          // Skip common ignores (venv, node_modules, etc.)
          if (DEFAULT_SKIP_DIRS.has(entry.name)) {
            trackSkip(entry.name);
            continue;
          }

          const fullPath = join(dir, entry.name);

          // Apply custom exclude patterns
          if (matchesExclude(fullPath)) {
            trackSkip('custom_exclude');
            continue;
          }

          if (!this.config.isPathAllowed(fullPath)) {
            trackSkip('not_allowed');
            continue;
          }

          if (entry.isDirectory()) {
            scanDir(fullPath, useIncludePatterns);
          } else if (entry.isFile()) {
            // Check include patterns first (only if useIncludePatterns is true)
            if (useIncludePatterns && !matchesInclude(fullPath)) {
              trackSkip('not_in_include');
              continue;
            }
            // Skip files that commonly have false positives
            if (shouldSkipFile(fullPath)) {
              trackSkip('false_positive_prone');
              continue;
            }
            this.scanFileWithContext(
              fullPath,
              patternsToUse,
              findings,
              resolvedRoot,
              isFalsePositiveContext
            );
            filesScanned++;
            // F3-005: Track scanned file for transparency (keep first 20)
            if (scannedFileList.length < 20) {
              scannedFileList.push(relative(resolvedRoot, fullPath));
            }
          }
        }
      } catch {
        // Skip directories we can't read
        trackSkip('unreadable');
      }
    };

    // Black-box V5: First pass with include patterns
    scanDir(resolvedRoot, true);

    // Black-box V5: Fallback - if 0 files matched include patterns, scan ALL files
    let usedFallback = false;
    let fallbackReason: string | undefined;
    if (
      filesScanned === 0 &&
      skippedReasons['not_in_include'] &&
      skippedReasons['not_in_include'] > 0
    ) {
      // Reset counters for fallback scan
      filesScanned = 0;
      filesSkipped = 0;
      const fallbackSkipped = skippedReasons['not_in_include'];
      Object.keys(skippedReasons).forEach((key) => delete skippedReasons[key]);
      skippedReasons['fallback_from_include_mismatch'] = fallbackSkipped;
      usedFallback = true;
      fallbackReason = 'include_mismatch';
      scanDir(resolvedRoot, false); // Scan without include pattern restrictions
    }

    // Low-coverage fallback: if only test files were skipped, broaden scan to include them
    const autoExpandThreshold = options?.minimumFilesExpected ?? 5;
    const shouldExpandForTests =
      skipTests && filesScanned === 0 && skippedReasons['false_positive_prone'] > 0;
    const shouldExpandForLowCoverage =
      skipTests && filesScanned > 0 && filesScanned < autoExpandThreshold;

    if (!usedFallback && (shouldExpandForTests || shouldExpandForLowCoverage)) {
      filesScanned = 0;
      filesSkipped = 0;
      Object.keys(skippedReasons).forEach((key) => delete skippedReasons[key]);
      skippedReasons['fallback_from_low_coverage'] = autoExpandThreshold;
      usedFallback = true;
      fallbackReason = 'low_coverage';
      skipFilePatterns = buildSkipFilePatterns(false);
      scanDir(resolvedRoot, false);
    }

    // In CI environments, misconfigured scans should fail loudly to prevent security gaps
    const isCI = !!(
      process.env.CI ||
      process.env.GITHUB_ACTIONS ||
      process.env.JENKINS_URL ||
      process.env.GITLAB_CI ||
      process.env.CIRCLECI ||
      process.env.TRAVIS ||
      process.env.AZURE_PIPELINES ||
      process.env.BITBUCKET_PIPELINES
    );
    const failOnEmpty = options?.failOnEmpty ?? isCI; // Default to CI environment detection
    const rootForExample = String(root || '.')
      .replace(/\\/g, '/')
      .replace(/"/g, '\\"');
    const recommendationForMessage = recommendedInclude.slice(0, 4);
    const recommendedIncludeJson = JSON.stringify(recommendationForMessage);
    const recommendedCommand =
      `security {"action":"scan","root":"${rootForExample}","scanType":"${scanType}",` +
      `"includeHidden":${includeHidden ? 'true' : 'false'},"include":${recommendedIncludeJson}}`;
    const remediationHint =
      `Try includeHidden=true or add include patterns. ` +
      `Detected project type: ${detectedType}. ` +
      `Recommended include: ${recommendedIncludeJson}. ` +
      `Example: ${recommendedCommand}.`;
    const coverageGuidance = {
      detectedProjectType: detectedType,
      includeProvided,
      includePatternsUsed: includePatterns.slice(0, 12),
      recommendedInclude: recommendationForMessage,
      recommendedCommand,
      lowCoverageThreshold: autoExpandThreshold,
    };

    if (failOnEmpty && filesScanned === 0) {
      const ciPrefix = isCI ? '[CI_MODE] ' : '';
      throw new Error(
        `${ciPrefix}Security scan found 0 files to scan in '${root}'. ` +
          `This may indicate a misconfigured path or overly restrictive exclude patterns. ` +
          `Skipped ${filesSkipped} files. Reasons: ${JSON.stringify(skippedReasons)}. ` +
          remediationHint
      );
    }

    // Plan 2 (V4): Collect warnings for non-fatal edge cases
    const warnings: string[] = [];

    // warnOnEmpty: Non-fatal warning when no files scanned
    const warnOnEmpty = options?.warnOnEmpty ?? true; // Default to true for visibility
    if (warnOnEmpty && filesScanned === 0) {
      warnings.push(
        `Zero files scanned in '${root}'. ` +
          `This may indicate a misconfigured path or overly restrictive exclude patterns. ` +
          `Skipped ${filesSkipped} files. Reasons: ${JSON.stringify(skippedReasons)}. ` +
          remediationHint
      );
    }

    // minimumFilesExpected: Warn if file count below threshold
    const minimumFilesExpected = options?.minimumFilesExpected;
    if (minimumFilesExpected !== undefined && filesScanned < minimumFilesExpected) {
      warnings.push(
        `Only ${filesScanned} files scanned (expected at least ${minimumFilesExpected}). ` +
          `This may indicate missing files or overly restrictive patterns.`
      );
    }

    if (usedFallback || filesScanned < autoExpandThreshold) {
      warnings.push(
        `Coverage guidance: scanned ${filesScanned} files (skipped ${filesSkipped}). ` +
          `Detected '${detectedType}' project. ` +
          `Recommended include patterns: ${recommendedIncludeJson}.`
      );
    }

    // Calculate statistics
    const findingsByCategory: Record<string, number> = {};
    for (const finding of findings) {
      findingsByCategory[finding.type] = (findingsByCategory[finding.type] || 0) + 1;
    }

    // Calculate risk score (0-100)
    let riskScore = 0;
    for (const finding of findings) {
      switch (finding.severity) {
        case 'critical':
          riskScore += 25;
          break;
        case 'high':
          riskScore += 15;
          break;
        case 'medium':
          riskScore += 5;
          break;
        case 'low':
          riskScore += 1;
          break;
      }
    }
    riskScore = Math.min(100, riskScore);

    const scanDurationMs = Date.now() - startTime;

    // Black-box V5: Add info about fallback scan if used
    // V14: Reworded to be less alarming per LLM feedback
    if (usedFallback) {
      warnings.push(
        `Include patterns matched 0 files; scanned all files in directory instead (excluding .git, node_modules, etc.). ` +
          `Tip: Use patterns like ["**/*.py", "**/*.ts"] to target specific file types.`
      );
    }

    return {
      findings,
      statistics: {
        filesScanned,
        filesSkipped,
        skippedReasons,
        findingsByCategory,
        riskScore,
        scanDurationMs,
        usedFallback, // Black-box V5: Indicate if fallback was used
        fallbackReason,
        coverageGuidance,
        // F3-005: Show which files were scanned for transparency
        scannedFiles: scannedFileList.length > 0 ? scannedFileList : undefined,
        ...(filesScanned > 20 ? { note: `Showing first 20 of ${filesScanned} scanned files` } : {}),
      },
      executionId,
      timestamp: new Date().toISOString(),
      // Plan 2 (V4): Include warnings in result
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Plan 1: Security Fix - auto-generates replacement code for detected secrets
   * Scans for secrets and optionally applies fixes using environment variables
   */
  async securityFix(
    root: string,
    options?: {
      apply?: boolean;
      scanType?: 'secrets' | 'vulnerabilities' | 'both';
      includeHidden?: boolean;
    }
  ): Promise<SecurityFixResult> {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      return {
        success: false,
        error: `Access denied: Path '${root}' is not in the allowlist`,
        findings: [],
        totalFindings: 0,
        fixesApplied: 0,
        summary: '',
      };
    }

    // First, run the secret scan
    const scanResult = this.secretScan(root, {
      scanType: options?.scanType ?? 'secrets',
      includeHidden: options?.includeHidden,
    });
    const findings = scanResult.findings;

    if (findings.length === 0) {
      return {
        success: true,
        findings: [],
        totalFindings: 0,
        fixesApplied: 0,
        summary: 'No security issues found',
      };
    }

    // Generate fixes for each finding
    const fixedFindings: SecurityFixResult['findings'] = [];
    const backupPaths: string[] = [];
    let fixesApplied = 0;

    // Group findings by file for batch processing
    const findingsByFile = new Map<string, SecretScanFinding[]>();
    for (const finding of findings) {
      const filePath = join(resolvedRoot, finding.file);
      if (!findingsByFile.has(filePath)) {
        findingsByFile.set(filePath, []);
      }
      findingsByFile.get(filePath)!.push(finding);
    }

    for (const [filePath, fileFindings] of findingsByFile) {
      let fileContent: string;
      try {
        fileContent = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      let modified = false;
      let currentContent = fileContent;

      for (const finding of fileFindings) {
        // Generate suggested fix based on secret type
        const fix = this.generateSecretFix(finding);

        const findingResult: SecurityFixResult['findings'][0] = {
          file: finding.file,
          line: finding.line,
          type: finding.type,
          severity: finding.severity,
          originalCode: finding.preview,
          suggestedFix: fix.replacement,
          explanation: fix.explanation,
          applied: false,
        };

        // Apply fix if requested
        if (options?.apply && fix.replacement) {
          try {
            // Find the line and replace
            const lines = currentContent.split('\n');
            const lineIndex = finding.line - 1;
            if (lineIndex >= 0 && lineIndex < lines.length) {
              const originalLine = lines[lineIndex];
              // Try to apply the fix pattern
              if (fix.pattern) {
                const newLine = originalLine.replace(fix.pattern, fix.replacement);
                if (newLine !== originalLine) {
                  lines[lineIndex] = newLine;
                  currentContent = lines.join('\n');
                  modified = true;
                  findingResult.applied = true;
                  fixesApplied++;
                }
              }
            }
          } catch (e) {
            findingResult.applyError = e instanceof Error ? e.message : String(e);
          }
        }

        fixedFindings.push(findingResult);
      }

      // Write back if modified
      if (modified && options?.apply) {
        // Create backup
        const backupDir = join(dirname(filePath), '.mcp-backups');
        if (!existsSync(backupDir)) {
          mkdirSync(backupDir, { recursive: true });
        }
        const backupPath = join(backupDir, `${basename(filePath)}.${Date.now()}.bak`);
        writeFileSync(backupPath, fileContent);
        backupPaths.push(backupPath);

        // Write updated content
        writeFileSync(filePath, currentContent, 'utf-8');
      }
    }

    return {
      success: true,
      findings: fixedFindings,
      totalFindings: findings.length,
      fixesApplied,
      summary: `Found ${findings.length} security issues${options?.apply ? `, fixed ${fixesApplied}` : ''}`,
      backupPaths: backupPaths.length > 0 ? backupPaths : undefined,
    };
  }

  /**
   * Generate a fix suggestion for a secret finding
   */
  private generateSecretFix(finding: SecretScanFinding): {
    replacement: string;
    explanation: string;
    pattern?: RegExp;
  } {
    const type = finding.type.toLowerCase();

    // Generate environment variable name from secret type
    const envVarName = this.secretTypeToEnvVar(type);

    if (type.includes('api') || type.includes('key')) {
      return {
        replacement: `process.env.${envVarName}`,
        explanation: `Replace hardcoded API key with environment variable ${envVarName}`,
        pattern: /['"][a-zA-Z0-9_-]{20,}['"]/g,
      };
    }

    if (type.includes('password') || type.includes('secret')) {
      return {
        replacement: `process.env.${envVarName}`,
        explanation: `Replace hardcoded password/secret with environment variable ${envVarName}`,
        pattern: /['"][^'"]{8,}['"]/g,
      };
    }

    if (type.includes('connection') || type.includes('url')) {
      return {
        replacement: `process.env.${envVarName}`,
        explanation: `Replace hardcoded connection string with environment variable ${envVarName}`,
        pattern: /['"][a-z]+:\/\/[^'"]+['"]/gi,
      };
    }

    if (type.includes('token')) {
      return {
        replacement: `process.env.${envVarName}`,
        explanation: `Replace hardcoded token with environment variable ${envVarName}`,
        pattern: /['"][a-zA-Z0-9_.-]+['"]/g,
      };
    }

    // Default
    return {
      replacement: `process.env.${envVarName}`,
      explanation: `Replace hardcoded value with environment variable ${envVarName}`,
    };
  }

  /**
   * Convert secret type to environment variable name
   */
  private secretTypeToEnvVar(type: string): string {
    const normalized = type
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    // Common mappings
    const mappings: Record<string, string> = {
      API_KEY: 'API_KEY',
      APIKEY: 'API_KEY',
      OPENAI_KEY: 'OPENAI_API_KEY',
      STRIPE_KEY: 'STRIPE_SECRET_KEY',
      PASSWORD: 'DB_PASSWORD',
      AWS_KEY: 'AWS_ACCESS_KEY_ID',
      AWS_SECRET: 'AWS_SECRET_ACCESS_KEY',
      JWT_TOKEN: 'JWT_SECRET',
      GITHUB_TOKEN: 'GITHUB_TOKEN',
      CONNECTION_STRING: 'DATABASE_URL',
    };

    return mappings[normalized] || normalized;
  }

  /**
   * Aggregate TODO/FIXME comments across codebase
   */
  aggregateTodos(
    root: string,
    options?: {
      groupBy?: 'file' | 'priority' | 'category' | 'type';
      includeContext?: boolean;
      maxResults?: number;
      todoTypes?: TodoItem['type'][];
    }
  ): AggregateTodosResult {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    const includeContext = options?.includeContext ?? true;
    const maxResults = options?.maxResults ?? 100;
    const todos: TodoItem[] = [];

    const configuredTypes = Array.isArray(options?.todoTypes) ? options!.todoTypes : [];
    const types =
      configuredTypes.length > 0
        ? [...new Set(configuredTypes.map((t) => String(t).toUpperCase()))]
        : ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE', 'REFACTOR'];

    // TODO/FIXME patterns (configurable)
    const todoPattern = new RegExp(`\\b(${types.join('|')})[\\s:]+(.+?)(?:\\n|$)`, 'gi');

    const scanDir = (dir: string) => {
      if (todos.length >= maxResults) return;

      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (todos.length >= maxResults) break;

          // Skip hidden files/dirs and common ignores (venv, node_modules, etc.)
          if (entry.name.startsWith('.')) continue;
          if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;

          const fullPath = join(dir, entry.name);

          if (!this.config.isPathAllowed(fullPath)) continue;

          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            this.scanFileForTodos(
              fullPath,
              todoPattern,
              todos,
              resolvedRoot,
              includeContext,
              maxResults
            );
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    scanDir(resolvedRoot);

    // Categorize todos
    for (const todo of todos) {
      todo.category = this.categorizeTodo(todo.content);
      todo.suggestedPriority = this.suggestPriority(todo.type, todo.content);
    }

    // Group by specified criterion
    const groupBy = options?.groupBy ?? 'file';
    const grouped = this.groupTodos(todos, groupBy);

    // Calculate summary
    const byType: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    for (const todo of todos) {
      byType[todo.type] = (byType[todo.type] || 0) + 1;
      byPriority[todo.suggestedPriority] = (byPriority[todo.suggestedPriority] || 0) + 1;
    }

    return {
      todos,
      grouped,
      summary: {
        total: todos.length,
        byType,
        byPriority,
        topFiles: this.getTopFiles(todos),
      },
    };
  }

  /**
   * Answer questions about the codebase
   */
  async codebaseQA(
    question: string,
    options?: {
      searchScope?: string[];
      maxSearchDepth?: number;
      maxSources?: number;
    }
  ): Promise<CodebaseQAResult> {
    const searchScope = options?.searchScope ?? ['.'];
    const maxSources = options?.maxSources ?? 5;

    // First, search for relevant files
    const relevantFiles: Array<{
      file: string;
      relevantLines: { start: number; end: number };
      excerpt: string;
      score: number;
    }> = [];

    // Extract keywords from question
    const keywords = this.extractKeywords(question);

    // Check if this is a factual/trivia question vs a codebase question
    const isCodebaseQuestion = this.isCodebaseRelatedQuestion(question, keywords);

    for (const scopePath of searchScope) {
      const resolvedScope = this.config.resolveWorkspacePath(scopePath);
      if (!this.config.isPathAllowed(resolvedScope)) continue;

      this.searchForRelevance(resolvedScope, keywords, relevantFiles, maxSources * 2);
    }

    // Sort by score and take top results
    relevantFiles.sort((a, b) => b.score - a.score);
    const topSources = relevantFiles.slice(0, maxSources);

    // Build context for LLM
    const contextText = topSources
      .map(
        (s) =>
          `File: ${s.file} (lines ${s.relevantLines.start}-${s.relevantLines.end}):\n\`\`\`\n${s.excerpt}\n\`\`\``
      )
      .join('\n\n');

    let answer: string;
    let confidence: 'high' | 'medium' | 'low';
    let usedSources: typeof topSources = [];

    try {
      // Use an improved prompt that enforces grounding
      const systemPrompt = isCodebaseQuestion
        ? `You are a code assistant answering questions about a codebase.

## GROUNDING RULES (CRITICAL):
1. Answer ONLY based on the provided code context
2. If the context doesn't contain relevant information, say "I couldn't find information about this in the provided code context"
3. NEVER make up information that isn't in the context
4. When citing a source, it MUST contain text that directly supports your answer
5. If the question is about general knowledge (not code-specific), say "This question doesn't appear to be about the codebase"

## RESPONSE FORMAT:
- Be concise but thorough
- Reference specific files and line numbers when applicable
- If uncertain, express that uncertainty`
        : `You are a helpful assistant. The user asked a question that may not be about the codebase.

## GROUNDING RULES:
1. If this is a general knowledge question (like "What is the capital of France?"), answer it directly WITHOUT citing code sources
2. Do NOT cite code files as sources for factual/trivia questions
3. Only cite sources if the question is actually about the code

## RESPONSE FORMAT:
- Answer the question directly if it's general knowledge
- If it IS about code, use the provided context`;

      const responseText = await this.llmWrapper.callToolLlm(
        'codebase_qa',
        [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: isCodebaseQuestion
              ? `Based on the following code context, answer this question: "${question}"\n\nContext:\n${contextText || '(No relevant code context found)'}`
              : `Question: "${question}"\n\n(Code context provided for reference, but may not be relevant):\n${contextText || '(No context)'}`,
          },
        ],
        { type: 'codebase_qa', isCodebaseQuestion }
      );

      answer = responseText;

      // Only include sources if the question is actually about the codebase
      if (isCodebaseQuestion && topSources.length > 0 && topSources[0].score > 2) {
        usedSources = topSources;
        confidence =
          topSources.length >= 3 && topSources[0].score > 5
            ? 'high'
            : topSources.length >= 1 && topSources[0].score > 2
              ? 'medium'
              : 'low';
      } else {
        // For general questions or low-relevance sources, don't cite them
        usedSources = [];
        confidence = isCodebaseQuestion ? 'low' : 'high'; // General knowledge is "high" confidence
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const backendRejectedRequest = /http\s*400|bad request|invalid request|no model loaded/i.test(
        errorMessage
      );

      if (isCodebaseQuestion && topSources.length > 0) {
        usedSources = topSources;
        const sourceRefs = topSources
          .slice(0, 3)
          .map((s) => `${s.file}:${s.relevantLines.start}-${s.relevantLines.end}`)
          .join(', ');
        const evidence = topSources[0]?.excerpt?.replace(/\s+/g, ' ').trim() ?? '';
        const cappedEvidence = evidence.length > 220 ? `${evidence.slice(0, 220)}...` : evidence;
        const prefix = backendRejectedRequest
          ? `LLM backend rejected the request (${errorMessage}).`
          : `LLM backend call failed (${errorMessage}).`;
        answer =
          `${prefix} Returning source-grounded fallback from: ${sourceRefs}.` +
          (cappedEvidence ? ` Top evidence: ${cappedEvidence}` : '');
      } else {
        answer = `Unable to generate answer. Found ${topSources.length} relevant sources but LLM call failed: ${errorMessage}`;
        usedSources = [];
      }

      confidence = 'low';
    }

    // Generate related questions
    const relatedQuestions = this.generateRelatedQuestions(question, usedSources);

    return {
      answer,
      confidence,
      sources: usedSources.map((s) => ({
        file: s.file,
        relevantLines: s.relevantLines,
        excerpt: s.excerpt,
      })),
      relatedQuestions,
    };
  }

  /**
   * Determine if a question is about the codebase vs general knowledge
   */
  private isCodebaseRelatedQuestion(question: string, keywords: string[]): boolean {
    const lowerQuestion = question.toLowerCase();

    // Code-related keywords that suggest a codebase question
    const codeKeywords = [
      'function',
      'class',
      'method',
      'variable',
      'import',
      'export',
      'module',
      'file',
      'code',
      'implement',
      'definition',
      'where',
      'how does',
      'what does',
      'find',
      'search',
      'usage',
      'called',
      'api',
      'interface',
      'type',
      'error',
      'bug',
      'fix',
      'refactor',
      'test',
      'config',
      'setting',
      'database',
      'migration',
      'connection',
    ];

    // Check if question contains code-related keywords
    const hasCodeKeyword = codeKeywords.some((kw) => lowerQuestion.includes(kw));

    // Check if extracted keywords are likely code identifiers
    const hasCodeIdentifiers = keywords.some(
      (kw) =>
        /^[a-z][a-zA-Z0-9_]*$/.test(kw) && // camelCase or snake_case
        kw.length > 3 &&
        !['what', 'when', 'where', 'which', 'about', 'from', 'that', 'this', 'with'].includes(kw)
    );

    // General knowledge question patterns
    const generalPatterns = [
      /^what is the capital of/i,
      /^who (is|was|are)/i,
      /^when (did|was|is)/i,
      /^how many/i,
      /^define /i,
      /^explain (the concept|what)/i,
    ];

    const isGeneralQuestion = generalPatterns.some((p) => p.test(question));

    return !isGeneralQuestion && (hasCodeKeyword || hasCodeIdentifiers);
  }

  /**
   * Analyze test coverage gaps
   */
  async analyzeTestGaps(
    root: string,
    options?: {
      testPatterns?: string[];
      sourcePatterns?: string[];
    }
  ): Promise<TestGapsResult> {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    const testPatterns = options?.testPatterns ?? [
      '*.test.ts',
      '*.test.tsx',
      '*.test.js',
      '*.test.jsx',
      '*.spec.ts',
      '*.spec.js',
      '*.spec.tsx',
      '*.spec.jsx',
      'test_*.py',
      '*_test.py',
      '*.test.py',
    ];
    const sourcePatterns = options?.sourcePatterns ?? ['*.ts', '*.tsx', '*.js', '*.jsx', '*.py'];

    // Collect test files and source files
    const testFiles: string[] = [];
    const sourceFiles: string[] = [];

    const collectFiles = (dir: string) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          if (['node_modules', 'dist', 'build', '__pycache__', '.git'].includes(entry.name))
            continue;

          const fullPath = join(dir, entry.name);

          if (!this.config.isPathAllowed(fullPath)) continue;

          if (entry.isDirectory()) {
            collectFiles(fullPath);
          } else if (entry.isFile()) {
            const relativePath = relative(resolvedRoot, fullPath).replace(/\\/g, '/');
            const isTest = testPatterns.some(
              (p) => this.matchPattern(relativePath, p) || this.matchPattern(entry.name, p)
            );
            const isSource = sourcePatterns.some(
              (p) => this.matchPattern(relativePath, p) || this.matchPattern(entry.name, p)
            );

            if (isTest) {
              testFiles.push(fullPath);
            } else if (isSource) {
              sourceFiles.push(fullPath);
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    collectFiles(resolvedRoot);

    // Analyze which source files have corresponding tests
    const untestedFiles: Array<{
      file: string;
      complexity: 'high' | 'medium' | 'low';
      reason: string;
      suggestedTests: string[];
    }> = [];

    const partiallyTestedFiles: Array<{
      file: string;
      testedFunctions: string[];
      untestedFunctions: string[];
      coverageEstimate: number;
    }> = [];

    // Extract functions from test files
    const testedSymbols = new Set<string>();
    for (const testFile of testFiles) {
      try {
        const content = readFileSync(testFile, 'utf-8');
        // Look for describe/it/test blocks and extract function names
        const importMatch = content.matchAll(/import\s*\{([^}]+)\}\s*from/g);
        for (const match of importMatch) {
          const symbols = match[1].split(',').map((s) => s.trim());
          symbols.forEach((s) => testedSymbols.add(s));
        }
        // Look for direct function calls in tests
        const fnCalls = content.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
        for (const match of fnCalls) {
          testedSymbols.add(match[1]);
        }
      } catch {
        // Skip files we can't read
      }
    }

    // Check each source file
    for (const sourceFile of sourceFiles) {
      try {
        const content = readFileSync(sourceFile, 'utf-8');
        const relativePath = relative(resolvedRoot, sourceFile);
        const normalizedRelativePath = relativePath.replace(/\\/g, '/');

        // Extract exported functions/classes
        const exports = this.extractExports(content);

        // Check if there's a corresponding test file
        const sourceWithoutExt = normalizedRelativePath.replace(/\.[^.]+$/, '');
        const sourceStem = basename(sourceWithoutExt);
        const hasTestFile = testFiles.some((testFilePath) => {
          const normalizedTestPath = relative(resolvedRoot, testFilePath).replace(/\\/g, '/');
          return (
            normalizedTestPath.includes(sourceWithoutExt + '.test') ||
            normalizedTestPath.includes(sourceWithoutExt + '.spec') ||
            normalizedTestPath.endsWith(`/test_${sourceStem}.py`) ||
            normalizedTestPath.endsWith(`/${sourceStem}_test.py`) ||
            normalizedTestPath.endsWith(`/${sourceStem}.test.py`)
          );
        });

        const testedFunctions = exports.filter((e) => testedSymbols.has(e));
        const untestedFunctions = exports.filter((e) => !testedSymbols.has(e));

        if (!hasTestFile && exports.length > 0) {
          // No test file at all
          const complexity = this.estimateComplexity(content);
          untestedFiles.push({
            file: relativePath,
            complexity,
            reason: 'No corresponding test file found',
            suggestedTests: exports.slice(0, 5).map((e) => `Test for ${e}`),
          });
        } else if (untestedFunctions.length > 0 && exports.length > 0) {
          // Partial test coverage
          partiallyTestedFiles.push({
            file: relativePath,
            testedFunctions,
            untestedFunctions,
            coverageEstimate: Math.round((testedFunctions.length / exports.length) * 100),
          });
        }
      } catch {
        // Skip files we can't read
      }
    }

    // Generate recommendations
    const recommendations = this.generateTestRecommendations(untestedFiles, partiallyTestedFiles);

    return {
      untestedFiles,
      partiallyTestedFiles,
      coverageSummary: {
        totalSourceFiles: sourceFiles.length,
        totalTestFiles: testFiles.length,
        untestedCount: untestedFiles.length,
        partiallyTestedCount: partiallyTestedFiles.length,
        estimatedCoverage:
          sourceFiles.length > 0
            ? Math.round(((sourceFiles.length - untestedFiles.length) / sourceFiles.length) * 100)
            : 0,
      },
      recommendations,
    };
  }

  /**
   * Preview redaction of sensitive content without actually redacting
   * Shows what would be redacted and why
   */
  redactionPreview(
    content: string,
    options?: {
      showContext?: boolean;
      contextLines?: number;
    }
  ): RedactionPreviewResult {
    const showContext = options?.showContext ?? true;
    const contextLines = options?.contextLines ?? 2;

    const findings: Array<{
      type: string;
      original: string;
      redacted: string;
      line: number;
      column: number;
      context?: string;
    }> = [];

    const lines = content.split('\n');

    // Patterns that match what RedactionEngine uses
    const patterns = [
      { name: 'OpenAI/Anthropic Key', regex: /['"]?(sk-[a-zA-Z0-9_-]{10,})['"]?/g },
      {
        name: 'API Key Variable',
        regex: /(?:const|let|var)\s+(?:API_?KEY|api_?key)\s*=\s*['"]([^'"]+)['"]/gi,
      },
      {
        name: 'API Key',
        regex: /(?:api[_-]?key|apikey)['":\s]*[=:]?\s*['"]?([a-zA-Z0-9_-]{20,})/gi,
      },
      { name: 'Password', regex: /(?:password|passwd|pwd)['":\s]*[=:]?\s*['"]?([^\s'"]{8,})/gi },
      { name: 'Private Key', regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/g },
      { name: 'AWS Key', regex: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g },
      { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g },
      { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9_\-.]+/gi },
      { name: 'Connection String', regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi },
      { name: 'GitHub Token', regex: /ghp_[A-Za-z0-9]{36}/g },
      { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]+/g },
      {
        name: 'Generic Secret',
        regex: /(?:secret|token)['":\s]*[=:]?\s*['"]?([a-zA-Z0-9_-]{16,})/gi,
      },
    ];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        let match;

        while ((match = pattern.regex.exec(line)) !== null) {
          const original = match[0];
          const redacted = `[REDACTED:${pattern.name}]`;

          let context: string | undefined;
          if (showContext) {
            const start = Math.max(0, lineIndex - contextLines);
            const end = Math.min(lines.length - 1, lineIndex + contextLines);
            context = lines.slice(start, end + 1).join('\n');
          }

          findings.push({
            type: pattern.name,
            original: original.substring(0, 20) + (original.length > 20 ? '...' : ''),
            redacted,
            line: lineIndex + 1,
            column: match.index + 1,
            context,
          });
        }
      }
    }

    // Generate preview with redactions applied
    let previewContent = content;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      previewContent = previewContent.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
    }

    // Calculate statistics
    const byType: Record<string, number> = {};
    for (const finding of findings) {
      byType[finding.type] = (byType[finding.type] || 0) + 1;
    }

    return {
      totalFindings: findings.length,
      findings,
      preview: previewContent,
      summary: {
        byType,
        linesAffected: new Set(findings.map((f) => f.line)).size,
      },
    };
  }

  /**
   * Calculate security risk score for content or a file
   */
  riskScore(
    content: string,
    options?: {
      context?: 'code' | 'config' | 'documentation' | 'unknown';
      strictMode?: boolean;
    }
  ): RiskScoreResult {
    const context = options?.context ?? 'unknown';
    const strictMode = options?.strictMode ?? false;

    const factors: Array<{
      name: string;
      score: number;
      severity: 'critical' | 'high' | 'medium' | 'low';
      description: string;
    }> = [];

    // Check for various risk factors
    const riskChecks = [
      // Critical risks
      {
        name: 'Hardcoded Private Key',
        regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/g,
        score: 40,
        severity: 'critical' as const,
        description: 'Private key found in content',
      },
      {
        name: 'AWS Credentials',
        regex: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
        score: 35,
        severity: 'critical' as const,
        description: 'AWS access key detected',
      },
      {
        name: 'AWS Secret Access Key',
        // Prefer context-bound detection to reduce false positives.
        // Matches common env var / config assignments like:
        // AWS_SECRET_ACCESS_KEY=... or aws_secret_access_key: "..."
        regex:
          /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{30,}['"]?/g,
        score: 35,
        severity: 'critical' as const,
        description: 'AWS secret access key detected',
      },
      {
        name: 'OpenAI/Anthropic Key',
        regex: /['"]?(sk-[a-zA-Z0-9_-]{10,})['"]?/g,
        score: 35,
        severity: 'critical' as const,
        description: 'OpenAI/Anthropic API key detected',
      },
      {
        name: 'Stripe Secret Key',
        regex: /['"]?(sk_(?:live|test)_[A-Za-z0-9]{10,})['"]?/g,
        score: 35,
        severity: 'critical' as const,
        description: 'Stripe secret key detected',
      },
      {
        name: 'GitHub Token',
        regex: /ghp_[A-Za-z0-9]{36}/g,
        score: 35,
        severity: 'critical' as const,
        description: 'GitHub token detected',
      },
      {
        name: 'Hardcoded Password',
        // Match common assignments like:
        // - password=admin123
        // - password: "admin123"
        // - pwd = admin123
        // Keep it bounded to a single line to avoid catastrophic backtracking.
        regex:
          /(?:password|passwd|pwd)\s*[=:]\s*(?:['"][^'"\r\n]{1,120}['"]|[^\s"'`\r\n]{4,120})/gi,
        score: 30,
        severity: 'critical' as const,
        description: 'Hardcoded password found',
      },

      // High risks
      {
        name: 'API Key',
        regex: /(?:api[_-]?key|apikey)['":\s]*[=:]?\s*['"]?[a-zA-Z0-9_-]{20,}/gi,
        score: 20,
        severity: 'high' as const,
        description: 'API key detected',
      },
      {
        name: 'JWT Token',
        regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
        score: 20,
        severity: 'high' as const,
        description: 'JWT token found',
      },
      {
        name: 'Database Connection String',
        regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,
        score: 25,
        severity: 'high' as const,
        description: 'Database connection string with possible credentials',
      },

      // Medium risks
      {
        name: 'Eval Usage',
        regex: /\beval\s*\(/g,
        score: 15,
        severity: 'medium' as const,
        description: 'Use of eval() is a security risk',
      },
      {
        name: 'SQL Injection Risk',
        regex: /`[^`]*\$\{[^}]+\}[^`]*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/gi,
        score: 15,
        severity: 'medium' as const,
        description: 'Possible SQL injection vulnerability',
      },
      {
        name: 'innerHTML Assignment',
        regex: /\.innerHTML\s*=/g,
        score: 10,
        severity: 'medium' as const,
        description: 'innerHTML can lead to XSS vulnerabilities',
      },

      // Low risks (increase score in strict mode)
      {
        name: 'Hardcoded IP Address',
        regex: /\b(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
        score: strictMode ? 10 : 5,
        severity: 'low' as const,
        description: 'Hardcoded private IP address',
      },
      {
        name: 'TODO Security',
        regex: /\/\/\s*TODO:?\s*(?:security|auth|fix\s+vuln)/gi,
        score: strictMode ? 8 : 3,
        severity: 'low' as const,
        description: 'Security-related TODO found',
      },
    ];

    // Apply context-specific adjustments
    const contextMultiplier =
      context === 'config'
        ? 1.5 // Config files are higher risk
        : context === 'code'
          ? 1.0
          : context === 'documentation'
            ? 0.5 // Docs less risky (might be examples)
            : 1.0;

    let totalScore = 0;

    for (const check of riskChecks) {
      check.regex.lastIndex = 0;
      const matches = content.match(check.regex);

      if (matches && matches.length > 0) {
        const adjustedScore = Math.round(check.score * contextMultiplier * matches.length);
        totalScore += adjustedScore;

        factors.push({
          name: check.name,
          score: adjustedScore,
          severity: check.severity,
          description: `${check.description} (${matches.length} occurrence${matches.length > 1 ? 's' : ''})`,
        });
      }
    }

    // Cap score at 100
    const finalScore = Math.min(100, totalScore);

    // Determine risk level
    const riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'minimal' =
      finalScore >= 70
        ? 'critical'
        : finalScore >= 50
          ? 'high'
          : finalScore >= 25
            ? 'medium'
            : finalScore >= 10
              ? 'low'
              : 'minimal';

    // Generate recommendations
    const recommendations: string[] = [];

    const criticalFactors = factors.filter((f) => f.severity === 'critical');
    if (criticalFactors.length > 0) {
      recommendations.push(
        'URGENT: Remove hardcoded secrets and use environment variables or a secrets manager'
      );
    }

    const highFactors = factors.filter((f) => f.severity === 'high');
    if (highFactors.length > 0) {
      recommendations.push(
        'Move sensitive data to secure storage (environment variables, vault, etc.)'
      );
    }

    if (factors.some((f) => f.name.includes('SQL'))) {
      recommendations.push('Use parameterized queries to prevent SQL injection');
    }

    if (factors.some((f) => f.name.includes('eval'))) {
      recommendations.push('Replace eval() with safer alternatives');
    }

    if (factors.some((f) => f.name.includes('innerHTML'))) {
      recommendations.push('Use textContent or DOM methods instead of innerHTML');
    }

    if (recommendations.length === 0) {
      recommendations.push('No critical issues found. Continue following security best practices.');
    }

    return {
      score: finalScore,
      riskLevel,
      factors,
      recommendations,
    };
  }

  /**
   * Analyze the impact of code changes
   */
  async analyzeImpact(
    changedFiles: string[],
    options?: {
      checkDependencies?: boolean;
      checkTests?: boolean;
      checkImports?: boolean;
    }
  ): Promise<AnalyzeImpactResult> {
    const checkTests = options?.checkTests ?? true;
    const checkImports = options?.checkImports ?? true;

    const impactedFiles: Array<{
      file: string;
      impactType: 'direct' | 'imported' | 'test' | 'dependency';
      reason: string;
    }> = [];

    const affectedTests: string[] = [];
    const affectedDependencies: Array<{
      name: string;
      type: 'imports' | 'exports' | 'calls';
    }> = [];

    // Resolve all changed file paths
    const resolvedChangedFiles = changedFiles.map((f) => this.config.resolveWorkspacePath(f));

    // Get exports from changed files
    const changedExports = new Map<string, string[]>();
    for (const file of resolvedChangedFiles) {
      try {
        if (!this.config.isPathAllowed(file)) continue;
        const content = readFileSync(file, 'utf-8');
        const exports = this.extractExports(content);
        changedExports.set(file, exports);

        // Record exported symbols as potentially affected
        for (const exp of exports) {
          affectedDependencies.push({
            name: exp,
            type: 'exports',
          });
        }
      } catch {
        // Skip files we can't read
      }
    }

    // Find files that import from changed files
    if (checkImports) {
      const workspaceRoot = this.config.resolveWorkspacePath('.');
      this.findImportingFiles(workspaceRoot, resolvedChangedFiles, impactedFiles, affectedTests);
    }

    // Find test files that might be affected
    if (checkTests) {
      for (const file of resolvedChangedFiles) {
        const baseName = file.replace(/\.(ts|js)$/, '');
        const testPatterns = [
          baseName + '.test.ts',
          baseName + '.test.js',
          baseName + '.spec.ts',
          baseName + '.spec.js',
        ];

        for (const testPath of testPatterns) {
          try {
            if (readFileSync(testPath)) {
              const relativePath = relative(this.config.resolveWorkspacePath('.'), testPath);
              if (!affectedTests.includes(relativePath)) {
                affectedTests.push(relativePath);
              }
              impactedFiles.push({
                file: relativePath,
                impactType: 'test',
                reason: `Test file for ${relative(this.config.resolveWorkspacePath('.'), file)}`,
              });
            }
          } catch {
            // Test file doesn't exist
          }
        }
      }
    }

    // Calculate risk assessment
    const riskLevel: 'high' | 'medium' | 'low' =
      impactedFiles.length > 10 || affectedTests.length > 5
        ? 'high'
        : impactedFiles.length > 5 || affectedTests.length > 2
          ? 'medium'
          : 'low';

    // Generate suggestions
    const suggestions: string[] = [];

    if (affectedTests.length > 0) {
      suggestions.push(
        `Run these tests: ${affectedTests.slice(0, 3).join(', ')}${affectedTests.length > 3 ? '...' : ''}`
      );
    }

    if (impactedFiles.length > 5) {
      suggestions.push('Consider breaking this change into smaller, incremental changes');
    }

    if (affectedDependencies.length > 0) {
      suggestions.push('Review API changes for backward compatibility');
    }

    if (riskLevel === 'high') {
      suggestions.push('This is a high-impact change. Consider thorough code review.');
    }

    return {
      changedFiles: changedFiles.map((f) =>
        relative(this.config.resolveWorkspacePath('.'), this.config.resolveWorkspacePath(f))
      ),
      impactedFiles,
      affectedTests,
      affectedDependencies,
      riskLevel,
      suggestions,
    };
  }

  /**
   * Find files that import from the changed files
   */
  private findImportingFiles(
    dir: string,
    changedFiles: string[],
    impactedFiles: Array<{
      file: string;
      impactType: 'direct' | 'imported' | 'test' | 'dependency';
      reason: string;
    }>,
    affectedTests: string[]
  ): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (['node_modules', 'dist', 'build', '__pycache__', '.git'].includes(entry.name)) continue;

        const fullPath = join(dir, entry.name);

        if (!this.config.isPathAllowed(fullPath)) continue;

        if (entry.isDirectory()) {
          this.findImportingFiles(fullPath, changedFiles, impactedFiles, affectedTests);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          // Skip the changed files themselves
          if (changedFiles.includes(fullPath)) continue;

          try {
            const content = readFileSync(fullPath, 'utf-8');

            // Check if this file imports from any changed file
            for (const changedFile of changedFiles) {
              // Extract just the module name (without extension)
              const changedFileName = changedFile
                .split(/[/\\]/)
                .pop()
                ?.replace(/\.(ts|js)$/, '');
              if (!changedFileName) continue;

              // Check for actual import statements that reference this file
              // Match patterns like: import ... from './file' or import ... from '../path/file'
              // Also match: require('./file') or require('../path/file')
              const importPatterns = [
                new RegExp(
                  `from\\s+['"][^'"]*[/\\\\]?${escapeRegexLiteral(changedFileName)}(\\.(?:ts|js))?['"]`,
                  'i'
                ),
                new RegExp(
                  `require\\s*\\(\\s*['"][^'"]*[/\\\\]?${escapeRegexLiteral(changedFileName)}(\\.(?:ts|js))?['"]\\s*\\)`,
                  'i'
                ),
                new RegExp(`from\\s+['"]\\.\\.?/${escapeRegexLiteral(changedFileName)}['"]`, 'i'),
              ];

              const hasImport = importPatterns.some((pattern) => pattern.test(content));

              if (hasImport) {
                const relativePath = relative(this.config.resolveWorkspacePath('.'), fullPath);

                // Check if it's a test file
                const isTest = entry.name.includes('.test.') || entry.name.includes('.spec.');

                if (isTest) {
                  if (!affectedTests.includes(relativePath)) {
                    affectedTests.push(relativePath);
                  }
                }

                impactedFiles.push({
                  file: relativePath,
                  impactType: isTest ? 'test' : 'imported',
                  reason: `Imports from ${relative(this.config.resolveWorkspacePath('.'), changedFile)}`,
                });

                break; // Don't add same file multiple times
              }
            }
          } catch {
            // Skip files we can't read
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private collectFiles(
    root: string,
    scope: 'file' | 'directory' | 'repo',
    maxFiles: number,
    include?: string[],
    exclude?: string[]
  ): string[] {
    const files: string[] = [];

    const defaultExclude = ['node_modules', 'dist', 'build', '.git', '__pycache__'];
    const effectiveExclude = [...defaultExclude, ...(exclude || [])];

    const scanDir = (dir: string, depth: number) => {
      if (files.length >= maxFiles) return;
      if (scope === 'file' && depth > 0) return;
      if (scope === 'directory' && depth > 1) return;

      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (files.length >= maxFiles) break;
          if (entry.name.startsWith('.')) continue;
          if (effectiveExclude.includes(entry.name)) continue;

          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            // Check include patterns
            if (include && include.length > 0) {
              if (!include.some((p) => this.matchPattern(entry.name, p))) {
                continue;
              }
            }
            files.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    scanDir(root, 0);
    return files;
  }

  private generateQuickSummary(file: string, lines: string[]): string {
    const ext = extname(file);
    const lineCount = lines.length;

    // Count functions/classes
    let functionCount = 0;
    let classCount = 0;

    for (const line of lines) {
      if (/^\s*(export\s+)?(async\s+)?function\s+/.test(line)) functionCount++;
      if (/^\s*(export\s+)?class\s+/.test(line)) classCount++;
      if (/^\s*(const|let)\s+\w+\s*=\s*(async\s+)?\(/.test(line)) functionCount++;
    }

    return `${ext} file with ${lineCount} lines, ${functionCount} functions, ${classCount} classes`;
  }

  private generateSuggestedQuestions(query: string, files: GatherContextResult['files']): string[] {
    const questions: string[] = [];

    if (files.some((f) => f.relevance === 'high')) {
      questions.push(`What are the key functions in the most relevant files?`);
    }
    if (files.length > 5) {
      questions.push(`Are there any dependencies between these ${files.length} files?`);
    }
    questions.push(`What changes would be needed to implement "${query}"?`);
    questions.push(`Are there any potential breaking changes to consider?`);

    return questions.slice(0, 3);
  }

  /**
   * Scan file with context-aware false positive filtering
   * V18 (QA_feedback_5): Enhanced with entropy-based filtering
   */
  private scanFileWithContext(
    filePath: string,
    patterns: Array<{
      name: string;
      regex: RegExp;
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    }>,
    findings: SecretScanFinding[],
    root: string,
    isFalsePositiveContext: (line: string) => boolean
  ): void {
    // Skip binary files to avoid false positives
    const binaryExtensions = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.ico',
      '.webp',
      '.svg',
      '.tiff',
      '.mp3',
      '.wav',
      '.ogg',
      '.mp4',
      '.avi',
      '.mkv',
      '.mov',
      '.webm',
      '.zip',
      '.tar',
      '.gz',
      '.rar',
      '.7z',
      '.bz2',
      '.exe',
      '.dll',
      '.so',
      '.dylib',
      '.bin',
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.woff',
      '.woff2',
      '.ttf',
      '.otf',
      '.eot',
      '.db',
      '.sqlite',
      '.sqlite3',
      '.pyc',
      '.pyo',
      '.class',
      '.o',
      '.a',
      '.wasm',
    ]);
    const ext = extname(filePath).toLowerCase();
    if (binaryExtensions.has(ext)) {
      return;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.includes('\0')) return; // Skip binary content

      const lines = content.split('\n');
      const relativePath = relative(root, filePath);
      const normalizedRelativePath = relativePath.replace(/\\/g, '/');
      const isTestFile =
        /(^|\/)(tests?|__tests__|fixtures?)(\/|$)/i.test(normalizedRelativePath) ||
        /(^|\/)test_[^/]+\.py$/i.test(normalizedRelativePath) ||
        /(^|\/)[^/]+_test\.py$/i.test(normalizedRelativePath) ||
        /\.spec\.(ts|js|tsx|jsx)$/i.test(normalizedRelativePath) ||
        /\.test\.(ts|js|tsx|jsx)$/i.test(normalizedRelativePath);

      // V18: Also check for mock_data, fixtures, examples directories
      const isTestDataFile = /(^|\/)(mock_data|test_data|fixtures|examples|samples)(\/|$)/i.test(
        normalizedRelativePath
      );

      const shouldDowngradeInTests = (patternName: string) => {
        if (!isTestFile && !isTestDataFile) return false;
        // Keep high-confidence secrets at full severity
        const highConfidence = new Set([
          'OpenAI/Anthropic Key',
          'Stripe Key',
          'Private Key',
          'AWS Key',
          'AWS Secret Access Key',
          'GitHub Token',
          'Slack Token',
          'JWT Token',
          'Connection String',
        ]);
        if (highConfidence.has(patternName)) return false;
        // These are common in fixtures/tests and often represent dummy values
        return (
          patternName === 'Password' ||
          patternName === 'Generic Secret' ||
          patternName === 'Hardcoded Key Assignment'
        );
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip lines that look like false positives
        if (isFalsePositiveContext(line)) continue;

        // V18: Skip environment variable assignments (e.g., password = os.getenv(...))
        if (
          /(?:os\.getenv|os\.environ|process\.env|Environment\.GetEnvironmentVariable)\s*\(/.test(
            line
          )
        ) {
          continue;
        }

        // V18: Skip function/method parameter declarations with password in name
        // e.g., def validate_password(password: str):
        if (
          /def\s+\w*password\w*\s*\(|function\s+\w*[Pp]assword\w*\s*\(|password\s*:\s*(?:str|string|String)/i.test(
            line
          )
        ) {
          continue;
        }

        for (const pattern of patterns) {
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(line);

          if (match) {
            // V18: Extract the matched secret value and check entropy
            // Only apply entropy check to patterns that might produce false positives
            const matchedValue = match[1] || match[0];

            // High-confidence patterns should NEVER be filtered by entropy
            // These are specific enough that false positives are unlikely
            const highConfidencePatterns = new Set([
              'Private Key',
              'OpenAI/Anthropic Key',
              'Stripe Key',
              'AWS Key',
              'AWS Secret Access Key',
              'GitHub Token',
              'Slack Token',
              'JWT Token',
              'Connection String',
              'Bearer Token',
            ]);

            // Only apply entropy check to patterns that commonly produce false positives
            if (!highConfidencePatterns.has(pattern.name)) {
              // Skip if the matched value looks like a placeholder (low entropy)
              if (isLikelyPlaceholder(matchedValue)) {
                continue;
              }
            }

            findings.push({
              severity: shouldDowngradeInTests(pattern.name) ? 'info' : pattern.severity,
              type: pattern.name,
              file: normalizedRelativePath,
              line: i + 1,
              preview: this.redaction.redact(line.trim().substring(0, 100)),
              recommendation: this.getRecommendation(pattern.name),
            });
          }
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  private getRecommendation(type: string): string {
    const recommendations: Record<string, string> = {
      'API Key': 'Move to environment variables or secrets manager',
      Password: 'Use environment variables or secure vault',
      'Private Key': 'Store in secure key management system',
      'AWS Key': 'Use IAM roles or AWS Secrets Manager',
      'JWT Token': 'Generate tokens dynamically, never hardcode',
      'Bearer Token': 'Use OAuth flow or secure token storage',
      'Connection String': 'Use environment variables for connection strings',
      'GitHub Token': 'Use GitHub Actions secrets or environment variables',
      'Slack Token': 'Store in secure secrets management',
      'Generic Secret': 'Review and move to secure storage if sensitive',
      'SQL Injection Risk': 'Use parameterized queries',
      'Eval Usage': 'Avoid eval; use safer alternatives',
      'innerHTML Assignment': 'Use textContent or DOM methods instead',
      'Hardcoded IP': 'Use configuration or service discovery',
    };
    return recommendations[type] || 'Review and address security concern';
  }

  private scanFileForTodos(
    filePath: string,
    pattern: RegExp,
    todos: TodoItem[],
    root: string,
    includeContext: boolean,
    maxResults: number
  ): void {
    if (todos.length >= maxResults) return;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relativePath = relative(root, filePath);

      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(content)) !== null && todos.length < maxResults) {
        const lineIndex = content.substring(0, match.index).split('\n').length - 1;
        const type = match[1].toUpperCase() as TodoItem['type'];
        const todoContent = match[2].trim();

        let context = '';
        if (includeContext) {
          const start = Math.max(0, lineIndex - 2);
          const end = Math.min(lines.length - 1, lineIndex + 2);
          context = lines.slice(start, end + 1).join('\n');
        }

        todos.push({
          file: relativePath,
          line: lineIndex + 1,
          type,
          content: todoContent,
          context,
          suggestedPriority: 'medium',
          category: 'uncategorized',
        });
      }
    } catch {
      // Skip files we can't read
    }
  }

  private categorizeTodo(content: string): string {
    const lower = content.toLowerCase();

    if (lower.includes('refactor') || lower.includes('cleanup') || lower.includes('clean up')) {
      return 'refactoring';
    }
    if (lower.includes('bug') || lower.includes('fix') || lower.includes('broken')) {
      return 'bug';
    }
    if (lower.includes('feature') || lower.includes('implement') || lower.includes('add')) {
      return 'feature';
    }
    if (lower.includes('test') || lower.includes('coverage')) {
      return 'testing';
    }
    if (lower.includes('doc') || lower.includes('comment')) {
      return 'documentation';
    }
    if (lower.includes('perf') || lower.includes('optim') || lower.includes('slow')) {
      return 'performance';
    }
    if (lower.includes('secur') || lower.includes('vulnerab')) {
      return 'security';
    }

    return 'general';
  }

  private suggestPriority(type: string, content: string): 'high' | 'medium' | 'low' {
    // FIXME and BUG are high priority
    if (type === 'FIXME' || type === 'BUG') return 'high';

    // HACK and XXX suggest technical debt
    if (type === 'HACK' || type === 'XXX') return 'high';

    // Check content for urgency indicators
    const lower = content.toLowerCase();
    if (lower.includes('critical') || lower.includes('urgent') || lower.includes('asap')) {
      return 'high';
    }
    if (lower.includes('later') || lower.includes('eventually') || lower.includes('nice to have')) {
      return 'low';
    }

    return 'medium';
  }

  private groupTodos(
    todos: TodoItem[],
    groupBy: 'file' | 'priority' | 'category' | 'type'
  ): Record<string, TodoItem[]> {
    const grouped: Record<string, TodoItem[]> = {};

    for (const todo of todos) {
      const key =
        groupBy === 'file'
          ? todo.file
          : groupBy === 'priority'
            ? todo.suggestedPriority
            : groupBy === 'category'
              ? todo.category
              : todo.type;

      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(todo);
    }

    return grouped;
  }

  private getTopFiles(todos: TodoItem[]): Array<{ file: string; count: number }> {
    const counts: Record<string, number> = {};
    for (const todo of todos) {
      counts[todo.file] = (counts[todo.file] || 0) + 1;
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }));
  }

  private extractKeywords(question: string): string[] {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      'what',
      'where',
      'how',
      'why',
      'when',
      'is',
      'are',
      'the',
      'a',
      'an',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
    ]);
    return question
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  private searchForRelevance(
    dir: string,
    keywords: string[],
    results: Array<{
      file: string;
      relevantLines: { start: number; end: number };
      excerpt: string;
      score: number;
    }>,
    maxResults: number
  ): void {
    if (results.length >= maxResults) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith('.')) continue;

        // Expanded exclusion list for generated/artifact directories
        const excludeDirs = [
          'node_modules',
          'dist',
          'build',
          '__pycache__',
          '.git',
          // Generated artifacts (Analysis_3 feedback)
          'analysis_reports',
          'test-results',
          'coverage',
          'reports',
          'logs',
          'output',
          'artifacts',
          'evidence',
          '.next',
          '.nuxt',
          'vendor',
          'target',
          'out',
          'bin',
          'obj',
        ];
        if (excludeDirs.includes(entry.name)) continue;

        const fullPath = join(dir, entry.name);

        if (!this.config.isPathAllowed(fullPath)) continue;

        if (entry.isDirectory()) {
          this.searchForRelevance(fullPath, keywords, results, maxResults);
        } else if (entry.isFile()) {
          this.scoreFileRelevance(fullPath, keywords, results);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  private scoreFileRelevance(
    filePath: string,
    keywords: string[],
    results: Array<{
      file: string;
      relevantLines: { start: number; end: number };
      excerpt: string;
      score: number;
    }>
  ): void {
    try {
      // Skip generated/artifact files based on path patterns
      const lowerPath = filePath.toLowerCase();
      const artifactPatterns = [
        '/analysis_reports/',
        '/test-results/',
        '/coverage/',
        '/logs/',
        '/output/',
        '/artifacts/',
        '/evidence/',
        'report_summary',
        'test_output',
        'analysis_output',
      ];
      if (artifactPatterns.some((p) => lowerPath.includes(p))) {
        return; // Skip generated artifacts entirely
      }

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const lower = content.toLowerCase();
      const fileNameLower = filePath.toLowerCase();

      let score = 0;
      let bestLineStart = 0;
      let bestLineEnd = 0;
      let maxLineScore = 0;

      // Score based on keyword matches in content
      for (const keyword of keywords) {
        const matches = lower.split(keyword).length - 1;
        score += matches;

        // Bonus points for filename match (very relevant)
        if (fileNameLower.includes(keyword)) {
          score += 10;
        }
      }

      if (score === 0) return;

      // File type weighting: prefer code files over documentation
      const ext = filePath.toLowerCase().split('.').pop() || '';
      const codeExtensions = ['ts', 'js', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'go', 'rs'];
      const docExtensions = ['md', 'txt', 'rst', 'adoc'];
      const dataExtensions = ['json', 'yaml', 'yml', 'xml'];

      if (codeExtensions.includes(ext)) {
        score *= 2; // Double score for code files
        // Extra bonus for src/ directories
        if (lowerPath.includes('/src/') || lowerPath.includes('\\src\\')) {
          score *= 1.5;
        }
      } else if (docExtensions.includes(ext)) {
        score *= 0.5; // Halve score for documentation files
      } else if (dataExtensions.includes(ext)) {
        // JSON/YAML files that look like reports or analysis outputs get heavily penalized
        if (
          lowerPath.includes('report') ||
          lowerPath.includes('analysis') ||
          lowerPath.includes('result') ||
          lowerPath.includes('output')
        ) {
          score *= 0.1; // 90% penalty for report-like data files
        } else {
          score *= 0.7; // Moderate penalty for other data files
        }
      }

      // Find the most relevant lines
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        let lineScore = 0;
        for (const keyword of keywords) {
          if (lineLower.includes(keyword)) lineScore++;
        }
        if (lineScore > maxLineScore) {
          maxLineScore = lineScore;
          bestLineStart = Math.max(0, i - 5);
          bestLineEnd = Math.min(lines.length - 1, i + 10);
        }
      }

      const excerpt = this.redaction.redact(lines.slice(bestLineStart, bestLineEnd + 1).join('\n'));

      results.push({
        file: filePath,
        relevantLines: { start: bestLineStart + 1, end: bestLineEnd + 1 },
        excerpt: excerpt.substring(0, 1000),
        score,
      });
    } catch {
      // Skip files we can't read
    }
  }

  private generateRelatedQuestions(
    _question: string,
    sources: Array<{ file: string; relevantLines: { start: number; end: number }; excerpt: string }>
  ): string[] {
    const questions: string[] = [];

    if (sources.length > 0) {
      questions.push(`What other files interact with ${sources[0].file}?`);
    }
    questions.push(`How can this be tested?`);
    questions.push(`What are the potential edge cases?`);

    return questions.slice(0, 3);
  }

  private matchPattern(filename: string, pattern: string): boolean {
    // Handle simple extension patterns like *.ts
    if (pattern.startsWith('*.') && !pattern.includes('/') && !pattern.includes('{')) {
      return filename.endsWith(pattern.slice(1));
    }

    // Handle brace expansion patterns like *.{test,spec}.ts
    if (pattern.includes('{') && pattern.includes('}')) {
      const braceMatch = pattern.match(/\{([^}]+)\}/);
      if (braceMatch) {
        const options = braceMatch[1].split(',');
        const prefix = pattern.slice(0, pattern.indexOf('{'));
        const suffix = pattern.slice(pattern.indexOf('}') + 1);
        return options.some((opt) => {
          const expandedPattern = prefix + opt + suffix;
          return this.matchPattern(filename, expandedPattern);
        });
      }
    }

    // Handle glob patterns with ** or * by converting to regex
    if (pattern.includes('*') || pattern.includes('?')) {
      const regexPattern = globToRegexSource(pattern, {
        starMatchesSlash: false,
        supportGlobstar: true,
      });
      try {
        const regex = new RegExp(`^${regexPattern}$`, 'i');
        return regex.test(filename);
      } catch {
        // If regex compilation fails, fall back to simple match
        return filename === pattern;
      }
    }

    return filename === pattern;
  }

  /**
   * Return concise include-pattern recommendations for improving scan coverage.
   * Keeps guidance focused so small models can apply it reliably.
   */
  private getSecurityIncludeGuidance(
    projectType: string,
    scanType: 'secrets' | 'vulnerabilities' | 'both'
  ): string[] {
    const byProjectType: Record<string, string[]> = {
      typescript: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.env*'],
      javascript: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.env*'],
      python: ['**/*.py', '**/*.pyw', '**/*.env*', '**/*.ini', '**/*.yaml'],
      go: ['**/*.go', '**/*.env*', '**/*.yaml', '**/*.json'],
      rust: ['**/*.rs', '**/*.toml', '**/*.env*', '**/*.yaml'],
      java: ['**/*.java', '**/*.kt', '**/*.kts', '**/*.properties', '**/*.yaml'],
      csharp: ['**/*.cs', '**/*.fs', '**/*.json', '**/*.env*', '**/*.yaml'],
      ruby: ['**/*.rb', '**/*.env*', '**/*.yaml', '**/*.json'],
      php: ['**/*.php', '**/*.env*', '**/*.yaml', '**/*.json'],
      unknown: ['**/*.ts', '**/*.js', '**/*.py', '**/*.env*', '**/*.yaml'],
    };

    const base = byProjectType[projectType] ?? byProjectType.unknown;
    const secretHeavy = ['**/*.env*', '**/*.key', '**/*.pem'];

    if (scanType === 'secrets') {
      // Prioritize secret-prone files first, then language files.
      return [...secretHeavy, ...base].slice(0, 6);
    }

    if (scanType === 'vulnerabilities') {
      return base.slice(0, 5);
    }

    return [...base.slice(0, 5), '**/*.env*'];
  }

  private extractExports(content: string): string[] {
    const exports = new Set<string>();

    // Export function
    const fnMatches = content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g);
    for (const match of fnMatches) exports.add(match[1]);

    // Export class
    const classMatches = content.matchAll(/export\s+class\s+(\w+)/g);
    for (const match of classMatches) exports.add(match[1]);

    // Export const/let arrow functions
    const constMatches = content.matchAll(/export\s+const\s+(\w+)\s*=/g);
    for (const match of constMatches) exports.add(match[1]);

    // Python module symbols
    const pyFnMatches = content.matchAll(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm);
    for (const match of pyFnMatches) {
      if (!match[1].startsWith('test_')) exports.add(match[1]);
    }
    const pyClassMatches = content.matchAll(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/gm);
    for (const match of pyClassMatches) exports.add(match[1]);

    return Array.from(exports);
  }

  private estimateComplexity(content: string): 'high' | 'medium' | 'low' {
    const lines = content.split('\n').length;
    const functionCount =
      (content.match(/function\s+\w+/g) || []).length +
      (content.match(/^\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/gm) || []).length;
    const classCount =
      (content.match(/class\s+\w+/g) || []).length +
      (content.match(/^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\s*[:(]/gm) || []).length;

    const score = lines / 50 + functionCount * 2 + classCount * 3;

    if (score > 20) return 'high';
    if (score > 10) return 'medium';
    return 'low';
  }

  private generateTestRecommendations(
    untestedFiles: Array<{
      file: string;
      complexity: string;
      reason: string;
      suggestedTests: string[];
    }>,
    partiallyTestedFiles: Array<{
      file: string;
      untestedFunctions: string[];
      coverageEstimate: number;
    }>
  ): string[] {
    const recommendations: string[] = [];

    const highComplexityUntested = untestedFiles.filter((f) => f.complexity === 'high');
    if (highComplexityUntested.length > 0) {
      recommendations.push(
        `Priority: Add tests for ${highComplexityUntested.length} high-complexity untested files`
      );
    }

    const lowCoverage = partiallyTestedFiles.filter((f) => f.coverageEstimate < 50);
    if (lowCoverage.length > 0) {
      recommendations.push(
        `Improve coverage: ${lowCoverage.length} files have less than 50% coverage`
      );
    }

    if (untestedFiles.length > partiallyTestedFiles.length) {
      recommendations.push('Focus on adding test files for untested modules');
    } else {
      recommendations.push('Focus on improving coverage of existing test files');
    }

    return recommendations;
  }
}
