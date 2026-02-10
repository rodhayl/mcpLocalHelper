import type {
  ChatRequest,
  ChatResponse,
  LlmBackend,
  ModelInfo,
  ProbeResult,
} from '../types/index.js';

function pickText(req: ChatRequest): string {
  const msgs = req.messages || [];
  return msgs.map((m) => m.content || '').join('\n');
}

export class StubAdapter implements LlmBackend {
  kind = 'local' as const;
  displayName = 'Stub Local (Deterministic)';

  constructor(public id: string) {}

  async probe(): Promise<ProbeResult> {
    return { available: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'stub-model', name: 'stub-model' }];
  }

  async invokeChat(
    req: ChatRequest,
    _options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<ChatResponse> {
    const text = pickText(req);

    // Deterministic JSON responses for AgentRunner prompts
    if (text.includes('"subtasks"') || text.includes('Break the user task into')) {
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            subtasks: [
              { id: 't1', title: 'Scan', task: 'Search for relevant strings and locations.' },
              { id: 't2', title: 'Report', task: 'Summarize findings as a concise report.' },
            ],
          }),
        },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }

    if (text.includes('"steps"') || text.includes('Create a short ordered plan')) {
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            steps: [
              {
                id: 's1',
                title: 'Search',
                description: 'Search repo for target patterns.',
                targets: ['.'],
              },
              { id: 's2', title: 'Summarize', description: 'Summarize results.', targets: ['.'] },
            ],
          }),
        },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }

    // Default small JSON response
    return {
      message: { role: 'assistant', content: JSON.stringify({ ok: true }) },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}
