import { describe, it, expect } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';

describe('LlmEnhancedTools.intelligentSearch invalid root', () => {
  it('should include path suggestions when root is invalid', async () => {
    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    const tools = new LlmEnhancedTools(config, backendManager);

    await expect(tools.intelligentSearch('__does_not_exist__', 'x')).rejects.toThrow(
      /Did you mean/
    );
    await expect(tools.intelligentSearch('__does_not_exist__', 'x')).rejects.not.toThrow(
      /Resolved to:/
    );
  });
});
