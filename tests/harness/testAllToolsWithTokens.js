const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function callTool(client, name, args, timeoutMs = 60000) {
  try {
    const res = await client.callTool({ name, arguments: args || {} }, undefined, { timeoutMs });
    const text = res.content?.[0]?.text ?? '';

    // Attempt to parse JSON output text from tool responses
    let parsedContent = null;
    try { parsedContent = JSON.parse(text); } catch (e) { parsedContent = null; }

    // Gather usage info from parsedContent (if present) or from Chat response usage
    let usage = null;

    if (parsedContent && parsedContent.tokensUsed) {
      usage = {
        input: parsedContent.tokensUsed.input || 0,
        output: parsedContent.tokensUsed.output || 0,
        total: (parsedContent.tokensUsed.input || 0) + (parsedContent.tokensUsed.output || 0),
        method: 'tool.reported.tokensUsed'
      };
    } else if (res?.content?.[0]?.usage) {
      usage = {
        prompt_tokens: res.content[0].usage.prompt_tokens || 0,
        completion_tokens: res.content[0].usage.completion_tokens || 0,
        total_tokens: res.content[0].usage.total_tokens || 0,
        method: 'response.usage'
      };
    } else if (res?.usage) {
      usage = res.usage || null;
    } else if (typeof text === 'string' && text.length > 0) {
      // Heuristic estimation: tokens = chars / 4
      const outputTokensEstimate = Math.ceil(text.length / 4);
      // Input tokens estimate from JSON args
      const inputTokensEstimate = Math.ceil(JSON.stringify(args || {}).length / 4);
      usage = { input: inputTokensEstimate, output: outputTokensEstimate, total: inputTokensEstimate + outputTokensEstimate, method: 'estimated' };
    }

    return { ok: !res.isError, name, args, text: text, parsed: parsedContent, usage };
  } catch (e) {
    return { ok: false, name, args, error: String(e) };
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

  console.log('Available tools:', tools.tools.map(t => t.name).join(', '));

  const root = workspaceRoot;
  const report = [];

  // Helper to run a tool and store result
  async function run(name, args = {}, timeoutMs) {
    const start = Date.now();
    const res = await callTool(client, name, args, timeoutMs);
    const duration = Date.now() - start;
    const out = { name, ok: res.ok, duration, args, error: res.error ?? null, textPreview: (res.text || '').slice(0, 200), usage: res.usage || null, parsed: res.parsed || null };
    report.push(out);
    console.log(`Tool: ${name} | ok: ${out.ok} | dur: ${out.duration}ms | usage: ${JSON.stringify(out.usage)}`);
    return out;
  }

  // ==========================
  // Round 1 - Basic set
  // ==========================
  await run('read_file', { path: 'README.md', maxBytes: 4096 });
  await run('list_dir', { path: root, maxEntries: 10 });
  await run('manifest_snapshot', { root, maxDepth: 2 });
  await run('index_symbols', { root, languages: ['typescript'], symbolTypes: ['function', 'class'] });
  await run('cross_file_links', { entryPoints: ['src/index.ts', 'src/server/mcp.ts'], depth: 3, includeTypes: true });
  await run('gather_context', { query: 'cross-file links starting from entry points', path: root, scope: 'repo', maxFiles: 10, strategy: 'relevant' }, 120000);

  // ==========================
  // Round 2 - LLM-powered
  // ==========================
  await run('summarize_path', { path: 'README.md', mode: 'compact' }, 120000);
  await run('summarize_repo', { root, mode: 'compact' }, 120000);
  await run('intelligent_search', { root, query: 'how does the server register tools', maxResults: 10 }, 120000);

  // LLM chat local & SOTA tests
  try {
    const localChat = await run('llm_chat', { backendRole: 'local', messages: [{ role: 'user', content: 'Reply with ok' }] }, 30000);
  } catch (e) {
    console.error('llm_chat local failed', e);
  }
  try {
    const sotaChat = await run('llm_chat', { backendRole: 'sota', messages: [{ role: 'user', content: 'Reply with ok' }] }, 30000);
  } catch (e) {
    console.error('llm_chat sota failed', e);
  }

  // ==========================
  // Round 3 - High value & analysis
  // ==========================
  await run('aggregate_todos', { root, groupBy: 'file', includeContext: false, maxResults: 50 });
  await run('secret_scan', { root, scanType: 'both', outputFormat: 'summary' }, 120000);
  await run('analyze_test_gaps', { root, testPatterns: ['tests/**/*.test.ts'], sourcePatterns: ['src/**/*.ts'] }, 120000);

  // ==========================
  // Auto-fix (dry run)
  // ==========================
  await run('fix_linter', { root, difficulty: 'easy', dryRun: true, maxFixes: 10 }, 120000);
  await run('fix_syntax', { paths: [root], difficulty: 'easy', dryRun: true, maxFixes: 10 }, 120000);
  await run('implement_todos', { root, difficulty: 'easy', dryRun: true, maxTodos: 5 }, 120000);

  // ==========================
  // Plan & verify
  // ==========================
  await run('verify_plan', {
    plan_id: 'tester-automated-1',
    context_root: root,
    steps: [
      { id: 's1', title: 'Check server file', description: 'Ensure server imports tools', targets: ['src/server/mcp.ts'] },
      { id: 's2', title: 'Check adapters', description: 'Confirm all adapters exist', targets: ['src/adapters'] }
    ],
    mode: 'quick'
  }, 60000);

  // Save report
  fs.writeFileSync('token_report.json', JSON.stringify({ timestamp: new Date().toISOString(), root, report }, null, 2));
  console.log('Saved token_report.json');

  await client.close();
  process.exit(0);
}

main().catch(err => { console.error('Test harness failed:', err); process.exit(1); });
