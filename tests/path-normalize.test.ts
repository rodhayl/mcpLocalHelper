/**
 * Path Normalization Tests
 * 
 * Verifies the path normalization utility works correctly across platforms.
 * Critical for fixing the intelligent search empty results bug on Windows.
 */

import { describe, it, expect } from 'vitest';
import { 
  toForwardSlashes, 
  normalizePathKey, 
  normalizeRelativePath,
  pathsEqual 
} from '../src/utils/path-normalize';

describe('Path Normalization Utility', () => {
  describe('toForwardSlashes', () => {
    it('should convert backslashes to forward slashes', () => {
      expect(toForwardSlashes('src\\tools\\file.ts')).toBe('src/tools/file.ts');
    });

    it('should handle Windows absolute paths', () => {
      expect(toForwardSlashes('C:\\Users\\name\\file.ts')).toBe('C:/Users/name/file.ts');
    });

    it('should leave forward slashes unchanged', () => {
      expect(toForwardSlashes('already/forward/slashes')).toBe('already/forward/slashes');
    });

    it('should handle mixed slashes', () => {
      expect(toForwardSlashes('src\\mixed/path\\file.ts')).toBe('src/mixed/path/file.ts');
    });

    it('should handle empty string', () => {
      expect(toForwardSlashes('')).toBe('');
    });

    it('should handle null/undefined gracefully', () => {
      expect(toForwardSlashes(null as any)).toBe(null);
      expect(toForwardSlashes(undefined as any)).toBe(undefined);
    });
  });

  describe('normalizePathKey', () => {
    it('should normalize and lowercase paths', () => {
      expect(normalizePathKey('src\\Tools\\File.ts')).toBe('src/tools/file.ts');
    });

    it('should handle already lowercase paths', () => {
      expect(normalizePathKey('src/tools/file.ts')).toBe('src/tools/file.ts');
    });
  });

  describe('normalizeRelativePath', () => {
    it('should remove leading ./', () => {
      expect(normalizeRelativePath('./src/file.ts')).toBe('src/file.ts');
    });

    it('should handle Windows-style leading .\\', () => {
      expect(normalizeRelativePath('.\\src\\file.ts')).toBe('src/file.ts');
    });

    it('should handle paths without leading ./', () => {
      expect(normalizeRelativePath('src/file.ts')).toBe('src/file.ts');
    });
  });

  describe('pathsEqual', () => {
    it('should match paths with different slash directions', () => {
      expect(pathsEqual('src\\file.ts', 'src/file.ts')).toBe(true);
    });

    it('should match paths with different cases (Windows-safe)', () => {
      expect(pathsEqual('SRC/File.ts', 'src/file.ts')).toBe(true);
    });

    it('should not match different paths', () => {
      expect(pathsEqual('src/file.ts', 'src/other.ts')).toBe(false);
    });

    it('should handle null values', () => {
      expect(pathsEqual(null as any, null as any)).toBe(true);
      expect(pathsEqual('file.ts', null as any)).toBe(false);
    });
  });
});

describe('Path Normalization Integration', () => {
  it('should ensure fileMatches Map keys match LLM ranking.file', () => {
    // Simulate what happens in intelligentSearch:
    // 1. grepRepoV2 returns paths with native separators (backslashes on Windows)
    // 2. LLM returns paths with forward slashes
    // 3. fileMatches.get(ranking.file) must find the match
    
    const windowsPath = 'src\\tools\\llm-enhanced.ts';
    const llmPath = 'src/tools/llm-enhanced.ts';
    
    // After normalization, they should be equal
    const normalizedWindowsPath = toForwardSlashes(windowsPath);
    const normalizedLlmPath = toForwardSlashes(llmPath);
    
    expect(normalizedWindowsPath).toBe(normalizedLlmPath);
    
    // Simulate Map lookup
    const fileMatches = new Map<string, string[]>();
    fileMatches.set(normalizedWindowsPath, ['match1', 'match2']);
    
    // LLM path should find the matches
    expect(fileMatches.get(normalizedLlmPath)).toEqual(['match1', 'match2']);
  });
});
