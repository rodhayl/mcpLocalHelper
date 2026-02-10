/**
 * Code Analysis Tools - Migrated from Python myMcpServer
 *
 * These tools provide code similarity and duplication detection:
 * - duplicateFileFinder: Find files similar to a given filename
 * - similarFunctionFinder: Find similar functions using AST analysis
 * - duplicateCodeFinder: Find duplicate code spans using token winnowing
 * - codeQualityAnalyzer: Comprehensive code quality analysis
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative, extname, basename, dirname } from 'path';
import { ConfigManager } from '../config/index.js';
import { levenshteinDistance } from '../utils/string-distance.js';
import * as ts from 'typescript';

// ============================================
// Types
// ============================================

interface DuplicateFileResult {
  path: string;
  score: number;
  size: number;
  reasons: string[];
}

interface SimilarFunctionResult {
  path: string;
  function: string;
  lines: [number, number];
  score: number;
  reasons: string[];
}

interface DuplicateCodeOccurrence {
  path: string;
  start_line: number;
  end_line: number;
}

interface DuplicateCodeGroup {
  score: number;
  occurrences: DuplicateCodeOccurrence[];
  reasons: string[];
}

interface CodeQualityIssue {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface CodeQualityResult {
  total_issues: number;
  by_type: Record<string, number>;
  by_severity: Record<string, number>;
  issues: CodeQualityIssue[];
  /** True when analysis stopped early (timeout / budget / internal limits). */
  partial?: boolean;
  /** Total elapsed time in milliseconds. */
  elapsedMs?: number;
  /** Total files discovered under the root (pre-filter). */
  filesDiscovered?: number;
  /** Total files analyzed (post-filter, best-effort). */
  filesAnalyzed?: number;
  /** Best-effort warnings / skipped sections. */
  warnings?: string[];
}

interface FunctionInfo {
  name: string;
  start: number;
  end: number;
  tokens: string[];
  shingles: Set<string>;
}

// ============================================
// Utility Functions
// ============================================

const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  '.venv',
  '__pycache__',
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
  '.mypy_cache',
  '.pytest_cache',
  'coverage',
  '.next',
  '.nuxt',
]);

function isSkippedDir(name: string): boolean {
  return DEFAULT_SKIP_DIRS.has(name) || name.startsWith('.');
}

function readTextFile(path: string, maxBytes = 128 * 1024): string | null {
  try {
    const buffer = readFileSync(path);
    // Check for binary content (null bytes)
    if (buffer.includes(0)) {
      return null;
    }
    return buffer.slice(0, maxBytes).toString('utf-8');
  } catch {
    return null;
  }
}

function shingles(text: string, k = 5): Set<string> {
  const normalized = text.split(/\s+/).join(' ');
  if (normalized.length < k) {
    return new Set([normalized]);
  }
  const result = new Set<string>();
  for (let i = 0; i <= normalized.length - k; i++) {
    result.add(normalized.slice(i, i + k));
  }
  return result;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const item of a) {
    if (b.has(item)) intersect++;
  }
  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fuzzyMatch(a: string, b: string): number {
  // Simple Levenshtein-based similarity
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  if (longer.length === 0) return 100;

  const distance = levenshteinDistance(longer.toLowerCase(), shorter.toLowerCase());
  return ((longer.length - distance) / longer.length) * 100;
}

