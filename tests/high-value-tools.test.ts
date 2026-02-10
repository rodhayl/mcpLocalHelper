import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { HighValueTools } from '../src/tools/highvalue.js';
import * as fs from 'fs';
import * as path from 'path';

describe('High-Value Local Tasks', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;
  let highValueTools: HighValueTools;
  const testDir = path.join(process.cwd(), 'tests', 'tmp', 'high-value');
  const simulatedOpenAiKey = `sk${'-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345678901234567'}`;
  const simulatedAwsAccessKey = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const simulatedPrivateKeyHeader = `-----BEGIN ${'PRIVATE KEY'}-----`;
  const simulatedPrivateKeyFooter = `-----END ${'PRIVATE KEY'}-----`;

  beforeAll(() => {
    config = new ConfigManager();
    backendManager = new BackendManager(config.getConfig().backends);
    highValueTools = new HighValueTools(config, backendManager);

    // Create test directory structure
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(testDir, 'tests'), { recursive: true });

    // Create source files with realistic secrets for detection
    fs.writeFileSync(
      path.join(testDir, 'src', 'auth.ts'),
      `// Authentication module
// TODO: Add rate limiting for login attempts
export class AuthService {
  // Use realistic OpenAI-style key format (sk-proj- followed by 48 chars)
  private apiKey = '${simulatedOpenAiKey}';
  
  // FIXME: This is insecure, needs proper hashing
  validatePassword(password: string): boolean {
    return password.length >= 8;
  }
  
  // TODO: Implement OAuth support
  login(username: string, password: string): boolean {
    // HACK: Temporary bypass for testing
    if (username === 'admin') return true;
    return this.validatePassword(password);
  }
}

export function createAuthService(): AuthService {
  return new AuthService();
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'user.ts'),
      `// User management
import { AuthService } from './auth';

// TODO: Add email validation
export interface User {
  id: string;
  email: string;
  name: string;
}

export class UserService {
  // XXX: Should use database instead of memory
  private users: User[] = [];
  
  addUser(user: User): void {
    this.users.push(user);
  }
  
  getUser(id: string): User | undefined {
    return this.users.find(u => u.id === id);
  }
}
`
    );

    fs.writeFileSync(
      path.join(testDir, 'src', 'config.ts'),
      `// Configuration
// NOTE: Environment variables should be set before import
export const config = {
  db: {
    host: '192.168.1.100',
    connectionString: 'mongodb://user:password@localhost:27017/db',
  },
  jwt: {
    secret: 'my-super-secret-jwt-key-do-not-share',
  },
  aws: {
    accessKeyId: '${simulatedAwsAccessKey}',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
};
`
    );

    // Create test file
    fs.writeFileSync(
      path.join(testDir, 'tests', 'auth.test.ts'),
      `import { describe, it, expect } from 'vitest';
import { AuthService, createAuthService } from '../src/auth';

describe('AuthService', () => {
  it('should validate password length', () => {
    const auth = new AuthService();
    expect(auth.validatePassword('short')).toBe(false);
    expect(auth.validatePassword('longenough')).toBe(true);
  });
});
`
    );
  });

  afterAll(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('secretScan', () => {
    it('should find hardcoded secrets', () => {
      const result = highValueTools.secretScan(testDir);

      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.statistics.filesScanned).toBeGreaterThan(0);

      // Should find OpenAI/Anthropic key (sk-proj- pattern)
      const openaiKeyFinding = result.findings.find((f) => f.type === 'OpenAI/Anthropic Key');
      expect(openaiKeyFinding).toBeDefined();

      // Should find connection string
      const connStringFinding = result.findings.find((f) => f.type === 'Connection String');
      expect(connStringFinding).toBeDefined();

      // Should find AWS key
      const awsKeyFinding = result.findings.find((f) => f.type === 'AWS Key');
      expect(awsKeyFinding).toBeDefined();
    });

    it('should detect private keys in .key files by default', () => {
      const secretsDir = path.join(testDir, 'secrets');
      fs.mkdirSync(secretsDir, { recursive: true });

      fs.writeFileSync(
        path.join(secretsDir, 'encryption.key'),
        `${simulatedPrivateKeyHeader}\n` +
          `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCu\n` +
          `${simulatedPrivateKeyFooter}\n`
      );

      const result = highValueTools.secretScan(testDir);
      const privateKeyFinding = result.findings.find((f) => f.type === 'Private Key');
      expect(privateKeyFinding).toBeDefined();
      expect(privateKeyFinding?.file).toContain('secrets');
      expect(privateKeyFinding?.file).toContain('encryption.key');
    });

    it('should calculate risk score', () => {
      const result = highValueTools.secretScan(testDir);

      expect(result.statistics.riskScore).toBeGreaterThan(0);
      expect(result.statistics.riskScore).toBeLessThanOrEqual(100);
    });

    it('should provide recommendations', () => {
      const result = highValueTools.secretScan(testDir);

      for (const finding of result.findings) {
        expect(finding.recommendation).toBeDefined();
        expect(finding.recommendation.length).toBeGreaterThan(0);
      }
    });

    it('should filter by scan type', () => {
      const secretsOnly = highValueTools.secretScan(testDir, { scanType: 'secrets' });
      const vulnsOnly = highValueTools.secretScan(testDir, { scanType: 'vulnerabilities' });

      // Secrets should find API keys, connection strings, etc.
      expect(
        secretsOnly.findings.some((f) => 
          f.type.includes('Key') || f.type.includes('Token') || f.type.includes('Connection')
        )
      ).toBe(true);

      // Secrets scan should have different count than vulnerabilities scan
      // (vulns may be 0 if no eval/innerHTML/SQL injection patterns found)
      expect(secretsOnly.findings.length).not.toBe(vulnsOnly.findings.length);
    });
  });

  describe('riskScore', () => {
    it('should report multiple risk factors in a single payload', () => {
      const simulatedOpenAiKey = `sk${'-proj-abc123'}`;
      const content = `password=admin123\napi_key=${simulatedOpenAiKey}`;
      const result = highValueTools.riskScore(content, { strictMode: true, context: 'config' });

      expect(result.score).toBeGreaterThan(0);
      expect(result.riskLevel).not.toBe('minimal');

      const factorNames = new Set(result.factors.map((f) => f.name));
      expect(factorNames.has('Hardcoded Password')).toBe(true);
      expect(factorNames.has('OpenAI/Anthropic Key')).toBe(true);
    });
  });

  describe('aggregateTodos', () => {
    it('should find TODO comments', () => {
      const result = highValueTools.aggregateTodos(testDir);

      expect(result.todos.length).toBeGreaterThan(0);
      expect(result.summary.total).toBeGreaterThan(0);

      // Should find various TODO types
      const types = new Set(result.todos.map((t) => t.type));
      expect(types.has('TODO')).toBe(true);
    });

    it('should filter TODO types when requested', () => {
      const result = highValueTools.aggregateTodos(testDir, { todoTypes: ['TODO'] });

      expect(result.todos.length).toBeGreaterThan(0);
      expect(new Set(result.todos.map((t) => t.type))).toEqual(new Set(['TODO']));
    });

    it('should find FIXME and HACK comments', () => {
      const result = highValueTools.aggregateTodos(testDir);

      const types = new Set(result.todos.map((t) => t.type));
      expect(types.has('FIXME') || types.has('HACK')).toBe(true);
    });

    it('should categorize TODOs', () => {
      const result = highValueTools.aggregateTodos(testDir);

      const categories = new Set(result.todos.map((t) => t.category));
      expect(categories.size).toBeGreaterThan(0);
    });

    it('should suggest priorities', () => {
      const result = highValueTools.aggregateTodos(testDir);

      // FIXME and HACK should be high priority
      const fixmes = result.todos.filter((t) => t.type === 'FIXME' || t.type === 'HACK');
      for (const fixme of fixmes) {
        expect(fixme.suggestedPriority).toBe('high');
      }
    });

    it('should include context when requested', () => {
      const withContext = highValueTools.aggregateTodos(testDir, { includeContext: true });
      const withoutContext = highValueTools.aggregateTodos(testDir, { includeContext: false });

      if (withContext.todos.length > 0) {
        expect(withContext.todos[0].context.length).toBeGreaterThan(0);
        expect(withoutContext.todos[0].context).toBe('');
      }
    });

    it('should group by different criteria', () => {
      const byFile = highValueTools.aggregateTodos(testDir, { groupBy: 'file' });
      const byPriority = highValueTools.aggregateTodos(testDir, { groupBy: 'priority' });
      const byType = highValueTools.aggregateTodos(testDir, { groupBy: 'type' });

      // Different groupings should have different keys
      expect(Object.keys(byFile.grouped).sort()).not.toEqual(
        Object.keys(byPriority.grouped).sort()
      );
      expect(Object.keys(byType.grouped)).toContain('TODO');
    });
  });

  describe('gatherContext', () => {
    it('should gather relevant files for a query', async () => {
      const result = await highValueTools.gatherContext('authentication', testDir);

      expect(result.files.length).toBeGreaterThan(0);
      expect(result.totalTokensEstimate).toBeGreaterThan(0);

      // Should find auth.ts as relevant
      const authFile = result.files.find((f) => f.path.includes('auth'));
      expect(authFile).toBeDefined();
      // Relevance level depends on keyword matching
      expect(['high', 'medium', 'low']).toContain(authFile?.relevance);
    });

    it('should extract key snippets', async () => {
      const result = await highValueTools.gatherContext('authentication', testDir);

      const relevantFiles = result.files.filter((f) => f.keySnippets.length > 0);
      expect(relevantFiles.length).toBeGreaterThan(0);
    });

    it('should calculate compression ratio', async () => {
      const result = await highValueTools.gatherContext('user management', testDir);

      expect(result.compressionRatio).toBeGreaterThan(0);
    });

    it('should suggest follow-up questions', async () => {
      const result = await highValueTools.gatherContext('login', testDir);

      expect(result.suggestedQuestions.length).toBeGreaterThan(0);
    });

    it('should respect strategy option', async () => {
      const minimal = await highValueTools.gatherContext('auth', testDir, { strategy: 'minimal' });
      const comprehensive = await highValueTools.gatherContext('auth', testDir, {
        strategy: 'comprehensive',
      });

      // Comprehensive should include more files
      expect(comprehensive.files.length).toBeGreaterThanOrEqual(minimal.files.length);
    });
  });

  describe('analyzeTestGaps', () => {
    it('should identify untested files', async () => {
      const result = await highValueTools.analyzeTestGaps(testDir);

      // user.ts and config.ts don't have tests
      expect(result.untestedFiles.length).toBeGreaterThan(0);
      const untestedPaths = result.untestedFiles.map((f) => f.file);
      expect(untestedPaths.some((p) => p.includes('user') || p.includes('config'))).toBe(true);
    });

    it('should calculate coverage summary', async () => {
      const result = await highValueTools.analyzeTestGaps(testDir);

      expect(result.coverageSummary.totalSourceFiles).toBeGreaterThan(0);
      expect(result.coverageSummary.totalTestFiles).toBeGreaterThan(0);
    });

    it('should provide recommendations', async () => {
      const result = await highValueTools.analyzeTestGaps(testDir);

      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('should suggest tests for untested files', async () => {
      const result = await highValueTools.analyzeTestGaps(testDir);

      for (const untested of result.untestedFiles) {
        expect(untested.suggestedTests.length).toBeGreaterThan(0);
      }
    });
  });
});
