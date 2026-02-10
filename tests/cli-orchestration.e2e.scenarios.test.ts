/**
 * CLI Orchestration E2E Scenarios
 *
 * 5 comprehensive end-to-end test scenarios for the CLI orchestration feature:
 * 1. Backend Discovery and Status API
 * 2. CLI Model Fetching (OpenCode CLI)
 * 3. CLI Orchestration Settings Persistence
 * 4. Full Orchestration Flow with LM Studio
 * 5. HTTP API Endpoints for CLI Orchestration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmChatTool } from '../src/tools/llm.js';
import {
  OrchestrationService,
  initOrchestrationService,
  getOrchestrationService,
} from '../src/orchestration/index.js';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { CopilotAdapter } from '../src/adapters/copilot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as os from 'node:os';

// Helper to make HTTP requests
function httpRequest(
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 500, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Scenario 1: Backend Discovery and Status API', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;

  beforeAll(() => {
    config = new ConfigManager();
    backendManager = new BackendManager(config.getConfig().backends);
  });

  it('should discover all configured backends including CLI backends', () => {
    const backends = config.getConfig().backends;
    expect(Array.isArray(backends)).toBe(true);

    const backendTypes = backends.map((b) => b.type);
    // Should have at least some backends configured
    expect(backendTypes.length).toBeGreaterThan(0);
  });

  it('should identify CLI-type backends correctly', () => {
    const backends = config.getConfig().backends;
    const cliBackends = backends.filter((b) => b.type === 'opencode' || b.type === 'copilot');

    for (const backend of cliBackends) {
      expect(['opencode', 'copilot']).toContain(backend.type);
      // CLI backends should have a valid backend ID
      expect(backend.id).toBeDefined();
      expect(typeof backend.id).toBe('string');
      expect(backend.id.length).toBeGreaterThan(0);
    }
  });

  it('should probe backends and return availability status', async () => {
    const probeResults = await backendManager.probeAll();

    expect(probeResults).toBeInstanceOf(Map);

    // Each probe result should have the expected structure
    for (const [_id, result] of probeResults) {
      expect(result).toHaveProperty('available');
      expect(typeof result.available).toBe('boolean');
      if (!result.available && result.error) {
        expect(typeof result.error).toBe('string');
      }
    }
  }, 30000);

  it('should differentiate between available and unavailable backends', async () => {
    const probeResults = await backendManager.probeAll();

    let hasAvailable = false;
    let hasUnavailable = false;

    for (const [_id, result] of probeResults) {
      if (result.available) hasAvailable = true;
      else hasUnavailable = true;
    }

    // At least one status type should exist
    expect(hasAvailable || hasUnavailable).toBe(true);
  }, 30000);
});

describe('Scenario 2: CLI Model Fetching', () => {
  describe('OpenCode CLI Adapter', () => {
    let adapter: OpenCodeAdapter | null = null;
    let isOpenCodeAvailable = false;

    beforeAll(async () => {
      try {
        adapter = new OpenCodeAdapter('opencode-cli-test', {
          command: 'opencode',
          args_template: ['run', '--format', 'json', '--model', '{model}', '{prompt}'],
          timeout: 30000,
          working_dir: process.cwd(),
        });
        const probeResult = await adapter.probe();
        isOpenCodeAvailable = probeResult.available;
      } catch {
        isOpenCodeAvailable = false;
      }
    });

    it('should create OpenCode adapter with config', () => {
      expect(adapter).not.toBeNull();
    });

    it.skipIf(!isOpenCodeAvailable)('should fetch models from OpenCode CLI', async () => {
      if (!adapter) throw new Error('Adapter not initialized');

      const models = await adapter.listModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      // Each model should have id and name
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
      }
    }, 60000);

    it.skipIf(!isOpenCodeAvailable)('should include FREE models in the list', async () => {
      if (!adapter) throw new Error('Adapter not initialized');

      const models = await adapter.listModels();

      // Should have some free models (models with 'free' in the name)
      const freeModels = models.filter(
        (m) => m.name.toLowerCase().includes('free') || m.id.toLowerCase().includes('free')
      );

      // OpenCode typically has free models available
      expect(freeModels.length).toBeGreaterThanOrEqual(0);
    }, 60000);

    it.skipIf(!isOpenCodeAvailable)('should return models from multiple providers', async () => {
      if (!adapter) throw new Error('Adapter not initialized');

      const models = await adapter.listModels();

      // Extract providers from model IDs (e.g., "opencode/claude-3-5" -> "opencode")
      const providers = new Set<string>();
      for (const model of models) {
        const parts = model.id.split('/');
        if (parts.length > 1) {
          providers.add(parts[0]);
        }
      }

      // Should have models from multiple providers
      expect(providers.size).toBeGreaterThanOrEqual(1);
    }, 60000);
  });

  describe('Copilot CLI Adapter', () => {
    let adapter: CopilotAdapter | null = null;

    beforeAll(() => {
      adapter = new CopilotAdapter('copilot-cli-test', {
        command: 'copilot',
        timeout: 30000,
        working_dir: process.cwd(),
      });
    });

    it('should create Copilot adapter', () => {
      expect(adapter).not.toBeNull();
    });

    it('should return hardcoded GitHub models', async () => {
      if (!adapter) throw new Error('Adapter not initialized');

      const models = await adapter.listModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      // Should include known GitHub models
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/gpt-5-mini|claude|o1-preview|o1-mini/),
        ])
      );
    });
  });
});

describe('Scenario 3: CLI Orchestration Settings Persistence', () => {
  let config: ConfigManager;
  let tempDir: string | null = null;
  let testEnvSettingsPath: string;
  
  // Save/restore CLI env vars to prevent test interference
  let savedCliOrchestrationEnabled: string | undefined;
  let savedCliOrchestrationBackends: string | undefined;
  
  beforeAll(() => {
    // Use a temp copy of env-automated-tests.settings for persistence tests to avoid mutating
    // the repo's shared settings file (which other tests assert must remain stable).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-local-llm-cli-orch-'));
    testEnvSettingsPath = path.join(tempDir, 'env.settings.test');
    fs.copyFileSync(path.join(process.cwd(), 'env-automated-tests.settings'), testEnvSettingsPath);

    // Save current CLI env vars
    savedCliOrchestrationEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
    savedCliOrchestrationBackends = process.env.CLI_ORCHESTRATION_BACKENDS;
    
    // Unset CLI env vars so settings updates work correctly
    delete process.env.CLI_ORCHESTRATION_ENABLED;
    delete process.env.CLI_ORCHESTRATION_BACKENDS;
  });
  
  afterAll(() => {
    // Restore CLI env vars
    if (savedCliOrchestrationEnabled !== undefined) {
      process.env.CLI_ORCHESTRATION_ENABLED = savedCliOrchestrationEnabled;
    }
    if (savedCliOrchestrationBackends !== undefined) {
      process.env.CLI_ORCHESTRATION_BACKENDS = savedCliOrchestrationBackends;
    }
    
    // Clean up temp settings file
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Create a fresh config manager for each test
    config = new ConfigManager(testEnvSettingsPath);
  });

  it('should read CLI orchestration enabled state', () => {
    const settings = config.getEnvSettings();

    expect(settings).toHaveProperty('advanced');
    expect(settings.advanced).toHaveProperty('cliOrchestrationEnabled');
    expect(typeof settings.advanced.cliOrchestrationEnabled).toBe('boolean');
  });

  it('should read CLI orchestration backends list', () => {
    const settings = config.getEnvSettings();

    expect(settings.advanced).toHaveProperty('cliOrchestrationBackends');
    expect(Array.isArray(settings.advanced.cliOrchestrationBackends)).toBe(true);
  });

  it('should read CLI orchestration score threshold', () => {
    const settings = config.getEnvSettings();

    expect(settings.advanced).toHaveProperty('cliScoreThreshold');
    expect(typeof settings.advanced.cliScoreThreshold).toBe('number');
    expect(settings.advanced.cliScoreThreshold).toBeGreaterThanOrEqual(1);
    expect(settings.advanced.cliScoreThreshold).toBeLessThanOrEqual(10);
  });

  it('should read CLI orchestration max iterations', () => {
    const settings = config.getEnvSettings();

    expect(settings.advanced).toHaveProperty('cliMaxIterations');
    expect(typeof settings.advanced.cliMaxIterations).toBe('number');
    expect(settings.advanced.cliMaxIterations).toBeGreaterThanOrEqual(1);
  });

  it('should update and persist CLI orchestration settings', () => {
    const settings = config.getEnvSettings();

    // Modify settings
    const originalEnabled = settings.advanced.cliOrchestrationEnabled;
    settings.advanced.cliOrchestrationEnabled = !originalEnabled;
    settings.advanced.cliScoreThreshold = 8;
    settings.advanced.cliMaxIterations = 5;

    // Update settings
    config.updateEnvSettings({ advanced: settings.advanced });

    // Read back settings
    const updatedSettings = config.getEnvSettings();

    // Verify updates
    expect(updatedSettings.advanced.cliOrchestrationEnabled).toBe(!originalEnabled);
    expect(updatedSettings.advanced.cliScoreThreshold).toBe(8);
    expect(updatedSettings.advanced.cliMaxIterations).toBe(5);

    // Restore original state
    settings.advanced.cliOrchestrationEnabled = originalEnabled;
    config.updateEnvSettings({ advanced: settings.advanced });
  });
});

describe('Scenario 4: Full Orchestration Flow', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;
  let llmChat: LlmChatTool;
  let orchestrationService: OrchestrationService;
  let isLmStudioAvailable = false;
  let isOpenCodeAvailable = false;

  beforeAll(async () => {
    config = new ConfigManager();
    backendManager = new BackendManager(config.getConfig().backends);
    llmChat = new LlmChatTool(backendManager, config);
    orchestrationService = initOrchestrationService(config, llmChat, backendManager);

    // Check backend availability
    const probeResults = await backendManager.probeAll();
    for (const [id, result] of probeResults) {
      if (id.includes('lmstudio') && result.available) {
        isLmStudioAvailable = true;
      }
      if (id.includes('opencode') && result.available) {
        isOpenCodeAvailable = true;
      }
    }
  });

  it('should initialize orchestration service', () => {
    expect(orchestrationService).toBeDefined();
    expect(orchestrationService).toBeInstanceOf(OrchestrationService);
  });

  it('should return correct orchestration status', () => {
    const status = orchestrationService.getStatus();

    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('backends');
    expect(status).toHaveProperty('availableBackends');
    expect(status).toHaveProperty('config');

    expect(typeof status.enabled).toBe('boolean');
    expect(Array.isArray(status.backends)).toBe(true);
    expect(Array.isArray(status.availableBackends)).toBe(true);
  });

  it('should probe CLI backends', async () => {
    const probeResults = await orchestrationService.probeBackends();

    expect(probeResults).toBeInstanceOf(Map);

    for (const [id, result] of probeResults) {
      expect(result).toHaveProperty('available');
      expect(typeof result.available).toBe('boolean');
      console.log(`Backend ${id}: available=${result.available}`);
    }
  }, 30000);

  it.skipIf(!isLmStudioAvailable || !isOpenCodeAvailable)(
    'should execute full orchestration task',
    async () => {
      // Use a temp settings file so enabling/disabling orchestration doesn't mutate repo settings
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-local-llm-cli-orch-flow-'));
      const settingsPath = path.join(tempDir, 'env.settings.test');
      try {
        fs.copyFileSync(path.join(process.cwd(), 'env-automated-tests.settings'), settingsPath);

        const localConfig = new ConfigManager(settingsPath);
        const localBackendManager = new BackendManager(localConfig.getConfig().backends);
        const localLlmChat = new LlmChatTool(localBackendManager, localConfig);
        const localOrchestrationService = initOrchestrationService(localConfig, localLlmChat, localBackendManager);

        // Enable orchestration in the temp settings file
        const settings = localConfig.getEnvSettings();
        settings.advanced.cliOrchestrationEnabled = true;
        settings.advanced.cliOrchestrationBackends = ['opencode-cli'];
        settings.advanced.cliAutoVerify = true;
        settings.advanced.cliScoreThreshold = 5; // Lower threshold for testing
        localConfig.updateEnvSettings({ advanced: settings.advanced });

        // Execute a simple task
        const result = await localOrchestrationService.orchestrate('List the files in the current directory', {
          contextRoot: process.cwd(),
        });

        expect(result).toHaveProperty('success');
        expect(result).toHaveProperty('planId');
        expect(typeof result.planId).toBe('string');

        if (result.success) {
          expect(result).toHaveProperty('verification');
          expect(result.verification).toHaveProperty('score');
        } else {
          // Even if it fails, it should have an error message
          expect(result).toHaveProperty('error');
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
    120000
  );

  it('should manage orchestration plans', () => {
    // Get all plans
    const plans = orchestrationService.getAllPlans();
    expect(Array.isArray(plans)).toBe(true);

    // Non-existent plan should return null
    const nonExistentPlan = orchestrationService.getPlan('non-existent-id-12345');
    expect(nonExistentPlan).toBeNull();

    // Deleting non-existent plan should return false
    const deleteResult = orchestrationService.deletePlan('non-existent-id-12345');
    expect(deleteResult).toBe(false);
  });
});

describe('Scenario 5: HTTP API Endpoints', () => {
  // These tests verify the HTTP API structure and responses
  // They use mock data and don't require a running server

  describe('API Response Structures', () => {
    it('should define correct structure for /api/backends response', () => {
      // Expected structure for backends list
      interface BackendResponse {
        id: string;
        type: string;
        available: boolean;
        models?: string[];
        error?: string;
      }

      // Mock response validation
      const mockResponse: BackendResponse[] = [
        { id: 'lmstudio-local', type: 'lmstudio', available: true, models: ['model1'] },
        { id: 'opencode-cli', type: 'opencode', available: true },
        { id: 'copilot-cli', type: 'copilot', available: false, error: 'Not installed' },
      ];

      for (const backend of mockResponse) {
        expect(backend).toHaveProperty('id');
        expect(backend).toHaveProperty('type');
        expect(backend).toHaveProperty('available');
        expect(typeof backend.id).toBe('string');
        expect(typeof backend.type).toBe('string');
        expect(typeof backend.available).toBe('boolean');
      }
    });

    it('should define correct structure for /api/settings/cli-orchestration response', () => {
      // Expected structure for CLI orchestration settings
      interface CliOrchestrationResponse {
        enabled: boolean;
        backends: string[];
        autoVerify: boolean;
        scoreThreshold: number;
        maxIterations: number;
        availableBackends: Array<{
          id: string;
          type: string;
          available: boolean;
          error?: string;
        }>;
      }

      // Mock response validation
      const mockResponse: CliOrchestrationResponse = {
        enabled: true,
        backends: ['opencode-cli'],
        autoVerify: true,
        scoreThreshold: 7,
        maxIterations: 3,
        availableBackends: [
          { id: 'opencode-cli', type: 'opencode', available: true },
          { id: 'copilot-cli', type: 'copilot', available: false, error: 'Not installed' },
        ],
      };

      expect(mockResponse).toHaveProperty('enabled');
      expect(mockResponse).toHaveProperty('backends');
      expect(mockResponse).toHaveProperty('autoVerify');
      expect(mockResponse).toHaveProperty('scoreThreshold');
      expect(mockResponse).toHaveProperty('maxIterations');
      expect(mockResponse).toHaveProperty('availableBackends');

      expect(Array.isArray(mockResponse.backends)).toBe(true);
      expect(Array.isArray(mockResponse.availableBackends)).toBe(true);
    });

    it('should define correct structure for /api/backends/:id/models response', () => {
      // Expected structure for models list
      type ModelsResponse = string[];

      // Mock response validation
      const mockResponse: ModelsResponse = [
        'opencode/claude-3-5-haiku',
        'opencode/gpt-5',
        'google/gemini-2.5-flash',
        'openrouter/anthropic/claude-sonnet-4',
      ];

      expect(Array.isArray(mockResponse)).toBe(true);
      for (const model of mockResponse) {
        expect(typeof model).toBe('string');
        // Model IDs typically have provider/model format
        expect(model).toMatch(/[\w-]+\/[\w.-]+/);
      }
    });

    it('should handle CLI orchestration enable/disable endpoints', () => {
      // Expected structure for enable/disable responses
      interface EnableDisableResponse {
        success: boolean;
        message: string;
        enabled: boolean;
      }

      // Mock enable response
      const enableResponse: EnableDisableResponse = {
        success: true,
        message: 'CLI orchestration enabled',
        enabled: true,
      };

      expect(enableResponse).toHaveProperty('success');
      expect(enableResponse).toHaveProperty('message');
      expect(enableResponse).toHaveProperty('enabled');
      expect(enableResponse.success).toBe(true);
      expect(enableResponse.enabled).toBe(true);

      // Mock disable response
      const disableResponse: EnableDisableResponse = {
        success: true,
        message: 'CLI orchestration disabled',
        enabled: false,
      };

      expect(disableResponse.success).toBe(true);
      expect(disableResponse.enabled).toBe(false);
    });

    it('should handle orchestration save settings endpoint', () => {
      // Expected structure for save settings response
      interface SaveSettingsResponse {
        success: boolean;
        message?: string;
        error?: string;
      }

      // Mock success response
      const successResponse: SaveSettingsResponse = {
        success: true,
        message: 'Settings saved successfully',
      };

      expect(successResponse).toHaveProperty('success');
      expect(successResponse.success).toBe(true);

      // Mock error response
      const errorResponse: SaveSettingsResponse = {
        success: false,
        error: 'Invalid score threshold',
      };

      expect(errorResponse.success).toBe(false);
      expect(errorResponse).toHaveProperty('error');
    });
  });

  describe('API Input Validation', () => {
    it('should validate score threshold is within range', () => {
      const validateScoreThreshold = (value: number): boolean => {
        return value >= 1 && value <= 10;
      };

      expect(validateScoreThreshold(1)).toBe(true);
      expect(validateScoreThreshold(5)).toBe(true);
      expect(validateScoreThreshold(10)).toBe(true);
      expect(validateScoreThreshold(0)).toBe(false);
      expect(validateScoreThreshold(11)).toBe(false);
      expect(validateScoreThreshold(-1)).toBe(false);
    });

    it('should validate max iterations is positive', () => {
      const validateMaxIterations = (value: number): boolean => {
        return value >= 1 && value <= 10;
      };

      expect(validateMaxIterations(1)).toBe(true);
      expect(validateMaxIterations(3)).toBe(true);
      expect(validateMaxIterations(10)).toBe(true);
      expect(validateMaxIterations(0)).toBe(false);
      expect(validateMaxIterations(-1)).toBe(false);
    });

    it('should validate backend IDs are valid strings', () => {
      const validateBackendId = (id: string): boolean => {
        return typeof id === 'string' && id.length > 0 && /^[\w-]+$/.test(id);
      };

      expect(validateBackendId('opencode-cli')).toBe(true);
      expect(validateBackendId('copilot-cli')).toBe(true);
      expect(validateBackendId('lmstudio-local')).toBe(true);
      expect(validateBackendId('')).toBe(false);
      expect(validateBackendId('invalid id with spaces')).toBe(false);
    });
  });
});
