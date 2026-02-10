import { describe, it, expect } from 'vitest';
import { LlmChatTool } from '../src/tools/llm.js';
import { BackendManager } from '../src/adapters/factory.js';
import { ConfigManager } from '../src/config/index.js';
import type { ChatRequest, LlmBackend } from '../src/types/index.js';

// --- Stub configs and backends for testing ---

const testConfig = {
  backends: [],
  defaults: { localBackendId: 'none' },
  policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
  systemProfile: { exposeToLLM: false },
  features: { testingModeEnabled: false },
};

class StubConfigManager extends ConfigManager {
  constructor() {
    super();
  }
  getConfig() {
    return testConfig as any;
  }
  isSotaAvailable() {
    return false;
  }
}

class StubBackend implements LlmBackend {
  id: string;
  kind: 'local' | 'sota';
  displayName: string;

  constructor(id: string, kind: 'local' | 'sota') {
    this.id = id;
    this.kind = kind;
    this.displayName = id;
  }

  async probe() {
    return { available: true };
  }

  async listModels() {
    return [{ id: 'm1', name: 'm1' }];
  }

  async invokeChat(req: ChatRequest) {
    return {
      message: {
        role: 'assistant',
        content: `backend=${this.id};model=${req.model || 'none'}`,
      },
      usage: undefined,
    };
  }
}

class SimpleStubBackend {
  constructor(public id: string) {}
  kind = 'local';
  displayName = 'Stub Local';
  async probe() {
    return { available: true };
  }
  async listModels() {
    return [{ id: 'stub-model', name: 'stub-model' }];
  }
  async invokeChat(req: any) {
    if (req.model === 'invalid-model') {
      throw new Error('Model not found');
    }
    return {
      message: { role: 'assistant', content: 'ok' },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
}

class SimpleStubBackendManager {
  private backend = new SimpleStubBackend('stub-local');
  getBackend(id: string) {
    return id === 'stub-local' ? this.backend : undefined;
  }
  getLocalBackends() {
    return [this.backend];
  }
  getSotaBackends() {
    return [];
  }
}

class SimpleStubConfigManager {
  getConfig() {
    return {
      backends: [],
      defaults: { localBackendId: 'stub-local' },
      policy: { allowlistPaths: ['.'], maxFileBytes: 131072 },
      systemProfile: { exposeToLLM: false },
      features: { openRouterTestMode: false },
    } as any;
  }
  getTimeouts() {
    return {
      llmChat: 60000,
      llmChatSota: 180000,
      llmInflight: 300000,
      agentStep: 300000,
      taskQueue: 1800000,
      taskStale: 86400000,
    };
  }
}

// --- Tests ---

describe('LlmChatTool SOTA gating', () => {
  it('should block SOTA when testing mode is not enabled', async () => {
    const backendManager = new BackendManager([]);
    const config = new StubConfigManager();
    const llm = new LlmChatTool(backendManager, config);

    const request = { messages: [{ role: 'user', content: 'hello' }] } as any;

    await expect(llm.chat(request, 'sota')).rejects.toThrow(/SOTA backend is not available/);
  });
});

describe('LlmChatTool uses configured backend/model', () => {
  it('uses defaults.localBackendId and defaults.localModel', async () => {
    const backends = new Map<string, LlmBackend>([
      ['a', new StubBackend('a', 'local')],
      ['b', new StubBackend('b', 'local')],
    ]);

    const backendManager = {
      getBackend: (id: string) => backends.get(id),
      getLocalBackends: () => Array.from(backends.values()).filter((b) => b.kind === 'local'),
      getSotaBackends: () => Array.from(backends.values()).filter((b) => b.kind === 'sota'),
    } as any;

    const config = {
      getConfig: () => ({
        defaults: { localBackendId: 'b', localModel: 'chosen', sotaBackendId: undefined, sotaModel: undefined },
      }),
      isSotaAvailable: () => false,
      getTimeouts: () => ({
        llmChat: 60000,
        llmChatSota: 180000,
        llmInflight: 300000,
        agentStep: 300000,
        taskQueue: 1800000,
        taskStale: 86400000,
      }),
    } as any;

    const tool = new LlmChatTool(backendManager, config);
    const resp = await tool.chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      'local'
    );
    expect(resp.message.content).toContain('backend=b');
    expect(resp.message.content).toContain('model=chosen');
  });

  it('uses defaults.sotaBackendId and defaults.sotaModel when enabled', async () => {
    const backends = new Map<string, LlmBackend>([
      ['s', new StubBackend('s', 'sota')],
    ]);

    const backendManager = {
      getBackend: (id: string) => backends.get(id),
      getLocalBackends: () => [],
      getSotaBackends: () => Array.from(backends.values()),
    } as any;

    const config = {
      getConfig: () => ({
        defaults: { localBackendId: 'unused', localModel: undefined, sotaBackendId: 's', sotaModel: 'sota-model' },
      }),
      isSotaAvailable: () => true,
      getTimeouts: () => ({
        llmChat: 60000,
        llmChatSota: 180000,
        llmInflight: 300000,
        agentStep: 300000,
        taskQueue: 1800000,
        taskStale: 86400000,
      }),
    } as any;

    const tool = new LlmChatTool(backendManager, config);
    const resp = await tool.chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      'sota'
    );
    expect(resp.message.content).toContain('backend=s');
    expect(resp.message.content).toContain('model=sota-model');
  });
});

describe('llm_chat via stub backend', () => {
  it('should succeed with stub local backend', async () => {
    const llm = new LlmChatTool(new SimpleStubBackendManager() as any, new SimpleStubConfigManager() as any);
    const res = await llm.chat(
      { messages: [{ role: 'user', content: 'ping' }], model: 'stub-model' } as any,
      'local'
    );
    expect(res.message.content).toBe('ok');
  });

  it('should error for invalid model', async () => {
    const llm = new LlmChatTool(new SimpleStubBackendManager() as any, new SimpleStubConfigManager() as any);
    await expect(
      llm.chat(
        { messages: [{ role: 'user', content: 'ping' }], model: 'invalid-model' } as any,
        'local'
      )
    ).rejects.toThrow(/Model not found|Chat failed/);
  });
});
