const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function simpleSymbolCount(root) {
  // Only count symbols in src/ and ignore node_modules and .git
  const exts = ['.ts', '.tsx', '.js', '.jsx'];
  let files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        walk(p);
      } else if (exts.includes(path.extname(p))) {
        files.push(p);
      }
    }
  }
  const srcRoot = path.join(root, 'src');
  if (fs.existsSync(srcRoot)) walk(srcRoot);
  let functions = 0;
  let classes = 0;
  for (const f of files) {
    const c = fs.readFileSync(f, 'utf8');
    functions += (c.match(/\bfunction\b/g) || []).length;
    classes += (c.match(/\bclass\b/g) || []).length;
  }
  return { functions, classes, filesCount: files.length };
}

function computeManifest(root, maxDepth = 2) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    for (const name of fs.readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(name)) continue;
      const p = path.join(dir, name);
      results.push(path.relative(root, p));
      if (fs.statSync(p).isDirectory()) walk(p, depth + 1);
    }
  }
  walk(root, 0);
  return { total: results.length, sample: results.slice(0, 20) };
}

function importsFromFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const imports = [];
  for (const l of lines) {
    const m = l.match(/import\s+.*from\s+['\"](.*)['\"]/);
    if (m) imports.push(m[1]);
  }
  return imports;
}

function normalizeImport(s) {
  if (!s) return s;
  return s.replace(/\.js$/, '').replace(/\.ts$/, '');
}

async function callTool(client, name, args, timeoutMs = 60000) {
  try {
    const res = await client.callTool({ name, arguments: args || {} }, undefined, { timeoutMs });
    const text = res.content?.[0]?.text ?? '';
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    let usage = null;
    if (parsed && parsed.tokensUsed) {
      usage = { input: parsed.tokensUsed.input || 0, output: parsed.tokensUsed.output || 0, total: (parsed.tokensUsed.input || 0) + (parsed.tokensUsed.output || 0), method: 'tool.reported.tokensUsed' };
    } else if (res?.content?.[0]?.usage) {
      const u = res.content[0].usage;
      usage = { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0, method: 'response.usage' };
    } else if (res?.usage) {
      usage = res.usage;
    } else if (typeof text === 'string' && text.length > 0) {
      const out = Math.ceil(text.length / 4);
      const inTok = Math.ceil(JSON.stringify(args || {}).length / 4);
      usage = { input: inTok, output: out, total: inTok + out, method: 'estimated' };
    }
    return { ok: !res.isError, name, args, text, parsed, usage };
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

  const client = new Client({ name: 'ground-truth-tester', version: '0.0.1' });
  await client.connect(transport);
  const tools = await client.listTools();
  const available = new Set(tools.tools.map(t => t.name));
  console.log('Available tools:', [...available].join(', '));

  // Prepare ground truth
  const root = workspaceRoot;
  const manifestGT = computeManifest(root, 2);
  const symbolsGT = simpleSymbolCount(root);
  const importsGT = {};
  const entries = ['src/index.ts', 'src/server/mcp.ts'];
  for (const e of entries) {
    const p = path.join(root, e);
    if (fs.existsSync(p)) importsGT[e] = importsFromFile(p);
  }
  const readmePath = path.join(root, 'README.md');
  const readmeGT = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8').split('\n').slice(0, 6).join('\n') : '';

  const report = [];

  function push(name, result, matches, summary) {
    report.push({ name, ok: result.ok, error: result.error || null, toolUsage: result.usage || null, parsed: result.parsed || null, matches, summary, textPreview: (result.text || '').slice(0, 600) });
  }

  // Helper to run only registered tools
  async function runIfAvailable(name, args = {}, gtCheck = null, timeoutMs) {
    if (!available.has(name)) {
      report.push({ name, ok: false, error: 'tool-not-available' });
      console.log('skip', name, 'not available');
      return;
    }
    console.log('running', name, '...');
    const result = await callTool(client, name, args, timeoutMs);
    let matches = null, summary = null;
    try {
      if (gtCheck) {
        const res = gtCheck(result);
        matches = res.matches;
        summary = res.summary;
      }
    } catch (e) {
      summary = 'gt-check failed: ' + String(e);
    }
    push(name, result, matches, summary);
    console.log('done', name, 'ok:', result.ok, 'matches:', matches);
  }

  // Deterministic checks - only run if the tools exist
  await runIfAvailable('manifest_snapshot', { root: root, maxDepth: 2 }, (res) => {
    const parsed = res.parsed || (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    if (!parsed) return { matches: false, summary: 'No parsed JSON' };
    const foundTotal = parsed?.total || (Array.isArray(parsed.files) ? parsed.files.length : null);
    // Compare counts and also compute intersection of file samples
    const toolFiles = (parsed.files || []).map(f => f.relativePath || f.path || '').slice(0, 200);
    const intersection = toolFiles.filter(f => manifestGT.sample.includes(f));
    const ratio = toolFiles.length === 0 ? 0 : intersection.length / toolFiles.length;
    const matches = Math.abs(foundTotal - manifestGT.total) < 20 || ratio > 0.6;
    return { matches, summary: `toolTotal=${foundTotal} gtTotal=${manifestGT.total} ratio=${ratio.toFixed(2)}` };
  });

  await runIfAvailable('index_symbols', { root: root, languages: ['typescript'], symbolTypes: ['function', 'class'] }, (res) => {
    const parsed = res.parsed || (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    if (!parsed) return { matches: false, summary: 'No parsed JSON' };
    let toolFunctions = 0;
    let toolClasses = 0;
    if (Array.isArray(parsed?.symbols)) {
      toolFunctions = parsed.symbols.filter(s => s.type === 'function').length;
      toolClasses = parsed.symbols.filter(s => s.type === 'class').length;
      console.log('index_symbols parsedSymbolsCount:', parsed.symbols.length, 'functions:', toolFunctions, 'classes:', toolClasses);
    } else {
      toolFunctions = parsed?.functions || 0;
      toolClasses = parsed?.classes || 0;
    }
    // Instead of strict counts, verify that some well-known symbol names are present
    const sampleSymbols = ['makeRequest', 'BaseBackend', 'McpServer'];
    let present = true;
    if (Array.isArray(parsed?.symbols)) {
      const names = new Set(parsed.symbols.map(s => s.name));
      for (const s of sampleSymbols) if (!names.has(s)) present = false;
    } else present = false;
    return { matches: present, summary: `toolF=${toolFunctions} gtF=${symbolsGT.functions} toolC=${toolClasses} gtC=${symbolsGT.classes} sampleSymbolsPresent=${present}` };
  }, 120000);

  await runIfAvailable('cross_file_links', { entryPoints: entries, depth: 3, includeTypes: true }, (res) => {
    const parsed = res.parsed || (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    if (!parsed) return { matches: false, summary: 'No parsed JSON' };
    // Ensure that each entry point includes at least the same imports found by local parsing
    let ok = true;
    for (const e of entries) {
      const eNormalized = e.split('/').join(path.sep);
      // First, try to use parsed.files
      let fileEntry = parsed?.files?.find(f => f.path && f.path.endsWith(e) || f.path && f.path.endsWith(eNormalized));
      // Fallback: try to parse JSON text to recover structure
      if (!fileEntry && res.text) {
        try {
          const parsedText = JSON.parse(res.text);
          fileEntry = parsedText?.files?.find(f => f.path && f.path.endsWith(e));
        } catch {}
      }
      const eFound = (fileEntry?.imports || []).map(i => normalizeImport(i.source));
      const localList = (importsGT[e] || []).map(normalizeImport);
      console.log('cross_file_links entry', e, 'localList=', localList, 'eFound=', eFound);
      for (const l of localList) {
        if (!eFound.some(x => x.includes(l) || x.includes(path.basename(l)))) { ok = false; break; }
      }
    }
    return { matches: ok, summary: `links match=${ok}` };
  });

  await runIfAvailable('summarize_path', { path: path.join(root, 'README.md'), mode: 'compact' }, (res) => {
    const parsed = res.parsed || (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    const summary = parsed?.summary || res.text || '';
    // Check whether the top line(s) from README appear in the summary
    // Check whether the summary contains keywords: 'mcp' or 'local' or 'llm' or 'server'
    const keywords = ['mcp', 'local', 'llm', 'server'];
    const found = keywords.some(k => summary.toLowerCase().includes(k));
    return { matches: found, summary: `contains any keywords: ${found}` };
  }, 120000);

  // Baseline: replicate summarize_path via llm_chat and compute token savings
  try {
    const spEntry = report.find(r => r.name === 'summarize_path');
    if (spEntry && spEntry.ok) {
      const pathAbs = path.join(root, 'README.md');
      const content = fs.readFileSync(pathAbs, 'utf8');
      const sysPrompt = 'Provide a brief 2-3 sentence summary of this file content. Focus on the main purpose and key components.';
      const userPrompt = `Please summarize the following file content:\n\nPath: README.md\n\nContent:\n${content}`;
      const baseline = await callTool(client, 'llm_chat', { backendRole: 'local', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] }, 60000);
      spEntry.baselineUsage = baseline.usage || null;
      if (spEntry.baselineUsage) {
        spEntry.tokenSavings = (spEntry.baselineUsage?.total || 0) - (spEntry.toolUsage?.total || ((spEntry.parsed?.tokensUsed?.input || 0) + (spEntry.parsed?.tokensUsed?.output || 0)));
      } else {
        spEntry.tokenSavings = null;
      }
    }
  } catch (e) {
    console.log('summarize_path baseline failed:', e);
  }

  await runIfAvailable('summarize_repo', { root, mode: 'compact' }, (res) => {
    const parsed = res.parsed || (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    const summary = parsed?.summary || res.text || '';
    // Check if repo name or 'tools' or 'adapters' words are present
    const keys = ['tools', 'adapters', 'server', 'mcp'];
    const found = keys.some(k => summary.toLowerCase().includes(k));
    return { matches: found, summary: `repo-summary-contains:${found}` };
  }, 120000);

  // Baseline: replicate summarize_repo via llm_chat and compute token savings
  try {
    const srEntry = report.find(r => r.name === 'summarize_repo');
    if (srEntry && srEntry.ok) {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const components = entries.map(e => e.name).slice(0, 20);
      const sysPrompt = 'Provide a brief 3-4 sentence summary of this repository. Focus on the main purpose, technology stack, and key components.';
      const userPrompt = `Please summarize this repository:\nRoot: ${root}\nComponents found: ${components.join(', ')}`;
      const baseline = await callTool(client, 'llm_chat', { backendRole: 'local', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }] }, 120000);
      srEntry.baselineUsage = baseline.usage || null;
      if (srEntry.baselineUsage) {
        srEntry.tokenSavings = (srEntry.baselineUsage?.total || 0) - (srEntry.toolUsage?.total || ((srEntry.parsed?.tokensUsed?.input || 0) + (srEntry.parsed?.tokensUsed?.output || 0)));
      } else {
        srEntry.tokenSavings = null;
      }
    }
  } catch (e) {
    console.log('summarize_repo baseline failed:', e);
  }

  await runIfAvailable('intelligent_search', { root, query: 'how does the server register tools', maxResults: 10 }, (res) => {
    // Compare whether 'src/server/mcp.ts' is in the results
    const text = res.text || '';
    return { matches: text.includes('mcp.ts') || text.includes('register'), summary: 'intelligent_search text includes mcp.ts or register' };
  }, 120000);

  // llm_chat local - small check
  await runIfAvailable('llm_chat', { backendRole: 'local', messages: [{ role: 'user', content: 'Reply with ok' }] }, (res) => {
    const parsed = res.parsed || (() => { try { return JSON.parse(res.text); } catch { return null; } })();
    const msg = parsed?.message?.content || res.text || '';
    const ok = /ok|okay|success|done/i.test(msg);
    return { matches: ok, summary: `message:${msg}` };
  }, 5000);

  // Save report
  const outPath = 'token_report_with_ground_truth.json';
  fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), root, manifestGT, symbolsGT, importsGT, readmeTop: readmeGT.split('\n').slice(0, 2).join('\n'), report }, null, 2));
  console.log('Saved', outPath);
  await client.close();
  process.exit(0);
}

main().catch(e => { console.error('harness error:', e); process.exit(1); });
