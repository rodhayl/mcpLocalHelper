import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { ConfigManager } from '../src/config/index.js';
import { SymbolIndexer } from '../src/tools/symbols.js';

// Test fixtures directory
const TEST_DIR = resolve('./tests/tmp/symbol-test');

describe('SymbolIndexer', () => {
  let config: ConfigManager;
  let symbolIndexer: SymbolIndexer;

  beforeAll(() => {
    // Create test directory structure
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'lib'), { recursive: true });

    // Create TypeScript test files
    writeFileSync(
      join(TEST_DIR, 'src/utils.ts'),
      `// Utility functions
export function formatDate(date: Date): string {
  return date.toISOString();
}

export const MAX_ITEMS = 100;
const INTERNAL_CONSTANT = 'private';

export async function fetchData(url: string): Promise<any> {
  return fetch(url).then(r => r.json());
}

function privateHelper(): void {
  console.log('helper');
}

export type UserId = string;
export interface User {
  id: UserId;
  name: string;
}

export class UserService {
  private users: User[] = [];
  
  async getUser(id: string): Promise<User | null> {
    return this.users.find(u => u.id === id) || null;
  }
  
  addUser(user: User): void {
    this.users.push(user);
  }
}
`
    );

    writeFileSync(
      join(TEST_DIR, 'src/index.ts'),
      `import { formatDate, UserService, User } from './utils';
import type { UserId } from './utils';

export { formatDate, UserService };
export type { User, UserId };

const app = new UserService();

export async function main(): Promise<void> {
  const user: User = { id: '1', name: 'Test' };
  app.addUser(user);
  console.log(formatDate(new Date()));
}

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}
`
    );

    writeFileSync(
      join(TEST_DIR, 'lib/helpers.ts'),
      `// Helper functions
export const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);
export const toLowerCase = (str: string) => str.toLowerCase();

export interface Config {
  name: string;
  version: number;
}

export type ConfigKey = keyof Config;
`
    );

    // Create JavaScript test file
    writeFileSync(
      join(TEST_DIR, 'src/legacy.js'),
      `// Legacy JavaScript file
function legacyFunction(x) {
  return x * 2;
}

const LEGACY_CONSTANT = 42;

class LegacyClass {
  constructor() {
    this.value = 0;
  }
  
  getValue() {
    return this.value;
  }
}

module.exports = {
  legacyFunction,
  LegacyClass,
  LEGACY_CONSTANT,
};
`
    );

    // Create Python test file
    writeFileSync(
      join(TEST_DIR, 'src/script.py'),
      `# Python module
MAX_SIZE = 1024
DEFAULT_NAME = "test"

def greet(name: str) -> str:
    return f"Hello, {name}"

async def fetch_async(url: str) -> dict:
    pass

class Calculator:
    def __init__(self):
        self.value = 0
    
    def add(self, x: int) -> int:
        self.value += x
        return self.value

def _private_helper():
    pass
`
    );

    // Initialize config and indexer
    config = new ConfigManager();
    // Override workspace to point to test directory
    (config as any).config.workspace = { roots: [TEST_DIR], defaultRoot: TEST_DIR };
    (config as any).config.policy.allowlistPaths = [TEST_DIR];

    symbolIndexer = new SymbolIndexer(config);
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('indexSymbols', () => {
    it('should index TypeScript functions', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
        symbolTypes: ['function'],
      });

      expect(result.indexed).toBeGreaterThan(0);

      const functionNames = result.symbols.map((s) => s.name);
      expect(functionNames).toContain('formatDate');
      expect(functionNames).toContain('fetchData');
      expect(functionNames).toContain('main');
    });

    it('should index TypeScript classes', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
        symbolTypes: ['class'],
      });

      expect(result.indexed).toBeGreaterThan(0);

      const classNames = result.symbols.map((s) => s.name);
      expect(classNames).toContain('UserService');
    });

    it('should index TypeScript interfaces and types', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
        symbolTypes: ['interface', 'type'],
      });

      expect(result.indexed).toBeGreaterThan(0);

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('User');
      expect(names).toContain('UserId');
      expect(names).toContain('Config');
    });

    it('should index TypeScript enums', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
        symbolTypes: ['enum'],
      });

      expect(result.indexed).toBeGreaterThan(0);

      const enumNames = result.symbols.map((s) => s.name);
      expect(enumNames).toContain('Status');
    });

    it('should mark exported symbols correctly', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
      });

      const formatDateSymbol = result.symbols.find((s) => s.name === 'formatDate');
      expect(formatDateSymbol).toBeDefined();
      expect(formatDateSymbol?.exported).toBe(true);

      const privateHelperSymbol = result.symbols.find((s) => s.name === 'privateHelper');
      expect(privateHelperSymbol).toBeDefined();
      expect(privateHelperSymbol?.exported).toBe(false);
    });

    it('should index JavaScript symbols', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['javascript'],
      });

      expect(result.indexed).toBeGreaterThan(0);

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('legacyFunction');
      expect(names).toContain('LegacyClass');
    });

    it('should index Python symbols', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['python'],
      });

      expect(result.indexed).toBeGreaterThan(0);

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('greet');
      expect(names).toContain('Calculator');
    });

    it('should index all languages by default', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR);

      expect(result.languages.length).toBeGreaterThanOrEqual(1);
      expect(result.indexed).toBeGreaterThan(0);

      // Should have symbols from all files
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain('formatDate'); // TypeScript
      expect(names).toContain('legacyFunction'); // JavaScript
      expect(names).toContain('greet'); // Python
    });

    it('should include line numbers', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
      });

      const formatDateSymbol = result.symbols.find((s) => s.name === 'formatDate');
      expect(formatDateSymbol).toBeDefined();
      expect(formatDateSymbol?.line).toBeGreaterThan(0);
    });

    it('should include signatures', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR, {
        languages: ['typescript'],
      });

      const formatDateSymbol = result.symbols.find((s) => s.name === 'formatDate');
      expect(formatDateSymbol).toBeDefined();
      expect(formatDateSymbol?.signature).toContain('formatDate');
    });

    it('should report indexing duration', () => {
      const result = symbolIndexer.indexSymbols(TEST_DIR);
      expect(result.indexDuration).toBeGreaterThanOrEqual(0);
    });

    it('should use cache for subsequent calls', () => {
      // First call
      const result1 = symbolIndexer.indexSymbols(TEST_DIR);

      // Second call should use cache
      const result2 = symbolIndexer.indexSymbols(TEST_DIR);

      // Cache hit should have 0 duration
      expect(result2.indexDuration).toBe(0);
      expect(result2.indexed).toBe(result1.indexed);
    });
  });

  describe('crossFileLinks', () => {
    it('should find imports in entry point', () => {
      const result = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')]);

      expect(result.files.length).toBeGreaterThan(0);

      const indexFile = result.files.find((f) => f.path.includes('index.ts'));
      expect(indexFile).toBeDefined();
      expect(indexFile?.imports.length).toBeGreaterThan(0);

      // Should import from utils
      const utilsImport = indexFile?.imports.find((i) => i.source.includes('utils'));
      expect(utilsImport).toBeDefined();
      expect(utilsImport?.symbols).toContain('formatDate');
    });

    it('should resolve relative import paths', () => {
      const result = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')]);

      const indexFile = result.files.find((f) => f.path.includes('index.ts'));
      const utilsImport = indexFile?.imports.find((i) => i.source.includes('utils'));

      expect(utilsImport?.resolvedPath).toBeDefined();
      expect(utilsImport?.resolvedPath).toContain('utils.ts');
    });

    it('should track importedBy relationships', () => {
      const result = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')], { depth: 1 });

      // utils should be imported by index
      const utilsFile = result.files.find((f) => f.path.includes('utils.ts'));
      expect(utilsFile?.importedBy.length).toBeGreaterThan(0);
    });

    it('should generate graph nodes and edges', () => {
      const result = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')]);

      expect(result.graph.nodes.length).toBeGreaterThan(0);
      expect(result.graph.edges.length).toBeGreaterThan(0);

      // Should have edge from index to utils
      const hasEdge = result.graph.edges.some(
        (e) => e.from.includes('index.ts') && e.to.includes('utils.ts')
      );
      expect(hasEdge).toBe(true);
    });

    it('should respect depth limit', () => {
      const shallowResult = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')], {
        depth: 0,
      });

      const deepResult = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')], {
        depth: 3,
      });

      expect(shallowResult.files.length).toBeLessThanOrEqual(deepResult.files.length);
    });

    it('should identify type-only imports', () => {
      const result = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')]);

      const indexFile = result.files.find((f) => f.path.includes('index.ts'));
      const typeImport = indexFile?.imports.find((i) => i.isTypeOnly);

      expect(typeImport).toBeDefined();
      expect(typeImport?.symbols).toContain('UserId');
    });

    it('should filter type-only imports when requested', () => {
      const withTypes = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')], {
        includeTypes: true,
      });

      const withoutTypes = symbolIndexer.crossFileLinks([join(TEST_DIR, 'src/index.ts')], {
        includeTypes: false,
      });

      const indexWithTypes = withTypes.files.find((f) => f.path.includes('index.ts'));
      const indexWithoutTypes = withoutTypes.files.find((f) => f.path.includes('index.ts'));

      expect(indexWithTypes?.imports.length).toBeGreaterThanOrEqual(
        indexWithoutTypes?.imports.length || 0
      );
    });
  });

  describe('structuredSearch', () => {
    it('should find functions by name', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'formatDate');

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].symbolName).toBe('formatDate');
      expect(result.matches[0].symbolType).toBe('function');
    });

    it('should find classes by name', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'UserService', {
        targetType: 'class',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].symbolName).toBe('UserService');
      expect(result.matches[0].symbolType).toBe('class');
    });

    it('should filter by symbol type', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'User', {
        targetType: 'interface',
      });

      // Should only find User interface, not UserService class
      expect(result.matches.every((m) => m.symbolType === 'interface')).toBe(true);
    });

    it('should return relevance scores', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'format');

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].relevanceScore).toBeGreaterThan(0);
      expect(result.matches[0].relevanceScore).toBeLessThanOrEqual(1);
    });

    it('should rank exact matches higher', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'formatDate');

      // formatDate should be first
      expect(result.matches[0].symbolName).toBe('formatDate');
    });

    it('should include preview code', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'formatDate');

      expect(result.matches[0].preview).toBeDefined();
      expect(result.matches[0].preview.length).toBeGreaterThan(0);
    });

    it('should include line range', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'formatDate');

      expect(result.matches[0].startLine).toBeGreaterThan(0);
      expect(result.matches[0].endLine).toBeGreaterThanOrEqual(result.matches[0].startLine);
    });

    it('should respect maxResults', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'a', {
        maxResults: 3,
      });

      expect(result.matches.length).toBeLessThanOrEqual(3);
    });

    it('should filter by language', () => {
      const tsOnly = symbolIndexer.structuredSearch(TEST_DIR, 'function', {
        languages: ['typescript'],
      });

      const pyOnly = symbolIndexer.structuredSearch(TEST_DIR, 'function', {
        languages: ['python'],
      });

      // TypeScript files should have TypeScript symbols
      for (const match of tsOnly.matches) {
        expect(match.file).toMatch(/\.(ts|tsx)$/);
      }

      // Python files should have Python symbols
      for (const match of pyOnly.matches) {
        expect(match.file).toMatch(/\.py$/);
      }
    });

    it('should search across word boundaries', () => {
      // Search for "get" should find "getUser"
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'get');

      const hasGetUser = result.matches.some((m) => m.symbolName === 'getUser');
      expect(hasGetUser).toBe(true);
    });

    it('should report total matches', () => {
      const result = symbolIndexer.structuredSearch(TEST_DIR, 'e', {
        maxResults: 5,
      });

      expect(result.totalMatches).toBeGreaterThanOrEqual(result.matches.length);
    });
  });

  describe('cache management', () => {
    it('should invalidate cache for specific root', () => {
      // Prime the cache
      symbolIndexer.indexSymbols(TEST_DIR);

      // Invalidate
      symbolIndexer.invalidateCache(TEST_DIR);

      // Next call should not be from cache (duration > 0)
      const result = symbolIndexer.indexSymbols(TEST_DIR);
      expect(result.indexDuration).toBeGreaterThan(0);
    });

    it('should invalidate all caches', () => {
      // Prime the cache
      symbolIndexer.indexSymbols(TEST_DIR);

      // Invalidate all
      symbolIndexer.invalidateCache();

      // Next call should not be from cache
      const result = symbolIndexer.indexSymbols(TEST_DIR);
      expect(result.indexDuration).toBeGreaterThan(0);
    });
  });
});
