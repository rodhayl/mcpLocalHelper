/**
 * ConfigManager Path Resolution Tests
 * 
 * Tests for the resolveWorkspacePath method, particularly:
 * - Unix-style absolute paths like "/auth/" being normalized on Windows
 * - Helpful error messages when paths are outside workspace
 * - Redundant workspace prefix stripping
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

describe('ConfigManager.resolveWorkspacePath', () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let configPath: string;
  
  beforeEach(() => {
    // Create a temp workspace
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-path-test-'));
    mkdirSync(join(tempDir, 'auth'), { recursive: true });
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export {}');
    writeFileSync(join(tempDir, 'auth', 'service.ts'), 'export class AuthService {}');
    
    // Write a temp settings file and point ConfigManager at it
    configPath = join(tempDir, 'env.settings');
    const tempDirNorm = tempDir.replace(/\\/g, '/');
    const cfg = {
      backends: [{ id: 'test', type: 'ollama', base_url: 'http://127.0.0.1:11434' }],
      defaults: { localBackendId: 'test' },
      policy: { allowlistPaths: [tempDirNorm], maxFileBytes: 131072 },
      systemProfile: { exposeToLLM: false },
    };
    writeFileSync(configPath, `[config]\nCONFIG_JSON=${JSON.stringify(cfg)}\n`, 'utf-8');
    
    configManager = new ConfigManager(configPath);
  });
  
  afterEach(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Unix-style path normalization on Windows', () => {
    it('should normalize /auth to relative ./auth on Windows', () => {
      // This test verifies the fix for LLMs generating paths like "/auth/"
      // which on Windows would resolve to "C:\auth" (outside workspace)
      
      if (process.platform !== 'win32') {
        // On Unix, /auth is actually absolute, so behavior is different
        // This test is specifically for the Windows edge case
        return;
      }
      
      // The fix should convert /auth to ./auth internally
      const resolved = configManager.resolveWorkspacePath('/auth');
      
      // Should resolve to the auth directory within the workspace
      expect(resolved.toLowerCase()).toContain('auth');
      expect(configManager.isPathAllowed(resolved)).toBe(true);
    });

    it('should normalize /src/index.ts to relative path on Windows', () => {
      if (process.platform !== 'win32') {
        return;
      }
      
      const resolved = configManager.resolveWorkspacePath('/src/index.ts');
      expect(resolved.toLowerCase()).toContain('src');
      expect(configManager.isPathAllowed(resolved)).toBe(true);
    });

    it('should not alter UNC paths starting with //', () => {
      // UNC paths like //server/share should not be modified
      try {
        configManager.resolveWorkspacePath('//server/share');
        // If it doesn't throw, that's also valid (depends on allowlist)
      } catch (e) {
        // Expected: outside workspace error, but not a normalization error
        expect(String(e)).toContain('Outside workspace');
      }
    });
  });

  describe('relative path handling', () => {
    it('should resolve ./auth correctly', () => {
      const resolved = configManager.resolveWorkspacePath('./auth');
      expect(resolved.toLowerCase()).toContain('auth');
      expect(configManager.isPathAllowed(resolved)).toBe(true);
    });

    it('should resolve auth (no prefix) correctly', () => {
      const resolved = configManager.resolveWorkspacePath('auth');
      expect(resolved.toLowerCase()).toContain('auth');
      expect(configManager.isPathAllowed(resolved)).toBe(true);
    });

    it('should resolve . to workspace root', () => {
      const resolved = configManager.resolveWorkspacePath('.');
      expect(configManager.isPathAllowed(resolved)).toBe(true);
    });
  });

  describe('error messages', () => {
    it('should provide helpful hint for Unix-style absolute paths on non-Windows', () => {
      if (process.platform === 'win32') {
        // On Windows, the path normalization should fix the issue
        // so no error is expected for /etc-style paths
        return;
      }
      
      // On Unix, /etc/passwd is actually absolute and outside workspace
      try {
        configManager.resolveWorkspacePath('/etc/passwd');
        // Should have thrown
        expect.fail('Expected error for path outside workspace');
      } catch (e) {
        const msg = String(e);
        expect(msg).toContain('Outside workspace');
        // Should include hint
        expect(msg).toContain('hint');
      }
    });
  });

  describe('redundant prefix stripping', () => {
    it('should strip workspace prefix from paths', () => {
      // If workspace is /tmp/mcp-path-test-xxx, and we pass the full path,
      // it should work and be allowed
      const fullPath = resolve(tempDir, 'src', 'index.ts');
      const resolved = configManager.resolveWorkspacePath(fullPath);
      expect(configManager.isPathAllowed(resolved)).toBe(true);
    });
  });
});
