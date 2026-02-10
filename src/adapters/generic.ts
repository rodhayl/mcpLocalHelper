import { BaseBackend } from './base.js';
import {
  ProbeResult,
  ModelInfo,
  ChatRequest,
  ChatResponse,
  OpenAIModelsResponse,
  OpenAIChatCompletionResponse,
  OpenAIModelData,
} from '../types/index.js';
import { applyReasoningFallback, envTimeoutOrDefault } from './shared.js';

export class GenericOpenAIAdapter extends BaseBackend {
  id: string;
  kind: 'local' | 'sota' = 'local';
  displayName: string;

  protected baseUrl: string;
  protected apiKey?: string;

  constructor(
    id: string,
    baseUrl: string,
    apiKey?: string,
    displayName: string = 'Generic OpenAI'
  ) {
    super();
    this.id = id;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.displayName = displayName;
  }

  protected getListTimeoutMs(): number {
    return envTimeoutOrDefault('LLM_LIST_MODELS_TIMEOUT_MS', 8000);
  }

  protected getChatTimeoutMs(): number {
    return envTimeoutOrDefault('LLM_CHAT_TIMEOUT_MS', 300000);
  }

  async probe(): Promise<ProbeResult> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      await this.makeRequest(
        `${this.baseUrl}/v1/models`,
        { method: 'GET', headers },
        this.getListTimeoutMs()
      );

      return {
        available: true,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await this.makeRequest(
        `${this.baseUrl}/v1/models`,
        { method: 'GET', headers },
        this.getListTimeoutMs()
      );

      const data = (await response.json()) as OpenAIModelsResponse;

      if (!data.data || !Array.isArray(data.data)) {
        return [];
      }

      return data.data.map((model: OpenAIModelData) => ({
        id: model.id,
        name: model.id,
        context_length: undefined, // Not consistently available
        capabilities: ['chat', 'completion'],
      }));
    } catch (error) {
      console.error(`Failed to list models for ${this.displayName}:`, error);
      return [];
    }
  }

  async invokeChat(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    const model = req.model || (await this.listModels())[0]?.id || 'gpt-3.5-turbo';

    const openaiRequest = {
      model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this.makeRequest(
      `${this.baseUrl}/v1/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(openaiRequest) },
      options?.timeoutMs ?? this.getChatTimeoutMs(),
      undefined,
      { signal: options?.signal }
    );

    const data = (await response.json()) as OpenAIChatCompletionResponse;

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error(`Invalid response from ${this.displayName}`);
    }

    // Fall back to `reasoning` field if `content` is empty
    applyReasoningFallback(data.choices[0].message as any);

    return {
      message: data.choices[0].message,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
            total_tokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}
