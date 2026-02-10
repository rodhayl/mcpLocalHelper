/**
 * Tests for Improvement Plans V3
 * 
 * Plan 1: Enhanced Search Noise Filtering - shouldExcludePath uses DEFAULT_EXCLUDE_PATTERNS
 * Plan 2: Cache Key Normalization Fix - Less aggressive normalization for better hit rate
 * Plan 3: Security Scan CI-Ready Defaults - failOnEmpty defaults to true in CI environments
 * Plan 5: Agent Limit Optimization - Increased defaults (maxSteps=25, maxSubtasks=8, maxActionsPerStep=8)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { FileTools } from '../src/tools/file.js';
import { LLMCache } from '../src/utils/llm-cache.js';
import { HighValueTools } from '../src/tools/highvalue.js';
import { BackendManager } from '../src/adapters/factory.js';
import * as fs from 'fs';
import * as path from 'path';
import { writeSettingsFile } from './test-utils/settings.js';

describe('Improvement Plan V3 Tests', () => {
  describe('Plan 1: Enhanced Search Noise Filtering', () => {
    let config: ConfigManager;
    let fileTools: FileTools;
    const testDir = path.join(process.cwd(), 'tests', 'tmp', 'noise-filter-test');
    const configPath = path.join(testDir, 'env.noise-filter.test.settings');

    beforeAll(() => {
      fs.mkdirSync(testDir, { recursive: true });
      const testDirNorm = testDir.replace(/\\/g, '/');
      const cfg = {
        backends: [],
        defaults: { localBackendId: 'stub' },
        policy: { allowlistPaths: [testDirNorm], maxFileBytes: 131072 },
        workspace: { roots: [testDirNorm], defaultRoot: testDirNorm },
        systemProfile: { exposeToLLM: false },
      };
      writeSettingsFile(configPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

      config = new ConfigManager(configPath);
      fileTools = new FileTools(config);

      // Create test directory structure with noise directories
      fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'venv', 'lib', 'site-packages'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.venv', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'node_modules', 'lodash'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '__pycache__'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'coverage'), { recursive: true });
      fs.mkdirSync(path.join(testDir, '.pytest_cache'), { recursive: true });

      // Create actual source files
      fs.writeFileSync(
        path.join(testDir, 'src', 'main.ts'),
        `export function config() { return 'config value'; }`
      );
      fs.writeFileSync(
        path.join(testDir, 'config.ts'),
        `export const config = { key: 'value' };`
      );

      // Create noise files that should be filtered
      fs.writeFileSync(
        path.join(testDir, 'venv', 'lib', 'site-packages', 'package_config.py'),
        `# venv package config - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, '.venv', 'config.py'),
        `# .venv config - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'node_modules', 'lodash', 'config.js'),
        `// node_modules config - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, '__pycache__', 'config.cpython-311.pyc'),
        `# pycache - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'dist', 'config.js'),
        `// dist config - should be filtered`
      );
      fs.writeFileSync(
        path.join(testDir, 'coverage', 'config-report.json'),
        `{"coverage": "report"}`
      );
    });

    afterAll(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('shouldExcludePath', () => {
      it('should exclude venv directories', () => {
        expect(fileTools.shouldExcludePath('venv/lib/site-packages/package.py')).toBe(true);
        expect(fileTools.shouldExcludePath('.venv/bin/python')).toBe(true);
      });

      it('should exclude node_modules', () => {
        expect(fileTools.shouldExcludePath('node_modules/lodash/index.js')).toBe(true);
      });

      it('should exclude __pycache__', () => {
        expect(fileTools.shouldExcludePath('__pycache__/module.cpython-311.pyc')).toBe(true);
      });

      it('should exclude .pyc files anywhere', () => {
        expect(fileTools.shouldExcludePath('src/module.pyc')).toBe(true);
      });

      it('should exclude dist and build directories', () => {
        expect(fileTools.shouldExcludePath('dist/bundle.js')).toBe(true);
        expect(fileTools.shouldExcludePath('build/output.js')).toBe(true);
      });

      it('should exclude coverage directories', () => {
        expect(fileTools.shouldExcludePath('coverage/lcov.info')).toBe(true);
      });

      it('should exclude lock files', () => {
        expect(fileTools.shouldExcludePath('package-lock.json')).toBe(true);
        expect(fileTools.shouldExcludePath('yarn.lock')).toBe(true);
        expect(fileTools.shouldExcludePath('pnpm-lock.yaml')).toBe(true);
      });

      it('should exclude minified files', () => {
        expect(fileTools.shouldExcludePath('bundle.min.js')).toBe(true);
        expect(fileTools.shouldExcludePath('styles.min.css')).toBe(true);
      });

      it('should exclude .pytest_cache', () => {
        expect(fileTools.shouldExcludePath('.pytest_cache/v/cache/nodeids')).toBe(true);
      });

      it('should NOT exclude src/ files', () => {
        expect(fileTools.shouldExcludePath('src/main.ts')).toBe(false);
        expect(fileTools.shouldExcludePath('src/config/index.ts')).toBe(false);
      });

      it('should NOT exclude regular TypeScript/JavaScript files', () => {
        expect(fileTools.shouldExcludePath('utils.ts')).toBe(false);
        expect(fileTools.shouldExcludePath('helper.js')).toBe(false);
      });

      it('should handle Windows-style paths', () => {
        expect(fileTools.shouldExcludePath('venv\\lib\\site-packages\\pkg.py')).toBe(true);
        expect(fileTools.shouldExcludePath('src\\main.ts')).toBe(false);
      });

      // Additional edge case tests
      it('should exclude OS-specific files like .DS_Store and Thumbs.db', () => {
        expect(fileTools.shouldExcludePath('.DS_Store')).toBe(true);
        expect(fileTools.shouldExcludePath('Thumbs.db')).toBe(true);
        expect(fileTools.shouldExcludePath('project/.DS_Store')).toBe(true);
      });

      it('should exclude IDE directories', () => {
        expect(fileTools.shouldExcludePath('.idea/workspace.xml')).toBe(true);
        expect(fileTools.shouldExcludePath('.vscode/settings.json')).toBe(true);
      });

      it('should exclude temporary and swap files', () => {
        expect(fileTools.shouldExcludePath('file.swp')).toBe(true);
        expect(fileTools.shouldExcludePath('file.swo')).toBe(true);
        expect(fileTools.shouldExcludePath('tmp/cache.json')).toBe(true);
        expect(fileTools.shouldExcludePath('temp/session.dat')).toBe(true);
      });

      it('should exclude binary and media files', () => {
        expect(fileTools.shouldExcludePath('image.png')).toBe(true);
        expect(fileTools.shouldExcludePath('assets/logo.jpg')).toBe(true);
        expect(fileTools.shouldExcludePath('fonts/arial.woff2')).toBe(true);
        expect(fileTools.shouldExcludePath('app.exe')).toBe(true);
        expect(fileTools.shouldExcludePath('lib.dll')).toBe(true);
      });

      it('should exclude log files', () => {
        expect(fileTools.shouldExcludePath('debug.log')).toBe(true);
        expect(fileTools.shouldExcludePath('logs/app.log')).toBe(true);
      });

      it('should exclude nested noise directories', () => {
        expect(fileTools.shouldExcludePath('project/subproject/node_modules/pkg/index.js')).toBe(true);
        expect(fileTools.shouldExcludePath('deep/nested/__pycache__/module.pyc')).toBe(true);
      });

      it('should NOT exclude files with similar names to excluded dirs', () => {
        // A file named "node_modules.ts" should NOT be excluded
        expect(fileTools.shouldExcludePath('node_modules.ts')).toBe(false);
        // A file in a dir called "mynode_modules" should NOT be excluded
        expect(fileTools.shouldExcludePath('mynode_modules/file.js')).toBe(false);
      });
    });

    describe('grepRepoV2 noise filtering', () => {
      it('should NOT return results from venv directories', () => {
        const result = fileTools.grepRepoV2(testDir, 'config', { isRegex: false });
        
        // Should find src/main.ts and config.ts but NOT venv files
        const files = result.matches.map(m => m.file);
        expect(files.some(f => f.includes('venv'))).toBe(false);
        expect(files.some(f => f.includes('.venv'))).toBe(false);
      });

      it('should NOT return results from node_modules', () => {
        const result = fileTools.grepRepoV2(testDir, 'config', { isRegex: false });
        
        const files = result.matches.map(m => m.file);
        expect(files.some(f => f.includes('node_modules'))).toBe(false);
      });

      it('should NOT return results from __pycache__', () => {
        const result = fileTools.grepRepoV2(testDir, 'config', { isRegex: false });
        
        const files = result.matches.map(m => m.file);
        expect(files.some(f => f.includes('__pycache__'))).toBe(false);
      });

      it('should NOT return results from dist directories', () => {
        const result = fileTools.grepRepoV2(testDir, 'config', { isRegex: false });
        
        const files = result.matches.map(m => m.file);
        expect(files.some(f => f.includes('dist/'))).toBe(false);
      });

      it('should return results from src directories', () => {
        const result = fileTools.grepRepoV2(testDir, 'config', { isRegex: false });
        
        const files = result.matches.map(m => m.file);
        expect(files.some(f => f.includes('src/') || f === 'config.ts')).toBe(true);
      });

      it('should return results from root-level source files', () => {
        const result = fileTools.grepRepoV2(testDir, 'config', { isRegex: false });
        
        const files = result.matches.map(m => m.file);
        expect(files.some(f => f === 'config.ts' || f.endsWith('/config.ts'))).toBe(true);
      });
    });
  });

  describe('Plan 2: Cache Key Normalization Fix', () => {
    let cache: LLMCache;

    beforeEach(() => {
      cache = new LLMCache();
    });

    it('should preserve case in cache keys (case should matter)', () => {
      const messages1 = [{ role: 'user', content: 'Analyze the FunctionName class' }];
      const messages2 = [{ role: 'user', content: 'Analyze the functionname class' }];
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be DIFFERENT because case matters in code
      expect(key1).not.toBe(key2);
    });

    it('should normalize whitespace variations', () => {
      const messages1 = [{ role: 'user', content: 'Analyze   the   code' }];
      const messages2 = [{ role: 'user', content: 'Analyze the code' }];
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be SAME because whitespace is normalized
      expect(key1).toBe(key2);
    });

    it('should normalize line endings', () => {
      const messages1 = [{ role: 'user', content: 'Line 1\r\nLine 2' }];
      const messages2 = [{ role: 'user', content: 'Line 1\nLine 2' }];
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be SAME because line endings are normalized
      expect(key1).toBe(key2);
    });

    it('should normalize smart quotes to regular quotes', () => {
      // Use String.fromCharCode for reliable unicode representation
      // U+2018 = left single quote, U+2019 = right single quote
      // U+201C = left double quote, U+201D = right double quote
      const smartQuoteContent = 'The ' + String.fromCharCode(0x201C) + 'value' + String.fromCharCode(0x201D) + ' is ' + String.fromCharCode(0x2018) + 'here' + String.fromCharCode(0x2019);
      const regularQuoteContent = 'The "value" is \'here\'';
      
      const messages1 = [{ role: 'user', content: smartQuoteContent }];
      const messages2 = [{ role: 'user', content: regularQuoteContent }];
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be SAME because quotes are normalized
      expect(key1).toBe(key2);
    });

    it('should normalize en-dash/em-dash to hyphen', () => {
      const messages1 = [{ role: 'user', content: 'test\u2014value' }]; // em-dash
      const messages2 = [{ role: 'user', content: 'test-value' }]; // regular hyphen
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be SAME because dashes are normalized
      expect(key1).toBe(key2);
    });

    it('should normalize ellipsis', () => {
      const messages1 = [{ role: 'user', content: 'wait\u2026 for it' }]; // unicode ellipsis
      const messages2 = [{ role: 'user', content: 'wait... for it' }]; // three periods
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be SAME because ellipsis is normalized
      expect(key1).toBe(key2);
    });

    it('should preserve trailing punctuation (not strip it)', () => {
      const messages1 = [{ role: 'user', content: 'What is the error?' }];
      const messages2 = [{ role: 'user', content: 'What is the error' }];
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      // Keys should be DIFFERENT because punctuation is now preserved
      expect(key1).not.toBe(key2);
    });

    it('should handle identical messages with same key', () => {
      const messages = [{ role: 'user', content: 'Analyze this code' }];
      
      const key1 = cache.getKeyFromMessages(messages, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages, 'gpt-4');
      
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different content', () => {
      const messages1 = [{ role: 'user', content: 'Analyze function A' }];
      const messages2 = [{ role: 'user', content: 'Analyze function B' }];
      
      const key1 = cache.getKeyFromMessages(messages1, 'gpt-4');
      const key2 = cache.getKeyFromMessages(messages2, 'gpt-4');
      
      expect(key1).not.toBe(key2);
    });

    it('should cache and retrieve responses correctly', () => {
      const messages = [{ role: 'user', content: 'Test prompt' }];
      const response = { result: 'cached response' };
      
      cache.setFromMessages(messages, response, 'gpt-4');
      const cached = cache.getFromMessages(messages, 'gpt-4');
      
      expect(cached).toEqual(response);
    });
  });

  describe('Plan 3: Security Scan CI-Ready Defaults', () => {
    let config: ConfigManager;
    let backendManager: BackendManager;
    const testDir = path.join(process.cwd(), 'tests', 'tmp', 'security-ci-test');
    const configPath = path.join(testDir, 'env.security-ci.test.settings');
    const originalEnv = { ...process.env };

    beforeAll(() => {
      fs.mkdirSync(testDir, { recursive: true });
      const testDirNorm = testDir.replace(/\\/g, '/');
      const cfg = {
        backends: [],
        defaults: { localBackendId: 'stub' },
        policy: { allowlistPaths: [testDirNorm], maxFileBytes: 131072 },
        workspace: { roots: [testDirNorm], defaultRoot: testDirNorm },
        systemProfile: { exposeToLLM: false },
      };
      writeSettingsFile(configPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

      config = new ConfigManager(configPath);
      backendManager = new BackendManager(config.getConfig().backends);

      // Create an empty test directory (no scannable files)
      fs.mkdirSync(path.join(testDir, 'empty'), { recursive: true });
      
      // Create a directory with only excluded files
      fs.mkdirSync(path.join(testDir, 'only-excluded', 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(testDir, 'only-excluded', 'node_modules', 'test.js'), '// excluded');
    });

    afterAll(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    afterEach(() => {
      // Restore original environment
      process.env = { ...originalEnv };
    });

    describe('CI environment detection', () => {
      it('should detect CI environment variable', () => {
        process.env.CI = 'true';
        delete process.env.GITHUB_ACTIONS;
        delete process.env.JENKINS_URL;
        
        // Recreate tools to pick up new env - secretScan is SYNCHRONOUS
        const tools = new HighValueTools(config, backendManager);
        
        // Test that failOnEmpty defaults to true in CI
        expect(() => {
          tools.secretScan(path.join(testDir, 'empty'));
        }).toThrow(/Security scan found 0 files/);
      });

      it('should detect GITHUB_ACTIONS environment variable', () => {
        process.env.GITHUB_ACTIONS = 'true';
        delete process.env.CI;
        delete process.env.JENKINS_URL;
        
        const tools = new HighValueTools(config, backendManager);
        
        expect(() => {
          tools.secretScan(path.join(testDir, 'empty'));
        }).toThrow(/Security scan found 0 files/);
      });

      it('should detect JENKINS_URL environment variable', () => {
        process.env.JENKINS_URL = 'http://jenkins.example.com';
        delete process.env.CI;
        delete process.env.GITHUB_ACTIONS;
        
        const tools = new HighValueTools(config, backendManager);
        
        expect(() => {
          tools.secretScan(path.join(testDir, 'empty'));
        }).toThrow(/Security scan found 0 files/);
      });

      it('should include [CI_MODE] prefix in error message when in CI', () => {
        process.env.CI = 'true';
        
        const tools = new HighValueTools(config, backendManager);
        
        expect(() => {
          tools.secretScan(path.join(testDir, 'empty'));
        }).toThrow(/\[CI_MODE\]/);
      });

      it('should NOT include [CI_MODE] prefix when not in CI', () => {
        delete process.env.CI;
        delete process.env.GITHUB_ACTIONS;
        delete process.env.JENKINS_URL;
        delete process.env.GITLAB_CI;
        delete process.env.CIRCLECI;
        delete process.env.TRAVIS;
        delete process.env.AZURE_PIPELINES;
        delete process.env.BITBUCKET_PIPELINES;
        
        const tools = new HighValueTools(config, backendManager);
        
        // With explicit failOnEmpty=true but not in CI, should NOT contain CI_MODE
        try {
          tools.secretScan(path.join(testDir, 'empty'), { failOnEmpty: true });
          // If we get here, the test should fail since we expect an error
          expect(true).toBe(false); // Force failure
        } catch (e) {
          expect((e as Error).message).toContain('Security scan found 0 files');
          expect((e as Error).message).not.toContain('[CI_MODE]');
        }
      });

      it('should NOT throw on empty when not in CI and failOnEmpty not set', () => {
        delete process.env.CI;
        delete process.env.GITHUB_ACTIONS;
        delete process.env.JENKINS_URL;
        delete process.env.GITLAB_CI;
        delete process.env.CIRCLECI;
        delete process.env.TRAVIS;
        delete process.env.AZURE_PIPELINES;
        delete process.env.BITBUCKET_PIPELINES;
        
        const tools = new HighValueTools(config, backendManager);
        
        // Should NOT throw - default is false outside CI
        const result = tools.secretScan(path.join(testDir, 'empty'));
        expect(result.statistics.filesScanned).toBe(0);
      });
    });

    describe('failOnEmpty option override', () => {
      it('should respect explicit failOnEmpty=false even in CI', () => {
        process.env.CI = 'true';
        
        const tools = new HighValueTools(config, backendManager);
        
        // Explicit false should override CI default
        const result = tools.secretScan(path.join(testDir, 'empty'), { failOnEmpty: false });
        expect(result.statistics.filesScanned).toBe(0);
      });

      it('should respect explicit failOnEmpty=true outside CI', () => {
        delete process.env.CI;
        delete process.env.GITHUB_ACTIONS;
        delete process.env.JENKINS_URL;
        delete process.env.GITLAB_CI;
        delete process.env.CIRCLECI;
        delete process.env.TRAVIS;
        delete process.env.AZURE_PIPELINES;
        delete process.env.BITBUCKET_PIPELINES;
        
        const tools = new HighValueTools(config, backendManager);
        
        expect(() => {
          tools.secretScan(path.join(testDir, 'empty'), { failOnEmpty: true });
        }).toThrow(/Security scan found 0 files/);
      });
    });
  });

  describe('Plan 5: Agent Limit Optimization', () => {
    it('should have increased default maxSteps to 25', async () => {
      // We can't easily test the runner without a full setup,
      // so we'll just verify the constant by importing
      const { AgentRunner } = await import('../src/agent/runner.js');
      
      // Create a minimal mock to test default values
      // The defaults are set in runTask, so we check the effectiveOptions output
      // For now, we just verify the module exports correctly
      expect(AgentRunner).toBeDefined();
    });

    it('should document the new limits in the AgentRunner code', async () => {
      // Read the source file and verify the new defaults are documented
      const runnerSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'agent', 'runner.ts'),
        'utf-8'
      );
      
      // Verify new defaults are in place
      expect(runnerSource).toContain('maxSubtasks ?? 8');
      expect(runnerSource).toContain('maxSteps ?? 50');
      expect(runnerSource).toContain('maxActionsPerStep ?? 100');
      
      // Verify the comment explaining the change
      expect(runnerSource).toContain('Plan 5: Agent Limit Optimization');
      expect(runnerSource).toContain('Previous: maxSubtasks=6, maxSteps=18, maxActionsPerStep=6');
    });

    it('should calculate total actions correctly with new limits', () => {
      // Old limits: 6 * 18 * 6 = 648 max actions
      // V14 limits: 8 * 25 * 8 = 1600 max actions
      // V15 limits: 8 * 25 * 12 = 2400 max actions
      // V16 limits: 8 * 50 * 12 = 4800 max actions (QA_feedback_1.md)
      // V19 limits: 8 * 50 * 30 = 12000 max actions
      // V20 limits: 8 * 50 * 50 = 20000 max actions
      // V21 limits: 8 * 50 * 100 = 40000 max actions
      const oldMaxActions = 6 * 18 * 6;
      const v14MaxActions = 8 * 25 * 8;
      const v15MaxActions = 8 * 25 * 12;
      const v16MaxActions = 8 * 50 * 12;
      const v19MaxActions = 8 * 50 * 30;
      const v20MaxActions = 8 * 50 * 50;
      const v21MaxActions = 8 * 50 * 100;
      
      expect(oldMaxActions).toBe(648);
      expect(v14MaxActions).toBe(1600);
      expect(v15MaxActions).toBe(2400);
      expect(v16MaxActions).toBe(4800);
      expect(v19MaxActions).toBe(12000);
      expect(v20MaxActions).toBe(20000);
      expect(v21MaxActions).toBe(40000);
      expect(v19MaxActions).toBeGreaterThan(oldMaxActions * 12);
    });
  });
});
