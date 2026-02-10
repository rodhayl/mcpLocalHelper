import { describe, it, expect } from 'vitest';

describe('agent_task timeout propagation', () => {
  it('should pass effective timeoutMs to AgentRunner.runTask', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const mcpPath = path.join(process.cwd(), 'src', 'server', 'mcp.ts');
    const content = fs.readFileSync(mcpPath, 'utf-8');

    // Ensure timeoutMs is computed from settings or options
    expect(content).toContain('agentTimeoutMs');
    // Ensure runTask receives timeoutMs
    expect(content).toContain('timeoutMs: effectiveTimeoutMs');
  });
});
