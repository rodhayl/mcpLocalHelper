import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { performance } from 'perf_hooks';
import { ConfigManager } from '../config/index.js';
import {
  SymbolInfo,
  IndexSymbolsResult,
  ImportInfo,
  CrossFileLinksResult,
  StructuredSearchMatch,
  StructuredSearchResult,
} from '../types/index.js';
import { generatePathSuggestions } from '../utils/structured-errors.js';

interface CachedIndex {
  symbols: SymbolInfo[];
  timestamp: number;
  root: string;
}

/**
 * SymbolIndexer - Lightweight symbol indexing using regex heuristics
 * Phase 5 implementation for symbol-aware search and navigation
 */
export class SymbolIndexer {
  private config: ConfigManager;
  private cache: Map<string, CachedIndex> = new Map();
  private cacheTTL: number = 30000; // 30 seconds cache

  // Language extension mappings
  // Language extension mappings - supports both full names and short aliases
  private languageExtensions: Record<string, string[]> = {
    // TypeScript
    typescript: ['.ts', '.tsx', '.mts', '.cts'],
    ts: ['.ts', '.tsx', '.mts', '.cts'],
    tsx: ['.tsx'],
    // JavaScript
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
    js: ['.js', '.jsx', '.mjs', '.cjs'],
    jsx: ['.jsx'],
    // Python
    python: ['.py', '.pyw', '.pyi'],
    py: ['.py', '.pyw', '.pyi'],
  };

