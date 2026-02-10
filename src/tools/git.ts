/**
 * Git Tools - Tools for interacting with Git repositories
 * Provides safe access to git status, diff, log, and commit operations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { GitStatusResult, GitDiffResult, GitLogResult, GitCommitResult } from '../types/index.js';

const execAsync = promisify(exec);

export interface GitToolsOptions {
  workspaceRoot: string;
  timeout?: number;
  maxOutputSize?: number;
}

interface GitFileStatus {
  file: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'ignored';
  staged: boolean;
}

interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export class GitTools {
  private workspaceRoot: string;
  private timeout: number;
  private maxOutputSize: number;

  constructor(options: GitToolsOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.timeout = options.timeout ?? 30000;
    this.maxOutputSize = options.maxOutputSize ?? 100 * 1024; // 100KB
  }

  /**
   * Execute a git command safely
   */
  private async execGit(
    args: string
  ): Promise<{ stdout: string; stderr: string; success: boolean }> {
    try {
      const result = await execAsync(`git ${args}`, {
        cwd: this.workspaceRoot,
        timeout: this.timeout,
        maxBuffer: this.maxOutputSize * 2,
        windowsHide: true,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        success: true,
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message?: string };
      return {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message ?? String(error),
        success: false,
      };
    }
  }

  /**
   * Check if the workspace is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    const gitDir = join(this.workspaceRoot, '.git');
    if (existsSync(gitDir)) {
      return true;
    }

    // Also check via git command (handles worktrees, etc.)
    const result = await this.execGit('rev-parse --is-inside-work-tree');
    return result.success && result.stdout.trim() === 'true';
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string | null> {
    const result = await this.execGit('rev-parse --abbrev-ref HEAD');
    if (result.success) {
      return result.stdout.trim();
    }
    return null;
  }

  /**
   * Get git status
   */
  async gitStatus(options?: {
    includeUntracked?: boolean;
    short?: boolean;
  }): Promise<GitStatusResult> {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return {
        success: false,
        isRepository: false,
        branch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        error: 'Not a git repository',
      };
    }

    const branch = await this.getCurrentBranch();

    // Get porcelain status for parsing
    const untrackedFlag = options?.includeUntracked !== false ? '-uall' : '-uno';
    const result = await this.execGit(`status --porcelain=v1 ${untrackedFlag}`);

    if (!result.success) {
      return {
        success: false,
        isRepository: true,
        branch,
        staged: [],
        unstaged: [],
        untracked: [],
        error: result.stderr,
      };
    }

    const staged: GitFileStatus[] = [];
    const unstaged: GitFileStatus[] = [];
    const untracked: string[] = [];

    const lines = result.stdout.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const file = line.substring(3).trim();

      // Handle renamed files (format: "R  old -> new")
      const fileName = file.includes(' -> ') ? file.split(' -> ')[1] : file;

      // Untracked files
      if (indexStatus === '?' && workTreeStatus === '?') {
        untracked.push(fileName);
        continue;
      }

      // Staged changes
      if (indexStatus !== ' ' && indexStatus !== '?') {
        staged.push({
          file: fileName,
          status: this.parseGitStatus(indexStatus),
          staged: true,
        });
      }

      // Unstaged changes
      if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
        unstaged.push({
          file: fileName,
          status: this.parseGitStatus(workTreeStatus),
          staged: false,
        });
      }
    }

    // Get ahead/behind info
    let ahead = 0;
    let behind = 0;
    const trackingResult = await this.execGit('rev-list --left-right --count HEAD...@{upstream}');
    if (trackingResult.success) {
      const parts = trackingResult.stdout.trim().split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    }

    return {
      success: true,
      isRepository: true,
      branch,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
    };
  }

  /**
   * Parse git status character to status string
   */
  private parseGitStatus(char: string): GitFileStatus['status'] {
    switch (char) {
      case 'M':
        return 'modified';
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case 'C':
        return 'copied';
      case '?':
        return 'untracked';
      case '!':
        return 'ignored';
      default:
        return 'modified';
    }
  }

  /**
   * Get git diff
   */
  async gitDiff(options?: {
    file?: string;
    staged?: boolean;
    commit?: string;
    compareWith?: string;
    unified?: number; // Context lines
  }): Promise<GitDiffResult> {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return {
        success: false,
        diff: '',
        files: [],
        additions: 0,
        deletions: 0,
        error: 'Not a git repository',
      };
    }

    let args = 'diff';

    // Staged changes
    if (options?.staged) {
      args += ' --cached';
    }

    // Compare commits
    if (options?.commit && options?.compareWith) {
      args += ` ${options.commit}..${options.compareWith}`;
    } else if (options?.commit) {
      args += ` ${options.commit}`;
    }

    // Context lines
    if (options?.unified !== undefined) {
      args += ` -U${options.unified}`;
    }

    // Specific file
    if (options?.file) {
      const filePath = isAbsolute(options.file)
        ? options.file
        : join(this.workspaceRoot, options.file);
      args += ` -- "${filePath}"`;
    }

    const result = await this.execGit(args);

    if (!result.success) {
      return {
        success: false,
        diff: '',
        files: [],
        additions: 0,
        deletions: 0,
        error: result.stderr,
      };
    }

    // Get stat for summary
    const statResult = await this.execGit(`${args} --stat`);

    // Parse files changed
    const files: string[] = [];
    let additions = 0;
    let deletions = 0;

    if (statResult.success) {
      const statLines = statResult.stdout.split('\n');
      for (const line of statLines) {
        // Match file lines: " file.ts | 10 ++----"
        const fileMatch = line.match(/^\s+([^|]+)\s+\|/);
        if (fileMatch) {
          files.push(fileMatch[1].trim());
        }

        // Match summary line: " 3 files changed, 10 insertions(+), 5 deletions(-)"
        const summaryMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
        const delMatch = line.match(/(\d+)\s+deletions?\(-\)/);
        if (summaryMatch) additions = parseInt(summaryMatch[1], 10);
        if (delMatch) deletions = parseInt(delMatch[1], 10);
      }
    }

    // Truncate diff if too large
    let diff = result.stdout;
    if (diff.length > this.maxOutputSize) {
      diff =
        diff.substring(0, this.maxOutputSize) +
        `\n\n... (diff truncated, ${diff.length - this.maxOutputSize} bytes omitted)`;
    }

    return {
      success: true,
      diff,
      files,
      additions,
      deletions,
    };
  }

  /**
   * Get git log
   */
  async gitLog(options?: {
    maxCount?: number;
    file?: string;
    author?: string;
    since?: string;
    until?: string;
    grep?: string;
    oneline?: boolean;
  }): Promise<GitLogResult> {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return {
        success: false,
        entries: [],
        error: 'Not a git repository',
      };
    }

    const maxCount = options?.maxCount ?? 20;

    // Use a custom format for parsing
    const format = options?.oneline ? '%h %s' : '%H|%h|%an|%ae|%ai|%s|%b|||'; // Using ||| as entry separator

    let args = `log -n ${maxCount} --format="${format}"`;

    if (options?.author) {
      args += ` --author="${options.author}"`;
    }

    if (options?.since) {
      args += ` --since="${options.since}"`;
    }

    if (options?.until) {
      args += ` --until="${options.until}"`;
    }

    if (options?.grep) {
      args += ` --grep="${options.grep}"`;
    }

    if (options?.file) {
      const filePath = isAbsolute(options.file)
        ? options.file
        : join(this.workspaceRoot, options.file);
      args += ` -- "${filePath}"`;
    }

    const result = await this.execGit(args);

    if (!result.success) {
      return {
        success: false,
        entries: [],
        error: result.stderr,
      };
    }

    const entries: GitLogEntry[] = [];

    if (options?.oneline) {
      const lines = result.stdout.split('\n').filter((line) => line.trim());
      for (const line of lines) {
        const [shortHash, ...subjectParts] = line.split(' ');
        entries.push({
          hash: '',
          shortHash,
          author: '',
          email: '',
          date: '',
          subject: subjectParts.join(' '),
          body: '',
        });
      }
    } else {
      // Parse custom format
      const entryStrings = result.stdout.split('|||').filter((e) => e.trim());
      for (const entryStr of entryStrings) {
        const parts = entryStr.trim().split('|');
        if (parts.length >= 6) {
          entries.push({
            hash: parts[0],
            shortHash: parts[1],
            author: parts[2],
            email: parts[3],
            date: parts[4],
            subject: parts[5],
            body: parts.slice(6).join('|').trim(),
          });
        }
      }
    }

    return {
      success: true,
      entries,
      totalCount: entries.length,
    };
  }

  /**
   * Create a git commit
   */
  async gitCommit(options: {
    message: string;
    files?: string[]; // Specific files to commit (stages them first)
    all?: boolean; // Stage all modified files
    amend?: boolean; // Amend previous commit
    allowEmpty?: boolean; // Allow empty commits
  }): Promise<GitCommitResult> {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return {
        success: false,
        error: 'Not a git repository',
      };
    }

    // Validate message
    if (!options.message || options.message.trim().length === 0) {
      return {
        success: false,
        error: 'Commit message is required',
      };
    }

    // Stage specific files if provided
    if (options.files && options.files.length > 0) {
      for (const file of options.files) {
        const filePath = isAbsolute(file) ? file : join(this.workspaceRoot, file);
        const addResult = await this.execGit(`add "${filePath}"`);
        if (!addResult.success) {
          return {
            success: false,
            error: `Failed to stage file ${file}: ${addResult.stderr}`,
          };
        }
      }
    }

    // Build commit command
    let args = 'commit';

    if (options.all) {
      args += ' -a';
    }

    if (options.amend) {
      args += ' --amend';
    }

    if (options.allowEmpty) {
      args += ' --allow-empty';
    }

    // Escape message for command line
    const escapedMessage = options.message.replace(/"/g, '\\"');
    args += ` -m "${escapedMessage}"`;

    const result = await this.execGit(args);

    if (!result.success) {
      // Check for common issues
      if (result.stderr.includes('nothing to commit')) {
        return {
          success: false,
          error: 'Nothing to commit - working tree is clean',
        };
      }

      if (result.stderr.includes('no changes added to commit')) {
        return {
          success: false,
          error: 'No changes staged for commit. Use --all to stage all changes or specify files.',
        };
      }

      return {
        success: false,
        error: result.stderr,
      };
    }

    // Parse commit result to get hash and other info
    // Output format: "[branch hash] message\n files changed..."
    const lines = result.stdout.split('\n');
    let commitHash = '';
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    for (const line of lines) {
      // Match: "[main abc1234] Commit message"
      const hashMatch = line.match(/\[[\w\-/]+\s+([a-f0-9]+)\]/);
      if (hashMatch) {
        commitHash = hashMatch[1];
      }

      // Match: " 3 files changed, 10 insertions(+), 5 deletions(-)"
      const statsMatch = line.match(/(\d+)\s+files?\s+changed/);
      if (statsMatch) {
        filesChanged = parseInt(statsMatch[1], 10);
      }
      const insMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
      if (insMatch) {
        insertions = parseInt(insMatch[1], 10);
      }
      const delMatch = line.match(/(\d+)\s+deletions?\(-\)/);
      if (delMatch) {
        deletions = parseInt(delMatch[1], 10);
      }
    }

    return {
      success: true,
      hash: commitHash,
      message: options.message,
      filesChanged,
      insertions,
      deletions,
    };
  }

  /**
   * Get the remote URL
   */
  async getRemoteUrl(remote: string = 'origin'): Promise<string | null> {
    const result = await this.execGit(`remote get-url ${remote}`);
    if (result.success) {
      return result.stdout.trim();
    }
    return null;
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const result = await this.execGit('status --porcelain');
    return result.success && result.stdout.trim().length > 0;
  }
}

export default GitTools;
