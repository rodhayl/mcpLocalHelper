import { CliToolAdapter } from './cli-tool.js';
import { CliToolConfig, CliToolResult, ProbeResult, ModelInfo } from '../types/index.js';

/**
 * CopilotAdapter - GitHub Copilot CLI Backend
 *
 * V25: Simplified to use shared implementations from CliToolAdapter base class.
 *      Removed duplicate methods: buildConstrainedPrompt, buildCommandArgs,
 *      extractFilesFromContent, extractToolsFromContent, buildValidationPrompt.
 */
export class CopilotAdapter extends CliToolAdapter {
  readonly id: string;
  readonly kind = 'local' as const;
  readonly displayName = 'GitHub Copilot CLI';

  protected static readonly DEFAULT_COMMAND = 'copilot';
  protected static readonly DEFAULT_MODEL = 'gpt-5-mini';

  constructor(id: string, config: Partial<CliToolConfig> = {}) {
    const fullConfig: CliToolConfig = {
      command: config.command || CopilotAdapter.DEFAULT_COMMAND,
      args_template: config.args_template || [
        '--model',
        '{model}',
        '-p',
        '{prompt}',
        '--allow-all',
        '--no-ask-user',
      ],
      working_dir: config.working_dir,
      timeout: config.timeout || 300000,
      auto_approve: config.auto_approve ?? true,
      environment: config.environment,
    };

    super(fullConfig);
    this.id = id;
  }

  /**
   * Get the default model for Copilot
   */
  protected getDefaultModel(): string {
    return CopilotAdapter.DEFAULT_MODEL;
  }

  /**
   * List available models from GitHub Copilot CLI
   */
  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', capabilities: ['chat', 'tools', 'code'] },
      { id: 'gpt-4.1', name: 'GPT-4.1', capabilities: ['chat', 'tools', 'code'] },
      { id: 'gpt-5', name: 'GPT-5', capabilities: ['chat', 'tools', 'code'] },
      { id: 'gpt-5.1', name: 'GPT-5.1', capabilities: ['chat', 'tools', 'code'] },
      { id: 'gpt-5.2', name: 'GPT-5.2', capabilities: ['chat', 'tools', 'code'] },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', capabilities: ['chat', 'tools', 'code'] },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', capabilities: ['chat', 'tools', 'code'] },
      {
        id: 'claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        capabilities: ['chat', 'tools', 'code'],
      },
      { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', capabilities: ['chat', 'tools', 'code'] },
      { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', capabilities: ['chat', 'tools', 'code'] },
      {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
        capabilities: ['chat', 'tools', 'code'],
      },
    ];
  }

  /**
   * Check for Copilot CLI without triggering interactive prompts.
   */
  async probe(): Promise<ProbeResult> {
    try {
      const { execSync } = await import('child_process');

      // Primary: Check for copilot binary via --version
      try {
        const versionOutput = execSync('copilot --version 2>&1', {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const versionMatch = versionOutput.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
        if (versionMatch) {
          return { available: true, version: versionMatch[1] };
        }
        if (versionOutput && versionOutput.trim().length > 0) {
          return { available: true, version: 'installed' };
        }
      } catch {
        // Binary check failed, fall through to npm check
      }

      // Fallback: Check npm package
      try {
        const result = execSync('npm list -g @github/copilot --depth=0 2>&1', {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (result && result.includes('@github/copilot')) {
          const versionMatch = result.match(/@github\/copilot@([0-9.]+)/);
          return { available: true, version: versionMatch?.[1] || 'installed' };
        }
      } catch {
        // npm check also failed
      }

      return {
        available: false,
        error: 'GitHub Copilot CLI not installed. Install via: npm i -g @github/copilot or VS Code',
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return { available: false, error: `GitHub Copilot CLI not found: ${errMsg}` };
    }
  }

  /**
   * Execute task via Copilot CLI
   */
  async executeTask(prompt: string): Promise<CliToolResult> {
    // V25: Use shared buildConstrainedPrompt and buildCommandArgs from base class
    const constrainedPrompt = this.buildConstrainedPrompt(prompt, 'text');
    const { command, args } = this.buildCommandArgs(constrainedPrompt);

    console.log(`\n🚀 [COPILOT-CLI] ==========================================`);
    console.log(`🚀 [COPILOT-CLI] Executing task via Copilot CLI`);
    console.log(`🚀 [COPILOT-CLI] Working dir: ${this.config.working_dir || process.cwd()}`);
    console.log(`🚀 [COPILOT-CLI] Command: ${command} [${args.length} args]`);
    console.log(`🚀 [COPILOT-CLI] ==========================================\n`);

    try {
      const { stdout, stderr, exitCode } = await this.execCommand(command, args);
      const rawOutput = stdout.trim() || stderr.trim();
      console.log(
        `[COPILOT-ADAPTER] 📤 Output source: ${stdout.trim() ? 'stdout' : stderr.trim() ? 'stderr' : 'empty'} | exitCode=${exitCode}`
      );
      const result = this.parseOutput(rawOutput);
      if (exitCode !== 0 && result.content) {
        result.error = result.error || `Exit code ${exitCode}`;
      }
      return result;
    } catch (error) {
      return {
        success: false,
        content: '',
        files_modified: [],
        tools_used: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Parse output from Copilot CLI (text format)
   */
  parseOutput(rawOutput: string): CliToolResult {
    const content = rawOutput.trim();
    // V25: Use shared extractFilesFromContent and extractToolsFromContent from base class
    const filesModified = this.extractFilesFromContent(content);
    const toolsUsed = this.extractToolsFromContent(content);
    const success = content.length > 0 && !content.toLowerCase().includes('error');

    return {
      success,
      content,
      files_modified: filesModified,
      tools_used: toolsUsed,
    };
  }

  // V25: REMOVED - Now using base class implementations:
  // - buildConstrainedPrompt()
  // - buildCommandArgs()
  // - buildCommand() - deprecated, use buildCommandArgs instead
  // - extractFilesFromContent()
  // - extractToolsFromContent()
  // - buildValidationPrompt()
}
