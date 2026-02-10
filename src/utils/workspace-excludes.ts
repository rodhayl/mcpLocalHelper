/**
 * Default Workspace Excludes
 *
 * Shared constants for workspace directory/file exclusion patterns.
 * Used by summarize, search, workspace, and other tools to reduce noise.
 *
 * QA_feedback_6.md Analysis Task:
 * - Implement robust default ignore list (node_modules, .git, __pycache__, dist)
 * - Apply consistently across all tools
 */

/**
 * Default directories to exclude from workspace operations.
 * These are common build artifacts, caches, and third-party dependencies
 * that should not be included in searches, summaries, or analysis.
 */
export const DEFAULT_WORKSPACE_EXCLUDES = [
  // Version control
  '.git',
  '.svn',
  '.hg',

  // Node.js / JavaScript / TypeScript
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.vite',

  // Python
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.eggs',
  '*.egg-info',
  'site-packages',

  // Java / JVM
  'target',
  '.gradle',
  '.m2',

  // Go
  'vendor',

  // Rust
  'target',

  // .NET / C#
  'bin',
  'obj',
  'packages',

  // General build/coverage
  'coverage',
  '.coverage',
  'htmlcov',

  // IDE / Editor
  '.idea',
  '.vscode',
  '*.swp',
  '*.swo',

  // Test artifacts
  'test-results',
  '.nyc_output',

  // Logs
  'logs',
  '*.log',

  // Temp
  'tmp',
  'temp',
  '.tmp',

  // Documentation build
  '_build',
  'site',
  'docs/_build',

  // Archives
  'ARCHIVED',
  '.mcp-backups',
];

/**
 * Default file patterns to exclude from workspace operations.
 * These are generated files, caches, and binary artifacts.
 */
export const DEFAULT_FILE_EXCLUDES = [
  // Lock files (large, not useful for code analysis)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Pipfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',

  // Generated source maps
  '*.map',
  '*.js.map',
  '*.css.map',

  // Compiled files
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.a',
  '*.so',
  '*.dll',
  '*.dylib',
  '*.wasm',

  // Large binary files
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.webp',
  '*.svg',
  '*.mp3',
  '*.mp4',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.rar',
  '*.pdf',
  '*.doc',
  '*.docx',
  '*.xls',
  '*.xlsx',
  '*.ppt',
  '*.pptx',
];

/**
 * Get combined exclude patterns for a specific tool.
 * Tools can extend these defaults with additional patterns.
 */
export function getDefaultExcludes(toolName?: string): string[] {
  const baseExcludes = [...DEFAULT_WORKSPACE_EXCLUDES];

  // Tool-specific additions
  switch (toolName) {
    case 'summarize':
      // Summarize should skip all lock files and test artifacts
      return [...baseExcludes, ...DEFAULT_FILE_EXCLUDES.slice(0, 10)];

    case 'search':
      // Search needs file excludes too to avoid scanning binary files
      return [...baseExcludes, ...DEFAULT_FILE_EXCLUDES];

    case 'security':
      // Security scan should check more files but skip obvious non-code
      return [...baseExcludes.filter((p) => !p.includes('test'))];

    default:
      return baseExcludes;
  }
}

/**
 * Check if a path matches any exclude pattern.
 */
export function matchesExcludePattern(path: string, excludePatterns: string[]): boolean {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();

  return excludePatterns.some((pattern) => {
    const normalizedPattern = pattern.toLowerCase();

    // Handle glob patterns
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
      return regex.test(normalizedPath) || regex.test(normalizedPath.split('/').pop() || '');
    }

    // Handle directory patterns (exact match or as path component)
    return (
      normalizedPath === normalizedPattern ||
      normalizedPath.includes('/' + normalizedPattern + '/') ||
      normalizedPath.includes('/' + normalizedPattern) ||
      normalizedPath.startsWith(normalizedPattern + '/') ||
      normalizedPath.endsWith('/' + normalizedPattern)
    );
  });
}