function walkDirectory(root: string, maxFiles = 10000): Array<{ path: string; size: number }> {
  const files: Array<{ path: string; size: number }> = [];
  let scanned = 0;

  function walk(dir: string) {
    if (scanned >= maxFiles) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (scanned >= maxFiles) break;

        if (entry.isDirectory()) {
          if (!isSkippedDir(entry.name)) {
            walk(join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          try {
            const fullPath = join(dir, entry.name);
            const stats = statSync(fullPath);
            files.push({ path: fullPath, size: stats.size });
            scanned++;
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walk(root);
  return files;
}

// ============================================
// Token-based Analysis
// ============================================

function tokenize(text: string, language: string): { tokens: string[]; lines: number[] } {
  const tokens: string[] = [];
  const lines: number[] = [];
  let lineNum = 1;
  let i = 0;

  const keywords = new Set([
    'return',
    'if',
    'else',
    'for',
    'while',
    'switch',
    'case',
    'break',
    'continue',
    'function',
    'def',
    'class',
    'const',
    'let',
    'var',
    'public',
    'private',
    'static',
    'try',
    'catch',
    'finally',
    'new',
    'delete',
    'import',
    'from',
    'export',
    'async',
    'await',
  ]);

  while (i < text.length) {
    const ch = text[i];

    // Newline
    if (ch === '\n') {
      lineNum++;
      i++;
      continue;
    }

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') lineNum++;
        i++;
      }
      i += 2;
      continue;
    }

    // Python comment
    if (ch === '#' && language === 'python') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        if (text[i] === '\n') lineNum++;
        i++;
      }
      tokens.push('STR');
      lines.push(lineNum);
      continue;
    }

    // Number
    if (/\d/.test(ch)) {
      while (i < text.length && /[\d.]/.test(text[i])) i++;
      tokens.push('NUM');
      lines.push(lineNum);
      continue;
    }

    // Identifier
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) {
        ident += text[i];
        i++;
      }
      const lower = ident.toLowerCase();
      if (keywords.has(lower)) {
        tokens.push(lower === 'function' ? 'def' : lower);
      } else {
        tokens.push('ID');
      }
      lines.push(lineNum);
      continue;
    }

    // Punctuation
    if ('()[]{}.,;:+-*/%&|^!<>=?'.includes(ch)) {
      if (ch !== ';' && ch !== '}') {
        tokens.push(ch === '{' ? ':' : ch);
        lines.push(lineNum);
      }
      i++;
      continue;
    }

    // Default: single char
    tokens.push(ch);
    lines.push(lineNum);
    i++;
  }

  return { tokens, lines };
}

function kgrams(tokens: string[], k: number): string[] {
  if (tokens.length < k) return [];
  const result: string[] = [];
  for (let i = 0; i <= tokens.length - k; i++) {
    result.push(tokens.slice(i, i + k).join(' '));
  }
  return result;
}

function blakeHash(s: string): bigint {
  const hash = createHash('blake2b512').update(s).digest();
  return BigInt('0x' + hash.slice(0, 8).toString('hex'));
}

function winnowHashes(kgramList: string[], window: number): Array<[bigint, number]> {
  if (kgramList.length === 0) return [];

  const hashes = kgramList.map(blakeHash);
  const w = Math.max(1, window);

  if (w <= 2) {
    return hashes.map((h, i) => [h, i] as [bigint, number]);
  }

  const fps: Array<[bigint, number]> = [];
  let lastPos = -1;

  for (let i = 0; i <= hashes.length - w; i++) {
    const windowSlice = hashes.slice(i, i + w);
    const minVal = windowSlice.reduce((a, b) => (a < b ? a : b));
    let pos = i;
    for (let j = w - 1; j >= 0; j--) {
      if (windowSlice[j] === minVal) {
        pos = i + j;
        break;
      }
    }

    if (fps.length === 0 || pos !== lastPos || minVal !== fps[fps.length - 1][0]) {
      fps.push([minVal, pos]);
      lastPos = pos;
    }
  }

  return fps;
}

// ============================================
// Function Extraction (TypeScript/JavaScript)
// ============================================

function extractFunctionsFromTS(content: string, filePath: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  try {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    function visit(node: ts.Node) {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

        let name = '<anonymous>';
        if (ts.isFunctionDeclaration(node) && node.name) {
          name = node.name.text;
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          name = node.name.text;
        } else if (
          (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name)
        ) {
          name = node.parent.name.text;
        }

        const funcText = content.slice(node.getStart(), node.getEnd());
        const { tokens } = tokenize(funcText, 'typescript');
        const shingleSet = shingles(tokens.join(' '), 5);

        functions.push({
          name,
          start: start.line + 1,
          end: end.line + 1,
          tokens,
          shingles: shingleSet,
        });
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  } catch {
    // If parsing fails, return empty
  }

  return functions;
}

function extractFunctionsFromPython(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = content.split('\n');

  // Simple regex-based Python function detection
  const funcRegex = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(funcRegex);
    if (match) {
      const indent = match[1].length;
      const name = match[3];
      const startLine = i + 1;
      let endLine = startLine;

      // Find end of function by indentation
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') continue;
        const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (lineIndent <= indent && line.trim() !== '') {
          break;
        }
        endLine = j + 1;
      }

      const funcLines = lines.slice(i, endLine);
      const funcText = funcLines.join('\n');
      const { tokens } = tokenize(funcText, 'python');
      const shingleSet = shingles(tokens.join(' '), 5);

      functions.push({
        name,
        start: startLine,
        end: endLine,
        tokens,
        shingles: shingleSet,
      });
    }
  }

  return functions;
}

