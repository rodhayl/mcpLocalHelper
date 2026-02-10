const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function callTool(client, name, args, timeoutMs = 60000) {
  try {
    const res = await client.callTool({ name, arguments: args || {} }, undefined, { timeoutMs });
    const text = res.content?.[0]?.text ?? '';
    return { ok: !res.isError, text };
  } catch (e) {
    return { ok: false, text: String(e) };
  }
}

async function main() {
  const settingsPath = process.argv[2] || 'env.settings';
  const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js', '--settings', settingsPath],
    env: { ...process.env, WORKSPACE_ROOT: workspaceRoot, MCP_LOCAL_LLM_SETTINGS_PATH: settingsPath },
    stderr: 'pipe',
    cwd: process.cwd()
  });
  const client = new Client({ name: 'tool-tester', version: '0.0.1' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(JSON.stringify({ tools: tools.tools.map(t => t.name) }, null, 2));
  const root = workspaceRoot;
  const results = {};
  results.read_file = await callTool(client, 'read_file', { path: 'README.md', maxBytes: 4096 });
  results.list_dir = await callTool(client, 'list_dir', { path: root, maxEntries: 10 });
  results.grep_repo = await callTool(client, 'grep_repo', { root, pattern: 'MCP', maxMatches: 5 });
  results.summarize_path = await callTool(client, 'summarize_path', { path: 'README.md', mode: 'compact' }, 120000);
  results.summarize_repo = await callTool(client, 'summarize_repo', { root, mode: 'compact' }, 120000);
  results.llm_chat_local = await callTool(client, 'llm_chat', { backendRole: 'local', messages: [{ role: 'user', content: 'Reply with ok' }] }, 30000);
  results.llm_chat_sota = await callTool(client, 'llm_chat', { backendRole: 'sota', messages: [{ role: 'user', content: 'Reply with ok' }] }, 30000);
  results.system_profile = await callTool(client, 'system_profile', { detail: 'basic' });
  results.verify_plan = await callTool(client, 'verify_plan', {
    plan_id: 'tester-1',
    context_root: root,
    steps: [
      { id: 's1', title: 'Adapters dir', description: 'Check adapters exist', targets: ['src/adapters/'] },
      { id: 's2', title: 'Missing file', description: 'Should be missing', targets: ['src/does-not-exist.ts'] },
      { id: 's3', title: 'Pattern', description: 'Find class decl', targets: ['optional-pattern:class\\s+OllamaAdapter'] }
    ],
    mode: 'quick'
  }, 60000);
  results.workspace_smoke_test = await callTool(client, 'workspace_smoke_test', { pathHint: 'README.md', mode: 'quick' }, 30000);
  console.log(JSON.stringify({ round: 1, results }, null, 2));

  const results2 = {};
  results2.read_file = await callTool(client, 'read_file', { path: 'IMPLEMENTATION_SUMMARY.md', maxBytes: 4096 });
  results2.list_dir = await callTool(client, 'list_dir', { path: `${root}/src`, maxEntries: 20 });
  results2.grep_repo = await callTool(client, 'grep_repo', { root, pattern: 'workspace', maxMatches: 10 });
  results2.summarize_path = await callTool(client, 'summarize_path', { path: 'implementation_plan_v2.md', mode: 'compact' }, 120000);
  results2.summarize_repo = await callTool(client, 'summarize_repo', { root, mode: 'extended' }, 180000);
  results2.llm_chat_local = await callTool(client, 'llm_chat', { backendRole: 'local', messages: [{ role: 'user', content: 'Say ok' }] }, 30000);
  results2.llm_chat_sota = await callTool(client, 'llm_chat', { backendRole: 'sota', messages: [{ role: 'user', content: 'Say ok' }] }, 30000);
  results2.system_profile = await callTool(client, 'system_profile', { detail: 'extended' });
  results2.verify_plan = await callTool(client, 'verify_plan', {
    plan_id: 'tester-2',
    context_root: root,
    steps: [
      { id: 's1', title: 'Tools dir', description: 'Check tools exist', targets: ['src/tools/'] },
      { id: 's2', title: 'Verify TS file', description: 'Verify file exists', targets: ['src/tools/verify.ts'] },
      { id: 's3', title: 'Grep pattern', description: 'Find workspace method', targets: ['optional-pattern:resolveWorkspacePath'] }
    ],
    mode: 'deep'
  }, 90000);
  results2.workspace_smoke_test = await callTool(client, 'workspace_smoke_test', { pathHint: 'IMPLEMENTATION_SUMMARY.md', mode: 'quick' }, 30000);
  console.log(JSON.stringify({ round: 2, results: results2 }, null, 2));
  await client.close();
}

main().catch(err => {
  console.error('Tool test failed:', err);
  process.exit(1);
});

