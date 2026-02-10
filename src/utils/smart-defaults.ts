/**
 * Smart Defaults - Plan 4: Smart Defaults & Filters
 *
 * Provides intelligent default exclude patterns and auto-detection
 * of project-specific patterns to reduce noise in searches and scans.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type { SmartDefaultsConfig } from '../types/index.js';

/**
 * Default exclude patterns for common noise directories
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  // Package managers
  'node_modules/**',
  '.pnpm/**',
  'bower_components/**',

  // Version control
  '.git/**',
  '.svn/**',
  '.hg/**',

  // Python virtual environments
  'venv/**',
  '.venv/**',
  'env/**',
  '.env/**',
  '__pycache__/**',
  '*.pyc',
  '.pytest_cache/**',
  '.mypy_cache/**',
  '.tox/**',
  'site-packages/**',
  // V12: Generic cache pattern (catches .ruff_cache, .uv_cache, etc.)
  '**/*_cache/**',
  '**/.*_cache/**',

  // Build outputs
  'dist/**',
  'dist_package/**',
  'build/**',
  'out/**',
  'output/**',
  'target/**',
  'tmp_test_dist/**',

  // Test outputs and coverage
  'coverage/**',
  '.coverage',
  '.nyc_output/**',
  'test-results/**',
  '*.lcov',

  // Reports and archives (often noisy/generated)
  'reports/**',
  'analysis_reports/**',
  'analysis-reports/**',
  'ARCHIVED/**',
  'TEST_PROMPTS/REPORTS/**',
  'TEST_PROMPTS/ARCHIVED/**',

  // Framework caches
  '.next/**',
  '.nuxt/**',
  '.cache/**',
  '.parcel-cache/**',
  '.turbo/**',

  // IDE and editor
  '.idea/**',
  '.vscode/**',
  '.mcp-backups/**',
  '*.swp',
  '*.swo',
  '*~',

  // OS files
  '.DS_Store',
  'Thumbs.db',

  // Lock files (large, rarely useful for code search)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Pipfile.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',

  // Minified/bundled files
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.chunk.js',
  '*.map',

  // Binary and media files
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.svg',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp3',
  '*.mp4',
  '*.webm',
  '*.pdf',
  '*.zip',
  '*.tar.gz',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',

  // Logs
  '*.log',
  'logs/**',
  'npm-debug.log*',

  // Temporary files
  'tmp/**',
  'temp/**',
  '.tmp/**',
];

/**
 * Project-specific patterns that can be auto-detected
 */
interface ProjectPattern {
  /** Marker file or directory that indicates this pattern applies */
  indicator: string;
  /** Additional exclude patterns for this project type */
  excludePatterns: string[];
  /** Project type for logging/debugging */
  type: string;
}

export const PROJECT_PATTERNS: ProjectPattern[] = [
  {
    indicator: 'package.json',
    type: 'node',
    excludePatterns: ['node_modules/**', '.npm/**'],
  },
  {
    indicator: 'tsconfig.json',
    type: 'typescript',
    excludePatterns: ['dist/**', 'build/**', '*.js.map'],
  },
  {
    indicator: 'requirements.txt',
    type: 'python',
    excludePatterns: ['venv/**', '.venv/**', '__pycache__/**', '*.egg-info/**'],
  },
  {
    indicator: 'Pipfile',
    type: 'python-pipenv',
    excludePatterns: ['.venv/**', '__pycache__/**'],
  },
  {
    indicator: 'pyproject.toml',
    type: 'python-poetry',
    excludePatterns: ['.venv/**', '__pycache__/**', 'dist/**'],
  },
  {
    indicator: 'Cargo.toml',
    type: 'rust',
    excludePatterns: ['target/**'],
  },
  {
    indicator: 'go.mod',
    type: 'go',
    excludePatterns: ['vendor/**'],
  },
  {
    indicator: 'pom.xml',
    type: 'java-maven',
    excludePatterns: ['target/**', '.mvn/**'],
  },
  {
    indicator: 'build.gradle',
    type: 'java-gradle',
    excludePatterns: ['build/**', '.gradle/**'],
  },
  {
    indicator: 'composer.json',
    type: 'php',
    excludePatterns: ['vendor/**'],
  },
  {
    indicator: 'Gemfile',
    type: 'ruby',
    excludePatterns: ['vendor/bundle/**', '.bundle/**'],
  },
  {
    indicator: '.next',
    type: 'nextjs',
    excludePatterns: ['.next/**', 'out/**'],
  },
  {
    indicator: '.nuxt',
    type: 'nuxtjs',
    excludePatterns: ['.nuxt/**', '.output/**'],
  },
  {
    indicator: 'angular.json',
    type: 'angular',
    excludePatterns: ['dist/**', '.angular/**'],
  },
  {
    indicator: 'docker-compose.yml',
    type: 'docker',
    excludePatterns: [],
  },
  {
    indicator: 'Dockerfile',
    type: 'docker',
    excludePatterns: [],
  },
];

