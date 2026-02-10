/**
 * MCP Client Integration Verification Script
 * 
 * This script verifies that the MCP client feature is properly configured.
 * The actual MCP client tools (mcp_server_connect, mcp_server_call, etc.)
 * are accessed through the MCP protocol, which VS Code Copilot uses.
 * 
 * To test the full integration:
 * 
 * 1. Start the MCP server (it's already configured in your VS Code mcp.json)
 * 
 * 2. In VS Code Copilot Chat, you can use these tools:
 *    - @mcp.mcp-local-llm.mcp_server_status - Check configured MCP servers
 *    - @mcp.mcp-local-llm.mcp_server_connect serverName="chrome-devtools" - Connect to chrome-devtools
 *    - @mcp.mcp-local-llm.mcp_server_list_tools serverName="chrome-devtools" - List available tools
 *    - @mcp.mcp-local-llm.mcp_server_call serverName="chrome-devtools" toolName="take_screenshot" arguments={}
 *    - @mcp.mcp-local-llm.mcp_ask serverName="chrome-devtools" task="Take a screenshot of google.com"
 * 
 * 3. Example 5 basic operations to test:
 *    a) Check server status
 *    b) Connect to chrome-devtools
 *    c) List available tools
 *    d) Take a screenshot (requires browser running)
 *    e) Ask LLM to help with a browser task
 * 
 * Prerequisites:
 * - Ollama running with granite4:3b model
 * - Chrome browser (for chrome-devtools MCP)
 * - npm dependencies installed
 */

const http = require('http');

const SERVER_URL = 'http://127.0.0.1:3000';

async function checkServer() {
  return new Promise((resolve) => {
    http.get(`${SERVER_URL}/api/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: 'Invalid response' });
        }
      });
    }).on('error', (err) => {
      resolve({ error: err.message });
    });
  });
}

async function checkToolGroups() {
  return new Promise((resolve) => {
    http.get(`${SERVER_URL}/api/tool-groups`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: 'Invalid response' });
        }
      });
    }).on('error', (err) => {
      resolve({ error: err.message });
    });
  });
}

async function checkBackends() {
  return new Promise((resolve) => {
    http.get(`${SERVER_URL}/api/backends`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ error: 'Invalid response' });
        }
      });
    }).on('error', (err) => {
      resolve({ error: err.message });
    });
  });
}

async function runVerification() {
  console.log('='.repeat(60));
  console.log('MCP Client Feature Verification');
  console.log('='.repeat(60));
  console.log();

  // Check 1: Server health
  console.log('1. Checking server health...');
  const health = await checkServer();
  if (health.status === 'ok') {
    console.log('   ✅ Server is running');
  } else {
    console.log('   ❌ Server not running:', health.error || 'Unknown error');
    console.log('   Start with: node dist/index.js --settings env.settings');
    return;
  }

  // Check 2: Tool groups
  console.log('\n2. Checking tool groups...');
  const groups = await checkToolGroups();
  if (groups.enabledGroups && groups.enabledGroups.includes('mcp.client')) {
    console.log('   ✅ mcp.client group is enabled');
    const mcpTools = groups.enabledTools.filter(t => t.startsWith('mcp_server') || t === 'mcp_ask');
    console.log('   MCP Client Tools:', mcpTools.join(', '));
  } else {
    console.log('   ❌ mcp.client group not enabled');
    console.log('   Available groups:', groups.enabledGroups?.join(', ') || 'None');
  }

  // Check 3: LLM Backend
  console.log('\n3. Checking LLM backend...');
  const backends = await checkBackends();
  if (Array.isArray(backends) && backends.length > 0) {
    const ollama = backends.find(b => b.id === 'ollama');
    if (ollama) {
      console.log('   ✅ Ollama backend configured');
      console.log('   Status:', ollama.status || 'unknown');
      console.log('   Models:', ollama.models?.length || 0, 'available');
    } else {
      console.log('   ⚠️ Ollama backend not found');
    }
  } else {
    console.log('   ❌ No backends configured');
  }

  // Check 4: MCP Servers Config
  console.log('\n4. Checking MCP servers configuration...');
  // We can't directly check mcpServers from HTTP API, but we can verify the config exists
  console.log('   Check env.settings (CONFIG_JSON) for mcpServers section');
  console.log('   Default: chrome-devtools configured');

  console.log('\n' + '='.repeat(60));
  console.log('TESTING INSTRUCTIONS');
  console.log('='.repeat(60));
  console.log(`
To test the MCP client integration with chrome-devtools:

1. In VS Code Copilot Chat, first check status:
   "Use mcp_server_status to show configured MCP servers"

2. Connect to chrome-devtools:
   "Use mcp_server_connect with serverName chrome-devtools"

3. List available tools:
   "Use mcp_server_list_tools for chrome-devtools"

4. Take a screenshot (opens Chrome):
   "Use mcp_server_call on chrome-devtools, tool take_screenshot"

5. Ask the LLM for help:
   "Use mcp_ask with chrome-devtools to take a screenshot of example.com"

Note: These tools are available via MCP protocol, not HTTP API.
VS Code Copilot integrates with MCP automatically.
`);
}

runVerification().catch(console.error);