  // Regex patterns for symbol detection by language
  private patterns: Record<string, Record<string, RegExp[]>> = {
    typescript: {
      function: [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm,
        /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm,
      ],
      class: [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm],
      interface: [/^\s*(?:export\s+)?interface\s+(\w+)/gm],
      type: [/^\s*(?:export\s+)?type\s+(\w+)\s*=/gm],
      enum: [/^\s*(?:export\s+)?enum\s+(\w+)/gm],
      variable: [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/gm],
      constant: [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm],
    },
    javascript: {
      function: [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm,
        /^\s*(\w+)\s*\([^)]*\)\s*\{/gm, // Method in object
      ],
      class: [/^\s*(?:export\s+)?class\s+(\w+)/gm],
      variable: [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/gm],
      constant: [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm],
    },
    python: {
      function: [/^(?:async\s+)?def\s+(\w+)\s*\(/gm],
      class: [/^class\s+(\w+)/gm],
      variable: [
        /^([A-Z][A-Z0-9_]*)\s*=/gm, // Module-level constants
        /^(\w+)\s*:\s*\w+\s*=/gm, // Type-annotated variables
      ],
    },
    // Short aliases for patterns - mirror full names
    py: {
      function: [/^(?:async\s+)?def\s+(\w+)\s*\(/gm],
      class: [/^class\s+(\w+)/gm],
      variable: [/^([A-Z][A-Z0-9_]*)\s*=/gm, /^(\w+)\s*:\s*\w+\s*=/gm],
    },
    ts: {
      function: [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm,
        /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm,
      ],
      class: [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm],
      interface: [/^\s*(?:export\s+)?interface\s+(\w+)/gm],
      type: [/^\s*(?:export\s+)?type\s+(\w+)\s*=/gm],
      enum: [/^\s*(?:export\s+)?enum\s+(\w+)/gm],
      variable: [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/gm],
      constant: [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm],
    },
    tsx: {
      function: [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm,
        /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm,
      ],
      class: [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm],
      interface: [/^\s*(?:export\s+)?interface\s+(\w+)/gm],
      type: [/^\s*(?:export\s+)?type\s+(\w+)\s*=/gm],
      enum: [/^\s*(?:export\s+)?enum\s+(\w+)/gm],
      variable: [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/gm],
      constant: [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm],
    },
    js: {
      function: [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm,
        /^\s*(\w+)\s*\([^)]*\)\s*\{/gm,
      ],
      class: [/^\s*(?:export\s+)?class\s+(\w+)/gm],
      variable: [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/gm],
      constant: [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm],
    },
    jsx: {
      function: [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
        /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/gm,
        /^\s*(\w+)\s*\([^)]*\)\s*\{/gm,
      ],
      class: [/^\s*(?:export\s+)?class\s+(\w+)/gm],
      variable: [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/gm],
      constant: [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm],
    },
  };

  // Import patterns by language
  private importPatterns: Record<string, RegExp[]> = {
    typescript: [
      /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    javascript: [
      /import\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    python: [/^from\s+([\w.]+)\s+import\s+(.+)/gm, /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm],
    // Short aliases for import patterns
    ts: [
      /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    tsx: [
      /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    js: [
      /import\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    jsx: [
      /import\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    py: [/^from\s+([\w.]+)\s+import\s+(.+)/gm, /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm],
  };

  constructor(config: ConfigManager) {
    this.config = config;
  }

  /**
   * JavaScript/TypeScript keywords that should not be treated as function names
   */
  private jsKeywords = new Set([
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'return',
    'throw',
    'try',
    'catch',
    'finally',
    'new',
    'delete',
    'typeof',
    'instanceof',
    'void',
    'this',
    'super',
    'with',
    'yield',
    'await',
    'import',
    'export',
    'default',
    'class',
    'extends',
    'const',
    'let',
    'var',
    'function',
    'get',
    'set',
    'static',
    'public',
    'private',
    'protected',
    'async',
  ]);

  /**
   * Get the language from file extension
   */
  private getLanguage(filePath: string): string | null {
    const ext = extname(filePath).toLowerCase();
    for (const [lang, exts] of Object.entries(this.languageExtensions)) {
      if (exts.includes(ext)) {
        return lang;
      }
    }
    return null;
  }

  /**
   * Check if a symbol is exported based on line content
   */
  private isExported(line: string): boolean {
    return /^\s*export\s+/.test(line);
  }

  /**
   * Extract symbols from file content
   */
  private extractSymbols(content: string, filePath: string, language: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const lines = content.split('\n');
    const patterns = this.patterns[language];

    if (!patterns) {
      return symbols;
    }

    // Track seen symbols to avoid duplicates
    const seen = new Set<string>();

    // Determine if this is a JS/TS file for keyword filtering
    const isJsTs = ['typescript', 'ts', 'tsx', 'javascript', 'js', 'jsx'].includes(language);

    for (const [symbolType, regexList] of Object.entries(patterns)) {
      for (const regex of regexList) {
        // Reset regex
        regex.lastIndex = 0;
        let match;

        while ((match = regex.exec(content)) !== null) {
          const symbolName = match[1];
          if (!symbolName) continue;

          // Skip JavaScript/TypeScript keywords that may be matched by overly broad regexes
          // (e.g., "if (condition) {" should not be treated as a function named "if")
          if (isJsTs && symbolType === 'function' && this.jsKeywords.has(symbolName)) {
            continue;
          }

          // Find line number
          const textBefore = content.substring(0, match.index);
          const lineNumber = textBefore.split('\n').length;

          // Create unique key
          const key = `${symbolName}:${symbolType}:${lineNumber}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Get the full line for signature extraction
          const line = lines[lineNumber - 1] || '';
          const exported = this.isExported(line);

          // Skip constants that are already captured as variables (unless truly constants)
          if (symbolType === 'constant' && seen.has(`${symbolName}:variable:${lineNumber}`)) {
            continue;
          }

          // Extract signature (first 100 chars of declaration)
          const signature = line.trim().substring(0, 100);

          symbols.push({
            name: symbolName,
            type: symbolType as SymbolInfo['type'],
            file: filePath,
            line: lineNumber,
            exported,
            signature: signature.length >= 100 ? signature + '...' : signature,
          });
        }
      }
    }

    return symbols;
  }

  /**
   * Find all source files in directory
   */
  private findSourceFiles(root: string, languages: string[]): string[] {
    const files: string[] = [];
    const allowedExtensions = new Set<string>();

    for (const lang of languages) {
      const exts = this.languageExtensions[lang];
      if (exts) {
        exts.forEach((ext) => allowedExtensions.add(ext));
      }
    }

    const walk = (dir: string) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          // Skip hidden and common ignore patterns
          if (
            entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === '__pycache__' ||
            entry.name === 'dist' ||
            entry.name === 'build' ||
            entry.name === 'coverage'
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase();
            if (allowedExtensions.has(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    walk(root);
    return files;
  }

  /**
   * Index symbols in workspace
   */
  indexSymbols(
    root: string,
    options: {
      languages?: string[];
      symbolTypes?: string[];
    } = {}
  ): IndexSymbolsResult {
    const startTime = performance.now();
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    const languages = options.languages || ['typescript', 'javascript', 'python'];

    // Build language extensions set for filtering
    const langExtensions = new Set<string>();
    for (const lang of languages) {
      const exts = this.languageExtensions[lang];
      if (exts) {
        exts.forEach((ext) => langExtensions.add(ext));
      }
    }

    // Check cache - but we still need to filter by language
    const cacheKey = resolvedRoot;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      // Filter cached results by language and symbol types
      let symbols = cached.symbols;

      // Filter by language
      symbols = symbols.filter((s) => {
        const ext = extname(s.file).toLowerCase();
        return langExtensions.has(ext);
      });

      // Filter by symbol types
      if (options.symbolTypes?.length) {
        symbols = symbols.filter((s) => options.symbolTypes!.includes(s.type));
      }
      return {
        indexed: symbols.length,
        symbols,
        indexDuration: 0,
        languages,
      };
    }

    // For non-cached case, find and index files
    const files = this.findSourceFiles(resolvedRoot, ['typescript', 'javascript', 'python']); // Always scan all
    const allSymbols: SymbolInfo[] = [];
    const detectedLanguages = new Set<string>();

    for (const filePath of files) {
      try {
        const language = this.getLanguage(filePath);
        if (!language) continue;

        const content = readFileSync(filePath, 'utf-8');
        const symbols = this.extractSymbols(content, filePath, language);
        allSymbols.push(...symbols);
        if (symbols.length > 0) {
          detectedLanguages.add(language);
        }
      } catch {
        // Skip files we can't read
      }
    }

    // Cache the unfiltered results (all languages)
    this.cache.set(cacheKey, {
      symbols: allSymbols,
      timestamp: Date.now(),
      root: resolvedRoot,
    });

    // Now filter by requested languages and symbol types
    let filteredSymbols = allSymbols.filter((s) => {
      const ext = extname(s.file).toLowerCase();
      return langExtensions.has(ext);
    });

    if (options.symbolTypes?.length) {
      filteredSymbols = filteredSymbols.filter((s) => options.symbolTypes!.includes(s.type));
    }

    const duration = Math.max(0.001, performance.now() - startTime);

    return {
      indexed: filteredSymbols.length,
      symbols: filteredSymbols,
      indexDuration: duration,
      languages: Array.from(detectedLanguages).filter((lang) => languages.includes(lang)),
    };
  }

  /**
   * Extract imports from file content
   */
  private extractImports(content: string, filePath: string, language: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const patterns = this.importPatterns[language];

    if (!patterns) {
      return imports;
    }

    const fileDir = dirname(filePath);

    for (const regex of patterns) {
      regex.lastIndex = 0;
      let match;

      while ((match = regex.exec(content)) !== null) {
        let source: string;
        let symbols: string[] = [];
        let isTypeOnly = false;

        if (language === 'python') {
          // Python import patterns
          if (match[0].startsWith('from')) {
            source = match[1];
            symbols = match[2].split(',').map((s) => s.trim().split(' as ')[0].trim());
          } else {
            source = match[1];
            symbols = match[2] ? [match[2]] : [match[1].split('.').pop()!];
          }
        } else {
          // JavaScript/TypeScript import patterns
          source = match[4] || match[1];
          isTypeOnly = match[0].includes('import type');

          if (match[1]) {
            // Named imports
            symbols = match[1]
              .split(',')
              .map((s) => {
                const parts = s.trim().split(/\s+as\s+/);
                return parts[0].trim();
              })
              .filter((s) => s.length > 0);
          } else if (match[2]) {
            // Default import
            symbols = [match[2]];
          } else if (match[3]) {
            // Namespace import
            symbols = [`* as ${match[3]}`];
          }
        }

        if (!source) continue;

        // Try to resolve the import path
        let resolvedPath: string | null = null;
        if (source.startsWith('.')) {
          // Relative import
          const possiblePath = resolve(fileDir, source);
          const extensions = this.languageExtensions[language] || [];

          for (const ext of extensions) {
            const withExt = possiblePath + ext;
            if (existsSync(withExt)) {
              resolvedPath = withExt;
              break;
            }
            const indexPath = join(possiblePath, `index${ext}`);
            if (existsSync(indexPath)) {
              resolvedPath = indexPath;
              break;
            }
          }

          // Check if it exists as-is
          if (!resolvedPath && existsSync(possiblePath)) {
            resolvedPath = possiblePath;
          }
        } else if (!source.startsWith('@') && !source.includes('/')) {
          // Bare module specifier (like 'fs', 'path') - skip resolution as these are built-ins or node_modules
          // resolvedPath stays null, which is correct
        } else {
          // Package imports (like '@modelcontextprotocol/sdk/server/index.js' or 'lodash/debounce')
          // Try to resolve from node_modules in the workspace
          const workspaceRoot = this.config.getDefaultWorkspaceRoot();
          const nodeModulesPath = join(workspaceRoot, 'node_modules', source);

          // Try exact path first (for paths with extensions like .js)
          if (existsSync(nodeModulesPath)) {
            resolvedPath = nodeModulesPath;
          } else {
            // Try with common extensions
            const extensions = this.languageExtensions[language] || ['.js', '.ts', '.mjs', '.cjs'];
            for (const ext of extensions) {
              const withExt = nodeModulesPath + ext;
              if (existsSync(withExt)) {
                resolvedPath = withExt;
                break;
              }
              // Try index file in directory
              const indexPath = join(nodeModulesPath, `index${ext}`);
              if (existsSync(indexPath)) {
                resolvedPath = indexPath;
                break;
              }
            }

            // Try package.json main field resolution
            if (!resolvedPath) {
              const pkgJsonPath = join(nodeModulesPath, 'package.json');
              if (existsSync(pkgJsonPath)) {
                try {
                  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
                  const mainField = pkgJson.main || pkgJson.module || 'index.js';
                  const mainPath = join(nodeModulesPath, mainField);
                  if (existsSync(mainPath)) {
                    resolvedPath = mainPath;
                  }
                } catch {
                  // Ignore parse errors
                }
              }
            }
          }
        }

        imports.push({
          source,
          resolvedPath,
          symbols,
          isTypeOnly,
        });
      }
    }

    return imports;
  }

  /**
   * Analyze cross-file links starting from entry points
   */
  crossFileLinks(
    entryPoints: string[],
    options: {
      depth?: number;
      includeTypes?: boolean;
    } = {}
  ): CrossFileLinksResult {
    const maxDepth = options.depth ?? 3;
    const includeTypes = options.includeTypes ?? true;

    const fileData: Map<
      string,
      {
        path: string;
        imports: ImportInfo[];
        importedBy: Set<string>;
      }
    > = new Map();

    const edges: Array<{ from: string; to: string }> = [];
    const visited = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [];

    // Initialize with entry points
    for (const entry of entryPoints) {
      const resolvedPath = this.config.resolveWorkspacePath(entry);
      if (this.config.isPathAllowed(resolvedPath) && existsSync(resolvedPath)) {
        queue.push({ path: resolvedPath, depth: 0 });
      }
    }

    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;

      if (visited.has(path) || depth > maxDepth) {
        continue;
      }
      visited.add(path);

      const language = this.getLanguage(path);
      if (!language) continue;

      try {
        const content = readFileSync(path, 'utf-8');
        const imports = this.extractImports(content, path, language);

        // Filter type-only imports if requested
        const filteredImports = includeTypes ? imports : imports.filter((i) => !i.isTypeOnly);

        // Initialize file data
        if (!fileData.has(path)) {
          fileData.set(path, {
            path,
            imports: [],
            importedBy: new Set(),
          });
        }
        fileData.get(path)!.imports = filteredImports;

        // Process resolved imports
        for (const imp of filteredImports) {
          if (imp.resolvedPath) {
            // Add to queue for processing
            if (!visited.has(imp.resolvedPath) && depth < maxDepth) {
              queue.push({ path: imp.resolvedPath, depth: depth + 1 });
            }

            // Track importedBy
            if (!fileData.has(imp.resolvedPath)) {
              fileData.set(imp.resolvedPath, {
                path: imp.resolvedPath,
                imports: [],
                importedBy: new Set(),
              });
            }
            fileData.get(imp.resolvedPath)!.importedBy.add(path);

            // Add edge
            edges.push({ from: path, to: imp.resolvedPath });
          }
        }
      } catch {
        // Skip files we can't read
      }
    }

    // Build result
    const files = Array.from(fileData.values()).map((fd) => ({
      path: fd.path,
      imports: fd.imports,
      importedBy: Array.from(fd.importedBy),
    }));

    return {
      files,
      graph: {
        nodes: Array.from(visited),
        edges,
      },
    };
  }

  /**
   * Perform structured search combining grep + symbol analysis
   */
  structuredSearch(
    root: string,
    query: string,
    options: {
      targetType?: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'any';
      languages?: string[];
      maxResults?: number;
    } = {}
  ): StructuredSearchResult {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    // EXPLICIT PATH VALIDATION - provide clear feedback for invalid paths
    // This ensures structured search errors consistently like intelligent search
    if (!existsSync(resolvedRoot)) {
      const workspaceRoots = this.config.getWorkspaceRoots();
      const pathHints = generatePathSuggestions(root, workspaceRoots);
      throw new Error(
        `Path not found: '${root}' does not exist. ` +
          `Resolved to: '${resolvedRoot}'. ` +
          `Please verify the path is correct and accessible. ` +
          (pathHints.length > 0 ? pathHints.join(' ') : '')
      );
    }

    const stats = statSync(resolvedRoot);
    if (!stats.isDirectory()) {
      throw new Error(
        `Invalid path: '${root}' is not a directory. ` +
          `The 'root' parameter must be a directory path to search.`
      );
    }

    const targetType = options.targetType || 'any';
    const maxResults = options.maxResults || 50;
    const languages = options.languages || ['typescript', 'javascript', 'python'];

    // First, get all symbols
    const indexResult = this.indexSymbols(root, { languages });
    const symbols = indexResult.symbols;

    // Filter symbols by type if specified
    const candidateSymbols =
      targetType === 'any' ? symbols : symbols.filter((s) => s.type === targetType);

    // Path query handling: if query looks like a file path, return symbols from that file
    const normalizedQuery = query.replace(/\\/g, '/').trim();
    const looksLikePath =
      normalizedQuery.includes('/') || /\.[a-z0-9]{1,6}$/i.test(normalizedQuery);
    if (looksLikePath) {
      let resolvedQueryPath: string | null = null;
      try {
        resolvedQueryPath = this.config.resolveWorkspacePath(query).replace(/\\/g, '/');
      } catch {
        resolvedQueryPath = null;
      }

      const matchesInFile = candidateSymbols.filter((symbol) => {
        const symbolFile = symbol.file.replace(/\\/g, '/');
        if (resolvedQueryPath && symbolFile === resolvedQueryPath) return true;
        return symbolFile.endsWith(normalizedQuery);
      });

      if (matchesInFile.length > 0) {
        const matches = matchesInFile.map((symbol) => {
          let preview = symbol.signature || '';
          try {
            const content = readFileSync(symbol.file, 'utf-8');
            const lines = content.split('\n');
            const startLine = Math.max(0, symbol.line - 1);
            const endLine = Math.min(lines.length, symbol.line + 4);
            preview = lines.slice(startLine, endLine).join('\n');
          } catch {
            // Use signature as fallback
          }

          return {
            file: symbol.file,
            symbolName: symbol.name,
            symbolType: symbol.type,
            startLine: symbol.line,
            endLine: symbol.line + 4,
            preview,
            relevanceScore: 1,
          };
        });

        return {
          matches: matches.slice(0, maxResults),
          totalMatches: matches.length,
        };
      }
    }

    // Score and rank symbols by query relevance
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 0);

    const scoredMatches: Array<StructuredSearchMatch & { score: number }> = [];

    for (const symbol of candidateSymbols) {
      const nameLower = symbol.name.toLowerCase();
      let score = 0;

      // Exact match
      if (nameLower === queryLower) {
        score += 100;
      }
      // Starts with query
      else if (nameLower.startsWith(queryLower)) {
        score += 50;
      }
      // Contains query
      else if (nameLower.includes(queryLower)) {
        score += 30;
      }

      // Word matching
      for (const word of queryWords) {
        if (nameLower.includes(word)) {
          score += 10;
        }
        // Camel case matching
        const camelParts = symbol.name.split(/(?=[A-Z])/).map((p) => p.toLowerCase());
        if (camelParts.some((p) => p.startsWith(word))) {
          score += 15;
        }
      }

      // Signature matching (if available)
      if (symbol.signature) {
        const sigLower = symbol.signature.toLowerCase();
        for (const word of queryWords) {
          if (sigLower.includes(word)) {
            score += 5;
          }
        }
      }

      // Boost exported symbols
      if (symbol.exported) {
        score += 5;
      }

      if (score > 0) {
        // Read a few lines around the symbol for preview
        let preview = symbol.signature || '';
        try {
          const content = readFileSync(symbol.file, 'utf-8');
          const lines = content.split('\n');
          const startLine = Math.max(0, symbol.line - 1);
          const endLine = Math.min(lines.length, symbol.line + 4);
          preview = lines.slice(startLine, endLine).join('\n');
        } catch {
          // Use signature as fallback
        }

        scoredMatches.push({
          file: symbol.file,
          symbolName: symbol.name,
          symbolType: symbol.type,
          startLine: symbol.line,
          endLine: symbol.line + 4,
          preview,
          relevanceScore: Math.min(score / 100, 1),
          score,
        });
      }
    }

    // Sort by score and limit results
    scoredMatches.sort((a, b) => b.score - a.score);
    const topMatches = scoredMatches.slice(0, maxResults);

    // Remove internal score field
    const matches: StructuredSearchMatch[] = topMatches.map(({ score: _score, ...rest }) => rest);

    return {
      matches,
      totalMatches: scoredMatches.length,
    };
  }

  /**
   * Invalidate cache for a specific root or all
   */
  invalidateCache(root?: string): void {
    if (root) {
      const resolvedRoot = this.config.resolveWorkspacePath(root);
      this.cache.delete(resolvedRoot);
    } else {
      this.cache.clear();
    }
  }
}
