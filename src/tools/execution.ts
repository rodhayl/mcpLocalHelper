/**
 * Execution Tools - Tools for running tests, linters, formatters, and scripts
 * These tools execute commands in a sandboxed manner with timeout and output limits
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync, readFileSync } from 'fs';
import { join, isAbsolute, extname } from 'path';
import { ExecutionResult } from '../types/index.js';

const execAsync = promisify(exec);

export interface ExecutionOptions {
  workspaceRoot: string;
  timeout?: number; // Timeout in milliseconds (default: 60000)
  maxOutputSize?: number; // Max output size in bytes (default: 100KB)
  allowedCommands?: string[]; // Whitelist of allowed commands
  env?: Record<string, string>; // Additional environment variables
}

export interface ScriptOptions extends ExecutionOptions {
  args?: string[];
  cwd?: string;
}

// Default safe commands that can be executed
const DEFAULT_ALLOWED_COMMANDS = [
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'node',
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'eslint',
  'prettier',
  'tslint',
  'python',
  'python3',
  'pip',
  'pytest',
  'go',
  'cargo',
  'rustfmt',
  'clippy',
  'make',
  'cmake',
  'git', // Read-only git commands
];

// Dangerous patterns to block
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i,
  /rmdir\s+\/s/i,
  /del\s+\/[fqs]/i,
  /format\s+[a-z]:/i,
  /shutdown/i,
  /reboot/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|/, // Fork bomb
  />\s*\/dev\/sd/i,
  /curl.*\|\s*(ba)?sh/i, // Piped execution
  /wget.*\|\s*(ba)?sh/i,
];

export class ExecutionTools {
  private workspaceRoot: string;
  private defaultTimeout: number;
  private maxOutputSize: number;
  private allowedCommands: Set<string>;

  constructor(options: ExecutionOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.defaultTimeout = options.timeout ?? 60000;
    this.maxOutputSize = options.maxOutputSize ?? 100 * 1024; // 100KB
    this.allowedCommands = new Set(options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);
  }

  /**
   * Validate command safety
   */
  private validateCommand(command: string): { valid: boolean; error?: string } {
    // Check for dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { valid: false, error: `Command contains dangerous pattern: ${pattern.source}` };
      }
    }

    // Extract base command
    const parts = command.trim().split(/\s+/);
    const baseCommand = parts[0].toLowerCase();

    // Check if command is in whitelist
    if (!this.allowedCommands.has(baseCommand)) {
      return {
        valid: false,
        error: `Command '${baseCommand}' is not in the allowed list. Allowed: ${Array.from(this.allowedCommands).join(', ')}`,
      };
    }

    return { valid: true };
  }

  /**
   * Truncate output if it exceeds max size
   */
  private truncateOutput(output: string): string {
    if (output.length > this.maxOutputSize) {
      const truncated = output.substring(0, this.maxOutputSize);
      return (
        truncated +
        `\n\n... (output truncated, ${output.length - this.maxOutputSize} bytes omitted)`
      );
    }
    return output;
  }

  /**
   * Execute a command safely
   */
  private async executeCommand(
    command: string,
    cwd: string,
    timeout: number,
    env?: Record<string, string>
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      const validation = this.validateCommand(command);
      if (!validation.valid) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: validation.error ?? 'Command validation failed',
          duration: 0,
          command,
        };
      }

      const result = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: this.maxOutputSize * 2,
        env: { ...process.env, ...env },
        windowsHide: true,
      });

      const duration = Date.now() - startTime;

      return {
        success: true,
        exitCode: 0,
        stdout: this.truncateOutput(result.stdout),
        stderr: this.truncateOutput(result.stderr),
        duration,
        command,
      };
    } catch (error: unknown) {
      const duration = Date.now() - startTime;
      const execError = error as {
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        code?: number;
      };

      // Handle timeout
      if (execError.killed) {
        return {
          success: false,
          exitCode: -1,
          stdout: this.truncateOutput(execError.stdout ?? ''),
          stderr: `Command timed out after ${timeout}ms`,
          duration,
          command,
          timedOut: true,
        };
      }

      // Handle command failure (non-zero exit)
      return {
        success: false,
        exitCode: execError.code ?? -1,
        stdout: this.truncateOutput(execError.stdout ?? ''),
        stderr: this.truncateOutput(
          execError.stderr ?? (error instanceof Error ? error.message : String(error))
        ),
        duration,
        command,
      };
    }
  }

  /**
   * Detect test framework and build test command
   */
  private async detectTestCommand(): Promise<string | undefined> {
    const packageJsonPath = join(this.workspaceRoot, 'package.json');

    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

        // Check scripts
        if (pkg.scripts?.test) {
          return 'npm test';
        }

        // Check devDependencies for common test frameworks
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vitest) return 'npx vitest run';
        if (deps.jest) return 'npx jest';
        if (deps.mocha) return 'npx mocha';
        if (deps.ava) return 'npx ava';
      } catch {
        // Ignore parse errors
      }
    }

    // Python projects
    if (
      existsSync(join(this.workspaceRoot, 'pytest.ini')) ||
      existsSync(join(this.workspaceRoot, 'pyproject.toml'))
    ) {
      return 'pytest';
    }

    // Go projects
    if (existsSync(join(this.workspaceRoot, 'go.mod'))) {
      return 'go test ./...';
    }

    // Rust projects
    if (existsSync(join(this.workspaceRoot, 'Cargo.toml'))) {
      return 'cargo test';
    }

    return undefined;
  }

  /**
   * Detect linter and build lint command
   */
  private async detectLintCommand(): Promise<string | undefined> {
    const packageJsonPath = join(this.workspaceRoot, 'package.json');

    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

        // Check scripts
        if (pkg.scripts?.lint) {
          return 'npm run lint';
        }

        // Check for ESLint config
        const eslintConfigs = [
          '.eslintrc',
          '.eslintrc.js',
          '.eslintrc.json',
          '.eslintrc.yml',
          'eslint.config.js',
          'eslint.config.mjs',
          'eslint.config.cjs',
        ];
        for (const config of eslintConfigs) {
          if (existsSync(join(this.workspaceRoot, config))) {
            return 'npx eslint . --ext .ts,.js,.tsx,.jsx';
          }
        }

        // Check devDependencies
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.eslint) return 'npx eslint .';
        if (deps.tslint) return 'npx tslint -p tsconfig.json';
      } catch {
        // Ignore parse errors
      }
    }

    // Python projects
    if (
      existsSync(join(this.workspaceRoot, 'pyproject.toml')) ||
      existsSync(join(this.workspaceRoot, 'setup.py'))
    ) {
      if (existsSync(join(this.workspaceRoot, '.flake8'))) {
        return 'flake8';
      }
      return 'python -m pylint **/*.py';
    }

    // Go projects
    if (existsSync(join(this.workspaceRoot, 'go.mod'))) {
      return 'go vet ./...';
    }

    // Rust projects
    if (existsSync(join(this.workspaceRoot, 'Cargo.toml'))) {
      return 'cargo clippy';
    }

    return undefined;
  }

  /**
   * Detect formatter and build format command
   */
  private async detectFormatCommand(check: boolean = false): Promise<string | undefined> {
    const packageJsonPath = join(this.workspaceRoot, 'package.json');

    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

        // Check scripts
        const scriptName = check ? 'format:check' : 'format';
        if (pkg.scripts?.[scriptName]) {
          return `npm run ${scriptName}`;
        }

        // Check for Prettier config
        const prettierConfigs = [
          '.prettierrc',
          '.prettierrc.js',
          '.prettierrc.json',
          'prettier.config.js',
          'prettier.config.mjs',
          'prettier.config.cjs',
        ];
        for (const config of prettierConfigs) {
          if (existsSync(join(this.workspaceRoot, config))) {
            return check
              ? 'npx prettier --check "**/*.{ts,js,tsx,jsx,json,css,md}"'
              : 'npx prettier --write "**/*.{ts,js,tsx,jsx,json,css,md}"';
          }
        }

        // Check devDependencies
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.prettier) {
          return check ? 'npx prettier --check .' : 'npx prettier --write .';
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Python projects
    if (existsSync(join(this.workspaceRoot, 'pyproject.toml'))) {
      return check ? 'black --check .' : 'black .';
    }

    // Go projects
    if (existsSync(join(this.workspaceRoot, 'go.mod'))) {
      return 'go fmt ./...';
    }

    // Rust projects
    if (existsSync(join(this.workspaceRoot, 'Cargo.toml'))) {
      return check ? 'cargo fmt -- --check' : 'cargo fmt';
    }

    return undefined;
  }

  /**
   * Run tests with auto-detection or custom command
   */
  async runTests(options?: {
    command?: string;
    testFile?: string;
    timeout?: number;
  }): Promise<ExecutionResult> {
    let command = options?.command;

    if (!command) {
      command = await this.detectTestCommand();
      if (!command) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: 'Could not detect test framework. Please provide a test command.',
          duration: 0,
          command: '',
        };
      }
    }

    // Append test file if specified
    if (options?.testFile) {
      const filePath = isAbsolute(options.testFile)
        ? options.testFile
        : join(this.workspaceRoot, options.testFile);

      if (!existsSync(filePath)) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: `Test file not found: ${options.testFile}`,
          duration: 0,
          command,
        };
      }

      command = `${command} ${options.testFile}`;
    }

    return this.executeCommand(
      command,
      this.workspaceRoot,
      options?.timeout ?? this.defaultTimeout
    );
  }

  /**
   * Run linter with auto-detection or custom command
   */
  async runLinter(options?: {
    command?: string;
    files?: string[];
    fix?: boolean;
    timeout?: number;
  }): Promise<ExecutionResult> {
    let command = options?.command;

    if (!command) {
      command = await this.detectLintCommand();
      if (!command) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: 'Could not detect linter. Please provide a lint command.',
          duration: 0,
          command: '',
        };
      }
    }

    // Add fix flag if requested (ESLint style)
    if (options?.fix && command.includes('eslint')) {
      command = command.replace('eslint', 'eslint --fix');
    }

    // Append specific files if provided
    if (options?.files && options.files.length > 0) {
      command = `${command} ${options.files.join(' ')}`;
    }

    return this.executeCommand(
      command,
      this.workspaceRoot,
      options?.timeout ?? this.defaultTimeout
    );
  }

  /**
   * Run formatter with auto-detection or custom command
   */
  async runFormatter(options?: {
    command?: string;
    files?: string[];
    check?: boolean; // Just check, don't modify
    timeout?: number;
  }): Promise<ExecutionResult> {
    let command = options?.command;

    if (!command) {
      command = await this.detectFormatCommand(options?.check);
      if (!command) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: 'Could not detect formatter. Please provide a format command.',
          duration: 0,
          command: '',
        };
      }
    }

    // Append specific files if provided
    if (options?.files && options.files.length > 0) {
      // For prettier, replace glob pattern with specific files
      if (command.includes('prettier')) {
        command = command.replace(/"[^"]*"/, options.files.join(' '));
      } else {
        command = `${command} ${options.files.join(' ')}`;
      }
    }

    return this.executeCommand(
      command,
      this.workspaceRoot,
      options?.timeout ?? this.defaultTimeout
    );
  }

  /**
   * Execute a script file safely
   */
  async executeScript(options: {
    script: string;
    args?: string[];
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<ExecutionResult> {
    const scriptPath = isAbsolute(options.script)
      ? options.script
      : join(this.workspaceRoot, options.script);

    // Verify script exists
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: `Script not found: ${options.script}`,
        duration: 0,
        command: '',
      };
    }

    // Verify it's a file
    const stats = statSync(scriptPath);
    if (!stats.isFile()) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: `Not a file: ${options.script}`,
        duration: 0,
        command: '',
      };
    }

    // Determine how to execute based on extension
    const ext = extname(scriptPath).toLowerCase();
    let command: string;

    switch (ext) {
      case '.js':
      case '.mjs':
      case '.cjs':
        command = `node "${scriptPath}"`;
        break;
      case '.ts':
        command = `npx ts-node "${scriptPath}"`;
        break;
      case '.py':
        command = `python "${scriptPath}"`;
        break;
      case '.sh':
        command = `bash "${scriptPath}"`;
        break;
      case '.ps1':
        command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;
        break;
      case '.bat':
      case '.cmd':
        command = `"${scriptPath}"`;
        break;
      default:
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: `Unsupported script type: ${ext}. Supported: .js, .ts, .py, .sh, .ps1, .bat, .cmd`,
          duration: 0,
          command: '',
        };
    }

    // Add arguments
    if (options.args && options.args.length > 0) {
      command = `${command} ${options.args.map((a) => `"${a}"`).join(' ')}`;
    }

    const cwd = options.cwd
      ? isAbsolute(options.cwd)
        ? options.cwd
        : join(this.workspaceRoot, options.cwd)
      : this.workspaceRoot;

    return this.executeCommand(command, cwd, options.timeout ?? this.defaultTimeout, options.env);
  }
}

export default ExecutionTools;
