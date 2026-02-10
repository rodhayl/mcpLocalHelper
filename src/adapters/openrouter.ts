import { GenericOpenAIAdapter } from './generic.js';
import {
  ChatRequest,
  ChatResponse,
  ModelInfo,
  OpenAIChatCompletionResponse,
  OpenAIModelsResponse,
  OpenAIModelData,
} from '../types/index.js';
import { RedactionEngine } from '../utils/redaction.js';
import { applyReasoningFallback } from './shared.js';

export class OpenRouterAdapter extends GenericOpenAIAdapter {
  kind = 'sota' as const;
  displayName = 'OpenRouter (SOTA)';

  private redaction: RedactionEngine;

  constructor(id: string, apiKey: string, baseUrl: string = 'https://openrouter.ai/api') {
    super(id, baseUrl, apiKey, 'OpenRouter');
    this.redaction = new RedactionEngine();
  }

  async invokeChat(
    req: ChatRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    // Apply additional SOTA filters before sending
    const filteredMessages = req.messages.map((msg) => ({
      ...msg,
      content: this.redaction.applySotaFilters(msg.content),
    }));

    const model = req.model || 'openrouter/auto';
    const openrouterRequest = {
      model,
      messages: filteredMessages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'MCP Local LLM Server',
    };

    const totalContent = filteredMessages.map((m) => m.content).join(' ');
    if (totalContent.length > 100000) {
      throw new Error(
        'Content too large for SOTA backend. Consider using local backend for large contexts.'
      );
    }

    const response = await this.makeRequest(
      `${this.baseUrl}/v1/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(openrouterRequest) },
      options?.timeoutMs ?? this.getChatTimeoutMs(),
      undefined,
      { signal: options?.signal }
    );

    const data = (await response.json()) as OpenAIChatCompletionResponse;
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid response from OpenRouter');
    }

    // Prefer `content` but fall back to `reasoning` (shared adapter utility).
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

  async listModels(): Promise<ModelInfo[]> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'http://localhost:3000', // Required by OpenRouter
        'X-Title': 'MCP Local LLM Server',
      };

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
        context_length: model.context_length,
        capabilities: ['chat', 'completion'],
      }));
    } catch (error) {
      console.error('Failed to list OpenRouter models:', error);
      return [];
    }
  }
}