// ============================================
// Code Analysis Tools Class
// ============================================

export class CodeAnalysisTools {
  private config: ConfigManager;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  /**
   * Find files similar to the given filename in the workspace
   */
  duplicateFileFinder(
    fileName: string,
    options?: {
      maxResults?: number;
      includeContent?: boolean;
    }
  ): DuplicateFileResult[] {
    const maxResults = options?.maxResults ?? 25;
    const includeContent = options?.includeContent ?? false;
    const root = this.config.getDefaultWorkspaceRoot();

    const targetPath = join(root, fileName);
    const targetExists = existsSync(targetPath) && statSync(targetPath).isFile();
    const targetName = basename(fileName);
    const targetExt = extname(fileName).toLowerCase();
    const targetDir = dirname(fileName).toLowerCase();

    // Scan workspace
    const files = walkDirectory(root, 10000);

    // Find anchor if target exists
    let anchorPath: string | null = null;
    let anchorSize: number | null = null;
    let anchorContent: string | null = null;
    let anchorShingles: Set<string> | null = null;
    let anchorHash: string | null = null;

    if (targetExists) {
      anchorPath = targetPath;
      anchorSize = statSync(targetPath).size;
      if (includeContent) {
        anchorContent = readTextFile(targetPath);
        if (anchorContent) {
          anchorShingles = shingles(anchorContent.toLowerCase(), 5);
          if (anchorSize <= 2 * 1024 * 1024) {
            anchorHash = sha256(anchorContent);
          }
        }
      }
    } else {
      // Try to find a file with matching name
      for (const file of files) {
        if (basename(file.path).toLowerCase() === targetName.toLowerCase()) {
          anchorPath = file.path;
          anchorSize = file.size;
          break;
        }
      }
    }

    // Score files
    const scored: Array<{
      score: number;
      path: string;
      size: number;
      meta: {
        nameScore: number;
        extMatch: boolean;
        dirScore: number;
        sizeSim: number;
      };
    }> = [];

    for (const file of files) {
      const nameScore = fuzzyMatch(targetName.toLowerCase(), basename(file.path).toLowerCase());
      const extMatch = extname(file.path).toLowerCase() === targetExt && targetExt !== '';
      const dirScore = targetDir
        ? fuzzyMatch(targetDir, dirname(relative(root, file.path)).toLowerCase())
        : 0;
      let sizeSim = 0;
      if (anchorSize && anchorSize > 0 && file.size > 0) {
        sizeSim = 1 - Math.abs(file.size - anchorSize) / Math.max(file.size, anchorSize);
        sizeSim = Math.max(0, sizeSim);
      }

      const score =
        0.35 * nameScore + 0.2 * (extMatch ? 100 : 0) + 0.15 * (sizeSim * 100) + 0.1 * dirScore;

      scored.push({
        score,
        path: file.path,
        size: file.size,
        meta: { nameScore, extMatch, dirScore, sizeSim },
      });
    }

    // Sort and take top candidates
    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, 200);

    // Build results with content similarity if enabled
    const results: DuplicateFileResult[] = [];

