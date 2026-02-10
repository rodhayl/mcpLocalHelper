import { describe, it, expect } from 'vitest';

describe('orchestration tool surface', () => {
  it('should be defined in MCP tool list and handler', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const mcpPath = path.join(process.cwd(), 'src', 'server', 'mcp.ts');
    const content = fs.readFileSync(mcpPath, 'utf-8');

    expect(content).toContain("name: 'orchestration'");
    expect(content).toContain("case 'orchestration'");
    expect(content).toContain('cliOrchestrationEnabled');
  });

  it('should appear in planning tool category', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const toolPath = path.join(process.cwd(), 'src', 'server', 'tool-discovery.ts');
    const content = fs.readFileSync(toolPath, 'utf-8');

    expect(content).toContain('planning');
    expect(content).toContain('orchestration');
  });
});
