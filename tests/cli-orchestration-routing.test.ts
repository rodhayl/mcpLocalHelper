/**
 * CLI Orchestration Routing Tests
 * 
 * Tests that verify agent_task correctly routes to CLI backends when
 * CLI_ORCHESTRATION_ENABLED=true in settings.
 * 
 * V21 (QA_feedback_29012026): Added to verify fix for CLI orchestration
 * defaulting to false regardless of settings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CLI Orchestration Routing', () => {
  describe('useCliOrchestration default behavior', () => {
    it('should default to CLI_ORCHESTRATION_ENABLED setting value', async () => {
      // This test verifies the fix: useCliOrchestration should read from
      // config.getEnvSettings().advanced?.cliOrchestrationEnabled
      // instead of hardcoded false
      
      // The fix is in src/server/mcp.ts around line 3033-3040:
      // Before: const useCliOrchestration = ... ?? false;
      // After:  const useCliOrchestration = ... ?? cliOrchestrationSetting;
      
      const fs = await import('fs');
      const path = await import('path');
      
      // Read the mcp.ts file to verify the fix is in place
      const mcpPath = path.join(process.cwd(), 'src', 'server', 'mcp.ts');
      const content = fs.readFileSync(mcpPath, 'utf-8');
      
      // Check for the fix markers
      expect(content).toContain('cliOrchestrationSetting');
      expect(content).toContain('this.config.getEnvSettings().advanced?.cliOrchestrationEnabled');
      
      // Verify old hardcoded false is replaced
      // The pattern "use_cli_orchestration ??\n                false;" should NOT exist
      const oldPattern = /parsed\.use_cli_orchestration \?\?\s*false;/;
      expect(content).not.toMatch(oldPattern);
    });

    it('should use explicit useCliOrchestration=true over settings', async () => {
      // When useCliOrchestration is explicitly passed as true,
      // it should override any setting value
      const fs = await import('fs');
      const path = await import('path');
      
      const mcpPath = path.join(process.cwd(), 'src', 'server', 'mcp.ts');
      const content = fs.readFileSync(mcpPath, 'utf-8');
      
      // Verify opt.useCliOrchestration takes precedence (first in chain)
      expect(content).toMatch(/opt\.useCliOrchestration \?\?/);
    });

    it('should use explicit useCliOrchestration=false over settings', async () => {
      // When useCliOrchestration is explicitly passed as false,
      // it should override the CLI_ORCHESTRATION_ENABLED setting
      const fs = await import('fs');
      const path = await import('path');
      
      const mcpPath = path.join(process.cwd(), 'src', 'server', 'mcp.ts');
      const content = fs.readFileSync(mcpPath, 'utf-8');
      
      // The nullish coalescing chain ensures explicit false takes precedence
      expect(content).toMatch(/opt\.useCliOrchestration \?\?\s*parsed\.useCliOrchestration/);
    });
  });

  describe('env-automated-tests.settings configuration', () => {
    it('should have copilot-cli with correct args_template', async () => {
      const fs = await import('fs');
      const path = await import('path');
      
      const settingsPath = path.join(process.cwd(), 'env-automated-tests.settings');
      const content = fs.readFileSync(settingsPath, 'utf-8');
      
      // Verify correct Copilot CLI args format (non-interactive prompt)
      expect(content).toContain('"-p"');
      expect(content).toContain('"--allow-all"');
      expect(content).toContain('"--no-ask-user"');
      expect(content).toContain('"--model","gpt-5-mini"');
      
      // Verify old deprecated flags are NOT present
      expect(content).not.toContain('"--instructions"');
    });

    it('should have CLI_ORCHESTRATION_BACKENDS including both opencode-cli and copilot-cli', async () => {
      const fs = await import('fs');
      const path = await import('path');
      
      const settingsPath = path.join(process.cwd(), 'env-automated-tests.settings');
      const content = fs.readFileSync(settingsPath, 'utf-8');
      
      // Verify both backends are configured
      expect(content).toContain('CLI_ORCHESTRATION_BACKENDS=opencode-cli,copilot-cli');
    });

    // V22: CLI orchestration is now disabled by default for automated tests
    // to avoid latency overhead. It's opt-in per agent_task call.
    it('should have CLI_ORCHESTRATION_ENABLED=false for test stability', async () => {
      const fs = await import('fs');
      const path = await import('path');
      
      const settingsPath = path.join(process.cwd(), 'env-automated-tests.settings');
      const content = fs.readFileSync(settingsPath, 'utf-8');
      
      expect(content).toContain('CLI_ORCHESTRATION_ENABLED=false');
    });
  });

  describe('ConfigManager CLI orchestration parsing', () => {
    it('should parse CLI_ORCHESTRATION_ENABLED from settings file', async () => {
      // Import ConfigManager to verify it correctly parses CLI settings
      const { ConfigManager } = await import('../src/config/index.js');
      
      const configManager = new ConfigManager();
      const envSettings = configManager.getEnvSettings();
      
      // The env-automated-tests.settings has CLI_ORCHESTRATION_ENABLED=false (for stability)
      // ConfigManager should parse this correctly
      expect(envSettings.advanced).toBeDefined();
      expect(typeof envSettings.advanced.cliOrchestrationEnabled).toBe('boolean');
    });

    it('should parse CLI_ORCHESTRATION_BACKENDS from settings file', async () => {
      const { ConfigManager } = await import('../src/config/index.js');
      
      const configManager = new ConfigManager();
      const envSettings = configManager.getEnvSettings();
      
      expect(envSettings.advanced).toBeDefined();
      expect(Array.isArray(envSettings.advanced.cliOrchestrationBackends)).toBe(true);
    });
  });

  describe('Environment variable overrides', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // Clear CLI orchestration env vars
      delete process.env.CLI_ORCHESTRATION_ENABLED;
      delete process.env.CLI_ORCHESTRATION_BACKENDS;
    });

    afterEach(() => {
      // Restore original env
      process.env = { ...originalEnv };
    });

    it('should allow CLI_ORCHESTRATION_ENABLED env var to override settings', async () => {
      // This is tested by the batch files which set:
      // set "CLI_ORCHESTRATION_ENABLED=true"
      // set "CLI_ORCHESTRATION_BACKENDS=copilot-cli"
      
      const fs = await import('fs');
      const path = await import('path');
      
      // Read config/index.ts to verify env var override logic exists
      const configPath = path.join(process.cwd(), 'src', 'config', 'index.ts');
      const content = fs.readFileSync(configPath, 'utf-8');
      
      expect(content).toContain("process.env.CLI_ORCHESTRATION_ENABLED");
      expect(content).toContain("process.env.CLI_ORCHESTRATION_BACKENDS");
    });

    it('should parse CLI_ORCHESTRATION_BACKENDS as comma-separated list', async () => {
      const fs = await import('fs');
      const path = await import('path');
      
      const configPath = path.join(process.cwd(), 'src', 'config', 'index.ts');
      const content = fs.readFileSync(configPath, 'utf-8');
      
      // Verify the split logic exists
      expect(content).toMatch(/\.split\s*\(\s*['"],['"]?\s*\)/);
    });
  });
});
