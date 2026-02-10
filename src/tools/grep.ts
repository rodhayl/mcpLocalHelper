import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { GrepResult, GrepMatch } from '../types/index.js';
import { ConfigManager } from '../config/index.js';
import { RedactionEngine } from '../utils/redaction.js';
import { getSmartDefaultsManager } from '../utils/smart-defaults.js';
import { globToRegexSource } from '../utils/glob-patterns.js';

export class GrepTools {
  private config: ConfigManager;
  private redaction: RedactionEngine;

  constructor(config: ConfigManager) {
    this.config = config;
    this.redaction = new RedactionEngine();
  }

  private normalizePatternForJsRegex(pattern: string): string {
    let p = String(pattern || '').trim();

    // Detect and convert glob patterns to regex
    // Common glob indicators: *, **, ?, [...] - but avoid confusing with regex lookaheads (?=...)
    if (this.isGlobPattern(p)) {
      p = globToRegexSource(p, { starMatchesSlash: false, supportGlobstar: true });
    }

    // Some LLMs emit PCRE-style inline flags like `(?i)` or `(?im)` which JS RegExp doesn't support.
    // We already search case-insensitively, so strip a leading `(?[a-zA-Z]+)` prefix.
    // (Avoid touching JS lookaheads like `(?=...)` / `(?!...)` which start with non-letters.)
    const m = /^\(\?([a-zA-Z]+)\)/.exec(p);
    if (m) {
      p = p.slice(m[0].length);
    }

    // Also normalize `(?i:...)` style groups by dropping the flags and keeping the group.
    // This is a best-effort transform; it preserves the inner pattern.
    p = p.replace(/\(\?[a-zA-Z]+:/g, '(?:');

    return p;
  }

  /**
   * Detect if a pattern looks like a glob rather than a regex.
   * Glob patterns typically contain: *, **, ?, or file extensions like *.ts
   * But we avoid matching regex lookaheads like (?=...) or (?!...)
   */
  private isGlobPattern(pattern: string): boolean {
    // If it contains regex-specific syntax, it's likely regex
    if (/\(\?[=!<:]/.test(pattern)) return false; // Lookaheads, lookbehinds, non-capturing groups
    if (/\[[^\]]+\]/.test(pattern) && !/\*/.test(pattern)) return false; // Character classes without *
    if (/[+|^$]/.test(pattern)) return false; // Regex quantifiers/anchors/alternation

    // Glob indicators: ** (any depth), * with dots (like *.ts), standalone */?
    if (/\*\*/.test(pattern)) return true; // ** is definitely glob
    if (/\*\.[a-z0-9]+$/i.test(pattern)) return true; // *.ts, *.json etc.
    if (/^\*[^(]/.test(pattern)) return true; // Starts with * (not *(...) which is regex)

    return false;
  }

  grepRepo(root: string, pattern: string, maxMatches?: number): GrepResult {
    const resolvedRoot = this.config.resolveWorkspacePath(root);

    if (!this.config.isPathAllowed(resolvedRoot)) {
      throw new Error(`Access denied: Root '${root}' is not in the allowlist`);
    }

    const matches: GrepMatch[] = [];
    const effectiveMaxMatches = maxMatches || 50;
    const repaired = this.normalizePatternForJsRegex(pattern);
    let regex: RegExp;
    try {
      // Keep matching case-insensitive by default; this tool is designed for LLM usage.
      regex = new RegExp(repaired, 'i');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Provide helpful suggestions for common regex mistakes
      let hint = '';
      if (pattern === '*') {
        hint =
          ' Did you mean ".*" (match anything) or "**/*.ts" (glob pattern for TypeScript files)?';
      } else if (pattern.startsWith('*') && !pattern.includes('.')) {
        hint = ` Bare "*" is invalid regex. Use ".*" to match anything, or "\\*" to match literal asterisk.`;
      } else if (/^\*\.[a-z]+$/i.test(pattern)) {
        hint = ` Glob patterns like "${pattern}" should use "**/${pattern}" format or regex like ".*\\.${pattern.slice(2)}$".`;
      }
      throw new Error(`Invalid regex pattern: "${pattern}".${hint} Details: ${msg}`);
    }

    this.searchDirectory(resolvedRoot, regex, matches, effectiveMaxMatches);

    return { matches };
  }

  private searchDirectory(
    dir: string,
    pattern: RegExp,
    matches: GrepMatch[],
    maxMatches: number
  ): void {
    if (matches.length >= maxMatches) {
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= maxMatches) {
          break;
        }

        const fullPath = this.config.resolveWorkspacePath(join(dir, entry.name));

        if (!this.config.isPathAllowed(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          // Skip hidden directories and use unified exclude patterns from SmartDefaultsManager
          const excludeDirs = getSmartDefaultsManager().getSimpleExcludeDirs();
          if (!entry.name.startsWith('.') && !excludeDirs.includes(entry.name)) {
            this.searchDirectory(fullPath, pattern, matches, maxMatches);
          }
        } else if (entry.isFile()) {
          this.searchFile(fullPath, pattern, matches, maxMatches);
        }
      }
    } catch (error) {
      // Skip directories we can't read (common during agent exploration)
      const code = (error as any)?.code as string | undefined;
      if (code && ['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES'].includes(code)) return;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Could not read directory ${dir}: ${msg}`);
    }
  }

  private searchFile(
    filePath: string,
    pattern: RegExp,
    matches: GrepMatch[],
    maxMatches: number
  ): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        const line = lines[i];
        const match = pattern.exec(line);

        if (match) {
          const redactedLine = this.redaction.redact(line);
          const relativePath = this.getRelativePath(filePath);

          matches.push({
            file: relativePath,
            line: i + 1,
            preview: this.truncatePreview(redactedLine, match[0]),
          });
        }
      }
    } catch (error) {
      // Skip files we can't read (binary, permissions, etc.)
      const code = (error as any)?.code as string | undefined;
      if (code && ['ENOENT', 'EISDIR', 'EPERM', 'EACCES'].includes(code)) return;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Could not read file ${filePath}: ${msg}`);
    }
  }

  private getRelativePath(absolutePath: string): string {
    const cwd = process.cwd();
    if (absolutePath.startsWith(cwd)) {
      return absolutePath.slice(cwd.length + 1);
    }
    return absolutePath;
  }

  private truncatePreview(line: string, match: string): string {
    const maxLength = 200;
    if (line.length <= maxLength) {
      return line;
    }

    const matchIndex = line.indexOf(match);
    if (matchIndex === -1) {
      return line.slice(0, maxLength) + '...';
    }

    // Try to keep the match in the center
    const start = Math.max(0, matchIndex - 50);
    const end = Math.min(line.length, matchIndex + match.length + 50);

    let preview = line.slice(start, end);
    if (start > 0) preview = '...' + preview;
    if (end < line.length) preview = preview + '...';

    return preview;
  }
}
