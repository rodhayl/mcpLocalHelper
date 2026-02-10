import {
  readFileSync,
  readdirSync,
  statSync,
  promises as fsPromises,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { createHash } from 'crypto';
import { join, relative, extname, basename } from 'path';
import { LANGUAGE_MAP } from '../utils/language-map.js';
import {
  FileContent,
  DirectoryList,
  DirectoryEntry,
  ReadSegmentResult,
  BatchReadResult,
  FileMetadata,
  ManifestSnapshot,
  GrepV2Result,
  GrepV2Match,
} from '../types/index.js';
import { ConfigManager } from '../config/index.js';
import { RedactionEngine } from '../utils/redaction.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../utils/smart-defaults.js';
import { toForwardSlashes } from '../utils/path-normalize.js';
import { globToRegExp } from '../utils/glob-patterns.js';
import { escapeRegexLiteral } from '../utils/regex-escape.js';

export class FileTools {
  private config: ConfigManager;
  private redaction: RedactionEngine;

  constructor(config: ConfigManager) {
    this.config = config;
    const mode =
      this.config.getConfig().privacy?.secretPatterns === 'strict' ? 'strict' : 'default';
    this.redaction = new RedactionEngine({ mode });
  }

  readFile(path: string, maxBytes?: number): FileContent {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    try {
      const stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new Error(`Path '${path}' is not a file`);
      }

      const effectiveMaxBytes = maxBytes || this.config.getConfig().policy.maxFileBytes;
      const fileSize = stats.size;

      // OPTIMIZATION: Read only the bytes needed instead of entire file
      // This prevents OOM when a large file is requested with a small maxBytes limit
      let content: string;
      let truncated = false;

      if (fileSize <= effectiveMaxBytes) {
        // File is small enough, read it all
        content = readFileSync(resolvedPath, 'utf-8');
      } else {
        // File is larger than limit - read only what we need
        // Read slightly more to account for UTF-8 multi-byte chars
        const bytesToRead = Math.min(effectiveMaxBytes + 1024, fileSize);
        const fd = openSync(resolvedPath, 'r');
        try {
          const buffer = Buffer.alloc(bytesToRead);
          const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
          content = buffer.toString('utf-8', 0, bytesRead);
          truncated = true;
        } finally {
          closeSync(fd);
        }
      }

      // Apply redaction (preserve structure where possible)
      const { text: redactedContent, summary: redactionSummary } =
        this.redaction.redactWithSummary(content);

      // Apply truncation (may further truncate after redaction)
      const result = this.redaction.truncate(redactedContent, effectiveMaxBytes);

      return {
        path: resolvedPath,
        content: result.text,
        truncated: truncated || result.truncated,
        ...(redactionSummary.totalReplacements > 0 ? { redaction: redactionSummary } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error(`File not found: ${path}`);
      }
      throw error;
    }
  }

  listDirectory(path: string, maxEntries?: number): DirectoryList {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    try {
      const stats = statSync(resolvedPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path '${path}' is not a directory`);
      }

      const entries = readdirSync(resolvedPath, { withFileTypes: true });
      const effectiveMaxEntries = maxEntries || 100;

      const directoryEntries: DirectoryEntry[] = entries
        .slice(0, effectiveMaxEntries)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        }));

      return {
        path: resolvedPath,
        entries: directoryEntries,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error(`Directory not found: ${path}`);
      }
      throw error;
    }
  }

  isPathAllowed(path: string): boolean {
    try {
      const abs = this.config.resolveWorkspacePath(path);
      return this.config.isInsideWorkspace(abs);
    } catch {
      return false;
    }
  }

  /**
   * Resolve a path to an absolute path within the workspace
   */
  resolvePath(path: string): string {
    const resolvedPath = this.config.resolveWorkspacePath(path);
    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }
    return resolvedPath;
  }

  // ============================================
  // Enhanced Read Tools (Phase 3)
  // ============================================

  /**
   * Read specific line segments from a file
   */
  readSegments(
    segments: Array<{ path: string; startLine: number; endLine: number }>
  ): ReadSegmentResult[] {
    const config = this.config.getConfig().readEnhancements || {
      maxLineSpan: 2000,
      maxBatchBytes: 262144,
    };

    const results: ReadSegmentResult[] = [];

    for (const segment of segments) {
      const resolvedPath = this.config.resolveWorkspacePath(segment.path);

      if (!this.config.isPathAllowed(resolvedPath)) {
        results.push({
          path: segment.path,
          startLine: segment.startLine,
          endLine: segment.endLine,
          content: '',
          truncated: false,
          redactionApplied: false,
          error: `Access denied: Path '${segment.path}' is not in the allowlist`,
        });
        continue;
      }

      try {
        const content = readFileSync(resolvedPath, 'utf-8');
        const lines = content.split('\n');

        // Validate line range
        const start = Math.max(1, segment.startLine);
        const end = Math.min(lines.length, segment.endLine);
        const span = end - start + 1;

        if (span > config.maxLineSpan) {
          results.push({
            path: segment.path,
            startLine: start,
            endLine: start + config.maxLineSpan - 1,
            content: lines.slice(start - 1, start + config.maxLineSpan - 1).join('\n'),
            truncated: true,
            redactionApplied: false,
            error: `Line span exceeds maximum (${config.maxLineSpan})`,
          });
          continue;
        }

        const segmentContent = lines.slice(start - 1, end).join('\n');
        const redactedContent = this.redaction.redact(segmentContent);
        const redactionApplied = redactedContent !== segmentContent;

        // Calculate SHA256 of original content
        const sha256 = createHash('sha256').update(segmentContent).digest('hex');

        results.push({
          path: segment.path,
          startLine: start,
          endLine: end,
          content: redactedContent,
          truncated: false,
          redactionApplied,
          sha256,
        });
      } catch (error) {
        results.push({
          path: segment.path,
          startLine: segment.startLine,
          endLine: segment.endLine,
          content: '',
          truncated: false,
          redactionApplied: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  /**
   * Read multiple files in a single operation with aggregate size limits
   */
  batchReadFiles(paths: string[]): BatchReadResult {
    const config = this.config.getConfig().readEnhancements || {
      maxBatchFiles: 50,
      maxBatchBytes: 262144,
      maxConcurrentReads: 8,
    };

    const effectivePaths = paths.slice(0, config.maxBatchFiles);
    const omittedFiles: string[] = paths.slice(config.maxBatchFiles);

    const files: Array<{
      path: string;
      content: string;
      truncated: boolean;
      sizeBytes: number;
      error?: string;
    }> = [];

    let aggregateBytes = 0;
    let capped = false;

    for (const path of effectivePaths) {
      if (aggregateBytes >= config.maxBatchBytes) {
        capped = true;
        omittedFiles.push(path);
        continue;
      }

      const resolvedPath = this.config.resolveWorkspacePath(path);

      if (!this.config.isPathAllowed(resolvedPath)) {
        files.push({
          path,
          content: '',
          truncated: false,
          sizeBytes: 0,
          error: `Access denied: Path '${path}' is not in the allowlist`,
        });
        continue;
      }

      try {
        const stats = statSync(resolvedPath);
        if (!stats.isFile()) {
          files.push({
            path,
            content: '',
            truncated: false,
            sizeBytes: 0,
            error: `Path '${path}' is not a file`,
          });
          continue;
        }

        const content = readFileSync(resolvedPath, 'utf-8');
        const redactedContent = this.redaction.redact(content);

        const remainingBytes = config.maxBatchBytes - aggregateBytes;
        const truncated = redactedContent.length > remainingBytes;
        const finalContent = truncated
          ? redactedContent.substring(0, remainingBytes) + '\n... [TRUNCATED]'
          : redactedContent;

        const sizeBytes = Buffer.byteLength(finalContent, 'utf-8');
        aggregateBytes += sizeBytes;

        files.push({
          path,
          content: finalContent,
          truncated,
          sizeBytes,
        });

        if (truncated) {
          capped = true;
        }
      } catch (error) {
        files.push({
          path,
          content: '',
          truncated: false,
          sizeBytes: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return {
      files,
      aggregateBytes,
      capped,
      omittedFiles,
    };
  }

  /**
   * Get detailed metadata for a file without reading content
   */
  getFileMetadata(path: string): FileMetadata {
    const resolvedPath = this.config.resolveWorkspacePath(path);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${path}' is not in the allowlist`);
    }

    const stats = statSync(resolvedPath);

    if (!stats.isFile()) {
      throw new Error(`Path '${path}' is not a file`);
    }

    // Read file for line count and language detection
    const content = readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const extension = extname(resolvedPath).toLowerCase().slice(1);

    return {
      path: resolvedPath,
      name: basename(resolvedPath),
      extension,
      sizeBytes: stats.size,
      lineCount: lines.length,
      modifiedAt: stats.mtime.toISOString(),
      createdAt: stats.birthtime.toISOString(),
      language: LANGUAGE_MAP[extension] || null,
      isReadable: true,
    };
  }

  /**
   * Generate a manifest snapshot of the workspace structure
   */
  manifestSnapshot(
    root: string,
    options?: {
      maxDepth?: number;
      includeHidden?: boolean;
      extensions?: string[];
    }
  ): ManifestSnapshot {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    const maxDepth = options?.maxDepth ?? 10;
    const includeHidden = options?.includeHidden ?? false;
    const extensions = options?.extensions;

    const files: Array<{
      path: string;
      relativePath: string;
      sizeBytes: number;
      language: string | null;
    }> = [];

    const directories: string[] = [];
    let totalBytes = 0;

    const scanDir = (dir: string, depth: number) => {
      if (depth > maxDepth) return;

      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip hidden files/dirs if not included
          if (!includeHidden && entry.name.startsWith('.')) continue;

          const fullPath = join(dir, entry.name);
          if (!this.config.isPathAllowed(fullPath)) continue;

          // Use shared exclude patterns for noise filtering
          const relativeDirPath = relative(resolvedRoot, dir);
          const relativeEntryPath = relativeDirPath
            ? `${relativeDirPath}/${entry.name}`
            : entry.name;

          // When includeHidden=true, callers expect dot-directories to be discoverable.
          // Keep the shared noise filters, but do not exclude editor settings like .vscode.
          const isVscodePath = /(^|\/)\.vscode(\/|$)/.test(relativeEntryPath);
          if (!isVscodePath && this.shouldExcludePath(relativeEntryPath)) continue;

          const relativePath = relative(resolvedRoot, fullPath);

          if (entry.isDirectory()) {
            directories.push(relativePath);
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = extname(entry.name).toLowerCase().slice(1);

            // Filter by extensions if specified (handle both ".ts" and "ts" formats)
            if (extensions) {
              const normalizedExtensions = extensions.map((e) =>
                e.startsWith('.') ? e.slice(1) : e
              );
              if (!normalizedExtensions.includes(ext)) continue;
            }

            try {
              const stats = statSync(fullPath);
              totalBytes += stats.size;

              files.push({
                path: fullPath,
                relativePath,
                sizeBytes: stats.size,
                language: LANGUAGE_MAP[ext] || null,
              });
            } catch {
              // Skip files we can't stat
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    scanDir(resolvedRoot, 0);

    // Calculate language breakdown
    const languageBreakdown: Record<string, { count: number; bytes: number }> = {};
    for (const file of files) {
      const lang = file.language || 'other';
      if (!languageBreakdown[lang]) {
        languageBreakdown[lang] = { count: 0, bytes: 0 };
      }
      languageBreakdown[lang].count++;
      languageBreakdown[lang].bytes += file.sizeBytes;
    }

    // V18 (QA_feedback_5): Enhanced truncation info for transparency
    const fileLimit = 500;
    const dirLimit = 200;
    const isTruncated = files.length > fileLimit || directories.length > dirLimit;

    return {
      root: resolvedRoot,
      totalFiles: files.length,
      totalDirectories: directories.length,
      totalBytes,
      files: files.slice(0, fileLimit),
      directories: directories.slice(0, dirLimit),
      languageBreakdown,
      truncated: isTruncated,
      // V18: Add explicit truncation info to prevent "hallucinated repo structure" issues
      ...(isTruncated
        ? {
            truncationInfo: {
              filesShowing: Math.min(files.length, fileLimit),
              filesTotal: files.length,
              directoriesShowing: Math.min(directories.length, dirLimit),
              directoriesTotal: directories.length,
              hint:
                `Output truncated. Showing ${Math.min(files.length, fileLimit)}/${files.length} files and ${Math.min(directories.length, dirLimit)}/${directories.length} directories. ` +
                `Use 'extensions' filter (e.g., [".ts", ".py"]) or 'maxDepth' to narrow scope.`,
            },
          }
        : {}),
    };
  }

  /**
   * Async version of manifestSnapshot to avoid blocking the event loop.
   * Intended for long-running agent operations and concurrent request scenarios.
   */
  async manifestSnapshotAsync(
    root: string,
    options?: {
      maxDepth?: number;
      includeHidden?: boolean;
      extensions?: string[];
    }
  ): Promise<ManifestSnapshot> {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Path '${root}' is not in the allowlist`);
    }

    const maxDepth = options?.maxDepth ?? 10;
    const includeHidden = options?.includeHidden ?? false;
    const normalizedExtensions = options?.extensions
      ? options.extensions.map((e) => (e.startsWith('.') ? e.slice(1) : e).toLowerCase())
      : undefined;

    const files: Array<{
      path: string;
      relativePath: string;
      sizeBytes: number;
      language: string | null;
    }> = [];

    const directories: string[] = [];
    let totalBytes = 0;

    let opCount = 0;
    const maybeYield = async () => {
      opCount++;
      if (opCount % 200 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    const scanDir = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;

      let entries: import('fs').Dirent[];
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;

        const fullPath = join(dir, entry.name);
        if (!this.config.isPathAllowed(fullPath)) continue;

        const relativeDirPath = relative(resolvedRoot, dir);
        const relativeEntryPath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;
        if (this.shouldExcludePath(relativeEntryPath)) continue;

        const relativePath = relative(resolvedRoot, fullPath);

        if (entry.isDirectory()) {
          directories.push(relativePath);
          await maybeYield();
          await scanDir(fullPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) continue;

        const ext = extname(entry.name).toLowerCase().slice(1);
        if (normalizedExtensions && !normalizedExtensions.includes(ext)) continue;

        try {
          const stats = await fsPromises.stat(fullPath);
          totalBytes += stats.size;
          files.push({
            path: fullPath,
            relativePath,
            sizeBytes: stats.size,
            language: LANGUAGE_MAP[ext] || null,
          });
        } catch {
          // Skip files we can't stat
        }

        await maybeYield();
      }
    };

    await scanDir(resolvedRoot, 0);

    const languageBreakdown: Record<string, { count: number; bytes: number }> = {};
    for (const file of files) {
      const lang = file.language || 'other';
      if (!languageBreakdown[lang]) {
        languageBreakdown[lang] = { count: 0, bytes: 0 };
      }
      languageBreakdown[lang].count++;
      languageBreakdown[lang].bytes += file.sizeBytes;
    }

    // V18 (QA_feedback_5): Enhanced truncation info for transparency
    const fileLimit = 500;
    const dirLimit = 200;
    const isTruncated = files.length > fileLimit || directories.length > dirLimit;

    return {
      root: resolvedRoot,
      totalFiles: files.length,
      totalDirectories: directories.length,
      totalBytes,
      files: files.slice(0, fileLimit),
      directories: directories.slice(0, dirLimit),
      languageBreakdown,
      truncated: isTruncated,
      // V18: Add explicit truncation info to prevent "hallucinated repo structure" issues
      ...(isTruncated
        ? {
            truncationInfo: {
              filesShowing: Math.min(files.length, fileLimit),
              filesTotal: files.length,
              directoriesShowing: Math.min(directories.length, dirLimit),
              directoriesTotal: directories.length,
              hint:
                `Output truncated. Showing ${Math.min(files.length, fileLimit)}/${files.length} files and ${Math.min(directories.length, dirLimit)}/${directories.length} directories. ` +
                `Use 'extensions' filter (e.g., [".ts", ".py"]) or 'maxDepth' to narrow scope.`,
            },
          }
        : {}),
    };
  }

  /**
   * Find files/directories by name or path substring (no content search).
   * Useful for locating files like "AGENTS.md" where grep-based search may return 0 matches.
   */
  findPathsByName(
    root: string,
    query: string,
    options?: {
      maxResults?: number;
      includeHidden?: boolean;
      includeDirectories?: boolean;
      includePatterns?: string[];
      excludePatterns?: string[];
      caseSensitive?: boolean;
    }
  ): {
    query: string;
    root: string;
    matches: Array<{ path: string; type: 'file' | 'directory' }>;
    totalMatches: number;
    filesScanned: number;
    directoriesScanned: number;
    truncated: boolean;
  } {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Root '${root}' is not in the allowlist`);
    }

    let rootStats;
    try {
      rootStats = statSync(resolvedRoot);
    } catch (error) {
      if (error instanceof Error && (error as any).code === 'ENOENT') {
        throw new Error(`Directory not found: '${root}'`);
      }
      throw error;
    }

    if (!rootStats.isDirectory()) {
      throw new Error(`Invalid path: '${root}' is not a directory`);
    }

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error(`Invalid query: The 'query' parameter is required and cannot be empty.`);
    }

    const maxResults = Math.max(1, options?.maxResults ?? 50);
    const includeHidden = options?.includeHidden ?? false;
    const includeDirectories = options?.includeDirectories ?? false;
    const caseSensitive = options?.caseSensitive ?? false;
    const includePatterns = options?.includePatterns ?? [];
    const excludePatterns = options?.excludePatterns ?? [];

    const normalize = (s: string) => (caseSensitive ? s : s.toLowerCase());
    const normalizedQuery = normalize(query.trim());
    const queryIsGlob = /[*?]/.test(query);
    const queryRegex = queryIsGlob
      ? globToRegExp(query, { starMatchesSlash: true, supportGlobstar: false })
      : null;

    const matchesAnyPattern = (relPath: string, fileName: string, patterns: string[]): boolean => {
      if (patterns.length === 0) return false;
      for (const pattern of patterns) {
        const rx = globToRegExp(pattern, { starMatchesSlash: true, supportGlobstar: false });
        if (rx.test(relPath) || rx.test(fileName)) return true;
      }
      return false;
    };

    const shouldIncludeMatch = (relPath: string, fileName: string): boolean => {
      if (excludePatterns.length > 0 && matchesAnyPattern(relPath, fileName, excludePatterns)) {
        return false;
      }
      if (includePatterns.length > 0 && !matchesAnyPattern(relPath, fileName, includePatterns)) {
        return false;
      }
      return true;
    };

    const matchesQuery = (relPath: string, fileName: string): boolean => {
      if (queryRegex) {
        return queryRegex.test(relPath) || queryRegex.test(fileName);
      }
      return (
        normalize(fileName).includes(normalizedQuery) ||
        normalize(relPath).includes(normalizedQuery)
      );
    };

    const results: Array<{ path: string; type: 'file' | 'directory' }> = [];
    let filesScanned = 0;
    let directoriesScanned = 0;
    let truncated = false;

    const scanDir = (dir: string) => {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }

      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const relativeDirPath = relative(resolvedRoot, dir).replace(/\\/g, '/');

      for (const entry of entries) {
        if (results.length >= maxResults) {
          truncated = true;
          break;
        }

        if (!includeHidden && entry.name.startsWith('.')) continue;

        const relativeEntryPath = relativeDirPath ? `${relativeDirPath}/${entry.name}` : entry.name;

        // Default noise filtering (venv, node_modules, reports, etc.)
        if (this.shouldExcludePath(relativeEntryPath)) continue;

        const fullPath = join(dir, entry.name);
        if (!this.config.isPathAllowed(fullPath)) continue;

        if (entry.isDirectory()) {
          directoriesScanned++;

          if (
            includeDirectories &&
            matchesQuery(relativeEntryPath, entry.name) &&
            shouldIncludeMatch(relativeEntryPath, entry.name)
          ) {
            results.push({ path: relativeEntryPath, type: 'directory' });
          }

          scanDir(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;
        filesScanned++;

        if (
          matchesQuery(relativeEntryPath, entry.name) &&
          shouldIncludeMatch(relativeEntryPath, entry.name)
        ) {
          results.push({ path: relativeEntryPath, type: 'file' });
        }
      }
    };

    scanDir(resolvedRoot);

    return {
      query,
      root: resolvedRoot,
      matches: results,
      totalMatches: results.length,
      filesScanned,
      directoriesScanned,
      truncated,
    };
  }

  /**
   * Enhanced grep with context lines, column info, and advanced filtering
   */
  grepRepoV2(
    root: string,
    pattern: string,
    options?: {
      isRegex?: boolean;
      contextLines?: number;
      maxMatches?: number;
      filePattern?: string;
      maxMatchesPerFile?: number;
    }
  ): GrepV2Result {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Root '${root}' is not in the allowlist`);
    }

    const isRegex = options?.isRegex ?? true;
    const contextLines = options?.contextLines ?? 0;
    const maxMatches = options?.maxMatches ?? 100;
    const maxMatchesPerFile = Math.max(1, options?.maxMatchesPerFile ?? Math.min(5, maxMatches));
    const filePattern = options?.filePattern;

    const regex = isRegex
      ? new RegExp(pattern, 'gi')
      : new RegExp(escapeRegexLiteral(pattern), 'gi');
    const matches: GrepV2Match[] = [];
    let filesSearched = 0;
    let truncated = false;

    const searchDir = (dir: string) => {
      if (matches.length >= maxMatches) {
        truncated = true;
        return;
      }

      try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (matches.length >= maxMatches) break;

          // Skip hidden files/dirs
          if (entry.name.startsWith('.')) continue;

          // Plan 1: Use comprehensive DEFAULT_EXCLUDE_PATTERNS for noise filtering
          // This replaces the previous hardcoded list with 80+ patterns from smart-defaults
          const relativeDirPath = relative(resolvedRoot, dir);
          const relativeEntryPath = relativeDirPath
            ? `${relativeDirPath}/${entry.name}`
            : entry.name;
          if (this.shouldExcludePath(relativeEntryPath)) continue;

          const fullPath = join(dir, entry.name);

          if (!this.config.isPathAllowed(fullPath)) continue;

          if (entry.isDirectory()) {
            searchDir(fullPath);
          } else if (entry.isFile()) {
            // Check file pattern filter
            if (filePattern) {
              const relativePath = relative(resolvedRoot, fullPath);
              if (!this.matchesFilePattern(entry.name, relativePath, filePattern)) {
                continue;
              }
            }

            this.searchFileV2(
              fullPath,
              regex,
              matches,
              maxMatches,
              maxMatchesPerFile,
              contextLines,
              resolvedRoot
            );
            filesSearched++;
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    searchDir(resolvedRoot);

    return {
      matches,
      totalMatches: matches.length,
      filesSearched,
      truncated,
    };
  }

  private searchFileV2(
    filePath: string,
    pattern: RegExp,
    matches: GrepV2Match[],
    maxMatches: number,
    maxMatchesPerFile: number,
    contextLines: number,
    root: string
  ): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      // CRITICAL: Normalize to forward slashes for cross-platform consistency
      // This ensures fileMatches.get(ranking.file) works correctly on Windows
      // where relative() returns backslashes but LLM returns forward slashes
      const relativePath = toForwardSlashes(relative(root, filePath));
      let matchesInFile = 0;

      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (matchesInFile >= maxMatchesPerFile) break;
        const line = lines[i];
        pattern.lastIndex = 0; // Reset regex state
        const match = pattern.exec(line);

        if (match) {
          // Collect context lines
          const preview: string[] = [];
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);

          for (let j = start; j <= end; j++) {
            const redactedLine = this.redaction.redact(lines[j]);
            preview.push(redactedLine);
          }

          matches.push({
            file: relativePath,
            line: i + 1,
            column: match.index + 1,
            preview,
            matchedText: match[0],
          });
          matchesInFile++;
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  /**
   * Match a file against a glob pattern like **.py, *.ts, src/**.js
   * Handles common patterns used by LLMs for file filtering.
   */
  private matchesFilePattern(fileName: string, relativePath: string, pattern: string): boolean {
    // Normalize path separators
    const normalizedPath = relativePath.replace(/\\/g, '/');

    // Handle common glob patterns:
    // 1. **/*.ext - Match any file with extension recursively
    // 2. *.ext - Match files with extension in current dir
    // 3. dir/**/*.ext - Match files with extension under dir
    // 4. **/* - Match all files

    // Check for extension-based patterns (most common): **/*.ext or *.ext
    const extMatch = pattern.match(/^(\*\*\/)?\*\.(\w+)$/);
    if (extMatch) {
      const ext = extname(fileName).toLowerCase();
      const patternExt = '.' + extMatch[2].toLowerCase();
      return ext === patternExt;
    }

    // Check for simple extension match like *.py (no directory component)
    if (pattern.startsWith('*.') && !pattern.includes('/')) {
      const ext = extname(fileName).toLowerCase();
      const patternExt = pattern.slice(1).toLowerCase();
      return ext === patternExt;
    }

    // Check for directory prefix patterns like src/**/*.ts
    const dirMatch = pattern.match(/^([^*]+)\/\*\*\/\*\.(\w+)$/);
    if (dirMatch) {
      const dirPrefix = dirMatch[1].toLowerCase();
      const ext = extname(fileName).toLowerCase();
      const patternExt = '.' + dirMatch[2].toLowerCase();
      return normalizedPath.toLowerCase().startsWith(dirPrefix + '/') && ext === patternExt;
    }

    // Fallback to basic glob-to-regex conversion
    const rx = globToRegExp(pattern, { starMatchesSlash: true, supportGlobstar: false });
    return rx.test(fileName) || rx.test(normalizedPath);
  }

  /**
   * Check if a path or file should be excluded based on DEFAULT_EXCLUDE_PATTERNS.
   * Uses glob pattern matching for comprehensive noise filtering.
   * Plan 1: Enhanced Search Noise Filtering
   */
  shouldExcludePath(pathOrName: string): boolean {
    const normalizedPath = pathOrName.replace(/\\/g, '/').toLowerCase();
    const pathParts = normalizedPath.split('/');
    const fileName = pathParts[pathParts.length - 1];

    for (const pattern of DEFAULT_EXCLUDE_PATTERNS) {
      const normalizedPattern = pattern.toLowerCase();

      // Handle directory patterns like 'venv/**' or 'node_modules/**'
      if (normalizedPattern.endsWith('/**')) {
        const dirName = normalizedPattern.slice(0, -3);
        // Check if any path segment matches the directory name
        if (pathParts.some((part) => part === dirName)) {
          return true;
        }
        // Also check if the path starts with the directory
        if (normalizedPath.startsWith(dirName + '/')) {
          return true;
        }
      }

      // Handle file extension patterns like '*.pyc' or '*.min.js'
      else if (normalizedPattern.startsWith('*.')) {
        const ext = normalizedPattern.slice(1); // Get '.pyc' or '.min.js'
        if (normalizedPath.endsWith(ext)) {
          return true;
        }
      }

      // Handle exact file/directory matches like 'package-lock.json', '.DS_Store', 'Thumbs.db'
      // These can appear at any level in the path
      else if (!normalizedPattern.includes('*')) {
        // Check if the filename matches exactly
        if (fileName === normalizedPattern) {
          return true;
        }
        // Also check if any path segment matches (for things like 'tmp' in 'project/tmp/file.txt')
        if (pathParts.some((part) => part === normalizedPattern)) {
          return true;
        }
      }
    }

    return false;
  }
}
