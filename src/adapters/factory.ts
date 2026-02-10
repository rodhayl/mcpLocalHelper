import { LlmBackend, BackendConfig, BackendType, ProbeResult } from '../types/index.js';
import { OllamaAdapter } from './ollama.js';
import { LmStudioAdapter } from './lmstudio.js';
import { GenericOpenAIAdapter } from './generic.js';
import { OpenRouterAdapter } from './openrouter.js';
import { StubAdapter } from './stub.js';
import { OpenCodeAdapter } from './opencode.js';
import { CopilotAdapter } from './copilot.js';

export class BackendFactory {
  static create(config: BackendConfig): LlmBackend {
    switch (config.type) {
      case 'ollama':
        return new OllamaAdapter(config.id, config.base_url);

      case 'lmstudio':
        return new LmStudioAdapter(config.id, config.base_url);

      case 'generic':
        return new GenericOpenAIAdapter(
          config.id,
          config.base_url || 'http://localhost:3000',
          config.api_key
        );

      case 'openrouter':
        if (!config.api_key) {
          // OpenRouter requires API key - but we allow creating the backend without it
          // It will fail at runtime if used without a key
          console.warn('OpenRouter backend created without API key - will fail if used');
          return new OpenRouterAdapter(config.id, '', config.base_url);
        }
        return new OpenRouterAdapter(config.id, config.api_key, config.base_url);

      case 'stub':
        return new StubAdapter(config.id);

      case 'opencode':
        return new OpenCodeAdapter(config.id, {
          command: config.command || 'opencode',
          args_template: config.args_template || ['-p', '{prompt}', '-f', 'json', '-q'],
          working_dir: config.working_dir,
          timeout: config.timeout || 300000,
          auto_approve: config.auto_approve ?? true,
          environment: config.environment as Record<string, string>,
        });

      case 'copilot':
        return new CopilotAdapter(config.id, {
          command: config.command || 'copilot',
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
          environment: config.environment as Record<string, string>,
        });

      default:
        throw new Error(`Unknown backend type: ${config.type}`);
    }
  }
}

export class BackendManager {
  private backends: Map<string, LlmBackend> = new Map();
  private backendTypes: Map<string, BackendType> = new Map();

  constructor(backendConfigs: BackendConfig[]) {
    for (const config of backendConfigs) {
      try {
        const backend = BackendFactory.create(config);
        this.backends.set(config.id, backend);
        this.backendTypes.set(config.id, config.type);
      } catch (error) {
        console.warn(`Failed to create backend ${config.id}:`, error);
      }
    }
  }

  getBackend(id: string): LlmBackend | undefined {
    return this.backends.get(id);
  }

  getBackendType(id: string): BackendType | undefined {
    return this.backendTypes.get(id);
  }

  getAllBackends(): LlmBackend[] {
    return Array.from(this.backends.values());
  }

  getAllBackendsWithType(): Array<{ backend: LlmBackend; type: BackendType }> {
    return Array.from(this.backends.entries()).map(([id, backend]) => ({
      backend,
      type: this.backendTypes.get(id)!,
    }));
  }

  getLocalBackends(): LlmBackend[] {
    return this.getAllBackends().filter((b) => b.kind === 'local');
  }

  getSotaBackends(): LlmBackend[] {
    return this.getAllBackends().filter((b) => b.kind === 'sota');
  }

  async probeAll(): Promise<Map<string, ProbeResult>> {
    const results = new Map<string, ProbeResult>();

    for (const [id, backend] of this.backends) {
      try {
        const result = await backend.probe();
        results.set(id, result);
      } catch (error) {
        results.set(id, {
          available: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }
}