    for (const item of topK) {
      const reasons: string[] = [];
      reasons.push(`basename fuzzy match: ${item.meta.nameScore.toFixed(0)}`);
      if (item.meta.extMatch) reasons.push('extension match');
      if (item.meta.sizeSim > 0) reasons.push(`size similarity: ${item.meta.sizeSim.toFixed(2)}`);
      if (item.meta.dirScore > 0)
        reasons.push(`directory similarity: ${(item.meta.dirScore / 100).toFixed(2)}`);

      let score = item.score;

      if (includeContent && anchorPath && item.path !== anchorPath) {
        // Check exact hash match
        if (anchorHash && item.size <= 2 * 1024 * 1024) {
          const content = readTextFile(item.path);
          if (content) {
            const hash = sha256(content);
            if (hash === anchorHash) {
              reasons.push('exact content match (sha256)');
              score = 100;
            } else if (anchorShingles) {
              const itemShingles = shingles(content.toLowerCase(), 5);
              const contentSim = jaccard(anchorShingles, itemShingles);
              if (contentSim > 0) {
                reasons.push(`content similarity: ${contentSim.toFixed(2)}`);
                score += 0.2 * (contentSim * 100);
              }
            }
          }
        }
      }

      const relPath = relative(root, item.path);

      // Exclude anchor itself
      if (anchorPath && item.path === anchorPath) continue;

      results.push({
        path: relPath,
        score: Math.round(Math.min(100, score) * 10) / 10,
        size: item.size,
        reasons,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Find similar functions using AST-based analysis
   */
  similarFunctionFinder(options?: {
    symbol?: string;
    filePath?: string;
    minSimilarity?: number;
    maxResults?: number;
  }): SimilarFunctionResult[] {
    const symbol = options?.symbol;
    const filePath = options?.filePath;
    const minSimilarity = options?.minSimilarity ?? 0.6;
    const maxResults = options?.maxResults ?? 25;
    const root = this.config.getDefaultWorkspaceRoot();

    // Collect all functions from supported files
    const files = walkDirectory(root, 1000);
    const allFunctions: Array<{ path: string; func: FunctionInfo }> = [];

    const supportedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

    for (const file of files) {
      const ext = extname(file.path).toLowerCase();
      if (!supportedExts.has(ext)) continue;

      const content = readTextFile(file.path, 1024 * 1024);
      if (!content) continue;

      let functions: FunctionInfo[] = [];
      if (ext === '.py') {
        functions = extractFunctionsFromPython(content);
      } else {
        functions = extractFunctionsFromTS(content, file.path);
      }

      for (const func of functions) {
        allFunctions.push({ path: file.path, func });
      }
    }

    // Find anchor function
    let anchorShingles: Set<string> | null = null;
    let anchorDir = '';
    let anchorIdent: { path: string; start: number; end: number } | null = null;

    if (filePath) {
      const fullPath = join(root, filePath);
      for (const { path, func } of allFunctions) {
        if (path === fullPath && (!symbol || func.name.toLowerCase() === symbol.toLowerCase())) {
          anchorShingles = func.shingles;
          anchorDir = dirname(path).toLowerCase();
          anchorIdent = { path: relative(root, path), start: func.start, end: func.end };
          break;
        }
      }
    }

    if (!anchorShingles && symbol) {
      for (const { path, func } of allFunctions) {
        if (func.name.toLowerCase() === symbol.toLowerCase()) {
          anchorShingles = func.shingles;
          anchorDir = dirname(path).toLowerCase();
          anchorIdent = { path: relative(root, path), start: func.start, end: func.end };
          break;
        }
      }
    }

    // Score functions
    const results: SimilarFunctionResult[] = [];

    for (const { path, func } of allFunctions) {
      const reasons: string[] = [];
      let score = 0;

      // Name similarity
      if (symbol) {
        const nameSim = fuzzyMatch(symbol.toLowerCase(), func.name.toLowerCase()) / 100;
        if (nameSim > 0) {
          reasons.push(`name similarity: ${nameSim.toFixed(2)}`);
          score += 0.3 * (nameSim * 100);
        }
      }

      // Directory similarity
      if (filePath && anchorDir) {
        const dirSim = fuzzyMatch(anchorDir, dirname(path).toLowerCase()) / 100;
        if (dirSim > 0) {
          reasons.push(`path similarity: ${dirSim.toFixed(2)}`);
          score += 0.1 * (dirSim * 100);
        }
      }

      // Content similarity
      if (anchorShingles && func.shingles.size > 0) {
        const contentSim = jaccard(anchorShingles, func.shingles);
        if (contentSim > 0) {
          reasons.push(`content similarity: ${contentSim.toFixed(2)}`);
        }
        if (contentSim < minSimilarity) continue;
        score += 0.6 * (contentSim * 100);
      } else if (!anchorShingles && !symbol) {
        continue;
      }

      const relPath = relative(root, path);

      // Exclude anchor itself
      if (anchorIdent && relPath === anchorIdent.path && func.start === anchorIdent.start) {
        continue;
      }

      results.push({
        path: relPath,
        function: func.name,
        lines: [func.start, func.end],
        score: Math.round(Math.min(100, score) * 10) / 10,
        reasons,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * Find duplicate code spans using token winnowing
   */
  duplicateCodeFinder(options?: {
    rootDir?: string;
    minLines?: number;
    kTokens?: number;
    window?: number;
    maxReports?: number;
    extensions?: string[];
    maxFiles?: number;
    timeoutMs?: number;
  }): DuplicateCodeGroup[] {
    const minLines = options?.minLines ?? 8;
    const kTokens = Math.max(2, options?.kTokens ?? 25);
    const window = Math.max(1, options?.window ?? 4);
    const maxReports = options?.maxReports ?? 100;
    const extensions = options?.extensions ?? ['ts', 'tsx', 'js', 'jsx', 'py'];
    const rootDir = options?.rootDir ?? this.config.getDefaultWorkspaceRoot();
    const root = this.config.resolveWorkspacePath(rootDir);

    if (!this.config.isPathAllowed(root)) {
      throw new Error(`Access denied: Path '${rootDir}' is not in the allowlist`);
    }

    const maxFiles = Math.max(1, options?.maxFiles ?? 5000);
    const deadlineMs =
      typeof options?.timeoutMs === 'number' ? Date.now() + Math.max(0, options.timeoutMs) : null;
    const timedOut = () => deadlineMs !== null && Date.now() > deadlineMs;

    const extSet = new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)));

    // Collect files
    const allFiles = walkDirectory(root, maxFiles);
    const files = allFiles.filter((f) => extSet.has(extname(f.path).toLowerCase()));

    // Tokenize files
    const fileTokens: string[][] = [];
    const fileTokLines: number[][] = [];
    const fileKgrams: string[][] = [];
    const fileFps: Array<Array<[bigint, number]>> = [];
    const filePaths: string[] = [];

    for (const file of files) {
      if (timedOut()) break;
      const content = readTextFile(file.path, 2 * 1024 * 1024);
      if (!content) {
        fileTokens.push([]);
        fileTokLines.push([]);
        fileKgrams.push([]);
        fileFps.push([]);
        filePaths.push(file.path);
        continue;
      }

      const ext = extname(file.path).toLowerCase();
      const language = ext === '.py' ? 'python' : 'typescript';
      const { tokens, lines } = tokenize(content, language);

      const kgs = kgrams(tokens, kTokens);
      const fps = winnowHashes(kgs, window);

      fileTokens.push(tokens);
      fileTokLines.push(lines);
      fileKgrams.push(kgs);
      fileFps.push(fps);
      filePaths.push(file.path);
    }

    // If we couldn't finish tokenizing, don't attempt partial matching (too low signal).
    if (timedOut()) {
      return [];
    }

    // Build fingerprint index
    const index = new Map<string, Array<[number, number]>>();
    for (let fi = 0; fi < fileFps.length; fi++) {
      if (timedOut()) break;
      const seen = new Set<string>();
      for (const [hash, pos] of fileFps[fi]) {
        const key = `${hash}:${pos}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const hashKey = hash.toString();
        if (!index.has(hashKey)) {
          index.set(hashKey, []);
        }
        index.get(hashKey)!.push([fi, pos]);
      }
    }

    // Find matches
    const groups = new Map<string, DuplicateCodeGroup>();
    const seenSpans = new Set<string>();

    for (const [, occurrences] of index) {
      if (timedOut()) break;
      if (occurrences.length < 2) continue;

      for (let i = 0; i < occurrences.length; i++) {
        if (timedOut()) break;
        for (let j = i + 1; j < occurrences.length; j++) {
          if (timedOut()) break;
          const [fi, posI] = occurrences[i];
          const [fj, posJ] = occurrences[j];

          const toksI = fileTokens[fi];
          const toksJ = fileTokens[fj];
          if (!toksI.length || !toksJ.length) continue;

          // Extend match
          let startI = posI;
          let startJ = posJ;
          let endI = Math.min(posI + kTokens - 1, toksI.length - 1);
          let endJ = Math.min(posJ + kTokens - 1, toksJ.length - 1);

          // Extend backward
          while (startI > 0 && startJ > 0 && toksI[startI - 1] === toksJ[startJ - 1]) {
            startI--;
            startJ--;
          }

          // Extend forward
          while (
            endI + 1 < toksI.length &&
            endJ + 1 < toksJ.length &&
            toksI[endI + 1] === toksJ[endJ + 1]
          ) {
            endI++;
            endJ++;
          }

          // Get line ranges
          const linesI = fileTokLines[fi];
          const linesJ = fileTokLines[fj];

          const liStart = linesI[startI] ?? 1;
          const liEnd = linesI[endI] ?? liStart;
          const ljStart = linesJ[startJ] ?? 1;
          const ljEnd = linesJ[endJ] ?? ljStart;

          // Check min lines
          if (liEnd - liStart + 1 < minLines) continue;
          if (ljEnd - ljStart + 1 < minLines) continue;

          // Dedupe spans
          const spanKey = [
            Math.min(fi, fj),
            Math.min(liStart, ljStart),
            Math.max(fi, fj),
            Math.max(liEnd, ljEnd),
          ].join(':');

          if (seenSpans.has(spanKey)) continue;
          seenSpans.add(spanKey);

          // Group by content hash
          const normSeq = toksI
            .slice(startI, endI + 1)
            .join(' ')
            .slice(0, 4000);
          const gkey = blakeHash(normSeq).toString();

          const relI = relative(root, filePaths[fi]);
          const relJ = relative(root, filePaths[fj]);

          const occList = [
            { path: relI, start_line: liStart, end_line: liEnd },
            { path: relJ, start_line: ljStart, end_line: ljEnd },
          ];

          const score = endI - startI + 1 + (endJ - startJ + 1);

          if (!groups.has(gkey)) {
            groups.set(gkey, {
              score,
              occurrences: occList,
              reasons: [`matched k-grams with winnowing hash`],
            });
          } else {
            const group = groups.get(gkey)!;
            const existing = new Set(
              group.occurrences.map((o) => `${o.path}:${o.start_line}:${o.end_line}`)
            );
            for (const occ of occList) {
              const key = `${occ.path}:${occ.start_line}:${occ.end_line}`;
              if (!existing.has(key)) {
                group.occurrences.push(occ);
                existing.add(key);
              }
            }
            group.score = Math.max(group.score, score);
          }
        }
      }
    }

    const results = Array.from(groups.values()).sort((a, b) => b.score - a.score);
    return results.slice(0, maxReports);
  }

  /**
   * Comprehensive code quality analysis
   */
  codeQualityAnalyzer(options?: {
    rootDir?: string;
    minSimilarity?: number;
    includeTypes?: Array<'duplicates' | 'complexity' | 'security' | 'dead_code' | 'smells'>;
    timeoutMs?: number;
    maxFiles?: number;
  }): CodeQualityResult {
    const startedAtMs = Date.now();
    const timeoutMs = Math.max(1000, options?.timeoutMs ?? 30000);
    const deadlineMs = startedAtMs + timeoutMs;
    const timedOut = () => Date.now() > deadlineMs;

    const rootDir = options?.rootDir ?? this.config.getDefaultWorkspaceRoot();
    // minSimilarity is available for future similarity threshold customization
    const _minSimilarity = options?.minSimilarity ?? 0.85;
    void _minSimilarity; // Reserved for future use
    const includeTypes = options?.includeTypes ?? [
      'duplicates',
      'complexity',
      'security',
      'smells',
    ];

    const issues: CodeQualityIssue[] = [];
    const root = this.config.resolveWorkspacePath(rootDir);
    if (!this.config.isPathAllowed(root)) {
      throw new Error(`Access denied: Path '${rootDir}' is not in the allowlist`);
    }

    const maxFiles = Math.max(1, options?.maxFiles ?? 5000);
    const files = walkDirectory(root, maxFiles);
    const warnings: string[] = [];
    let partial = false;
    const analyzedFiles = new Set<string>();

    const supportedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);
    const sourceFiles = files.filter((f) => supportedExts.has(extname(f.path).toLowerCase()));

    // Duplicates analysis
    if (includeTypes.includes('duplicates')) {
      const timeLeft = Math.max(0, deadlineMs - Date.now());
      const dupBudgetMs = Math.min(15000, Math.floor(timeLeft * 0.6));

      if (dupBudgetMs < 500) {
        warnings.push('Skipped duplicate-code analysis due to low remaining time budget.');
        partial = true;
      } else {
        const duplicates = this.duplicateCodeFinder({
          rootDir,
          minLines: 6,
          kTokens: 20,
          maxReports: 50,
          // Keep duplicate detection bounded; winnowing is CPU-heavy on large repos.
          maxFiles: Math.min(maxFiles, 1500),
          timeoutMs: dupBudgetMs,
        });

        for (const group of duplicates) {
          if (group.occurrences.length >= 2) {
            issues.push({
              type: 'duplicate_code',
              severity: group.occurrences.length > 3 ? 'high' : 'medium',
              file: group.occurrences[0].path,
              line: group.occurrences[0].start_line,
              message: `Duplicate code found in ${group.occurrences.length} locations`,
              suggestion: 'Consider extracting to a shared function',
            });
          }
        }
      }
    }

    // Complexity analysis
    if (includeTypes.includes('complexity')) {
      for (const file of sourceFiles) {
        if (timedOut()) {
          partial = true;
          warnings.push('Stopped early due to timeout while running complexity analysis.');
          break;
        }
        const content = readTextFile(file.path);
        if (!content) continue;
        analyzedFiles.add(file.path);

        const ext = extname(file.path).toLowerCase();
        let functions: FunctionInfo[] = [];

        if (ext === '.py') {
          functions = extractFunctionsFromPython(content);
        } else {
          functions = extractFunctionsFromTS(content, file.path);
        }

        for (const func of functions) {
          const lines = func.end - func.start + 1;
          if (lines > 100) {
            issues.push({
              type: 'complexity',
              severity: lines > 200 ? 'high' : 'medium',
              file: relative(root, file.path),
              line: func.start,
              message: `Function '${func.name}' is ${lines} lines long`,
              suggestion: 'Consider breaking into smaller functions',
            });
          }
        }
      }
    }

    // Security analysis
    if (includeTypes.includes('security')) {
      const securityPatterns = [
        { pattern: /eval\s*\(/g, name: 'eval usage', severity: 'high' as const },
        { pattern: /innerHTML\s*=/g, name: 'innerHTML assignment', severity: 'medium' as const },
        {
          pattern: /password\s*[:=]\s*["'][^"']+["']/gi,
          name: 'hardcoded password',
          severity: 'critical' as const,
        },
        {
          pattern: /api[_-]?key\s*[:=]\s*["'][^"']+["']/gi,
          name: 'hardcoded API key',
          severity: 'critical' as const,
        },
        {
          pattern: /secret\s*[:=]\s*["'][^"']+["']/gi,
          name: 'hardcoded secret',
          severity: 'critical' as const,
        },
      ];

      for (const file of sourceFiles) {
        if (timedOut()) {
          partial = true;
          warnings.push('Stopped early due to timeout while running security pattern analysis.');
          break;
        }
        const content = readTextFile(file.path);
        if (!content) continue;
        analyzedFiles.add(file.path);

        const lines = content.split('\n');
        for (const { pattern, name, severity } of securityPatterns) {
          pattern.lastIndex = 0;
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              issues.push({
                type: 'security',
                severity,
                file: relative(root, file.path),
                line: i + 1,
                message: `Potential security issue: ${name}`,
                suggestion: 'Review and remediate security concern',
              });
            }
            pattern.lastIndex = 0;
          }
        }
      }
    }

    // Code smells
    if (includeTypes.includes('smells')) {
      for (const file of sourceFiles) {
        if (timedOut()) {
          partial = true;
          warnings.push('Stopped early due to timeout while running smell analysis.');
          break;
        }
        const content = readTextFile(file.path);
        if (!content) continue;
        analyzedFiles.add(file.path);

        const lines = content.split('\n');

        // Long lines
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 150) {
            issues.push({
              type: 'smell',
              severity: 'low',
              file: relative(root, file.path),
              line: i + 1,
              message: `Line is ${lines[i].length} characters long`,
              suggestion: 'Consider breaking into multiple lines',
            });
          }
        }

        // TODO/FIXME/HACK comments
        const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b/i;
        for (let i = 0; i < lines.length; i++) {
          if (todoPattern.test(lines[i])) {
            issues.push({
              type: 'smell',
              severity: 'low',
              file: relative(root, file.path),
              line: i + 1,
              message: 'Contains TODO/FIXME/HACK comment',
              suggestion: 'Address the technical debt',
            });
          }
        }
      }
    }

    if (includeTypes.includes('dead_code')) {
      // Not yet implemented: keep the public API stable while being explicit.
      warnings.push(
        "dead_code analysis is not implemented yet; omit 'dead_code' from includeTypes to suppress this warning."
      );
      partial = true;
    }

    // Calculate summary
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const issue of issues) {
      byType[issue.type] = (byType[issue.type] ?? 0) + 1;
      bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    }

    return {
      total_issues: issues.length,
      by_type: byType,
      by_severity: bySeverity,
      issues: issues.slice(0, 200), // Limit output
      partial: partial || warnings.length > 0,
      elapsedMs: Date.now() - startedAtMs,
      filesDiscovered: files.length,
      filesAnalyzed: analyzedFiles.size,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}
