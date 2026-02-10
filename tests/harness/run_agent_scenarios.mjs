import { ConfigManager } from '../dist/config/index.js';
import { BackendManager } from '../dist/adapters/factory.js';
import { FileTools } from '../dist/tools/file.js';
import { GrepTools } from '../dist/tools/grep.js';
import { LlmChatTool } from '../dist/tools/llm.js';
import { SummarizationTools } from '../dist/tools/summarize.js';
import { EditTools } from '../dist/tools/edit.js';
import { McpClientManager } from '../dist/utils/mcp-client.js';
import { AgentRunner } from '../dist/agent/runner.js';

async function isLocalServerRunning(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1200);
    try {
      const r = await fetch(url, { signal: controller.signal });
      return !!r && (r.status >= 200 && r.status < 500);
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

async function main() {
  const settingsPath =
    process.env.MCP_LOCAL_LLM_SETTINGS_PATH || process.env.MCP_LOCAL_LLM_CONFIG || './env.settings';
  const cfg = new ConfigManager(settingsPath);
  const envLocalBackendId = process.env.MCP_LOCAL_LLM_BACKEND_ID;
  const envLocalModel = process.env.MCP_LOCAL_LLM_MODEL;
  if (envLocalBackendId) cfg.getConfig().defaults.localBackendId = envLocalBackendId;
  if (envLocalModel !== undefined) cfg.getConfig().defaults.localModel = envLocalModel || undefined;

  // Convenience: if you set MCP_LOCAL_LLM_BACKEND_ID=lmstudio but your config doesn't list it,
  // auto-inject an LM Studio backend definition so the scenario runner "just works".
  if (cfg.getConfig().defaults.localBackendId === 'lmstudio') {
    const backends = cfg.getConfig().backends || [];
    const hasLmStudio = backends.some((b) => b?.id === 'lmstudio');
    if (!hasLmStudio) {
      backends.push({
        id: 'lmstudio',
        type: 'lmstudio',
        base_url: process.env.MCP_LOCAL_LLM_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
        labels: { priority: 'primary' },
      });
      cfg.getConfig().backends = backends;
    }
  }

  const bm = new BackendManager(cfg.getConfig().backends);
  const llm = new LlmChatTool(bm, cfg);

  // Ensure the intended model is used (as requested)
  const localId = cfg.getConfig().defaults.localBackendId;
  const localModel = cfg.getConfig().defaults.localModel;
  console.log(`[agent] local backend=${localId} model=${localModel || '(auto)'}`);

  const fileTools = new FileTools(cfg);
  const grepTools = new GrepTools(cfg);
  const summarization = new SummarizationTools(fileTools, llm);
  const editTools = new EditTools(cfg);
  const mcpClient = new McpClientManager(cfg.getConfig().mcpServers);
  const runner = new AgentRunner({
    config: cfg,
    llmChat: llm,
    fileTools,
    grepTools,
    summarization,
    editTools,
    mcpClient,
  });

  const workspaceRoot = cfg.getDefaultWorkspaceRoot();
  const writeRoot = '.mcp_cache/agent_scenarios';

  const scenarios = [
    {
      id: 's1',
      title: 'Repo audit (read-only)',
      requiresLocalServer: false,
      task:
        'Complex repo task (read-only): Audit this repo for outdated MCP connection types (sse/websocket). ' +
        'Search ALL markdown/docs/readmes present (do not assume a /docs folder exists). ' +
        'Produce a report listing files + snippets + suggested updates. Also verify chrome-devtools examples include --isolated.',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 6,
        maxSteps: 14,
        maxActionsPerStep: 8,
        readOnly: true,
      },
    },
    {
      id: 's2',
      title: 'Browser automation (chrome-devtools)',
      requiresLocalServer: false,
      task:
        'Complex browser task: Using the chrome-devtools MCP server, open https://github.com, ' +
        'take a full-page screenshot, and save it to .mcp_cache/agent_scenarios/github.png. Then report the saved file path.',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 4,
        maxSteps: 10,
        maxActionsPerStep: 10,
        readOnly: true,
        writeAllowlistPaths: [`${writeRoot}/github.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'done'],
      },
    },
    {
      id: 's3',
      title: 'API inventory artifact (write to cache)',
      requiresLocalServer: false,
      task:
        'Complex repo task: Generate a JSON inventory of ALL HTTP API routes (method + path) implemented by this project. ' +
        'Use src/server/http.ts as the source of truth and prefer generate_api_inventory. ' +
        `Write the file to ${writeRoot}/api_inventory.json, then read it back and verify it is a non-empty JSON array.`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 4,
        maxSteps: 8,
        maxActionsPerStep: 8,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/api_inventory.json`],
        allowedActions: ['generate_api_inventory', 'read_file', 'done'],
      },
    },
    {
      id: 's4',
      title: 'MCP servers API roundtrip (requires localhost:3000)',
      requiresLocalServer: true,
      task:
        'Very complex integration task: Use ONLY http_request to manage MCP servers via the running local server (no file reads, no repo search). ' +
        '1) GET http://127.0.0.1:3000/api/mcp-servers and record the current object. ' +
        "2) Add a temporary server named 'echo-test' with type stdio, command 'node', args ['-e','console.log(\"ok\")']. " +
        "3) Ensure existing 'chrome-devtools' args includes '--isolated' exactly once (no duplicates). " +
        '4) PUT the updated object to http://127.0.0.1:3000/api/mcp-servers. ' +
        '5) GET again and verify changes applied. ' +
        "6) DELETE http://127.0.0.1:3000/api/mcp-servers/echo-test and verify it's removed. " +
        'Return a concise summary of each step and whether it succeeded.',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 2,
        maxSteps: 10,
        maxActionsPerStep: 10,
        readOnly: true,
        allowedActions: ['http_request', 'done'],
      },
    },
    {
      id: 's5',
      title: 'Chrome DevTools schema cheat-sheet (write to cache)',
      requiresLocalServer: false,
      task:
        'Very complex MCP task: Connect to chrome-devtools. ' +
        'Generate a cheat-sheet JSON directly from the MCP tool schemas. ' +
        'Create a cheat-sheet JSON containing at least these tools: new_page, navigate_page, wait_for, evaluate_script, take_screenshot. ' +
        `Save ONLY ONE file to ${writeRoot}/chrome_devtools_cheatsheet.json (prefer mcp_generate_cheatsheet; no other files, no scripts, no installs).`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 2,
        maxSteps: 6,
        maxActionsPerStep: 8,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/chrome_devtools_cheatsheet.json`],
        allowedActions: ['mcp_generate_cheatsheet', 'mcp_list_tools', 'mcp_call', 'done'],
      },
    },
    {
      id: 's6',
      title: 'Security/permissions audit (read-only)',
      requiresLocalServer: false,
      task:
        'Very complex repo task (read-only): Audit security posture for file and network access. ' +
        'Identify (with file references) where the code enforces: workspace allowlists, max file bytes, temp-only artifact copy, ' +
        'and any external network calls. Then propose 3 concrete improvements with exact code locations.',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 7,
        maxSteps: 16,
        maxActionsPerStep: 10,
        readOnly: true,
      },
    },
    {
      id: 's7',
      title: 'Web UI smoke test via chrome-devtools (screenshot)',
      requiresLocalServer: true,
      task:
        'Very complex UI automation task: Use ONLY the chrome-devtools MCP server tools to automate the browser. ' +
        'First, list the chrome-devtools tools and read the inputSchema for the navigation and screenshot tools; do NOT guess parameter names. ' +
        'Then open http://127.0.0.1:3000/ (new_page or navigate_page), wait until the page contains text like \"MCP servers\" ' +
        'or \"Loading MCP servers\" (use wait_for), then take a full-page screenshot (take_screenshot) and save it to ' +
        `${writeRoot}/ui_mcp_servers.png. Return the absolute saved file path.`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 12,
        maxActionsPerStep: 12,
        readOnly: true,
        writeAllowlistPaths: [`${writeRoot}/ui_mcp_servers.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'done'],
      },
    },
    {
      id: 's8',
      title: 'Settings + restart roundtrip (requires localhost:3000)',
      requiresLocalServer: true,
      task:
        'Very complex integration task: Use ONLY http_request to validate settings persistence and restart behavior. ' +
        '1) GET http://127.0.0.1:3000/api/settings and record settings.advanced.exposeSystemProfile (boolean). ' +
        '2) POST http://127.0.0.1:3000/api/settings with { "advanced": { "exposeSystemProfile": <toggled> } }. ' +
        '3) POST http://127.0.0.1:3000/api/restart. ' +
        '4) Poll GET http://127.0.0.1:3000/api/health until it returns 200 (retry up to 10 times with backoff). ' +
        '5) GET /api/settings again and verify the toggle persisted. ' +
        '6) Revert the setting to the original value and confirm. ' +
        'Return a concise step-by-step PASS/FAIL and any error messages.',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 4,
        maxSteps: 14,
        maxActionsPerStep: 10,
        readOnly: true,
        allowedActions: ['http_request', 'done'],
      },
    },
    {
      id: 's9',
      title: 'MCP servers persist to env.settings (API + file verify)',
      requiresLocalServer: true,
      task:
        'Very complex integration task: Use http_request + read_file to verify MCP servers updates persist to env.settings. ' +
        '1) GET http://127.0.0.1:3000/api/mcp-servers and record the object as original. ' +
        "2) Choose a temporary unique server name starting with 'echo-test-' that does not already exist in the object. " +
        "3) PUT http://127.0.0.1:3000/api/mcp-servers with the updated object (add your temp server: type stdio, command node, args ['-e','console.log(\"ok\")']). " +
        "4) Read env.settings and verify the temp server name appears AND that the 'chrome-devtools' args contain '--isolated' exactly once. " +
        '5) DELETE http://127.0.0.1:3000/api/mcp-servers/<tempName>. ' +
        '6) Read env.settings again and verify the temp server is removed. ' +
        `7) Write a JSON report of each step to ${writeRoot}/mcp_servers_roundtrip_report.json (include timestamps + any errors).`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 5,
        maxSteps: 18,
        maxActionsPerStep: 10,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/mcp_servers_roundtrip_report.json`],
        allowedActions: ['http_request', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's10',
      title: 'Agent action/security map (write to cache)',
      requiresLocalServer: false,
      task:
        'Very complex repo task: Build a machine-readable JSON map of the agent action system and its security constraints. ' +
        'For each actionType supported by the agent, include: (a) where it is executed (file + approx location), ' +
        '(b) what inputs it expects, (c) what security checks apply (workspace allowlist, localhost-only HTTP, read-only guardrails, etc.). ' +
        `Write the JSON to ${writeRoot}/agent_action_map.json and make sure it contains at least 10 actionType entries.`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 10,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/agent_action_map.json`],
        allowedActions: ['search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's11',
      title: 'Chrome DevTools alias robustness (tool + arg aliases)',
      requiresLocalServer: false,
      task:
        'Very complex MCP robustness task: Use ONLY chrome-devtools via mcp_call. ' +
        '1) mcp_list_tools chrome-devtools and identify the canonical parameter names for new_page, navigate_page, evaluate_script, wait_for, take_screenshot. ' +
        "2) Intentionally try calling: (a) new_page via toolName 'open_page' and argument key 'uri' (not 'url'), " +
        "(b) evaluate_script using argument key 'code' (not 'function'), and (c) take_screenshot using keys 'path' + 'full' (not 'filePath' + 'fullPage'). " +
        'If any of these calls fail schema validation, retry using the canonical schema keys. ' +
        `Save a screenshot to ${writeRoot}/alias_robustness.png and return the absolute saved file path, plus a short JSON summary of which alias calls worked without retry.`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 4,
        maxSteps: 14,
        maxActionsPerStep: 12,
        readOnly: true,
        writeAllowlistPaths: [`${writeRoot}/alias_robustness.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'done'],
      },
    },
    {
      id: 's12',
      title: 'UI + API reconciliation (browser + http + artifacts)',
      requiresLocalServer: true,
      task:
        'Very complex end-to-end task: Compare MCP servers as shown in the Web UI vs the HTTP API. ' +
        '1) GET http://127.0.0.1:3000/api/mcp-servers and record the server names (keys). ' +
        '2) Using chrome-devtools, open http://127.0.0.1:3000/ and wait until the UI shows the external MCP servers list (wait_for for the text \"External MCP Servers\" and also for one known server name). ' +
        '3) Use evaluate_script to extract ONLY the text content of #mcp-servers-content (or an equivalent container), and confirm the API server names appear in that text. ' +
        `4) Take a full-page screenshot and save it to ${writeRoot}/ui_api_reconciliation.png. ` +
        `5) Write a JSON reconciliation report to ${writeRoot}/ui_api_reconciliation.json with fields: apiServers (array), uiContainsAllApiServers (boolean), missingInUi (array), rawUiSnippet (string, <= 400 chars).`,
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/ui_api_reconciliation.json`, `${writeRoot}/ui_api_reconciliation.png`],
        allowedActions: ['http_request', 'mcp_list_tools', 'mcp_call', 'write_json_file', 'done'],
      },
    },
    // =============================================
    // Context7 MCP Scenarios (Library Documentation)
    // =============================================
    {
      id: 's13',
      title: 'Zod schema validation check via Context7',
      requiresLocalServer: false,
      task:
        'Library documentation task: Use Context7 MCP to verify our zod usage is current and follows best practices. ' +
        '1) Connect to context7 MCP server and list available tools. ' +
        '2) Use resolve-library-id to get the Context7 ID for "zod". ' +
        '3) Use get-library-docs with topic "schema validation" to get current zod documentation. ' +
        '4) Search our codebase for zod schema definitions (look for z.object, z.string, etc. in src/**/*.ts). ' +
        '5) Compare our zod usage patterns against the documentation to identify any deprecated methods or outdated patterns. ' +
        `6) Write a JSON report to ${writeRoot}/zod_validation_report.json with fields: ` +
        'context7LibraryId (string), ourUsageLocations (array of {file, line, pattern}), ' +
        'deprecatedPatterns (array), recommendedUpdates (array), status (CURRENT|OUTDATED|NEEDS_REVIEW).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 14,
        maxActionsPerStep: 10,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/zod_validation_report.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's14',
      title: 'MCP SDK deprecation check via Context7',
      requiresLocalServer: false,
      task:
        'Complex deprecation audit task: Use Context7 to check if our @modelcontextprotocol/sdk usage is current. ' +
        '1) Connect to context7 and resolve the library ID for "@modelcontextprotocol/sdk". ' +
        '2) Get documentation with topic "client" to check client API patterns. ' +
        '3) Search our codebase for imports from @modelcontextprotocol/sdk (src/utils/mcp-client.ts and tests). ' +
        '4) Read our mcp-client.ts implementation and compare against current SDK documentation. ' +
        '5) Identify any deprecated methods (like old transport APIs, removed options, or changed signatures). ' +
        `6) Write findings to ${writeRoot}/mcp_sdk_deprecation_report.json with: ` +
        'libraryVersion (from package.json if found), deprecatedUsages (array with file, line, oldPattern, newPattern), ' +
        'breakingChanges (array), migrationSteps (array), overallStatus (UP_TO_DATE|MINOR_UPDATES|MAJOR_MIGRATION).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 16,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/mcp_sdk_deprecation_report.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's15',
      title: 'Vitest test patterns validation via Context7',
      requiresLocalServer: false,
      task:
        'Test framework best practices task: Use Context7 to validate our Vitest test patterns. ' +
        '1) Connect to context7 and resolve the library ID for "vitest". ' +
        '2) Get documentation with topic "testing patterns" or "describe it expect". ' +
        '3) Search our tests/ directory for test files (*.test.ts). ' +
        '4) Read at least 3 different test files to analyze our testing patterns. ' +
        '5) Compare our patterns against Vitest best practices from documentation. ' +
        '6) Check for: proper async/await handling, beforeAll/afterAll cleanup, timeout configurations, ' +
        'mock/spy patterns, and snapshot testing usage. ' +
        `7) Write a comprehensive report to ${writeRoot}/vitest_patterns_report.json with: ` +
        'analyzedFiles (array), goodPracticesFound (array with file and pattern), ' +
        'improvementOpportunities (array with file, line, issue, recommendation), ' +
        'deprecatedVitestFeatures (array), summary (string).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/vitest_patterns_report.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's16',
      title: 'Express/Fastify HTTP handler patterns via Context7',
      requiresLocalServer: false,
      task:
        'HTTP framework patterns task: Analyze our HTTP server implementation against current best practices. ' +
        '1) Read src/server/http.ts to identify which HTTP framework we use (likely native http or express patterns). ' +
        '2) Connect to context7 and resolve library IDs for both "express" and "node http". ' +
        '3) Get documentation for error handling and middleware patterns. ' +
        '4) Analyze our HTTP handler implementations for: proper error handling, async route handlers, ' +
        'request validation, response formatting, CORS handling, and security headers. ' +
        '5) Identify any deprecated http module APIs or patterns that should be updated. ' +
        `6) Write a detailed report to ${writeRoot}/http_patterns_report.json with: ` +
        'framework (string), routeHandlersAnalyzed (number), errorHandlingScore (0-10), ' +
        'deprecatedApis (array with location and deprecatedPattern), ' +
        'securityIssues (array), recommendedImprovements (array with priority and description).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 16,
        maxActionsPerStep: 10,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/http_patterns_report.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's17',
      title: 'TypeScript AST patterns via Context7',
      requiresLocalServer: false,
      task:
        'TypeScript AST best practices task: Check our TypeScript usage patterns against current recommendations. ' +
        '1) Connect to context7 and resolve the library ID for "typescript". ' +
        '2) Get documentation with topics covering: type inference, generics, utility types, and strict mode. ' +
        '3) Search our src/ directory for TypeScript patterns: interfaces, types, generics, enums, and type assertions. ' +
        '4) Read key type definition files (src/types/*.ts if exists, or type definitions in main source files). ' +
        '5) Analyze for: proper use of unknown vs any, readonly modifiers, discriminated unions, ' +
        'template literal types, satisfies operator usage, and const assertions. ' +
        '6) Check for deprecated TypeScript patterns (old-style enums, namespace, module declarations). ' +
        `7) Write a TypeScript quality report to ${writeRoot}/typescript_patterns_report.json with: ` +
        'filesAnalyzed (array), typeDefCount (number), anyUsageCount (number), unknownUsageCount (number), ' +
        'deprecatedPatterns (array with file, line, pattern, modernAlternative), ' +
        'typeScriptVersion (from tsconfig.json), strictModeEnabled (boolean), ' +
        'recommendations (array with category and suggestion).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 20,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/typescript_patterns_report.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    // =============================================
    // Complex E2E Scenarios (Chrome DevTools + Context7 + LM Studio)
    // =============================================
    {
      id: 's18',
      title: 'Full-stack docs validation (Context7 + Browser screenshot)',
      requiresLocalServer: true,
      task:
        'Complex multi-MCP task: Validate our documentation against library docs and capture visual proof. ' +
        '1) Use context7 to resolve library ID for "express" and get documentation about middleware patterns. ' +
        '2) Search our README.md and README-MCP.md for mentions of middleware, CORS, or routing. ' +
        '3) Compare our documented patterns vs official express docs from Context7. ' +
        '4) Use chrome-devtools to open http://127.0.0.1:3000/ and take a screenshot of the configuration page. ' +
        '5) Use evaluate_script to extract the page title and any visible backend configuration. ' +
        `6) Write a validation report to ${writeRoot}/docs_validation_report.json with: ` +
        'expressLibraryId (string), ourDocMentions (array), matchesOfficialDocs (boolean), ' +
        'screenshotPath (string), pageTitle (string), discrepancies (array).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 16,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/docs_validation_report.json`, `${writeRoot}/docs_validation_screenshot.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's19',
      title: 'Live API + Context7 SDK validation',
      requiresLocalServer: true,
      task:
        'Complex integration task: Verify our HTTP API implementation matches MCP SDK documentation. ' +
        '1) Use context7 to get documentation for "@modelcontextprotocol/sdk" with topic "server" or "tools". ' +
        '2) GET http://127.0.0.1:3000/api/tools to fetch our actual tool list. ' +
        '3) Compare our tool schemas against MCP SDK expected formats from Context7 docs. ' +
        '4) Use chrome-devtools to open http://127.0.0.1:3000/, navigate to Tool Governance tab (click on it). ' +
        '5) Take a screenshot of the tool governance page showing enabled tools. ' +
        '6) Use evaluate_script to count how many tool cards are displayed in the UI. ' +
        `7) Write a comprehensive report to ${writeRoot}/api_sdk_validation.json with: ` +
        'sdkDocsRetrieved (boolean), apiToolCount (number), uiToolCount (number), ' +
        'toolsMatchingSdkFormat (array), toolsNeedingUpdate (array), screenshotPath (string).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/api_sdk_validation.json`, `${writeRoot}/tool_governance_screenshot.png`],
        allowedActions: ['http_request', 'mcp_list_tools', 'mcp_call', 'write_json_file', 'done'],
      },
    },
    {
      id: 's20',
      title: 'YAML config validation against library docs',
      requiresLocalServer: false,
      task:
        'Complex configuration audit: Validate our YAML configuration against js-yaml library best practices. ' +
        '1) Use context7 to resolve library ID for "js-yaml" or "yaml". ' +
        '2) Get documentation about YAML parsing, schema options, and security considerations. ' +
        '3) Read our env.settings and env.settings.example files. ' +
        '4) Search src/ for how we parse YAML (look for yaml.load, yaml.parse, etc.). ' +
        '5) Check if we use safe loading options as recommended by the library docs. ' +
        '6) Use chrome-devtools to open file:// URL of our env.settings.example (or skip if not supported). ' +
        `7) Write a security audit report to ${writeRoot}/yaml_config_audit.json with: ` +
        'yamlLibraryId (string), parsingLocations (array with file and line), ' +
        'usesSafeLoad (boolean), securityIssues (array), recommendations (array).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 16,
        maxActionsPerStep: 10,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/yaml_config_audit.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's21',
      title: 'Package.json dependencies audit with Context7',
      requiresLocalServer: false,
      task:
        'Complex dependency audit: Check our major dependencies against their latest documentation. ' +
        '1) Read package.json to extract our dependencies and devDependencies. ' +
        '2) For each of these libraries: zod, express, vitest - use context7 resolve-library-id. ' +
        '3) Get documentation for each library focusing on "breaking changes" or "migration". ' +
        '4) Search our codebase for usage patterns of each library. ' +
        '5) Compare our versions (from package.json) vs documented latest features. ' +
        `6) Write a dependency audit report to ${writeRoot}/dependency_audit.json with: ` +
        'dependencies (array of {name, version, context7Id, latestFeatures, ourUsageCount}), ' +
        'outdatedPatterns (array), migrationNeeded (boolean), prioritizedUpdates (array).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 20,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/dependency_audit.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's22',
      title: 'Browser-based MCP server discovery + docs lookup',
      requiresLocalServer: true,
      task:
        'Complex discovery task: Use browser to explore our UI and validate with Context7 docs. ' +
        '1) Use chrome-devtools to open http://127.0.0.1:3000/ and wait for the page to load. ' +
        '2) Use take_snapshot to get the accessibility tree and identify all interactive elements. ' +
        '3) Click on "Model Capabilities" tab and take a screenshot. ' +
        '4) Use evaluate_script to extract any model names or backend IDs shown. ' +
        '5) Use context7 to look up documentation for "lmstudio" or "ollama" (our backend types). ' +
        '6) Compare what our UI shows vs official backend documentation. ' +
        `7) Write discovery report to ${writeRoot}/mcp_discovery_report.json with: ` +
        'uiElements (array), modelCapabilitiesScreenshot (string), backendsFound (array), ' +
        'context7DocsAvailable (boolean), uiAccuracyScore (0-10).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/mcp_discovery_report.json`, `${writeRoot}/model_capabilities_screenshot.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'write_json_file', 'done'],
      },
    },
    {
      id: 's23',
      title: 'End-to-end test coverage analysis with docs',
      requiresLocalServer: false,
      task:
        'Complex test analysis: Analyze our test coverage against Vitest best practices. ' +
        '1) Use context7 to get Vitest documentation about "coverage" and "test organization". ' +
        '2) Search tests/ directory for all test files and count them. ' +
        '3) Read vitest.config.ts to understand our test configuration. ' +
        '4) Search for describe, it, test, expect patterns to estimate test count. ' +
        '5) Check if we have beforeAll/afterAll cleanup patterns as recommended. ' +
        '6) Search for mock or spy usage patterns. ' +
        `7) Write test coverage analysis to ${writeRoot}/test_coverage_analysis.json with: ` +
        'totalTestFiles (number), estimatedTestCount (number), configuredCoverage (boolean), ' +
        'hasCleanupPatterns (boolean), mockUsageCount (number), ' +
        'vitestDocsRecommendations (array), complianceScore (0-100).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/test_coverage_analysis.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's24',
      title: 'Multi-page browser workflow + API verification',
      requiresLocalServer: true,
      task:
        'Complex browser automation: Navigate multiple tabs and verify API consistency. ' +
        '1) Use chrome-devtools new_page to open http://127.0.0.1:3000/ (Configuration tab). ' +
        '2) Take a screenshot of the Configuration page. ' +
        '3) GET http://127.0.0.1:3000/api/settings to fetch current settings via API. ' +
        '4) Use evaluate_script to read the "Local Backend" dropdown selected value from the UI. ' +
        '5) Compare: does the API localBackendId match what the UI dropdown shows? ' +
        '6) Click on "Scenarios" tab (if visible) and take another screenshot. ' +
        '7) GET http://127.0.0.1:3000/api/health to verify server is still responsive. ' +
        `8) Write consistency report to ${writeRoot}/ui_api_consistency.json with: ` +
        'configScreenshot (string), scenariosScreenshot (string), apiBackendId (string), ' +
        'uiBackendId (string), isConsistent (boolean), healthStatus (string).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [
          `${writeRoot}/ui_api_consistency.json`,
          `${writeRoot}/config_page_screenshot.png`,
          `${writeRoot}/scenarios_page_screenshot.png`,
        ],
        allowedActions: ['http_request', 'mcp_list_tools', 'mcp_call', 'write_json_file', 'done'],
      },
    },
    {
      id: 's25',
      title: 'Security headers audit via browser + docs',
      requiresLocalServer: true,
      task:
        'Complex security audit: Check our HTTP security headers against best practices. ' +
        '1) Use chrome-devtools to navigate to http://127.0.0.1:3000/ and capture network requests. ' +
        '2) Use context7 to get documentation for "helmet" or "express security headers". ' +
        '3) Use list_network_requests to see all requests made during page load. ' +
        '4) GET http://127.0.0.1:3000/api/health and examine response headers. ' +
        '5) Check for presence of: Content-Security-Policy, X-Content-Type-Options, X-Frame-Options. ' +
        '6) Compare our headers against Context7 security documentation recommendations. ' +
        `7) Write security audit to ${writeRoot}/security_headers_audit.json with: ` +
        'headersFound (array), missingRecommendedHeaders (array), ' +
        'securityScore (0-10), context7Recommendations (array), networkRequestCount (number).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 18,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/security_headers_audit.json`],
        allowedActions: ['http_request', 'mcp_list_tools', 'mcp_call', 'write_json_file', 'done'],
      },
    },
    {
      id: 's26',
      title: 'Form interaction test with library validation',
      requiresLocalServer: true,
      task:
        'Complex form automation: Test UI form interactions and validate patterns. ' +
        '1) Use chrome-devtools to open http://127.0.0.1:3000/ and wait for page load. ' +
        '2) Use take_snapshot to identify form elements (textboxes, dropdowns, buttons). ' +
        '3) Find the "Add MCP Server" button and click it. ' +
        '4) Take a screenshot showing the new form fields that appeared. ' +
        '5) Use context7 to get documentation for "form validation" or "zod" validation patterns. ' +
        '6) Search our codebase for how we validate MCP server configuration (zod schemas). ' +
        '7) Compare our validation approach vs Context7 best practices. ' +
        `8) Write form test report to ${writeRoot}/form_interaction_test.json with: ` +
        'formElementsFound (number), addButtonClicked (boolean), screenshotPath (string), ' +
        'validationPatternUsed (string), matchesBestPractices (boolean), suggestions (array).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 6,
        maxSteps: 20,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/form_interaction_test.json`, `${writeRoot}/form_interaction_screenshot.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's27',
      title: 'Cross-reference codebase with multiple library docs',
      requiresLocalServer: false,
      task:
        'Complex cross-reference task: Validate our implementation against 3 different library docs. ' +
        '1) Use context7 to resolve and get docs for: "zod" (schema validation), "vitest" (testing), "typescript" (types). ' +
        '2) For Zod: search our src/ for z.object, z.string patterns and count usages. ' +
        '3) For Vitest: search tests/ for describe, it, expect patterns. ' +
        '4) For TypeScript: read tsconfig.json and check strict mode settings. ' +
        '5) Cross-reference: Are our zod schemas properly typed? Are tests using proper async patterns? ' +
        '6) Check for any deprecated patterns mentioned in the 3 library docs. ' +
        `7) Write cross-reference report to ${writeRoot}/cross_reference_report.json with: ` +
        'librariesChecked (array of {name, context7Id, docsRetrieved}), ' +
        'zodUsageCount (number), vitestTestCount (number), typescriptStrictMode (boolean), ' +
        'crossReferenceIssues (array), overallHealthScore (0-100).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['context7'],
        autoConnectMcp: true,
        maxSubtasks: 7,
        maxSteps: 22,
        maxActionsPerStep: 12,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/cross_reference_report.json`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    // =============================================
    // Harder Edge Case Scenarios (s28-s32)
    // Test path normalization, action limits, and robustness
    // =============================================
    {
      id: 's28',
      title: 'Path normalization stress test',
      requiresLocalServer: false,
      task:
        'Path handling edge case test: Verify that various path formats resolve correctly. ' +
        '1) Read the file README.md using the relative path "README.md". ' +
        '2) Read the same file using a path with the repo name prefix: "mcpLocalLLM/README.md" (should strip redundant prefix). ' +
        '3) Read the file using path with parent directory: "GitHub/mcpLocalLLM/README.md" (should also work). ' +
        '4) Read src/index.ts using both "src/index.ts" and with various prefix combinations. ' +
        '5) Verify all reads return the same content by checking the first 100 characters match. ' +
        `6) Write a path normalization test report to ${writeRoot}/path_normalization_test.json with: ` +
        'testsRun (number), pathsSuccessfullyResolved (array of paths), ' +
        'pathsThatFailed (array with path and error), contentMatchVerified (boolean), ' +
        'allTestsPassed (boolean).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 3,
        maxSteps: 10,
        maxActionsPerStep: 15,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/path_normalization_test.json`],
        allowedActions: ['read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's29',
      title: 'High action count per step test',
      requiresLocalServer: false,
      task:
        'Action limit stress test: Execute many sequential actions to test limits. ' +
        '1) Search the codebase for all TypeScript files containing "export" (pattern: export.*function|export.*class). ' +
        '2) Read the first 5 matching files (read_file for each). ' +
        '3) For each file, extract the exported symbol names (just identify them, no parsing needed). ' +
        '4) Search for "import.*from" patterns to find where these symbols are used. ' +
        '5) Read at least 3 more files that import from the first set. ' +
        '6) Cross-reference: which exports are actually imported elsewhere vs orphaned. ' +
        `7) Write a comprehensive export analysis to ${writeRoot}/export_analysis.json with: ` +
        'filesSearched (number), filesRead (number), exportsFound (array of {file, symbols}), ' +
        'importsAnalyzed (number), orphanedExports (array), actionCountPerStep (number), ' +
        'hitActionLimit (boolean).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 4,
        maxSteps: 8,
        maxActionsPerStep: 100,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/export_analysis.json`],
        allowedActions: ['search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's30',
      title: 'Error recovery and retry test',
      requiresLocalServer: true,
      task:
        'Robustness test: Test error recovery when MCP tools fail or return unexpected results. ' +
        '1) Connect to chrome-devtools MCP server. ' +
        '2) Intentionally try to navigate to an invalid URL scheme (e.g., "invalid://test.com") and observe the error. ' +
        '3) Recover by navigating to a valid URL: http://127.0.0.1:3000/. ' +
        '4) Try calling take_screenshot with an invalid uid (e.g., "nonexistent_element_12345") and observe error. ' +
        '5) Recover by taking a full page screenshot instead (fullPage: true, no uid). ' +
        '6) Try evaluate_script with invalid JavaScript (e.g., "{{invalid syntax}}") and observe error. ' +
        '7) Recover by running valid JavaScript: "() => document.title". ' +
        '8) For each error, record the error message and recovery action taken. ' +
        `9) Write error recovery report to ${writeRoot}/error_recovery_test.json with: ` +
        'errorsTriggered (array of {action, errorMessage}), successfulRecoveries (array), ' +
        'finalScreenshotPath (string), pageTitle (string), allRecoveriesSuccessful (boolean).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools'],
        autoConnectMcp: true,
        maxSubtasks: 4,
        maxSteps: 12,
        maxActionsPerStep: 15,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/error_recovery_test.json`, `${writeRoot}/error_recovery_screenshot.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'write_json_file', 'done'],
      },
    },
    {
      id: 's31',
      title: 'Nested directory traversal test',
      requiresLocalServer: false,
      task:
        'Deep directory structure test: Navigate and read files at various depths. ' +
        '1) Read the top-level package.json file. ' +
        '2) Read src/index.ts (depth 1). ' +
        '3) Read src/config/index.ts (depth 2). ' +
        '4) Read src/tools/file.ts (depth 2). ' +
        '5) Search for all test files in tests/ directory. ' +
        '6) Read at least one test file. ' +
        '7) Search for files in .github directory if it exists. ' +
        '8) Verify you can read files using both forward slashes and backslashes in paths. ' +
        '9) Try reading a file using an absolute path (start with the workspace root). ' +
        `10) Write directory traversal report to ${writeRoot}/directory_traversal_test.json with: ` +
        'filesReadByDepth (object with depth as key, count as value), ' +
        'absolutePathWorked (boolean), mixedSlashesWorked (boolean), ' +
        'deepestFileRead (string), pathFormatsTestedOk (array), errors (array).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: [],
        autoConnectMcp: false,
        maxSubtasks: 4,
        maxSteps: 12,
        maxActionsPerStep: 15,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/directory_traversal_test.json`],
        allowedActions: ['search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
    {
      id: 's32',
      title: 'Multi-MCP concurrent operation test',
      requiresLocalServer: true,
      task:
        'Complex multi-server coordination: Use Chrome DevTools and Context7 together for validation. ' +
        '1) Connect to both chrome-devtools AND context7 MCP servers. ' +
        '2) List tools from both servers to confirm connectivity. ' +
        '3) Use Context7 to get documentation for "vitest" testing framework. ' +
        '4) Use chrome-devtools to open http://127.0.0.1:3000/ and take a snapshot. ' +
        '5) While Context7 provides docs, use chrome-devtools to take a screenshot. ' +
        '6) Read our vitest.config.ts file and compare against Context7 vitest docs. ' +
        '7) Use evaluate_script to get the current page URL and document ready state. ' +
        '8) Search our tests/ for vitest patterns (describe, it, expect). ' +
        `9) Write multi-MCP coordination report to ${writeRoot}/multi_mcp_test.json with: ` +
        'serversConnected (array), context7DocsRetrieved (boolean), ' +
        'browserScreenshotPath (string), pageUrl (string), readyState (string), ' +
        'vitestPatternsFound (number), coordinationSuccessful (boolean), ' +
        'totalMcpCallsMade (number), errors (array).',
      options: {
        contextRoot: workspaceRoot,
        allowMcpServers: ['chrome-devtools', 'context7'],
        autoConnectMcp: true,
        maxSubtasks: 5,
        maxSteps: 16,
        maxActionsPerStep: 15,
        readOnly: false,
        writeAllowlistPaths: [`${writeRoot}/multi_mcp_test.json`, `${writeRoot}/multi_mcp_screenshot.png`],
        allowedActions: ['mcp_list_tools', 'mcp_call', 'search_repo', 'read_file', 'write_json_file', 'done'],
      },
    },
  ];

  const selectedRaw = (process.env.MCP_LOCAL_LLM_SCENARIOS || '').trim();
  const selected = selectedRaw
    ? new Set(
        selectedRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

  const localServerOk = await isLocalServerRunning('http://127.0.0.1:3000/api/mcp-servers');

  const runOne = async (s) => {
    if (selected && !selected.has(s.id)) return;
    if (s.requiresLocalServer && !localServerOk) {
      console.log(`\n[${s.id}] ${s.title} (skipped: http://127.0.0.1:3000 not reachable)`);
      return;
    }

    console.log(`\n[${s.id}] ${s.title} (running...)`);
    const started = Date.now();

    const onProgress = (ev) => {
      if (ev.type === 'plan_generated') {
        console.log(`[${s.id}] plan: subtasks=${ev.subtasks} steps=${ev.steps}`);
        return;
      }
      if (ev.type === 'step_start') {
        console.log(`[${s.id}] step ${ev.index}/${ev.total}: ${ev.title}`);
        return;
      }
      if (ev.type === 'action') {
        console.log(`[${s.id}]  - ${ev.ok ? 'ok ' : 'err'} ${ev.actionType}`);
      }
    };

    const result = await runner.runTask(s.task, { ...s.options, onProgress });
    console.log(JSON.stringify(result.final, null, 2));
    if (!result.success) {
      const m = result.final?.metrics;
      const reason =
        result.error ||
        (m
          ? `failedSteps=${m.failedSteps} failedActions=${m.failedActions}`
          : 'task did not complete successfully (see execution log)');
      console.error(`[${s.id}] failed: ${reason}`);
    }
    console.log(`[${s.id}] elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
  };

  try {
    for (const s of scenarios) {
      // eslint-disable-next-line no-await-in-loop
      await runOne(s);
    }
  } finally {
    await mcpClient.disconnectAll().catch(() => {});
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
