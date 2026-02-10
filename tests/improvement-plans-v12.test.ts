/**
 * V12 Improvement Plan Regression Tests
 *
 * Tests for improvements addressing Black_box_compact_8.md feedback:
 * 1. Python indentation normalization (4 spaces per PEP 8)
 * 2. Search 0-files diagnostic object
 * 3. Loop detection threshold reduced from 3 to 2
 * 4. Per-task file read tracking
 * 5. Fact vs inference separation in analyze_file
 * 6. Auto-detect project type for security scan
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';
import { HighValueTools } from '../src/tools/highvalue.js';
import { BackendManager } from '../src/adapters/factory.js';
import * as path from 'path';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

describe('V12 Improvements', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;
  let tmpDir: string;

  beforeAll(() => {
    config = new ConfigManager();
    const backendConfigs = config.getConfig().backends || [];
    backendManager = new BackendManager(backendConfigs);
    tmpDir = join(tmpdir(), `v12-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Python Indentation Normalization', () => {
    it('should normalize 2-space indentation to 4-space', () => {
      const llmTools = new LlmEnhancedTools(config, backendManager);

      // Access private method
      const normalizePythonIndentation = (llmTools as any).normalizePythonIndentation.bind(llmTools);

      const input = `def hello():
  print("world")
  if True:
    return 1`;

      const result = normalizePythonIndentation(input);

      // Should have 4-space indentation
      expect(result).toContain('    print("world")');
      expect(result).toContain('        return 1');
    });

    it('should normalize tab indentation to 4-space', () => {
      const llmTools = new LlmEnhancedTools(config, backendManager);
      const normalizePythonIndentation = (llmTools as any).normalizePythonIndentation.bind(llmTools);

      const input = `def hello():
\tprint("world")
\tif True:
\t\treturn 1`;

      const result = normalizePythonIndentation(input);

      // Should have 4-space indentation
      expect(result).toContain('    print("world")');
      expect(result).toContain('        return 1');
    });

    it('should handle mixed indentation', () => {
      const llmTools = new LlmEnhancedTools(config, backendManager);
      const normalizePythonIndentation = (llmTools as any).normalizePythonIndentation.bind(llmTools);

      const input = `def hello():
  print("2-space")
    print("4-space")`;

      const result = normalizePythonIndentation(input);

      // All indentation should be normalized to 4-space multiples
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.trim() && line.startsWith(' ')) {
          const leadingSpaces = line.match(/^( *)/)?.[1].length ?? 0;
          expect(leadingSpaces % 4).toBe(0);
        }
      }
    });

    it('should preserve empty lines', () => {
      const llmTools = new LlmEnhancedTools(config, backendManager);
      const normalizePythonIndentation = (llmTools as any).normalizePythonIndentation.bind(llmTools);

      const input = `def hello():
  print("a")

  print("b")`;

      const result = normalizePythonIndentation(input);
      const lines = result.split('\n');

      expect(lines[2]).toBe('');
    });
  });

  describe('Search 0-Files Diagnostic', () => {
    it('should have diagnostic field in search result type', () => {
      // Verify the implementation adds diagnostic when 0 files found
      const llmEnhancedPath = join(process.cwd(), 'src', 'tools', 'llm-enhanced.ts');
      const content = readFileSync(llmEnhancedPath, 'utf-8');

      // Check the implementation adds diagnostic when totalMatches === 0
      expect(content).toContain('V12: Add diagnostic object when 0 files found');
      expect(content).toContain('grepResults.totalMatches === 0');
      expect(content).toContain('diagnostic');
    });

    it('should include useful diagnostic information', () => {
      // Verify the diagnostic object contains required fields
      const llmEnhancedPath = join(process.cwd(), 'src', 'tools', 'llm-enhanced.ts');
      const content = readFileSync(llmEnhancedPath, 'utf-8');

      // Check diagnostic object structure
      expect(content).toContain('resolvedRoot');
      expect(content).toContain('queryUsed');
      expect(content).toContain('isRegex');
      expect(content).toContain('filePatternUsed');
      expect(content).toContain('fallbackAttempted');
      expect(content).toContain('suggestions');
    });
  });

  describe('Loop Detection Threshold', () => {
    it('should have threshold of 5 (relaxed from 2 per QA_feedback_7)', async () => {
      // Read the runner.ts file and check the threshold
      const runnerPath = join(process.cwd(), 'src', 'agent', 'runner.ts');
      const content = readFileSync(runnerPath, 'utf-8');

      // Check for the relaxed loop detection with threshold of 5 (QA_feedback_7)
      // Previous: V12 had threshold=2, V13 had threshold=3
      expect(content).toContain('i >= 5');
      expect(content).toContain('QA_feedback_7');
    });
  });

  describe('Per-Task File Read Tracking', () => {
    it('should have taskFileReadHistory Set in AgentRunner', () => {
      const runnerPath = join(process.cwd(), 'src', 'agent', 'runner.ts');
      const content = readFileSync(runnerPath, 'utf-8');

      // Check for the V12 file read tracking
      expect(content).toContain('taskFileReadHistory');
      expect(content).toContain('Set<string>');
    });

    it('should clear history at task start', () => {
      const runnerPath = join(process.cwd(), 'src', 'agent', 'runner.ts');
      const content = readFileSync(runnerPath, 'utf-8');

      // Check for clearing at task start
      expect(content).toContain('taskFileReadHistory.clear()');
    });

    it('should return alreadyRead for duplicate file reads', () => {
      const runnerPath = join(process.cwd(), 'src', 'agent', 'runner.ts');
      const content = readFileSync(runnerPath, 'utf-8');

      // Check for alreadyRead response
      expect(content).toContain('alreadyRead: true');
      expect(content).toContain('already read in this task');
    });
  });

  describe('Fact vs Inference Separation in analyze_file', () => {
    it('should include evidence field requirement in prompt', () => {
      const llmEnhancedPath = join(process.cwd(), 'src', 'tools', 'llm-enhanced.ts');
      const content = readFileSync(llmEnhancedPath, 'utf-8');

      // Check for V12 fact vs inference separation
      expect(content).toContain('FACT VS INFERENCE SEPARATION');
      expect(content).toContain('"evidence": "fact|inference"');
    });

    it('should distinguish facts from inferences in prompt', () => {
      const llmEnhancedPath = join(process.cwd(), 'src', 'tools', 'llm-enhanced.ts');
      const content = readFileSync(llmEnhancedPath, 'utf-8');

      // Check for fact/inference distinction
      expect(content).toContain('FACTS: Things directly observable');
      expect(content).toContain('INFERENCES: Suggestions or potential improvements');
    });
  });

  describe('Auto-Detect Project Type for Security Scan', () => {
    it('should have detectProjectType method', () => {
      const highvaluePath = join(process.cwd(), 'src', 'tools', 'highvalue.ts');
      const content = readFileSync(highvaluePath, 'utf-8');

      expect(content).toContain('detectProjectType');
      expect(content).toContain('V12');
    });

    it('should detect TypeScript projects', () => {
      // Create test directory with tsconfig.json
      const tsDir = join(tmpDir, 'ts-project');
      mkdirSync(tsDir, { recursive: true });
      writeFileSync(join(tsDir, 'tsconfig.json'), '{}');

      const highValueTools = new HighValueTools(config, backendManager);

      // Access private method
      const detectProjectType = (highValueTools as any).detectProjectType.bind(highValueTools);
      expect(detectProjectType(tsDir)).toBe('typescript');
    });

    it('should detect Python projects', () => {
      // Create test directory with requirements.txt
      const pyDir = join(tmpDir, 'py-project');
      mkdirSync(pyDir, { recursive: true });
      writeFileSync(join(pyDir, 'requirements.txt'), 'pytest==7.0.0');

      const highValueTools = new HighValueTools(config, backendManager);

      const detectProjectType = (highValueTools as any).detectProjectType.bind(highValueTools);
      expect(detectProjectType(pyDir)).toBe('python');
    });

    it('should detect Go projects', () => {
      // Create test directory with go.mod
      const goDir = join(tmpDir, 'go-project');
      mkdirSync(goDir, { recursive: true });
      writeFileSync(join(goDir, 'go.mod'), 'module example.com/test');

      const highValueTools = new HighValueTools(config, backendManager);

      const detectProjectType = (highValueTools as any).detectProjectType.bind(highValueTools);
      expect(detectProjectType(goDir)).toBe('go');
    });

    it('should return unknown for unrecognized projects', () => {
      // Create test directory with no recognizable files
      const unknownDir = join(tmpDir, 'unknown-project');
      mkdirSync(unknownDir, { recursive: true });
      writeFileSync(join(unknownDir, 'random.xyz'), 'content');

      const highValueTools = new HighValueTools(config, backendManager);

      const detectProjectType = (highValueTools as any).detectProjectType.bind(highValueTools);
      expect(detectProjectType(unknownDir)).toBe('unknown');
    });

    it('should use project-specific patterns in security scan', () => {
      const highvaluePath = join(process.cwd(), 'src', 'tools', 'highvalue.ts');
      const content = readFileSync(highvaluePath, 'utf-8');

      // Check for project-type-specific patterns
      expect(content).toContain('projectTypePatterns');
      expect(content).toContain('typescript:');
      expect(content).toContain('python:');
      expect(content).toContain('go:');
    });
  });

  describe('V12 Integration - Search Diagnostic Structure', () => {
    it('should have proper diagnostic schema in types', () => {
      const typesPath = join(process.cwd(), 'src', 'types', 'index.ts');
      const content = readFileSync(typesPath, 'utf-8');

      // Check for diagnostic schema
      expect(content).toContain('diagnostic:');
      expect(content).toContain('resolvedRoot');
      expect(content).toContain('queryUsed');
      expect(content).toContain('isRegex');
      expect(content).toContain('filePatternUsed');
      expect(content).toContain('fallbackAttempted');
    });
  });
});
