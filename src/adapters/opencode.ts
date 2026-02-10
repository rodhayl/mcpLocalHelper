import { CliToolAdapter } from './cli-tool.js';
import { CliToolConfig, CliToolResult, ModelInfo } from '../types/index.js';

/**
 * OpenCodeAdapter - OpenCode CLI Backend
 *
 * V25: Simplified to use shared implementations from CliToolAdapter base class.
 *      Removed duplicate methods: buildConstrainedPrompt, buildCommandArgs,
 *      extractFilesFromContent, extractToolsFromContent, buildValidationPrompt.
 */
export class OpenCodeAdapter extends CliToolAdapter {
  readonly id: string;
  readonly kind = 'local' as const;
  readonly displayName = 'OpenCode CLI';

  protected static readonly DEFAULT_COMMAND = 'opencode';
  protected static readonly DEFAULT_MODEL = 'opencode/big-pickle';

  constructor(id: string, config: Partial<CliToolConfig> = {}) {
    const fullConfig: CliToolConfig = {
      command: config.command || OpenCodeAdapter.DEFAULT_COMMAND,
      args_template: config.args_template || [
        'run',
        '--format',
        'json',
        '--model',
        '{model}',
        '{prompt}',
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
   * Get the default model for OpenCode
   */
  protected getDefaultModel(): string {
    return OpenCodeAdapter.DEFAULT_MODEL;
  }

  /**
   * List available models from OpenCode CLI
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(`${this.config.command} models`, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      });

      const lines = output.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
      const models: ModelInfo[] = lines.map((line) => {
        const modelId = line.trim();
        const isFree = modelId.includes('free') || modelId.includes('Free');
        return {
          id: modelId,
          name: modelId,
          capabilities: ['chat', 'tools', 'code'],
          description: isFree ? 'Free model - no API costs' : undefined,
        };
      });

      return models.length > 0 ? models : this.getDefaultModels();
    } catch (error) {
      console.warn(
        '[OpenCodeAdapter] Failed to list models:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return this.getDefaultModels();
    }
  }

  private getDefaultModels(): ModelInfo[] {
    return [
      { id: 'opencode/big-pickle', name: 'Big Pickle', capabilities: ['chat', 'tools', 'code'] },
      {
        id: 'opencode/glm-4.7-free',
        name: 'GLM 4.7 Free (FREE)',
        capabilities: ['chat', 'tools', 'code'],
      },
      {
        id: 'opencode/claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        capabilities: ['chat', 'tools', 'code'],
      },
      { id: 'opencode/gpt-5', name: 'GPT-5', capabilities: ['chat', 'tools', 'code'] },
    ];
  }

  /**
   * Execute task via OpenCode CLI
   */
  async executeTask(prompt: string): Promise<CliToolResult> {
    // V25: Use shared buildConstrainedPrompt and buildCommandArgs from base class
    const constrainedPrompt = this.buildConstrainedPrompt(prompt, 'json');
    const { command, args } = this.buildCommandArgs(constrainedPrompt);

    console.log(`\n🚀 [OPENCODE-CLI] ==========================================`);
    console.log(`🚀 [OPENCODE-CLI] Executing task via OpenCode CLI (FREE MODEL)`);
    console.log(`🚀 [OPENCODE-CLI] Working dir: ${this.config.working_dir || process.cwd()}`);
    console.log(`🚀 [OPENCODE-CLI] Command: ${command} [${args.length} args]`);
    console.log(`🚀 [OPENCODE-CLI] ==========================================\n`);

    try {
      const { stdout, stderr, exitCode } = await this.execCommand(command, args);
      const rawOutput = stdout.trim() || stderr.trim();
      console.log(
        `✅ [OPENCODE-CLI] Execution complete | source=${stdout.trim() ? 'stdout' : stderr.trim() ? 'stderr' : 'empty'} | output length: ${rawOutput.length} | exitCode=${exitCode}`
      );
      const result = this.parseOutput(rawOutput);
      if (exitCode !== 0 && result.content) {
        result.error = result.error || `Exit code ${exitCode}`;
      }
      return result;
    } catch (error) {
      console.log(
        `❌ [OPENCODE-CLI] Execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
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
   * Parse output from OpenCode CLI (JSON format)
   */
  parseOutput(rawOutput: string): CliToolResult {
    try {
      const trimmed = rawOutput.trim();

      if (!trimmed) {
        return {
          success: false,
          content: '',
          files_modified: [],
          tools_used: [],
          error: 'Empty output from OpenCode',
        };
      }

      const parsed = JSON.parse(trimmed);

      return {
        success: parsed.success ?? true,
        content: parsed.content || '',
        // V25: Use shared extractFilesFromContent from base class as fallback
        files_modified: parsed.files_modified || this.extractFilesFromContent(parsed.content || ''),
        tools_used: parsed.tools_used || [],
        error: parsed.error,
      };
    } catch (e) {
      const content = rawOutput.trim();
      // V25: Use shared extractFilesFromContent and extractToolsFromContent from base class
      return {
        success: content.length > 0 && !content.toLowerCase().includes('error'),
        content,
        files_modified: this.extractFilesFromContent(content),
        tools_used: this.extractToolsFromContent(content),
        error: e instanceof Error ? `Parse error: ${e.message}` : 'Parse error',
      };
    }
  }

  // V25: REMOVED - Now using base class implementations:
  // - buildConstrainedPrompt()
  // - buildCommandArgs()
  // - buildCommand() - deprecated, use buildCommandArgs instead
  // - extractFilesFromContent()
  // - extractToolsFromContent()
  // - buildValidationPrompt()
}
