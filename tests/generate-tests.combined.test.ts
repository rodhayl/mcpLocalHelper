/**
 * Combined generate_tests Tests
 * 
 * Merged from:
 * - generate-tests.python-fixes.test.ts - Python import fixing, literals, collapsed lines
 * - generate-tests.quality.test.ts - HTML entity decoding, class name sanitization, import syntax
 * - generate-tests.validation.unit.test.ts - Missing imports detection, validation
 * 
 * QA issues covered:
 * - QA_feedback_22012026: Python generated tests contain syntax errors
 * - QA_feedback_9: Prevent regressions in test generation quality
 * - QA_feedback_10: Class name sanitization
 * - QA_feedback_11: Python import .py pattern
 * - QA_feedback_1: Missing Python imports and undefined variables
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { LlmEnhancedTools } from '../src/tools/llm-enhanced.js';
import { loadCentralConfigJson, writeSettingsFile } from './test-utils/settings.js';

// ============================================================================
// SECTION 1: Python Code Fixing (from generate-tests.python-fixes.test.ts)
// ============================================================================

describe('Python Code Fixing in generate_tests', () => {
  let LlmEnhancedToolsCls: any;
  let toolsInstance: any;
  
  beforeAll(async () => {
    const module = await import('../src/tools/llm-enhanced.js');
    LlmEnhancedToolsCls = module.LlmEnhancedTools;
    toolsInstance = Object.create(LlmEnhancedToolsCls.prototype);
  });
  
  describe('fixMergedPythonImports', () => {
    it('should fix "import types import pytest" merged onto one line', () => {
      const input = 'import types import pytest';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('import types\nimport pytest');
    });

    it('should fix multiple import statements merged together', () => {
      const input = 'import os import sys import re';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('import os\nimport sys\nimport re');
    });

    it('should fix from...import merged with another import', () => {
      const input = 'from pathlib import Path import pytest';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('from pathlib import Path\nimport pytest');
    });

    it('should fix from...import merged with from...import', () => {
      const input = 'from foo import bar from baz import qux';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('from foo import bar\nfrom baz import qux');
    });

    it('should fix import followed by from...import', () => {
      const input = 'import os from pathlib import Path';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('import os\nfrom pathlib import Path');
    });

    it('should preserve proper imports on separate lines', () => {
      const input = 'import os\nimport sys\nfrom pathlib import Path';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('import os\nimport sys\nfrom pathlib import Path');
    });

    it('should preserve indentation for nested imports', () => {
      const input = '    import types import pytest';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('    import types\n    import pytest');
    });

    it('should handle comma-separated imports correctly (not split)', () => {
      const input = 'from typing import List, Dict, Optional';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('from typing import List, Dict, Optional');
    });

    it('should not modify non-import lines', () => {
      const input = 'def test_function():\n    x = import_value\n    return x';
      const result = toolsInstance.fixMergedPythonImports(input);
      expect(result).toBe('def test_function():\n    x = import_value\n    return x');
    });
  });

  describe('fixPythonLiterals', () => {
    it('should convert JavaScript true to Python True', () => {
      const input = 'assert result == true';
      const result = toolsInstance.fixPythonLiterals(input);
      expect(result).toContain('True');
      expect(result).not.toContain('true');
    });

    it('should convert JavaScript false to Python False', () => {
      const input = 'is_valid = false';
      const result = toolsInstance.fixPythonLiterals(input);
      expect(result).toContain('False');
      expect(result).not.toContain('false');
    });

    it('should convert JavaScript null to Python None', () => {
      const input = 'result = null';
      const result = toolsInstance.fixPythonLiterals(input);
      expect(result).toContain('None');
    });

    it('should not modify literals inside strings', () => {
      const input = 'message = "This is true and false"';
      const result = toolsInstance.fixPythonLiterals(input);
      expect(result).toBe('message = "This is true and false"');
    });

    it('should handle multiple literals on one line', () => {
      const input = 'if result == true and error == false and value != null:';
      const result = toolsInstance.fixPythonLiterals(input);
      expect(result).toContain('True');
      expect(result).toContain('False');
      expect(result).toContain('None');
    });
  });

  describe('repairCollapsedPythonLines', () => {
    it('should split def with inline code', () => {
      const input = 'def test_foo():assert True';
      const result = toolsInstance.repairCollapsedPythonLines(input);
      expect(result).toContain('def test_foo():');
      expect(result).toContain('assert True');
      expect(result.split('\n').length).toBeGreaterThan(1);
    });

    it('should split class with inline def', () => {
      const input = 'class TestClass:def test_method(self):pass';
      const result = toolsInstance.repairCollapsedPythonLines(input);
      expect(result).toContain('class TestClass:');
      expect(result).toContain('def test_method');
    });
  });
});

describe('generateTests Python newline repair (unit)', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(() => {
    const base = join(process.cwd(), 'tests', 'tmp');
    mkdirSync(base, { recursive: true });
    tempDir = mkdtempSync(join(base, 'generate-tests-py-repair-'));
    configPath = join(tempDir, 'env.test.settings');

    const root = tempDir.replace(/\\/g, '/');
    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.workspace = { roots: [root], defaultRoot: root };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [root], maxFileBytes: 65536 };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
    cfg.backends = [
      {
        id: 'stub',
        type: 'stub',
        base_url: 'http://127.0.0.1:1',
        model: 'stub-model',
        labels: { priority: 'primary' },
      },
    ];
    cfg.defaults = { ...(cfg.defaults || {}), localBackendId: 'stub', sotaBackendId: 'stub' };

    writeSettingsFile(configPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'example.py'),
      'def add(a, b):\n    return a + b\n',
      'utf-8'
    );
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('should fix "import pytestdef" concatenation into a valid import + def', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({
        message: {
          content:
            '```python\n' +
            'import pytestdef test_example():\n' +
            '    assert True\n' +
            '```\n',
        },
      })),
    };

    (tools as any).getPythonSyntaxErrorSummary = vi.fn(async () => null);
    (tools as any).formatPythonWithBlack = vi.fn(async (code: string) => ({ code, formatted: false }));

    const result = await tools.generateTests(join(tempDir, 'src', 'example.py'), {
      coverage: 'basic',
      framework: 'pytest',
    });

    expect(result.success).toBe(true);
    expect(result.tests).toContain('import pytest');
    expect(result.tests).toContain('def test_example');
    expect(result.tests).not.toContain('import pytestdef');
  });
});

// ============================================================================
// SECTION 2: Quality Regression Tests (from generate-tests.quality.test.ts)
// ============================================================================

describe('generate_tests Quality (Unit)', () => {
  let llmEnhancedTools: LlmEnhancedTools;

  beforeAll(() => {
    const config = new ConfigManager();
    const backendManager = new BackendManager(config.getConfig().backends);
    llmEnhancedTools = new LlmEnhancedTools(config, backendManager);
  });

  describe('HTML Entity Decoding', () => {
    it('should decode &quot; to double quote', () => {
      const input = 'assert result == &quot;expected&quot;';
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe('assert result == "expected"');
      expect(decoded).not.toContain('&quot;');
    });

    it('should decode &#x3D; to equals sign', () => {
      const input = 'value &#x3D; 42';
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe('value = 42');
      expect(decoded).not.toContain('&#x3D;');
    });

    it('should decode &amp; to ampersand', () => {
      const input = 'a &amp;&amp; b';
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe('a && b');
      expect(decoded).not.toContain('&amp;');
    });

    it('should decode &lt; and &gt; to angle brackets', () => {
      const input = 'List&lt;str&gt;';
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe('List<str>');
      expect(decoded).not.toContain('&lt;');
      expect(decoded).not.toContain('&gt;');
    });

    it('should decode &apos; to single quote', () => {
      const input = "don&apos;t";
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe("don't");
      expect(decoded).not.toContain('&apos;');
    });

    it('should decode numeric entities &#39; and &#34;', () => {
      const input = '&#34;hello&#34; and &#39;world&#39;';
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe('"hello" and \'world\'');
    });

    it('should decode hex entities &#x27; and &#x60;', () => {
      const input = '&#x27;single&#x27; and &#x60;backtick&#x60;';
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(input);
      expect(decoded).toBe("'single' and `backtick`");
    });

    it('should handle mixed content without corrupting code', () => {
      const pythonCode = `
def test_example():
    &quot;&quot;&quot;Test docstring&quot;&quot;&quot;
    expected = &quot;value&quot;
    result &#x3D; get_value()
    assert result &#x3D;&#x3D; expected
`;
      const decoded = (llmEnhancedTools as any).decodeHtmlEntities(pythonCode);
      expect(decoded).toContain('"""Test docstring"""');
      expect(decoded).toContain('expected = "value"');
      expect(decoded).toContain('result = get_value()');
      expect(decoded).toContain('assert result == expected');
      expect(decoded).not.toContain('&quot;');
      expect(decoded).not.toContain('&#x3D;');
    });
  });

  describe('Class Name Sanitization (QA_feedback_10)', () => {
    it('should remove spaces from Python class names', () => {
      const code = 'class TestFocus Ring:\n    pass';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('class TestFocusRing:');
      expect(cleaned).not.toContain('class TestFocus Ring:');
    });

    it('should handle multiple words in class name', () => {
      const code = 'class Test Focus Ring Component:\n    def test_method(self):\n        pass';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('class TestFocusRingComponent:');
    });

    it('should not affect valid class names', () => {
      const code = 'class TestValidClassName:\n    pass';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('class TestValidClassName:');
    });

    it('should fix function names with spaces', () => {
      const code = 'def test focus ring():\n    pass';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('def test_focus_ring(');
    });

    it('should handle indented class definitions', () => {
      const code = '    class Test Inner Class:\n        pass';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('class TestInnerClass:');
    });
  });

  describe('Python Import Syntax Fixing', () => {
    it('should not rewrite JavaScript/TypeScript literals in non-Python code', () => {
      const code = `const enabled = true;
const fallback = null;
if (enabled === false) { return null; }`;
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code, 'src/example.test.ts');
      expect(cleaned).toContain('true');
      expect(cleaned).toContain('false');
      expect(cleaned).toContain('null');
      expect(cleaned).not.toContain('True');
      expect(cleaned).not.toContain('False');
      expect(cleaned).not.toContain('None');
    });

    it('should convert file path imports to module notation', () => {
      const code = 'from utils/file.py import helper\nimport auth/models';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('from utils.file import helper');
      expect(cleaned).toContain('import auth.models');
      expect(cleaned).not.toContain('/');
      expect(cleaned).not.toContain('.py');
    });

    it('should handle nested module paths', () => {
      const code = 'from auth/models/user.py import User';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('from auth.models.user import User');
    });

    it('should not break valid Python imports', () => {
      const code = 'from pathlib import Path\nimport pytest';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('from pathlib import Path');
      expect(cleaned).toContain('import pytest');
    });

    it('should split concatenated imports', () => {
      const code = 'import pytest def test_func():';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toMatch(/import pytest\s+def test_func/);
    });

    it('should fix "from filename.py import X" pattern (single file)', () => {
      const code = 'from ai_content_schema.py import ContentSchema';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toBe('from ai_content_schema import ContentSchema');
      expect(cleaned).not.toContain('.py');
    });

    it('should fix "import filename.py" pattern', () => {
      const code = 'import utils.py\nimport helpers.py';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('import utils');
      expect(cleaned).toContain('import helpers');
      expect(cleaned).not.toMatch(/import \w+\.py/);
    });

    it('should fix "./filename.py" relative import pattern', () => {
      const code = 'from ./ai_content_schema.py import ContentSchema';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toBe('from ai_content_schema import ContentSchema');
      expect(cleaned).not.toContain('./');
      expect(cleaned).not.toContain('.py');
    });

    it('should fix "./subdir/filename.py" relative import pattern', () => {
      const code = 'from ./utils/helpers.py import helper_func';
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toBe('from utils.helpers import helper_func');
      expect(cleaned).not.toContain('./');
      expect(cleaned).not.toContain('.py');
    });

    it('should handle multiple invalid import patterns in same code', () => {
      const code = `from ai_content_schema.py import ContentSchema
import utils.py
from ./helpers.py import helper
from pathlib import Path`;
      const cleaned = (llmEnhancedTools as any).cleanGeneratedTestCode(code);
      expect(cleaned).toContain('from ai_content_schema import ContentSchema');
      expect(cleaned).toContain('import utils');
      expect(cleaned).toContain('from helpers import helper');
      expect(cleaned).toContain('from pathlib import Path');
      expect(cleaned).not.toMatch(/\.py\s/);
    });
  });

  describe('Code Sanitization', () => {
    it('should remove zero-width characters', () => {
      const code = 'def\u200B test(): pass';
      const { code: cleaned, removedChars } = (llmEnhancedTools as any).sanitizeGeneratedCode(code);
      expect(cleaned).toBe('def test(): pass');
      expect(removedChars).toBeGreaterThan(0);
    });

    it('should replace non-breaking spaces with regular spaces', () => {
      const code = 'def\u00A0test(): pass';
      const { code: cleaned } = (llmEnhancedTools as any).sanitizeGeneratedCode(code);
      expect(cleaned).toBe('def test(): pass');
    });

    it('should convert leading tabs to spaces', () => {
      const code = 'def test():\n\treturn True';
      const { code: cleaned } = (llmEnhancedTools as any).sanitizeGeneratedCode(code);
      expect(cleaned).toBe('def test():\n    return True');
      expect(cleaned).not.toMatch(/^\t/m);
    });

    it('should trim trailing whitespace per line', () => {
      const code = 'def test():   \n    pass  ';
      const { code: cleaned } = (llmEnhancedTools as any).sanitizeGeneratedCode(code);
      expect(cleaned).toBe('def test():\n    pass');
    });
  });
});

describe('generate_tests Output Validation', () => {
  it('should NOT produce HTML entities in generated code skeleton', () => {
    const sampleLLMOutput = `
\`\`\`python
import pytest

def test_example():
    &quot;&quot;&quot;Test that values are equal&quot;&quot;&quot;
    expected = &quot;hello&quot;
    result &#x3D; get_value()
    assert result &#x3D;&#x3D; expected
\`\`\`
`;

    const tools = {} as any;
    tools.decodeHtmlEntities = (text: string) => {
      const entities: Record<string, string> = {
        '&quot;': '"',
        '&apos;': "'",
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&#x3D;': '=',
      };
      let decoded = text;
      for (const [entity, char] of Object.entries(entities)) {
        decoded = decoded.split(entity).join(char);
      }
      return decoded;
    };

    const decoded = tools.decodeHtmlEntities(sampleLLMOutput);
    
    expect(decoded).not.toContain('&quot;');
    expect(decoded).not.toContain('&#x3D;');
    expect(decoded).toContain('"""Test that values are equal"""');
    expect(decoded).toContain('expected = "hello"');
    expect(decoded).toContain('result = get_value()');
    expect(decoded).toContain('assert result == expected');
  });

  it('should produce valid Python import syntax', () => {
    const badImport = 'from utils/ai_content_schema.py import ContentSchema';
    const fixedImport = badImport
      .replace(/^from\s+([a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)\.py\s+import/gm, 'from $1.$2 import');
    
    expect(fixedImport).toBe('from utils.ai_content_schema import ContentSchema');
    expect(fixedImport).not.toContain('/');
    expect(fixedImport).not.toContain('.py');
  });
});

// ============================================================================
// SECTION 3: Validation Tests (from generate-tests.validation.unit.test.ts)
// ============================================================================

describe('generateTests validation (unit)', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(() => {
    const base = join(process.cwd(), 'tests', 'tmp');
    mkdirSync(base, { recursive: true });
    tempDir = mkdtempSync(join(base, 'generate-tests-validate-'));
    configPath = join(tempDir, 'env.test.settings');

    const root = tempDir.replace(/\\/g, '/');
    const baseConfig = loadCentralConfigJson();
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.workspace = { roots: [root], defaultRoot: root };
    cfg.policy = { ...(cfg.policy || {}), allowlistPaths: [root], maxFileBytes: 65536 };
    cfg.systemProfile = { ...(cfg.systemProfile || {}), exposeToLLM: false };
    cfg.backends = [
      {
        id: 'stub',
        type: 'stub',
        base_url: 'http://127.0.0.1:1',
        model: 'stub-model',
        labels: { priority: 'primary' },
      },
    ];
    cfg.defaults = { ...(cfg.defaults || {}), localBackendId: 'stub', sotaBackendId: 'stub' };

    writeSettingsFile(configPath, cfg, { exposeSystemProfile: false, testingEnabled: false });

    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'example.ts'),
      `export function add(a: number, b: number): number { return a + b; }\n`,
      'utf-8'
    );
    writeFileSync(
      join(tempDir, 'src', 'example.py'),
      `def add(a: int, b: int) -> int:\n    return a + b\n`,
      'utf-8'
    );
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects missing Python imports (datetime, timedelta) and adds warning', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    const mockContent = 
      'import pytest\n' +
      '\n' +
      'def test_add():\n' +
      '    now = datetime.now()\n' +
      '    delta = timedelta(days=1)\n' +
      '    assert 1 + 2 == 3\n';
    
    (tools as any).llmChat = {
      chat: vi.fn(async () => ({ message: { content: mockContent } })),
    };

    const result = await tools.generateTests(join(tempDir, 'src', 'example.py'), {
      framework: 'pytest',
      coverage: 'basic',
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    const warningsText = result.warnings?.join(' ') || '';
    expect(warningsText).toMatch(/datetime|timedelta|undefined|Potentially undefined/i);
  });

  it('detects undefined variables in generated Python tests', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    const mockContent = 
      'import pytest\n' +
      '\n' +
      'def test_example():\n' +
      '    result = datetime.now()\n' +
      '    path = Path("/tmp")\n' +
      '    assert result is not None\n';

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({ message: { content: mockContent } })),
    };

    const result = await tools.generateTests(join(tempDir, 'src', 'example.py'), {
      framework: 'pytest',
      coverage: 'basic',
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    const warningsText = result.warnings?.join(' ') || '';
    expect(warningsText).toMatch(/datetime|Path|Potentially undefined/i);
  });

  it('detects missing pytest fixture arguments', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    const mockContent = 
      'import pytest\n' +
      '\n' +
      'def test_something():\n' +
      '    monkeypatch.setattr("os.path.exists", lambda x: True)\n' +
      '    assert True\n';

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({ message: { content: mockContent } })),
    };

    const result = await tools.generateTests(join(tempDir, 'src', 'example.py'), {
      framework: 'pytest',
      coverage: 'basic',
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    const warningsText = result.warnings?.join(' ') || '';
    expect(warningsText).toMatch(/monkeypatch|fixture|Potentially undefined/i);
  });

  it('adds a warning when generated TypeScript has parse errors', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    const mockContent =
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('add', () => {\n" +
      "  it('adds', () => {\n" +
      '    expect(1).toBe(1)\n' +
      '  \n';
    
    (tools as any).llmChat = {
      chat: vi.fn(async () => ({ message: { content: mockContent } })),
    };

    const result = await tools.generateTests(join(tempDir, 'src', 'example.ts'), {
      framework: 'vitest',
      coverage: 'basic',
    });

    expect(result.success).toBe(true);
    expect(result.warnings?.some((w: string) => w.includes('TypeScript parse errors detected') || w.includes('Unbalanced'))).toBe(true);
  });

  it('decodes HTML entities in generated Python tests', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    const mockContent =
      'import pytest\n\n' +
      'def test_add():\n' +
      '    result = add(1, 2)\n' +
      '    assert result == &#x27;ok&#x27;\n';

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({ message: { content: mockContent } })),
    };

    const result = await tools.generateTests(join(tempDir, 'src', 'example.py'), {
      framework: 'pytest',
      coverage: 'basic',
    });

    expect(result.success).toBe(true);
    expect(result.tests).toContain("assert result == 'ok'");
    expect(result.tests).not.toContain('&#x27;');
  });

  it('normalizes absolute Python import paths to module name', async () => {
    const config = new ConfigManager(configPath);
    const backendManager = new BackendManager(config.getBackends());
    const tools = new LlmEnhancedTools(config, backendManager);

    const mockContent =
      'from C:\\\\Users\\\\demo\\\\project\\\\src\\\\example.py import add\n\n' +
      'def test_add():\n' +
      '    assert add(1, 2) == 3\n';

    (tools as any).llmChat = {
      chat: vi.fn(async () => ({ message: { content: mockContent } })),
    };

    const result = await tools.generateTests(join(tempDir, 'src', 'example.py'), {
      framework: 'pytest',
      coverage: 'basic',
    });

    expect(result.success).toBe(true);
    expect(result.tests).toMatch(/from example import add/);
    expect(result.tests).not.toMatch(/C:\\Users/i);
  });
});
