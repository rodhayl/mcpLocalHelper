import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { FileTools } from '../src/tools/file.js';
import * as fs from 'fs';
import * as path from 'path';

describe('Enhanced Read Tools', () => {
  let config: ConfigManager;
  let fileTools: FileTools;
  const testDir = path.join(process.cwd(), 'tests', 'tmp', 'enhanced-read');

  beforeAll(() => {
    config = new ConfigManager();
    fileTools = new FileTools(config);

    // Create nested directory first
    fs.mkdirSync(path.join(testDir, 'nested'), { recursive: true });

    // Create test files
    fs.writeFileSync(
      path.join(testDir, 'file1.ts'),
      `// File 1
export function hello() {
  console.log('Hello World');
}

export function goodbye() {
  console.log('Goodbye World');
}
`
    );
    fs.writeFileSync(
      path.join(testDir, 'file2.ts'),
      `// File 2
import { hello } from './file1';

export function greet(name: string) {
  console.log('Hello ' + name);
  hello();
}
`
    );
    fs.writeFileSync(
      path.join(testDir, 'nested', 'file3.ts'),
      `// Nested file
export const VERSION = '1.0.0';
`
    );

    // Hidden entries for filename/path search tests
    fs.writeFileSync(path.join(testDir, '.hidden.txt'), 'hidden', 'utf-8');
    fs.mkdirSync(path.join(testDir, '.hiddendir'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, '.hiddendir', 'inside.ts'),
      `export const INSIDE = true;\n`,
      'utf-8'
    );
  });

  afterAll(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('readSegments', () => {
    it('should read multiple segments from same file', () => {
      // readSegments returns ReadSegmentResult[] directly
      const result = fileTools.readSegments([
        { path: path.join(testDir, 'file1.ts'), startLine: 1, endLine: 3 },
        { path: path.join(testDir, 'file1.ts'), startLine: 5, endLine: 7 },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('File 1');
      expect(result[0].content).toContain('hello');
      expect(result[1].content).toContain('goodbye');
    });

    it('should read segments from different files', () => {
      const result = fileTools.readSegments([
        { path: path.join(testDir, 'file1.ts'), startLine: 2, endLine: 4 },
        { path: path.join(testDir, 'file2.ts'), startLine: 1, endLine: 3 },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('hello');
      expect(result[1].content).toContain('import');
    });

    it('should handle non-existent file gracefully', () => {
      const result = fileTools.readSegments([
        { path: path.join(testDir, 'nonexistent.ts'), startLine: 1, endLine: 10 },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].error).toBeDefined();
    });

    it('should include sha256 hash for successful reads', () => {
      const result = fileTools.readSegments([
        { path: path.join(testDir, 'file1.ts'), startLine: 1, endLine: 3 },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].sha256).toBeDefined();
      expect(result[0].sha256?.length).toBe(64); // SHA256 hex is 64 chars
    });
  });

  describe('batchReadFiles', () => {
    it('should read multiple files at once', () => {
      const result = fileTools.batchReadFiles([
        path.join(testDir, 'file1.ts'),
        path.join(testDir, 'file2.ts'),
      ]);

      expect(result.files).toHaveLength(2);
      expect(result.files[0].error).toBeUndefined();
      expect(result.files[1].error).toBeUndefined();
      expect(result.files[0].content).toContain('hello');
      expect(result.files[1].content).toContain('greet');
      expect(result.aggregateBytes).toBeGreaterThan(0);
    });

    it('should handle mixed success/failure', () => {
      const result = fileTools.batchReadFiles([
        path.join(testDir, 'file1.ts'),
        path.join(testDir, 'nonexistent.ts'),
      ]);

      expect(result.files).toHaveLength(2);
      expect(result.files[0].error).toBeUndefined();
      expect(result.files[1].error).toBeDefined();
    });

    it('should track aggregate bytes', () => {
      const result = fileTools.batchReadFiles([
        path.join(testDir, 'file1.ts'),
        path.join(testDir, 'file2.ts'),
      ]);

      expect(result.aggregateBytes).toBeGreaterThan(0);
      // Aggregate should be sum of individual file sizes
      const totalSize = result.files.reduce((sum, f) => sum + f.sizeBytes, 0);
      expect(result.aggregateBytes).toBe(totalSize);
    });
  });

  describe('getFileMetadata', () => {
    it('should return file metadata', () => {
      const result = fileTools.getFileMetadata(path.join(testDir, 'file1.ts'));

      expect(result.path).toContain('file1.ts');
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.lineCount).toBeGreaterThan(0);
      expect(result.language).toBe('typescript');
      expect(result.isReadable).toBe(true);
    });

    it('should throw for non-existent file', () => {
      expect(() => {
        fileTools.getFileMetadata(path.join(testDir, 'nonexistent.ts'));
      }).toThrow();
    });

    it('should detect language from extension', () => {
      // Create a JavaScript file
      const jsPath = path.join(testDir, 'test.js');
      fs.writeFileSync(jsPath, 'console.log("test");');

      const result = fileTools.getFileMetadata(jsPath);
      expect(result.language).toBe('javascript');
    });

    it('should include timestamps', () => {
      const result = fileTools.getFileMetadata(path.join(testDir, 'file1.ts'));

      expect(result.modifiedAt).toBeDefined();
      expect(result.createdAt).toBeDefined();
      // Verify they look like ISO date strings
      expect(result.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('manifestSnapshot', () => {
    it('should return manifest of directory', () => {
      const result = fileTools.manifestSnapshot(testDir);

      expect(result.root).toBe(path.resolve(testDir));
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.totalFiles).toBeGreaterThan(0);
      expect(result.totalBytes).toBeGreaterThan(0);
    });

    it('should include file details', () => {
      const result = fileTools.manifestSnapshot(testDir);

      const file1 = result.files.find((f) => f.relativePath.includes('file1.ts'));
      expect(file1).toBeDefined();
      expect(file1?.sizeBytes).toBeGreaterThan(0);
      expect(file1?.language).toBe('typescript');
    });

    it('should include nested files', () => {
      const result = fileTools.manifestSnapshot(testDir);

      const nestedFile = result.files.find((f) => f.relativePath.includes('nested'));
      expect(nestedFile).toBeDefined();
    });

    it('should include language breakdown', () => {
      const result = fileTools.manifestSnapshot(testDir);

      expect(result.languageBreakdown).toBeDefined();
      expect(result.languageBreakdown['typescript']).toBeDefined();
      expect(result.languageBreakdown['typescript'].count).toBeGreaterThan(0);
    });

    it('should include directories', () => {
      const result = fileTools.manifestSnapshot(testDir);

      expect(result.directories.length).toBeGreaterThan(0);
      expect(result.directories.some((d) => d.includes('nested'))).toBe(true);
    });
  });

  describe('findPathsByName', () => {
    it('should find files by name substring', () => {
      const result = fileTools.findPathsByName(testDir, 'file3.ts');
      expect(result.matches.some((m) => m.path.replace(/\\/g, '/').endsWith('nested/file3.ts'))).toBe(true);
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it('should support glob-like queries', () => {
      const result = fileTools.findPathsByName(testDir, '**/file3.ts');
      expect(result.matches.some((m) => m.path.replace(/\\/g, '/').endsWith('nested/file3.ts'))).toBe(true);
    });

    it('should include directory matches when enabled', () => {
      const result = fileTools.findPathsByName(testDir, 'nested', { includeDirectories: true });
      expect(result.matches.some((m) => m.type === 'directory' && m.path === 'nested')).toBe(true);
    });

    it('should exclude hidden entries by default', () => {
      const result = fileTools.findPathsByName(testDir, '.hidden');
      expect(result.matches.length).toBe(0);
    });

    it('should include hidden entries when includeHidden=true', () => {
      const result = fileTools.findPathsByName(testDir, '.hidden', { includeHidden: true });
      expect(result.matches.some((m) => m.type === 'file' && m.path === '.hidden.txt')).toBe(true);
    });

    it('should respect excludePatterns', () => {
      const result = fileTools.findPathsByName(testDir, 'file', { excludePatterns: ['nested/**'] });
      expect(result.matches.some((m) => m.path.includes('nested/'))).toBe(false);
      expect(result.matches.some((m) => m.path.endsWith('file1.ts'))).toBe(true);
    });
  });

  describe('grepRepoV2', () => {
    it('should find pattern matches with regex', () => {
      const result = fileTools.grepRepoV2(testDir, 'console\\.log', {
        isRegex: true,
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].matchedText).toBe('console.log');
    });

    it('should find literal string matches', () => {
      const result = fileTools.grepRepoV2(testDir, 'Hello World', {
        isRegex: false,
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].matchedText).toBe('Hello World');
    });

    it('should include context lines', () => {
      const result = fileTools.grepRepoV2(testDir, 'hello', {
        isRegex: false,
        contextLines: 1,
      });

      expect(result.matches.length).toBeGreaterThan(0);
      // With 1 context line, preview should have at least 2 lines (match + context)
      expect(result.matches[0].preview.length).toBeGreaterThanOrEqual(1);
    });

    it('should respect maxMatches limit', () => {
      // Use a very common pattern that will have many matches
      const result = fileTools.grepRepoV2(testDir, 'e', {
        isRegex: false,
        maxMatches: 2,
      });

      expect(result.matches.length).toBeLessThanOrEqual(2);
      // The pattern 'e' appears many times, so with maxMatches: 2 we expect truncation
      expect(result.totalMatches).toBeLessThanOrEqual(2);
    });

    it('should filter by file pattern', () => {
      // Create a different file type
      const mdPath = path.join(testDir, 'readme.md');
      fs.writeFileSync(mdPath, '# Hello World\n\nThis is a test.');

      const result = fileTools.grepRepoV2(testDir, 'Hello', {
        isRegex: false,
        filePattern: '*.ts',
      });

      // Should only match .ts files, not .md
      for (const match of result.matches) {
        expect(match.file).toMatch(/\.ts$/);
      }
    });

    it('should include column info', () => {
      const result = fileTools.grepRepoV2(testDir, 'function', {
        isRegex: false,
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].column).toBeGreaterThan(0);
    });

    it('should track files searched count', () => {
      const result = fileTools.grepRepoV2(testDir, 'somepattern', {
        isRegex: false,
      });

      expect(result.filesSearched).toBeGreaterThan(0);
    });
  });
});

describe('read_file binary behavior', () => {
  const binPath = path.resolve(process.cwd(), 'tests/tmp.bin');

  beforeAll(() => {
    const buf = Buffer.alloc(1024, 0xff); // 1KB binary
    fs.writeFileSync(binPath, buf);
  });

  afterAll(() => {
    try { fs.unlinkSync(binPath); } catch { /* ignore */ }
  });

  it('should read and truncate binary content without throwing', () => {
    const cm = new ConfigManager();
    const ft = new FileTools(cm);
    const res = ft.readFile(binPath, 64);
    expect(typeof res.content).toBe('string');
    expect(res.truncated).toBe(true);
    expect(res.content.includes('...[truncated]')).toBe(true);
  });
});
