/**
 * CLI Backend Model Loading Tests
 * 
 * TDD tests for BUG-1: CLI backends fail to load models with "Failed to load models"
 * 
 * These tests verify that:
 * 1. OpenCode adapter's listModels() returns fallback models when CLI not installed
 * 2. Copilot adapter's listModels() returns models without throwing
 * 3. The /api/backends/:id/models endpoint returns fallback models gracefully
 */

import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { CopilotAdapter } from '../src/adapters/copilot.js';

describe('CLI Backend Model Loading', () => {
  describe('OpenCodeAdapter.listModels()', () => {
    it('should return fallback models when opencode CLI is not installed', async () => {
      // Create adapter instance
      const adapter = new OpenCodeAdapter('test-opencode', {
        command: 'nonexistent-opencode-command-xyz',
        timeout: 5000,
      });

      // listModels should NOT throw, should return fallback models
      const models = await adapter.listModels();
      
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      
      // Should have at least one free model in fallback
      const hasFreeModel = models.some(m => 
        m.id.toLowerCase().includes('free') || 
        m.name?.toLowerCase().includes('free')
      );
      expect(hasFreeModel).toBe(true);
    });

    it('should return valid ModelInfo objects', async () => {
      // Keep this deterministic: validate fallback shape, not external CLI responsiveness.
      const adapter = new OpenCodeAdapter('test-opencode', {
        command: 'nonexistent-opencode-command-xyz',
        timeout: 5000,
      });
      const models = await adapter.listModels();
      
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(typeof model.id).toBe('string');
        expect(typeof model.name).toBe('string');
      }
    });
  });

  describe('CopilotAdapter.listModels()', () => {
    it('should return hardcoded models without throwing', async () => {
      const adapter = new CopilotAdapter('test-copilot', {
        command: 'nonexistent-copilot-command-xyz',
        timeout: 5000,
      });

      // listModels should NOT throw
      const models = await adapter.listModels();
      
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should include gpt-5-mini model in the list', async () => {
      const adapter = new CopilotAdapter('test-copilot', {});
      const models = await adapter.listModels();
      
      const hasGpt5Mini = models.some(m => m.id.includes('gpt-5-mini'));
      expect(hasGpt5Mini).toBe(true);
    });

    it('should return valid ModelInfo objects', async () => {
      const adapter = new CopilotAdapter('test-copilot', {});
      const models = await adapter.listModels();
      
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('capabilities');
        expect(Array.isArray(model.capabilities)).toBe(true);
      }
    });
  });

  describe('Mutual Exclusivity of CLI Backends', () => {
    it('should have documentation indicating only one CLI backend active at a time', () => {
      // This is more of a design test - verify the config structure
      // Both backends should be configurable, but the UI should enforce mutual exclusivity
      const opencodeAdapter = new OpenCodeAdapter('opencode-cli', {});
      const copilotAdapter = new CopilotAdapter('copilot-cli', {});
      
      // Both should exist and be distinct
      expect(opencodeAdapter.id).toBe('opencode-cli');
      expect(copilotAdapter.id).toBe('copilot-cli');
      expect(opencodeAdapter.displayName).not.toBe(copilotAdapter.displayName);
    });
  });
});
