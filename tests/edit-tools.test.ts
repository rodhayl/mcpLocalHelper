import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ConfigManager } from '../src/config/index.js';
import { EditTools } from '../src/tools/edit.js';

// Test fixtures directory
const TEST_DIR = resolve('./tests/tmp/edit-test');
const BACKUP_DIR = join(TEST_DIR, '.mcp-backups');

describe('EditTools', () => {
  let config: ConfigManager;
  let editTools: EditTools;

  beforeAll(() => {
    // Create test directory structure
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    // Initialize config and edit tools for each test
    config = new ConfigManager();
    // Override workspace to point to test directory
    (config as any).config.workspace = { roots: [TEST_DIR], defaultRoot: TEST_DIR };
    (config as any).config.policy.allowlistPaths = [TEST_DIR];
    (config as any).config.editing = {
      enabled: true,
      backupEnabled: true,
      backupDir: '.mcp-backups',
      requirePreview: false,
      maxFileSize: 1048576,
    };

    editTools = new EditTools(config);
  });

  afterEach(() => {
    // Clean up test files but keep directory
    const files = ['test.ts', 'test.js', 'test.py', 'syntax-error.ts'];
    for (const file of files) {
      const path = join(TEST_DIR, file);
      if (existsSync(path)) {
        rmSync(path);
      }
    }
    // Clean up backups
    if (existsSync(BACKUP_DIR)) {
      rmSync(BACKUP_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // Helper to create absolute path
  const testPath = (name: string) => join(TEST_DIR, name);

  describe('validateSyntax', () => {
    it('should validate valid TypeScript syntax', () => {
      writeFileSync(
        testPath('test.ts'),
        `
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const result = greet("World");
`
      );

      const result = editTools.validateSyntax(testPath('test.ts'));

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.language).toBe('typescript');
    });

    it('should detect unclosed braces', () => {
      writeFileSync(
        testPath('test.ts'),
        `
function broken() {
  if (true) {
    console.log('unclosed');
  // missing closing brace
}
`
      );

      const result = editTools.validateSyntax(testPath('test.ts'));

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('unclosed'))).toBe(true);
    });

    it('should detect unclosed parentheses', () => {
      writeFileSync(
        testPath('test.ts'),
        `
const fn = (a, b => {
  return a + b;
};
`
      );

      const result = editTools.validateSyntax(testPath('test.ts'));

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('parenthesis'))).toBe(true);
    });

    it('should validate provided content instead of file', () => {
      writeFileSync(testPath('test.ts'), 'original content');

      const result = editTools.validateSyntax(
        testPath('test.ts'),
        `
function valid() {
  return true;
}
`
      );

      expect(result.valid).toBe(true);
    });

    it('should handle unsupported languages gracefully', () => {
      writeFileSync(testPath('test.py'), 'def foo():\n  pass');

      const result = editTools.validateSyntax(testPath('test.py'));

      // Python validation not supported, should return valid
      expect(result.valid).toBe(true);
      expect(result.language).toBe('python');
    });
  });

  describe('editFilePreview', () => {
    it('should preview a replace operation', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3
line 4
line 5`
      );

      const result = editTools.editFilePreview(
        testPath('test.ts'),
        'replace',
        2,
        3,
        'new line 2\nnew line 3'
      );

      expect(result.diff).toContain('-line 2');
      expect(result.diff).toContain('+new line 2');
      expect(result.linesAffected).toBe(2);
      expect(result.syntaxValid).toBe(true);
    });

    it('should preview an insert operation', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3`
      );

      const result = editTools.editFilePreview(
        testPath('test.ts'),
        'insert',
        2,
        undefined,
        'inserted line'
      );

      expect(result.diff).toContain('+inserted line');
      expect(result.linesAffected).toBe(1);
    });

    it('should preview a delete operation', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3
line 4`
      );

      const result = editTools.editFilePreview(testPath('test.ts'), 'delete', 2, 3);

      expect(result.diff).toContain('-line 2');
      expect(result.diff).toContain('-line 3');
      expect(result.linesAffected).toBe(2);
    });

    it('should detect syntax errors in preview result', () => {
      writeFileSync(
        testPath('test.ts'),
        `function foo() {
  return 1;
}
`
      );

      const result = editTools.editFilePreview(
        testPath('test.ts'),
        'replace',
        1,
        1,
        'function foo( {' // Missing closing paren
      );

      expect(result.syntaxValid).toBe(false);
      expect(result.warnings).toContain('Result has syntax errors');
    });

    it('should validate line numbers', () => {
      writeFileSync(testPath('test.ts'), 'line 1\nline 2');

      expect(() =>
        editTools.editFilePreview(testPath('test.ts'), 'replace', 100, 101, 'new')
      ).toThrow('Invalid start line');
    });
  });

  describe('editFile', () => {
    it('should apply a replace operation', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3`
      );

      const result = editTools.editFile(testPath('test.ts'), 'replace', 2, 2, 'replaced line 2');

      expect(result.success).toBe(true);
      expect(result.linesChanged).toBe(1);

      const content = readFileSync(testPath('test.ts'), 'utf-8');
      expect(content).toContain('replaced line 2');
      // Check that the original "line 2" is gone but "replaced line 2" is present
      const lines = content.split('\n');
      expect(lines[1]).toBe('replaced line 2');
      expect(lines).not.toContain('line 2'); // original line should be gone
    });

    it('should apply an insert operation', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2`
      );

      const result = editTools.editFile(
        testPath('test.ts'),
        'insert',
        1,
        undefined,
        'inserted after line 1'
      );

      expect(result.success).toBe(true);

      const content = readFileSync(testPath('test.ts'), 'utf-8');
      expect(content).toContain('line 1\ninserted after line 1\nline 2');
    });

    it('should apply a delete operation', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3
line 4`
      );

      const result = editTools.editFile(testPath('test.ts'), 'delete', 2, 3);

      expect(result.success).toBe(true);
      expect(result.linesChanged).toBe(2);

      const content = readFileSync(testPath('test.ts'), 'utf-8');
      expect(content).toBe('line 1\nline 4');
    });

    it('should create backup before editing', () => {
      writeFileSync(testPath('test.ts'), 'original content');

      const result = editTools.editFile(testPath('test.ts'), 'replace', 1, 1, 'new content');

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);

      // Backup should contain original content
      const backupContent = readFileSync(result.backupPath!, 'utf-8');
      expect(backupContent).toBe('original content');
    });

    it('should skip backup when requested', () => {
      writeFileSync(testPath('test.ts'), 'original content');

      const result = editTools.editFile(testPath('test.ts'), 'replace', 1, 1, 'new content', {
        skipBackup: true,
      });

      expect(result.success).toBe(true);
      expect(result.backupPath).toBeUndefined();
    });

    it('should fail on syntax error by default', () => {
      writeFileSync(
        testPath('test.ts'),
        `function foo() {
  return 1;
}`
      );

      const result = editTools.editFile(
        testPath('test.ts'),
        'replace',
        1,
        1,
        'function foo( {' // Invalid syntax
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Syntax validation failed');
    });

    it('should allow syntax errors when validation is skipped', () => {
      writeFileSync(testPath('test.ts'), 'valid content');

      const result = editTools.editFile(
        testPath('test.ts'),
        'replace',
        1,
        1,
        'function foo( {', // Invalid syntax
        { skipValidation: true }
      );

      expect(result.success).toBe(true);
    });

    it('should return diff in result', () => {
      writeFileSync(testPath('test.ts'), 'old content');

      const result = editTools.editFile(testPath('test.ts'), 'replace', 1, 1, 'new content');

      expect(result.diff).toContain('-old content');
      expect(result.diff).toContain('+new content');
    });
  });

  describe('applyDiffPreview', () => {
    it('should preview a valid diff', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3`
      );

      const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 line 1
-line 2
+changed line 2
 line 3`;

      const result = editTools.applyDiffPreview(testPath('test.ts'), diff);

      expect(result.canApply).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(result.resultPreview).toContain('changed line 2');
    });

    it('should detect conflicts in diff', () => {
      writeFileSync(
        testPath('test.ts'),
        `line 1
line 2
line 3`
      );

      const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 line 1
-wrong content
+changed line 2
 line 3`;

      const result = editTools.applyDiffPreview(testPath('test.ts'), diff);

      expect(result.canApply).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('multiFileEdit', () => {
    it('should edit multiple files', () => {
      writeFileSync(testPath('test.ts'), 'file 1 content');
      writeFileSync(testPath('test.js'), 'file 2 content');

      const result = editTools.multiFileEdit([
        {
          file_path: testPath('test.ts'),
          operation: 'replace',
          startLine: 1,
          endLine: 1,
          newContent: 'new file 1 content',
        },
        {
          file_path: testPath('test.js'),
          operation: 'replace',
          startLine: 1,
          endLine: 1,
          newContent: 'new file 2 content',
        },
      ]);

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(true);

      expect(readFileSync(testPath('test.ts'), 'utf-8')).toBe('new file 1 content');
      expect(readFileSync(testPath('test.js'), 'utf-8')).toBe('new file 2 content');
    });

    it('should rollback on failure in transactional mode', () => {
      writeFileSync(testPath('test.ts'), 'original ts content');
      writeFileSync(testPath('test.js'), 'original js content');

      const result = editTools.multiFileEdit(
        [
          {
            file_path: testPath('test.ts'),
            operation: 'replace',
            startLine: 1,
            endLine: 1,
            newContent: 'new ts content',
          },
          {
            file_path: testPath('nonexistent.ts'),
            operation: 'replace',
            startLine: 1,
            endLine: 1,
            newContent: 'will fail',
          },
        ],
        true
      ); // transactional

      expect(result.success).toBe(false);
      expect(result.rollbackPerformed).toBe(true);

      // First file should be rolled back
      expect(readFileSync(testPath('test.ts'), 'utf-8')).toBe('original ts content');
    });

    it('should continue on failure in non-transactional mode', () => {
      writeFileSync(testPath('test.ts'), 'original ts content');
      writeFileSync(testPath('test.js'), 'original js content');

      const result = editTools.multiFileEdit(
        [
          {
            file_path: testPath('test.ts'),
            operation: 'replace',
            startLine: 1,
            endLine: 1,
            newContent: 'new ts content',
          },
          {
            file_path: testPath('nonexistent.ts'),
            operation: 'replace',
            startLine: 1,
            endLine: 1,
            newContent: 'will fail',
          },
          {
            file_path: testPath('test.js'),
            operation: 'replace',
            startLine: 1,
            endLine: 1,
            newContent: 'new js content',
          },
        ],
        false
      ); // non-transactional

      expect(result.success).toBe(false);
      expect(result.rollbackPerformed).toBe(false);

      // First and third should succeed
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
      expect(result.results[2].success).toBe(true);

      expect(readFileSync(testPath('test.ts'), 'utf-8')).toBe('new ts content');
      expect(readFileSync(testPath('test.js'), 'utf-8')).toBe('new js content');
    });
  });

  describe('audit log', () => {
    it('should log operations', () => {
      writeFileSync(testPath('test.ts'), 'content');

      editTools.editFile(testPath('test.ts'), 'replace', 1, 1, 'new content');

      const log = editTools.getAuditLog();
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].operation).toContain('replace');
      expect(log[0].file).toContain('test.ts');
      expect(log[0].success).toBe(true);
    });
  });

  describe('restoreFromBackup', () => {
    it('should restore file from backup', () => {
      writeFileSync(testPath('test.ts'), 'original content');

      // Make an edit to create backup
      const editResult = editTools.editFile(testPath('test.ts'), 'replace', 1, 1, 'new content');

      expect(editResult.backupPath).toBeDefined();

      // Restore from backup
      const restored = editTools.restoreFromBackup(editResult.backupPath!, testPath('test.ts'));

      expect(restored).toBe(true);
      expect(readFileSync(testPath('test.ts'), 'utf-8')).toBe('original content');
    });
  });

  describe('edge cases', () => {
    it('should handle empty files', () => {
      writeFileSync(testPath('test.ts'), '');

      const result = editTools.editFile(testPath('test.ts'), 'insert', 1, undefined, 'first line');

      expect(result.success).toBe(true);
    });

    it('should handle files with only whitespace', () => {
      writeFileSync(testPath('test.ts'), '   \n   \n   ');

      const result = editTools.editFile(testPath('test.ts'), 'replace', 1, 3, 'content');

      expect(result.success).toBe(true);
    });

    it('should reject edits to disallowed paths', () => {
      // Try to edit a file outside the allowed workspace
      expect(() => editTools.editFile('/etc/passwd', 'replace', 1, 1, 'hack')).toThrow(); // Just check that it throws
    });

    it('should error when editing is disabled', () => {
      (config as any).config.editing.enabled = false;
      editTools = new EditTools(config);

      writeFileSync(testPath('test.ts'), 'content');

      expect(() => editTools.editFilePreview(testPath('test.ts'), 'replace', 1, 1, 'new')).toThrow(
        'Editing is disabled'
      );
    });
  });
});
