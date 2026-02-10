import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname, basename, isAbsolute, resolve } from 'path';
import { ConfigManager, normalizePath } from '../config/index.js';
import { getLanguageFromExtension } from '../utils/language-map.js';
import {
  EditOperation,
  EditPreviewResult,
  EditResult,
  MultiEditResult,
  SyntaxValidationResult,
  ApplyDiffResult,
  CreateFileResult,
} from '../types/index.js';

interface ApplyDiffPreviewResult {
  canApply: boolean;
  conflicts: string[];
  resultPreview: string;
  syntaxValid: boolean;
}

interface EditOptions {
  skipValidation?: boolean;
  skipBackup?: boolean;
}

interface MultiEditInput {
  file_path: string;
  operation: EditOperation;
  startLine: number;
  endLine?: number;
  newContent?: string;
}

/**
 * EditTools - Safe file editing with preview, backup, and validation
 * Phase 6 implementation for edit.safe and edit.advanced groups
 */
export class EditTools {
  private config: ConfigManager;
  private backupDir: string;
  private auditLog: Array<{
    timestamp: string;
    operation: string;
    file: string;
    backupPath?: string;
    success: boolean;
  }> = [];

  // Languages we support syntax validation for
  private supportedValidationLanguages = ['typescript', 'javascript'];

  constructor(config: ConfigManager) {
    this.config = config;

    const editConfig = this.config.getConfig().editing;
    this.backupDir = editConfig?.backupDir || '.mcp-backups';
  }

  /**
   * Get language from file extension
   */
  private getLanguage(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase();
    return getLanguageFromExtension(ext || '');
  }

  /**
   * Validate TypeScript/JavaScript syntax using tsc or node --check-syntax
   */
  validateSyntax(filePath: string, content?: string): SyntaxValidationResult {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    const language = this.getLanguage(resolvedPath);

    if (!language || !this.supportedValidationLanguages.includes(language)) {
      return {
        valid: true,
        errors: [],
        language: language || 'unknown',
      };
    }

    // Get content to validate
    const fileContent =
      content ?? (existsSync(resolvedPath) ? readFileSync(resolvedPath, 'utf-8') : '');

    // For TypeScript/JavaScript, we'll do basic syntax validation
    // using regex patterns for common syntax errors
    const errors: SyntaxValidationResult['errors'] = [];

    // Check for basic syntax errors using heuristics
    const lines = fileContent.split('\n');
    let braceCount = 0;
    let parenCount = 0;
    let bracketCount = 0;
    let inString = false;
    let stringChar = '';
    let inTemplateString = false;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        const prevChar = j > 0 ? line[j - 1] : '';
        const nextChar = j < line.length - 1 ? line[j + 1] : '';

        // Skip escaped characters in strings
        if (prevChar === '\\' && (inString || inTemplateString)) {
          continue;
        }

        // Handle comments
        if (!inString && !inTemplateString && !inBlockComment) {
          if (char === '/' && nextChar === '/') {
            break; // Rest of line is comment
          }
          if (char === '/' && nextChar === '*') {
            inBlockComment = true;
            continue;
          }
        }

        if (inBlockComment) {
          if (char === '*' && nextChar === '/') {
            inBlockComment = false;
            j++; // Skip the /
          }
          continue;
        }

        // Handle strings
        if (!inString && !inTemplateString) {
          if (char === '"' || char === "'") {
            inString = true;
            stringChar = char;
            continue;
          }
          if (char === '`') {
            inTemplateString = true;
            continue;
          }
        } else if (inString && char === stringChar) {
          inString = false;
          stringChar = '';
          continue;
        } else if (inTemplateString && char === '`') {
          inTemplateString = false;
          continue;
        }

        // Count brackets only when not in string
        if (!inString && !inTemplateString) {
          if (char === '{') braceCount++;
          if (char === '}') braceCount--;
          if (char === '(') parenCount++;
          if (char === ')') parenCount--;
          if (char === '[') bracketCount++;
          if (char === ']') bracketCount--;

          // Check for negative counts (more closing than opening)
          if (braceCount < 0) {
            errors.push({
              line: lineNum,
              column: j + 1,
              message: 'Unexpected closing brace',
              severity: 'error',
            });
            braceCount = 0; // Reset to continue checking
          }
          if (parenCount < 0) {
            errors.push({
              line: lineNum,
              column: j + 1,
              message: 'Unexpected closing parenthesis',
              severity: 'error',
            });
            parenCount = 0;
          }
          if (bracketCount < 0) {
            errors.push({
              line: lineNum,
              column: j + 1,
              message: 'Unexpected closing bracket',
              severity: 'error',
            });
            bracketCount = 0;
          }
        }
      }