/**
 * Smart Defaults Manager
 * Auto-detects project type and provides appropriate exclude patterns
 */
export class SmartDefaultsManager {
  private config: SmartDefaultsConfig;
  private detectedPatterns: Set<string> = new Set();
  private projectTypes: Set<string> = new Set();

  constructor(config?: Partial<SmartDefaultsConfig>) {
    this.config = {
      excludePatterns: config?.excludePatterns ?? [...DEFAULT_EXCLUDE_PATTERNS],
      autoDetectExcludes: config?.autoDetectExcludes ?? config?.autoDetect ?? true,
      includePatterns: config?.includePatterns ?? config?.customIncludePatterns,
      customExcludePatterns: config?.customExcludePatterns ?? [],
    };

    // Merge custom exclude patterns
    if (this.config.customExcludePatterns && this.config.customExcludePatterns.length > 0) {
      for (const p of this.config.customExcludePatterns) {
        this.config.excludePatterns.push(p);
      }
    }
  }

  /**
   * Initialize with a workspace root - auto-detect project type
   */
  initialize(workspaceRoot: string): void {
    if (!this.config.autoDetectExcludes) return;
    if (!existsSync(workspaceRoot)) return;

    // Clear previous detection
    this.detectedPatterns.clear();
    this.projectTypes.clear();

    // Check for project indicators
    for (const { indicator, excludePatterns, type } of PROJECT_PATTERNS) {
      const indicatorPath = join(workspaceRoot, indicator);
      if (existsSync(indicatorPath)) {
        this.projectTypes.add(type);
        for (const pattern of excludePatterns) {
          this.detectedPatterns.add(pattern);
        }
      }
    }
  }

  /**
   * Detect project type from directory
   */
  detectProjectType(directory: string): string {
    if (!existsSync(directory)) return 'unknown';

    for (const { indicator, type } of PROJECT_PATTERNS) {
      const indicatorPath = join(directory, indicator);
      if (existsSync(indicatorPath)) {
        return type;
      }
    }

    return 'unknown';
  }

  /**
   * Get exclude patterns for a specific project directory
   */
  getExcludePatternsForProject(directory: string): string[] {
    const patterns = new Set<string>();

    // Add default patterns
    for (const p of DEFAULT_EXCLUDE_PATTERNS) {
      patterns.add(p);
    }

    // Add project-specific patterns
    if (existsSync(directory)) {
      for (const { indicator, excludePatterns } of PROJECT_PATTERNS) {
        const indicatorPath = join(directory, indicator);
        if (existsSync(indicatorPath)) {
          for (const p of excludePatterns) {
            patterns.add(p);
          }
        }
      }
    }

    return Array.from(patterns);
  }

  /**
   * Get all exclude patterns (default + detected + config)
   */
  getExcludePatterns(): string[] {
    const patterns = new Set<string>();

    // Add default patterns
    for (const p of DEFAULT_EXCLUDE_PATTERNS) {
      patterns.add(p);
    }

    // Add configured patterns
    for (const p of this.config.excludePatterns) {
      patterns.add(p);
    }

    // Add auto-detected patterns
    if (this.config.autoDetectExcludes) {
      for (const p of this.detectedPatterns) {
        patterns.add(p);
      }
    }

    return Array.from(patterns);
  }

  /**
   * Get include patterns (override excludes)
   */
  getIncludePatterns(): string[] | undefined {
    return this.config.includePatterns;
  }

