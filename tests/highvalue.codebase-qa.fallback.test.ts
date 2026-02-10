import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ConfigManager } from '../src/config/index.js';
import { BackendManager } from '../src/adapters/factory.js';
import { HighValueTools } from '../src/tools/highvalue.js';
import * as fs from 'fs';
import * as path from 'path';

describe('highvalue codebaseQA backend fallback', () => {
  let config: ConfigManager;
  let backendManager: BackendManager;
  let tools: HighValueTools;
  const testDir = path.join(process.cwd(), 'tests', 'tmp', 'highvalue-qa-fallback');

  beforeAll(() => {
    config = new ConfigManager();
    backendManager = new BackendManager(config.getConfig().backends);
    tools = new HighValueTools(config, backendManager);

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src', 'auth.ts'),
      `
// authentication flow for local login
export class AuthService {
  authenticateUser(username: string, password: string): boolean {
    // authentication succeeds only with non-empty credentials
    return username.length > 0 && password.length > 0;
  }
}
      `.trim(),
      'utf-8'
    );
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns source-grounded fallback instead of dropping all sources on HTTP 400', async () => {
    (tools as any).llmWrapper = {
      callToolLlm: vi
        .fn()
        .mockRejectedValue(new Error('HTTP 400 Bad Request: {"error":"No model loaded"}')),
    };

    const result = await tools.codebaseQA('How does authentication work in this code?', {
      searchScope: ['tests/tmp/highvalue-qa-fallback'],
      maxSources: 3,
    });

    expect(result.confidence).toBe('low');
    expect(result.answer).toMatch(/fallback|HTTP 400|model/i);
    expect(result.sources.length).toBeGreaterThan(0);
  });
});