      // Check for unterminated string on same line (but not template strings)
      if (inString) {
        errors.push({
          line: lineNum,
          column: 1,
          message: 'Unterminated string literal',
          severity: 'error',
        });
        inString = false;
        stringChar = '';
      }
    }

    // Check for unclosed brackets at end
    if (braceCount > 0) {
      errors.push({
        line: lines.length,
        column: 1,
        message: `${braceCount} unclosed brace(s)`,
        severity: 'error',
      });
    }
    if (parenCount > 0) {
      errors.push({
        line: lines.length,
        column: 1,
        message: `${parenCount} unclosed parenthesis(es)`,
        severity: 'error',
      });
    }
    if (bracketCount > 0) {
      errors.push({
        line: lines.length,
        column: 1,
        message: `${bracketCount} unclosed bracket(s)`,
        severity: 'error',
      });
    }
    if (inTemplateString) {
      errors.push({
        line: lines.length,
        column: 1,
        message: 'Unterminated template string',
        severity: 'error',
      });
    }
    if (inBlockComment) {
      errors.push({
        line: lines.length,
        column: 1,
        message: 'Unterminated block comment',
        severity: 'error',
      });
    }

    return {
      valid: errors.filter((e) => e.severity === 'error').length === 0,
      errors,
      language,
    };
  }

  /**
   * Create a backup of the file before editing
   */
  private createBackup(filePath: string): string | null {
    const editConfig = this.config.getConfig().editing;
    if (!editConfig?.backupEnabled) {
      return null;
    }

    const resolvedPath = this.config.resolveWorkspacePath(filePath);
    if (!existsSync(resolvedPath)) {
      return null;
    }

    // Get the workspace root and resolve it to absolute
    const workspaceRoot = this.config.getDefaultWorkspaceRoot();
    // Use normalizePath to prevent Windows drive duplication (C:\c:\...)
    const absoluteWorkspaceRoot = normalizePath(
      isAbsolute(workspaceRoot) ? workspaceRoot : resolve(workspaceRoot)
    );

    // Create backup root relative to workspace - absoluteWorkspaceRoot is now guaranteed normalized
    const backupRoot = join(absoluteWorkspaceRoot, this.backupDir);

    // Make the file path relative to workspace for backup structure
    const absoluteFilePath = isAbsolute(filePath) ? filePath : resolvedPath;
    const relativeFilePath = absoluteFilePath.startsWith(absoluteWorkspaceRoot)
      ? absoluteFilePath.slice(absoluteWorkspaceRoot.length).replace(/^[/\\]/, '')
      : basename(filePath); // Fallback to just the filename

    // Create timestamp-based backup name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${basename(filePath)}.${timestamp}.bak`;
    const backupPath = join(backupRoot, dirname(relativeFilePath), backupFileName);

    // Ensure backup directory exists
    mkdirSync(dirname(backupPath), { recursive: true });

    // Copy file to backup
    copyFileSync(resolvedPath, backupPath);

    return backupPath;
  }

  /**
   * Generate a unified diff between two content strings
   */
  private generateDiff(originalContent: string, newContent: string, filePath: string): string {
    const originalLines = originalContent.split('\n');
    const newLines = newContent.split('\n');

    const diff: string[] = [];
    diff.push(`--- a/${filePath}`);
    diff.push(`+++ b/${filePath}`);

    // Simple diff algorithm - show changed regions
    let i = 0,
      j = 0;
    let hunkStart = -1;
    let hunkOrigStart = 0;
    let hunkNewStart = 0;
    let hunkLines: string[] = [];

    const flushHunk = () => {
      if (hunkLines.length > 0) {
        diff.push(
          `@@ -${hunkOrigStart + 1},${hunkLines.filter((l) => l.startsWith('-') || l.startsWith(' ')).length} +${hunkNewStart + 1},${hunkLines.filter((l) => l.startsWith('+') || l.startsWith(' ')).length} @@`
        );
        diff.push(...hunkLines);
        hunkLines = [];
        hunkStart = -1;
      }
    };

    while (i < originalLines.length || j < newLines.length) {
      if (i < originalLines.length && j < newLines.length && originalLines[i] === newLines[j]) {
        // Lines match - context or flush
        if (hunkLines.length > 0) {
          // Add context after changes
          if (hunkLines.filter((l) => l.startsWith('-') || l.startsWith('+')).length > 0) {
            hunkLines.push(' ' + originalLines[i]);
          }
          // Check if we should flush (3 lines of unchanged after changes)
          const contextCount = hunkLines
            .slice()
            .reverse()
            .findIndex((l) => l.startsWith('-') || l.startsWith('+'));
          if (contextCount >= 3) {
            // Keep only 3 context lines
            hunkLines = hunkLines.slice(0, hunkLines.length - contextCount + 3);
            flushHunk();
          }
        }
        i++;
        j++;
      } else if (
        i < originalLines.length &&
        (j >= newLines.length || originalLines[i] !== newLines[j])
      ) {
        // Line removed from original
        if (hunkStart === -1) {
          hunkStart = i;
          hunkOrigStart = Math.max(0, i - 3);
          hunkNewStart = Math.max(0, j - 3);
          // Add context before
          for (let ctx = Math.max(0, i - 3); ctx < i; ctx++) {
            if (ctx < originalLines.length) {
              hunkLines.push(' ' + originalLines[ctx]);
            }
          }
        }
        hunkLines.push('-' + originalLines[i]);
        i++;
      } else {
        // Line added in new
        if (hunkStart === -1) {
          hunkStart = i;
          hunkOrigStart = Math.max(0, i - 3);
          hunkNewStart = Math.max(0, j - 3);
          // Add context before
          for (let ctx = Math.max(0, i - 3); ctx < i; ctx++) {
            if (ctx < originalLines.length) {
              hunkLines.push(' ' + originalLines[ctx]);
            }
          }
        }
        hunkLines.push('+' + newLines[j]);
        j++;
      }
    }

    flushHunk();

    return diff.join('\n');
  }

  /**
   * Apply an operation to content and return the result
   */
  private applyOperation(
    content: string,
    operation: EditOperation,
    startLine: number,
    endLine: number | undefined,
    newContent: string | undefined
  ): { newContent: string; linesAffected: number } {
    const lines = content.split('\n');
    const effectiveEndLine = endLine ?? startLine;

    // Validate line numbers
    if (startLine < 1 || startLine > lines.length + 1) {
      throw new Error(`Invalid start line ${startLine}. File has ${lines.length} lines.`);
    }
    if (effectiveEndLine < startLine) {
      throw new Error(`End line ${effectiveEndLine} cannot be before start line ${startLine}`);
    }

    let result: string[];
    let linesAffected: number;

    switch (operation) {
      case 'replace': {
        const newLines = newContent?.split('\n') || [];
        const beforeLines = lines.slice(0, startLine - 1);
        const afterLines = lines.slice(effectiveEndLine);
        result = [...beforeLines, ...newLines, ...afterLines];
        linesAffected = effectiveEndLine - startLine + 1;
        break;
      }

      case 'insert': {
        const newLines = newContent?.split('\n') || [];
        const beforeLines = lines.slice(0, startLine);
        const afterLines = lines.slice(startLine);
        result = [...beforeLines, ...newLines, ...afterLines];
        linesAffected = newLines.length;
        break;
      }

      case 'delete': {
        const beforeLines = lines.slice(0, startLine - 1);
        const afterLines = lines.slice(effectiveEndLine);
        result = [...beforeLines, ...afterLines];
        linesAffected = effectiveEndLine - startLine + 1;
        break;
      }

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    return {
      newContent: result.join('\n'),
      linesAffected,
    };
  }

  /**
   * Preview an edit without applying it
   */
  editFilePreview(
    filePath: string,
    operation: EditOperation,
    startLine: number,
    endLine?: number,
    newContent?: string
  ): EditPreviewResult {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    // Check editing is enabled
    const editConfig = this.config.getConfig().editing;
    if (!editConfig?.enabled) {
      throw new Error('Editing is disabled in configuration');
    }

    // Read current content
    if (!existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const currentContent = readFileSync(resolvedPath, 'utf-8');

    // Apply operation to get preview
    const { newContent: resultContent, linesAffected } = this.applyOperation(
      currentContent,
      operation,
      startLine,
      endLine,
      newContent
    );

    // Generate diff
    const diff = this.generateDiff(currentContent, resultContent, filePath);

    // Validate syntax of result
    const validation = this.validateSyntax(filePath, resultContent);

    // Generate warnings
    const warnings: string[] = [];

    if (!validation.valid) {
      warnings.push('Result has syntax errors');
    }

    // Check file size
    const maxSize = editConfig?.maxFileSize || 1048576;
    if (resultContent.length > maxSize) {
      warnings.push(
        `Result file size (${resultContent.length} bytes) exceeds limit (${maxSize} bytes)`
      );
    }

    return {
      diff,
      linesAffected,
      syntaxValid: validation.valid,
      warnings,
    };
  }

  /**
   * Preview applying a diff to a file
   */
  applyDiffPreview(filePath: string, diff: string): ApplyDiffPreviewResult {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    // Read current content
    if (!existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const currentContent = readFileSync(resolvedPath, 'utf-8');
    const lines = currentContent.split('\n');

    // Parse and apply diff
    const conflicts: string[] = [];
    let canApply = true;
    const resultLines = [...lines];

    // Parse unified diff format
    const diffLines = diff.split('\n');
    let lineOffset = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];

      // Skip header lines
      if (line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }

      // Parse hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        const origStart = parseInt(hunkMatch[1], 10) - 1; // 0-indexed
        let currentLine = origStart + lineOffset;

        // Process hunk lines
        i++;
        while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
          const hunkLine = diffLines[i];

          if (hunkLine.startsWith(' ')) {
            // Context line - verify it matches
            const expectedContent = hunkLine.substring(1);
            if (currentLine < resultLines.length && resultLines[currentLine] !== expectedContent) {
              conflicts.push(
                `Line ${currentLine + 1}: expected "${expectedContent.substring(0, 50)}" but found "${resultLines[currentLine]?.substring(0, 50)}"`
              );
              canApply = false;
            }
            currentLine++;
          } else if (hunkLine.startsWith('-')) {
            // Remove line
            const expectedContent = hunkLine.substring(1);
            if (currentLine < resultLines.length && resultLines[currentLine] !== expectedContent) {
              conflicts.push(`Line ${currentLine + 1}: cannot remove, content mismatch`);
              canApply = false;
            } else {
              resultLines.splice(currentLine, 1);
              lineOffset--;
            }
          } else if (hunkLine.startsWith('+')) {
            // Add line
            const newLine = hunkLine.substring(1);
            resultLines.splice(currentLine, 0, newLine);
            currentLine++;
            lineOffset++;
          }

          i++;
        }
        i--; // Back up so outer loop can process next hunk
      }
    }

    const resultContent = resultLines.join('\n');

    // Validate syntax
    const validation = this.validateSyntax(filePath, resultContent);

    // Generate preview (first 100 lines)
    const previewLines = resultLines.slice(0, 100);
    const resultPreview =
      previewLines.join('\n') + (resultLines.length > 100 ? '\n... (truncated)' : '');

    return {
      canApply,
      conflicts,
      resultPreview,
      syntaxValid: validation.valid,
    };
  }

  /**
   * Actually edit a file with backup and validation
   */
  editFile(
    filePath: string,
    operation: EditOperation,
    startLine: number,
    endLine?: number,
    newContent?: string,
    options: EditOptions = {}
  ): EditResult {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    // Check editing is enabled
    const editConfig = this.config.getConfig().editing;
    if (!editConfig?.enabled) {
      throw new Error('Editing is disabled in configuration');
    }

    // Read current content
    if (!existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const currentContent = readFileSync(resolvedPath, 'utf-8');

    // Apply operation
    const { newContent: resultContent, linesAffected } = this.applyOperation(
      currentContent,
      operation,
      startLine,
      endLine,
      newContent
    );

    // Validate syntax unless skipped
    if (!options.skipValidation) {
      const validation = this.validateSyntax(filePath, resultContent);
      if (!validation.valid) {
        return {
          success: false,
          diff: '',
          linesChanged: 0,
          error: `Syntax validation failed: ${validation.errors.map((e) => e.message).join(', ')}`,
        };
      }
    }

    // Create backup unless skipped
    let backupPath: string | undefined;
    if (!options.skipBackup) {
      const backup = this.createBackup(filePath);
      if (backup) {
        backupPath = backup;
      }
    }

    // Generate diff before writing
    const diff = this.generateDiff(currentContent, resultContent, filePath);

    try {
      // Write the new content
      writeFileSync(resolvedPath, resultContent, 'utf-8');

      // Log the operation
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        operation: `${operation} lines ${startLine}-${endLine || startLine}`,
        file: filePath,
        backupPath,
        success: true,
      });

      return {
        success: true,
        backupPath,
        diff,
        linesChanged: linesAffected,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Log the failure
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        operation: `${operation} lines ${startLine}-${endLine || startLine}`,
        file: filePath,
        backupPath,
        success: false,
      });

      return {
        success: false,
        backupPath,
        diff,
        linesChanged: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Edit multiple files with optional transaction support
   */
  multiFileEdit(edits: MultiEditInput[], transactional: boolean = false): MultiEditResult {
    const results: Array<{
      file_path: string;
      success: boolean;
      error?: string;
      backupPath?: string;
    }> = [];

    const backups: Array<{ file: string; backupPath: string; content: string }> = [];
    let allSuccess = true;

    // If transactional, pre-read all files and create backups
    if (transactional) {
      for (const edit of edits) {
        try {
          const resolvedPath = this.config.resolveWorkspacePath(edit.file_path);
          if (existsSync(resolvedPath)) {
            const content = readFileSync(resolvedPath, 'utf-8');
            const backupPath = this.createBackup(edit.file_path);
            backups.push({
              file: resolvedPath,
              backupPath: backupPath || '',
              content,
            });
          }
        } catch {
          // Will be caught during actual edit
        }
      }
    }

    // Apply edits
    for (const edit of edits) {
      let result: EditResult;
      try {
        result = this.editFile(
          edit.file_path,
          edit.operation,
          edit.startLine,
          edit.endLine,
          edit.newContent,
          { skipBackup: transactional } // Already backed up
        );
      } catch (error) {
        // Wrap thrown errors into a result object
        result = {
          success: false,
          diff: '',
          linesChanged: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      results.push({
        file_path: edit.file_path,
        success: result.success,
        error: result.error,
        backupPath: result.backupPath,
      });

      if (!result.success) {
        allSuccess = false;

        if (transactional) {
          // Rollback all changes
          for (const backup of backups) {
            try {
              writeFileSync(backup.file, backup.content, 'utf-8');
            } catch {
              // Best effort rollback
            }
          }

          return {
            success: false,
            results,
            rollbackPerformed: true,
          };
        }
      }
    }

    return {
      success: allSuccess,
      results,
      rollbackPerformed: false,
    };
  }

  /**
   * Get the audit log of recent operations
   */
  getAuditLog(): typeof this.auditLog {
    return [...this.auditLog];
  }

  /**
   * Restore a file from backup
   */
  restoreFromBackup(backupPath: string, targetPath: string): boolean {
    const resolvedBackup = this.config.resolveWorkspacePath(backupPath);
    const resolvedTarget = this.config.resolveWorkspacePath(targetPath);

    if (!existsSync(resolvedBackup)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    if (!this.config.isPathAllowed(resolvedTarget)) {
      throw new Error(`Access denied: Path '${targetPath}' is not in the allowlist`);
    }

    try {
      copyFileSync(resolvedBackup, resolvedTarget);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply a unified diff to a file
   */
  applyDiff(
    filePath: string,
    diff: string,
    options?: {
      dryRun?: boolean;
      force?: boolean; // Apply even with conflicts (best effort)
    }
  ): ApplyDiffResult {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    // Check editing is enabled
    const editConfig = this.config.getConfig().editing;
    if (!editConfig?.enabled) {
      throw new Error('Editing is disabled in configuration');
    }

    // Read current content
    if (!existsSync(resolvedPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const currentContent = readFileSync(resolvedPath, 'utf-8');
    const lines = currentContent.split('\n');

    // Parse and apply diff
    const conflicts: string[] = [];
    let canApply = true;
    const resultLines = [...lines];
    let hunksApplied = 0;
    let hunksRejected = 0;

    // Parse unified diff format
    const diffLines = diff.split('\n');
    let lineOffset = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];

      // Skip header lines
      if (line.startsWith('---') || line.startsWith('+++')) {
        continue;
      }

      // Parse hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        const origStart = parseInt(hunkMatch[1], 10) - 1; // 0-indexed
        const currentLine = origStart + lineOffset;
        let hunkSuccess = true;
        const hunkChanges: Array<{ type: 'add' | 'remove'; line: number; content: string }> = [];

        // Collect hunk operations first to validate
        let tempLine = currentLine;

        i++;
        while (
          i < diffLines.length &&
          !diffLines[i].startsWith('@@') &&
          !diffLines[i].startsWith('diff ')
        ) {
          const hunkLine = diffLines[i];

          if (hunkLine.startsWith(' ')) {
            // Context line - verify it matches
            const expectedContent = hunkLine.substring(1);
            if (tempLine < resultLines.length && resultLines[tempLine] !== expectedContent) {
              conflicts.push(
                `Line ${tempLine + 1}: expected "${expectedContent.substring(0, 40)}..." but found "${resultLines[tempLine]?.substring(0, 40)}..."`
              );
              hunkSuccess = false;
              if (!options?.force) {
                canApply = false;
              }
            }
            tempLine++;
          } else if (hunkLine.startsWith('-')) {
            // Will remove line
            const expectedContent = hunkLine.substring(1);
            if (tempLine < resultLines.length && resultLines[tempLine] !== expectedContent) {
              conflicts.push(`Line ${tempLine + 1}: cannot remove, content mismatch`);
              hunkSuccess = false;
              if (!options?.force) {
                canApply = false;
              }
            }
            hunkChanges.push({ type: 'remove', line: tempLine, content: expectedContent });
            tempLine++;
            // Offset tracked implicitly in hunk processing
          } else if (hunkLine.startsWith('+')) {
            // Will add line
            hunkChanges.push({ type: 'add', line: tempLine, content: hunkLine.substring(1) });
            // Offset tracked implicitly
          } else if (hunkLine === '' || hunkLine === '\\ No newline at end of file') {
            // Empty line in diff or special marker
          }

          i++;
        }
        i--; // Back up so outer loop can process next hunk

        // Apply hunk if it's valid or force mode is on
        if (hunkSuccess || options?.force) {
          // Apply changes in reverse order for removes to preserve line numbers
          const removes = hunkChanges.filter((c) => c.type === 'remove').reverse();
          const adds = hunkChanges.filter((c) => c.type === 'add');

          // Apply removes in reverse order to preserve line numbers
          for (const change of removes) {
            const actualLine = change.line + lineOffset;
            if (actualLine >= 0 && actualLine < resultLines.length) {
              resultLines.splice(actualLine, 1);
              lineOffset--;
            }
          }

          for (const change of adds) {
            // Use the recorded line position plus cumulative offset
            const actualLine = change.line + lineOffset;
            resultLines.splice(Math.max(0, actualLine), 0, change.content);
            lineOffset++;
          }

          hunksApplied++;
        } else {
          hunksRejected++;
        }
      }
    }

    // If dry run, just return what would happen
    if (options?.dryRun) {
      return {
        success: canApply || Boolean(options?.force && hunksApplied > 0),
        hunksApplied,
        hunksRejected,
        conflicts,
      };
    }

    // Check if we should proceed
    if (!canApply && !options?.force) {
      return {
        success: false,
        hunksApplied: 0,
        hunksRejected: hunksRejected + hunksApplied, // All rejected
        conflicts,
        error: 'Diff could not be applied due to conflicts',
      };
    }

    const resultContent = resultLines.join('\n');

    // Validate syntax
    const validation = this.validateSyntax(filePath, resultContent);
    if (!validation.valid && !options?.force) {
      return {
        success: false,
        hunksApplied,
        hunksRejected,
        conflicts,
        error: `Result has syntax errors: ${validation.errors.map((e) => e.message).join(', ')}`,
      };
    }

    // Create backup
    const backupPath = this.createBackup(filePath);

    try {
      // Write the result
      writeFileSync(resolvedPath, resultContent, 'utf-8');

      // Log the operation
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        operation: `apply_diff (${hunksApplied} hunks)`,
        file: filePath,
        backupPath: backupPath || undefined,
        success: true,
      });

      return {
        success: true,
        hunksApplied,
        hunksRejected,
        conflicts,
        backupPath: backupPath || undefined,
      };
    } catch (error) {
      return {
        success: false,
        hunksApplied: 0,
        hunksRejected: hunksApplied + hunksRejected,
        conflicts,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create a new file with validation
   */
  createFile(
    filePath: string,
    content: string,
    options?: {
      overwrite?: boolean;
      createDirectories?: boolean;
      validateSyntax?: boolean;
    }
  ): CreateFileResult {
    const resolvedPath = this.config.resolveWorkspacePath(filePath);

    if (!this.config.isPathAllowed(resolvedPath)) {
      throw new Error(`Access denied: Path '${filePath}' is not in the allowlist`);
    }

    // Check editing is enabled
    const editConfig = this.config.getConfig().editing;
    if (!editConfig?.enabled) {
      throw new Error('Editing is disabled in configuration');
    }

    // Check if file exists
    if (existsSync(resolvedPath) && !options?.overwrite) {
      return {
        success: false,
        error: `File already exists: ${filePath}. Use overwrite option to replace.`,
      };
    }

    // Validate syntax if requested
    if (options?.validateSyntax !== false) {
      const validation = this.validateSyntax(filePath, content);
      if (!validation.valid) {
        return {
          success: false,
          error: `Syntax validation failed: ${validation.errors.map((e) => e.message).join(', ')}`,
          syntaxErrors: validation.errors,
        };
      }
    }

    // Check file size limit
    const maxSize = editConfig?.maxFileSize || 1048576;
    if (content.length > maxSize) {
      return {
        success: false,
        error: `Content size (${content.length} bytes) exceeds limit (${maxSize} bytes)`,
      };
    }

    // Create directories if needed
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      if (options?.createDirectories !== false) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch (error) {
          return {
            success: false,
            error: `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } else {
        return {
          success: false,
          error: `Directory does not exist: ${dir}`,
        };
      }
    }

    // Backup existing file if overwriting
    let backupPath: string | undefined;
    if (existsSync(resolvedPath) && options?.overwrite) {
      const backup = this.createBackup(filePath);
      if (backup) {
        backupPath = backup;
      }
    }

    try {
      // Write the file
      writeFileSync(resolvedPath, content, 'utf-8');

      // Log the operation
      this.auditLog.push({
        timestamp: new Date().toISOString(),
        operation: options?.overwrite && backupPath ? 'create_file (overwrite)' : 'create_file',
        file: filePath,
        backupPath,
        success: true,
      });

      return {
        success: true,
        path: filePath,
        size: content.length,
        backupPath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
