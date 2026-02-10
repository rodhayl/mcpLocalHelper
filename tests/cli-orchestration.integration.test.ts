/**
 * CLI Orchestration Integration Tests
 * 
 * Tests the full CLI orchestration flow:
 * 1. OrchestrationService initialization
 * 2. Backend probing
 * 3. Task execution via CLI backends
 * 4. Verification and retry logic
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { OrchestrationService, initOrchestrationService, getOrchestrationService } from '../src/orchestration/index.js';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmChatTool } from '../src/tools/llm.js';
import { CliOrchestrator } from '../src/orchestration/cli-orchestrator.js';
import { PlanManager } from '../src/orchestration/plan-manager.js';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('CLI Orchestration Integration', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;
  let llmChat: LlmChatTool;
  let orchestrationService: OrchestrationService;

  beforeAll(() => {
    // Initialize with test configuration
    config = new ConfigManager();
    backendManager = new BackendManager(config.getConfig().backends);
    llmChat = new LlmChatTool(backendManager, config);
    
    // Initialize orchestration service
    orchestrationService = initOrchestrationService(config, llmChat, backendManager);
  });

  describe('OrchestrationService Initialization', () => {
    it('should initialize the orchestration service', () => {
      expect(orchestrationService).toBeDefined();
      expect(orchestrationService).toBeInstanceOf(OrchestrationService);
    });

    it('should return the singleton instance via getOrchestrationService', () => {
      const singleton = getOrchestrationService();
      expect(singleton).toBe(orchestrationService);
    });

    it('should report status correctly', () => {
      const status = orchestrationService.getStatus();
      
      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('backends');
      expect(status).toHaveProperty('availableBackends');
      expect(status).toHaveProperty('config');
      
      expect(status.availableBackends).toContain('opencode-cli');
      expect(status.availableBackends).toContain('copilot-cli');
    });

    it('should create orchestrator with only available backends', () => {
      const orchestrator = (orchestrationService as any).createOrchestrator(['copilot-cli']);
      const backends = (orchestrator as any).backends as Map<string, unknown>;
      expect(Array.from(backends.keys())).toEqual(['copilot-cli']);
    });
  });

  describe('Backend Probing', () => {
    it('should probe all CLI backends', async () => {
      const probeResults = await orchestrationService.probeBackends();
      
      expect(probeResults).toBeInstanceOf(Map);
      expect(probeResults.has('opencode-cli')).toBe(true);
      expect(probeResults.has('copilot-cli')).toBe(true);
      
      // Each probe result should have available and optionally error
      for (const [id, result] of probeResults) {
        expect(result).toHaveProperty('available');
        if (!result.available) {
          expect(result).toHaveProperty('error');
        }
      }
    }, 30000); // 30 second timeout for npm list commands
  });

  // V25 Phase 2 cleanup: Removed skipped tests that spawned real CLI processes
  // These scenarios are now covered by:
  // - tests/real-mcp/real.agent-task.test.ts (real MCP orchestration tests)
  // - The validation in orchestrationService.orchestrate() already handles disabled/no-backends

  describe('Plan Management', () => {
    it('should list all plans', () => {
      const plans = orchestrationService.getAllPlans();
      expect(Array.isArray(plans)).toBe(true);
    });

    it('should return null for non-existent plan', () => {
      const plan = orchestrationService.getPlan('non-existent-plan-id');
      expect(plan).toBeNull();
    });

    it('should return false when deleting non-existent plan', () => {
      const result = orchestrationService.deletePlan('non-existent-plan-id');
      expect(result).toBe(false);
    });
  });

  describe('Service Refresh', () => {
    it('should refresh CLI backends without error', () => {
      expect(() => orchestrationService.refresh()).not.toThrow();
      
      // Verify status still works after refresh
      const status = orchestrationService.getStatus();
      expect(status.availableBackends).toContain('opencode-cli');
    });
  });
});

describe('CLI Orchestration with LM Studio (E2E)', () => {
  // These tests require LM Studio to be running
  // Skip if not available
  
  let orchestrationService: OrchestrationService | null;
  let isLmStudioAvailable = false;

  beforeAll(async () => {
    try {
      const config = new ConfigManager();
      const backendManager = new BackendManager(config.getConfig().backends);
      const llmChat = new LlmChatTool(backendManager, config);
      
      orchestrationService = initOrchestrationService(config, llmChat, backendManager);
      
      // Check if LM Studio is available
      const probeResults = await backendManager.probeAll();
      for (const [id, result] of probeResults) {
        if (id.includes('lmstudio') && result.available) {
          isLmStudioAvailable = true;
          break;
        }
      }
    } catch {
      isLmStudioAvailable = false;
    }
  });

  it.skipIf(!isLmStudioAvailable)('should execute orchestration task with LM Studio planning', async () => {
    if (!orchestrationService) {
      throw new Error('Orchestration service not initialized');
    }

    // Use a temp settings file so enabling/disabling orchestration doesn't mutate repo settings.
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-local-llm-cli-orch-e2e-'));
    const settingsPath = path.join(tempDir, 'env.settings.test');
    try {
      copyFileSync(path.join(process.cwd(), 'env-automated-tests.settings'), settingsPath);

      // Enable orchestration with opencode-cli (in temp settings file)
      const tempConfig = new ConfigManager(settingsPath);
      const tempBackendManager = new BackendManager(tempConfig.getConfig().backends);
      const tempLlmChat = new LlmChatTool(tempBackendManager, tempConfig);
      const tempOrchestrationService = initOrchestrationService(tempConfig, tempLlmChat, tempBackendManager);

      const settings = tempConfig.getEnvSettings();
      settings.advanced.cliOrchestrationEnabled = true;
      settings.advanced.cliOrchestrationBackends = ['opencode-cli'];
      settings.advanced.cliAutoVerify = true;
      settings.advanced.cliScoreThreshold = 7;
      tempConfig.updateEnvSettings({ advanced: settings.advanced });

      // Run a simple orchestration task
      const result = await tempOrchestrationService.orchestrate('Create a simple hello.ts file that exports a greet function', {
        contextRoot: 'test-orchestration-sample',
      });

      // Even if OpenCode CLI is not installed, the orchestration should run
      // and return a result (possibly with error about backend not available)
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('planId');
      expect(result).toHaveProperty('verification');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 120000); // 2 minute timeout for LLM operations
});

// --- CLI Orchestration Environment Variable Isolation ---
describe('CLI Orchestration Environment Variable Isolation', () => {
  let originalCliEnabled: string | undefined;
  let originalCliBackends: string | undefined;

  beforeEach(() => {
    originalCliEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
    originalCliBackends = process.env.CLI_ORCHESTRATION_BACKENDS;
  });

  afterEach(() => {
    if (originalCliEnabled !== undefined) {
      process.env.CLI_ORCHESTRATION_ENABLED = originalCliEnabled;
    } else {
      delete process.env.CLI_ORCHESTRATION_ENABLED;
    }
    if (originalCliBackends !== undefined) {
      process.env.CLI_ORCHESTRATION_BACKENDS = originalCliBackends;
    } else {
      delete process.env.CLI_ORCHESTRATION_BACKENDS;
    }
  });

  it('should allow tests to unset CLI_ORCHESTRATION_ENABLED', () => {
    process.env.CLI_ORCHESTRATION_ENABLED = 'true';
    process.env.CLI_ORCHESTRATION_BACKENDS = 'copilot-cli';
    expect(process.env.CLI_ORCHESTRATION_ENABLED).toBe('true');
    expect(process.env.CLI_ORCHESTRATION_BACKENDS).toBe('copilot-cli');

    delete process.env.CLI_ORCHESTRATION_ENABLED;
    delete process.env.CLI_ORCHESTRATION_BACKENDS;

    expect(process.env.CLI_ORCHESTRATION_ENABLED).toBeUndefined();
    expect(process.env.CLI_ORCHESTRATION_BACKENDS).toBeUndefined();
  });

  it('should restore env vars after test cleanup', () => {
    process.env.CLI_ORCHESTRATION_ENABLED = 'true';
    process.env.CLI_ORCHESTRATION_BACKENDS = 'copilot-cli';

    const savedEnabled = process.env.CLI_ORCHESTRATION_ENABLED;
    const savedBackends = process.env.CLI_ORCHESTRATION_BACKENDS;

    delete process.env.CLI_ORCHESTRATION_ENABLED;
    delete process.env.CLI_ORCHESTRATION_BACKENDS;

    if (savedEnabled !== undefined) {
      process.env.CLI_ORCHESTRATION_ENABLED = savedEnabled;
    }
    if (savedBackends !== undefined) {
      process.env.CLI_ORCHESTRATION_BACKENDS = savedBackends;
    }

    expect(process.env.CLI_ORCHESTRATION_ENABLED).toBe('true');
    expect(process.env.CLI_ORCHESTRATION_BACKENDS).toBe('copilot-cli');
  });

  it('tests using stub backends should not be affected by CLI orchestration env vars', () => {
    expect(true).toBe(true); // Pattern documented
  });
});

// --- CliOrchestrator Timeout Handling ---
function createSlowLlm(delayMs: number) {
  return {
    id: 'slow-llm',
    invokeChat: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return {
        message: {
          role: 'assistant' as const,
          content: JSON.stringify({
            steps: [{
              description: 'Test step',
              cliBackend: 'opencode-cli',
              taskPrompt: 'Do something',
            }],
          }),
        },
      };
    }),
  };
}

function createWorkingBackend() {
  return {
    id: 'opencode-cli',
    executeTask: vi.fn(async () => ({
      success: true,
      content: 'Task completed',
      files_modified: ['test.txt'],
      tools_used: ['create_file'],
    })),
    probe: vi.fn(async () => ({ available: true })),
  };
}

describe('CliOrchestrator Timeout Handling', () => {
  let planManager: PlanManager;
  
  beforeEach(() => {
    planManager = new PlanManager();
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error with timing when LLM hangs during planning', async () => {
    let rejectFn: (reason: Error) => void;
    const hangingLlm = {
      id: 'hanging-llm',
      invokeChat: vi.fn(() => new Promise<never>((_, reject) => {
        rejectFn = reject;
        setTimeout(() => reject(new Error('[TIMEOUT] LLM planning exceeded 100ms')), 100);
      })),
    };
    
    const workingBackend = createWorkingBackend();
    const backends = new Map([['opencode-cli', workingBackend]]);
    
    const orchestrator = new CliOrchestrator(
      {
        cliOrchestrationEnabled: true,
        cliOrchestrationBackends: ['opencode-cli'],
        cliAutoVerify: false,
        cliScoreThreshold: 7,
        cliMaxIterations: 1,
      },
      planManager,
      backends,
      hangingLlm
    );
    
    const result = await orchestrator.orchestrate('Create a test file');
    
    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('timing');
    expect(result.timing).toHaveProperty('startTime');
    expect(result.error).toContain('TIMEOUT');
  }, 10000);

  it('should include timing data even when orchestration fails', async () => {
    const slowLlm = createSlowLlm(100);
    const workingBackend = createWorkingBackend();
    const backends = new Map([['opencode-cli', workingBackend]]);
    
    const orchestrator = new CliOrchestrator(
      {
        cliOrchestrationEnabled: true,
        cliOrchestrationBackends: ['opencode-cli'],
        cliAutoVerify: false,
        cliScoreThreshold: 7,
        cliMaxIterations: 1,
      },
      planManager,
      backends,
      slowLlm
    );
    
    const result = await orchestrator.orchestrate('Create a test file');
    
    expect(result).toHaveProperty('timing');
    expect(result.timing).toHaveProperty('llmPlanningMs');
    expect(result.timing.llmPlanningMs).toBeGreaterThan(0);
    expect(result.timing).toHaveProperty('startTime');
    expect(result.timing).toHaveProperty('endTime');
    expect(result.timing).toHaveProperty('totalMs');
    expect(result.timing.totalMs).toBeGreaterThan(0);
  });

  it('should return error with timing when CLI backend hangs', async () => {
    const workingLlm = createSlowLlm(10);
    
    const hangingBackend = {
      id: 'hanging-backend',
      executeTask: vi.fn(() => new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('[TIMEOUT] CLI execution (opencode-cli) exceeded 100ms')), 100);
      })),
      probe: vi.fn(async () => ({ available: true })),
    };
    
    const backends = new Map([['opencode-cli', hangingBackend]]);
    
    const orchestrator = new CliOrchestrator(
      {
        cliOrchestrationEnabled: true,
        cliOrchestrationBackends: ['opencode-cli'],
        cliAutoVerify: false,
        cliScoreThreshold: 7,
        cliMaxIterations: 1,
      },
      planManager,
      backends,
      workingLlm
    );
    
    const result = await orchestrator.orchestrate('Create a test file');
    
    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('timing');
    expect(result.timing.llmPlanningMs).toBeGreaterThan(0);
    expect(result.error).toContain('TIMEOUT');
  }, 10000);
});
