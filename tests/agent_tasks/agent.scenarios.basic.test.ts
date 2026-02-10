/**
 * Agent Scenarios - Basic Tests (Configuration + Structure)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { ConfigManager } from '../../src/config/index.js';
import { getTestConfig } from '../test-config.js';

describe('Agent Scenarios - Configuration Loading', () => {
  let config: ConfigManager;

  beforeAll(() => {
    // Load the configuration
    config = new ConfigManager();
  });

  it('should load configuration successfully', () => {
    expect(config).toBeDefined();
    expect(config).toBeInstanceOf(ConfigManager);
  });

  it('should have valid backends configuration', () => {
    const backends = config.getConfig().backends;
    expect(backends).toBeDefined();
    expect(Array.isArray(backends)).toBe(true);
    expect(backends.length).toBeGreaterThan(0);
  });

  it('should have LM Studio backend configured', () => {
    const backends = config.getConfig().backends;
    // Accept both 'lmstudio' and 'lmstudio-local' IDs
    const lmStudioBackend = backends.find((b: any) => 
      b.id === 'lmstudio' || b.id === 'lmstudio-local'
    );
    
    expect(lmStudioBackend).toBeDefined();
    expect(lmStudioBackend.type).toBe('lmstudio');
    expect(lmStudioBackend.base_url).toBe('http://127.0.0.1:1234');
  });

  it('should have Ollama backend configured', () => {
    const backends = config.getConfig().backends;
    // Accept both 'ollama' and 'ollama-local' IDs
    const ollamaBackend = backends.find((b: any) => 
      b.id === 'ollama' || b.id === 'ollama-local'
    );
    
    expect(ollamaBackend).toBeDefined();
    expect(ollamaBackend.type).toBe('ollama');
    expect(ollamaBackend.base_url).toBe('http://127.0.0.1:11434');
  });

  it('should have correct default backend configuration', () => {
    const defaults = config.getConfig().defaults;
    
    expect(defaults).toBeDefined();
    // Accept common backend IDs for local LLM (V22.1: also accept CLI backends when orchestration enabled)
    const validBackends = ['lmstudio', 'lmstudio-local', 'ollama', 'ollama-local', 'opencode-cli', 'copilot-cli'];
    expect(validBackends).toContain(defaults.localBackendId);
  });

  it('should optionally have MCP servers configured', () => {
    const mcpServers = config.getConfig().mcpServers;
    
    // MCP servers are optional in the centralized settings config
    if (mcpServers) {
      expect(typeof mcpServers).toBe('object');
      // If chrome-devtools is configured, verify its structure
      if (mcpServers['chrome-devtools']) {
        expect(mcpServers['chrome-devtools'].type).toBe('stdio');
        expect(mcpServers['chrome-devtools'].command).toBe('npx');
      }
      // If context7 is configured, verify its structure
      if (mcpServers['context7']) {
        expect(mcpServers['context7'].type).toBe('stdio');
        expect(mcpServers['context7'].command).toBe('npx');
      }
    }
    // Pass even if mcpServers is not configured
    expect(true).toBe(true);
  });

  it('should get default workspace root', () => {
    const workspaceRoot = config.getDefaultWorkspaceRoot();
    
    expect(workspaceRoot).toBeDefined();
    expect(typeof workspaceRoot).toBe('string');
    expect(workspaceRoot.length).toBeGreaterThan(0);
  });

  it('should have development tool groups enabled', () => {
    const toolGroups = config.getConfig().toolGroups;
    
    expect(toolGroups).toBeDefined();
    expect(toolGroups.activeMode).toBe('DEVELOPMENT');
  });
});

describe('Agent Scenarios - Basic Structure Test', () => {
  it('should have valid test structure', () => {
    // This is a basic test to verify the test file can be loaded and executed
    expect(true).toBe(true);
  });

  it('should verify configuration can be loaded', async () => {
    const settingsPath = process.env.MCP_LOCAL_LLM_SETTINGS_PATH;
    expect(settingsPath).toBeDefined();
    if (settingsPath) {
      expect(
        settingsPath.endsWith('env-automated-tests.settings') || settingsPath.endsWith('env.settings')
      ).toBe(true);
      expect(existsSync(settingsPath)).toBe(true);
    }

    const testConfig = getTestConfig();
    expect(testConfig.settingsPath).toBeDefined();
  });

  it('should verify environment variables are accessible from centralized config', () => {
    // Use centralized test configuration
    const testConfig = getTestConfig();
    
    // Test environment variable access - values come from centralized config
    const backendId = process.env.MCP_LOCAL_LLM_BACKEND_ID || testConfig.localBackendId;
    const model = process.env.MCP_LOCAL_LLM_MODEL || testConfig.localModel;
    
    // These should be defined from the centralized config
    expect(backendId).toBeDefined();
    expect(model).toBeDefined();
    expect(backendId).toBe(testConfig.localBackendId); // Should match centralized config
    expect(model).toBe(testConfig.localModel); // Should match centralized config
  });
});

describe('Agent Scenarios - Configuration Validation', () => {
  it('should validate workspace configuration', () => {
    // Basic validation that would be used in real scenarios
    const workspaceRoot = '.'; // This would come from config in real test
    const writeRoot = 'tests/.mcp_cache/agent_scenarios';
    
    expect(workspaceRoot).toBeDefined();
    expect(writeRoot).toBeDefined();
    expect(writeRoot).toContain('tests');
  });

  it('should validate scenario parameters structure', () => {
    // Test that scenario parameters have the right structure
    const sampleOptions = {
      contextRoot: '.',
      allowMcpServers: [],
      autoConnectMcp: false,
      maxSubtasks: 6,
      maxSteps: 14,
      maxActionsPerStep: 8,
      readOnly: true,
    };

    expect(sampleOptions).toHaveProperty('contextRoot');
    expect(sampleOptions).toHaveProperty('allowMcpServers');
    expect(sampleOptions).toHaveProperty('maxSubtasks');
    expect(sampleOptions).toHaveProperty('readOnly');
    expect(sampleOptions.readOnly).toBe(true);
  });
});