  /**
   * Check if a path should be excluded
   */
  shouldExclude(path: string): boolean {
    const excludePatterns = this.getExcludePatterns();

    for (const pattern of excludePatterns) {
      if (this.matchPattern(path, pattern)) {
        // Check if explicitly included
        const includePatterns = this.getIncludePatterns();
        if (includePatterns) {
          for (const incPattern of includePatterns) {
            if (this.matchPattern(path, incPattern)) {
              return false; // Include overrides exclude
            }
          }
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   */
  private matchPattern(path: string, pattern: string): boolean {
    // Normalize path separators
    const normalizedPath = path.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Convert glob to regex
    let regexStr = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*\*/g, '<<<GLOBSTAR>>>') // Temp placeholder
      .replace(/\*/g, '[^/]*') // Single star matches non-slash
      .replace(/<<<GLOBSTAR>>>/g, '.*') // Double star matches anything
      .replace(/\?/g, '.'); // Question mark matches single char

    // Add anchors
    regexStr = `^${regexStr}$|^${regexStr}/|/${regexStr}$|/${regexStr}/`;

    try {
      const regex = new RegExp(regexStr, 'i');
      return regex.test(normalizedPath);
    } catch {
      return false;
    }
  }

  /**
   * Get detected project types
   */
  getProjectTypes(): string[] {
    return Array.from(this.projectTypes);
  }

  /**
   * Filter a list of paths, removing excluded ones
   */
  filterPaths(paths: string[]): string[] {
    return paths.filter((p) => !this.shouldExclude(p));
  }

  /**
   * Get project context for a directory - used by agent for smarter execution
   * Returns detected project type, languages, and relevant patterns
   */
  getProjectContext(directory: string): {
    projectType: string;
    detectedTypes: string[];
    languages: string[];
    excludePatterns: string[];
    hasPackageJson: boolean;
    hasPyProject: boolean;
    hasCargoToml: boolean;
    hasGoMod: boolean;
  } {
    const projectType = this.detectProjectType(directory);
    const detectedTypes: string[] = [];
    const languages: string[] = [];
    const excludePatterns = new Set<string>();

    // Add default excludes
    for (const p of DEFAULT_EXCLUDE_PATTERNS) {
      excludePatterns.add(p);
    }

    // Detect all project types and their languages
    const indicatorToLanguage: Record<string, string> = {
      'package.json': 'javascript',
      'tsconfig.json': 'typescript',
      'requirements.txt': 'python',
      Pipfile: 'python',
      'pyproject.toml': 'python',
      'Cargo.toml': 'rust',
      'go.mod': 'go',
      'pom.xml': 'java',
      'build.gradle': 'java',
      'composer.json': 'php',
      Gemfile: 'ruby',
    };

    for (const { indicator, excludePatterns: patterns, type } of PROJECT_PATTERNS) {
      const indicatorPath = join(directory, indicator);
      if (existsSync(indicatorPath)) {
        detectedTypes.push(type);
        for (const p of patterns) {
          excludePatterns.add(p);
        }
        const lang = indicatorToLanguage[indicator];
        if (lang && !languages.includes(lang)) {
          languages.push(lang);
        }
      }
    }

    return {
      projectType,
      detectedTypes,
      languages,
      excludePatterns: Array.from(excludePatterns),
      hasPackageJson: existsSync(join(directory, 'package.json')),
      hasPyProject:
        existsSync(join(directory, 'pyproject.toml')) ||
        existsSync(join(directory, 'requirements.txt')),
      hasCargoToml: existsSync(join(directory, 'Cargo.toml')),
      hasGoMod: existsSync(join(directory, 'go.mod')),
    };
  }

  /**
   * Get a simple list of directory names to skip during file operations
   * Used by grep.ts and runner.ts for consistent exclusion patterns
   */
  getSimpleExcludeDirs(): string[] {
    // Extract directory names from DEFAULT_EXCLUDE_PATTERNS that end with /**
    const dirs = new Set<string>();

    for (const pattern of DEFAULT_EXCLUDE_PATTERNS) {
      // Match patterns like 'node_modules/**', 'venv/**', '.git/**'
      const match = pattern.match(/^([^*/]+)\/\*\*$/);
      if (match) {
        dirs.add(match[1]);
      }
    }

    // Also add common directories that might not be in the pattern list
    dirs.add('node_modules');
    dirs.add('.git');
    dirs.add('dist');
    dirs.add('build');
    dirs.add('venv');
    dirs.add('.venv');
    dirs.add('__pycache__');
    dirs.add('.pytest_cache');
    dirs.add('site-packages');
    dirs.add('target');
    dirs.add('vendor');
    dirs.add('.next');
    dirs.add('.nuxt');
    dirs.add('coverage');

    return Array.from(dirs);
  }

  /**
   * Get a summary of the current configuration
   */
  getSummary(): {
    projectTypes: string[];
    excludePatternsCount: number;
    autoDetectEnabled: boolean;
  } {
    return {
      projectTypes: this.getProjectTypes(),
      excludePatternsCount: this.getExcludePatterns().length,
      autoDetectEnabled: this.config.autoDetectExcludes,
    };
  }
}

// Singleton instance
let instance: SmartDefaultsManager | null = null;

export function getSmartDefaultsManager(
  config?: Partial<SmartDefaultsConfig>
): SmartDefaultsManager {
  if (!instance) {
    instance = new SmartDefaultsManager(config);
  }
  return instance;
}

export function resetSmartDefaultsManager(): void {
  instance = null;
}

// NOTE: Dead code removed (V13 cleanup):
// - isBinaryExtension, isNoiseDirectory
// These were exported but never imported anywhere in production code.
// For binary file extension checking, use BINARY_FILE_EXTENSIONS from validation-enhanced.ts
