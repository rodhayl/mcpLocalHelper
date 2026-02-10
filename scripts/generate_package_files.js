#!/usr/bin/env node
/**
 * Generate Package Files Script
 * 
 * This script generates all the documentation and configuration files
 * needed for the npm package distribution. It's called by build_npm_package.bat
 * to avoid batch file escaping issues with complex multi-line content.
 */

const fs = require('fs');
const path = require('path');

// Get the output directory from command line argument
const outputDir = process.argv[2] || 'dist_package';

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log(`Generating package files in: ${outputDir}`);

// ============================================================
// env.settings.example
// ============================================================
// Use the repository canonical env.settings.example as the single
// source of truth for packaging. This prevents drift between the
// example used when running the app locally and the one bundled
// into the npm package.
const srcEnvExample = path.resolve(__dirname, '..', 'env.settings.example');
const destEnvExample = path.join(outputDir, 'env.settings.example');

if (fs.existsSync(srcEnvExample)) {
  fs.copyFileSync(srcEnvExample, destEnvExample);
} else {
  // Fallback minimal example when canonical file is not available.
  const fallbackEnv = `# MCP Local LLM Server - Environment Settings (Example)
# Minimal fallback used when canonical env.settings.example is missing.
[config]
CONFIG_JSON={}
`;
  fs.writeFileSync(destEnvExample, fallbackEnv, 'utf8');
}

// ============================================================
// mcp.json.example (for global installation - ZERO CONFIG)
// ============================================================
// The MCP server automatically discovers settings in this order:
// 1. ${workspaceFolder}/env.settings (or env-automated-tests.settings)
// 2. ~/.mcp-local-llm/env.settings
// 3. ~/.config/mcp-local-llm/env.settings
// 4. Bundled defaults (works out of the box with Ollama)
const mcpJsonExample = {
  mcp: {
    servers: {
      "mcp-local-llm": {
        command: "mcp-local-llm"
        // No args needed! Config is auto-discovered.
        // To use a specific settings file, add: args: ["--settings", "/path/to/env.settings"]
      }
    }
  }
};

fs.writeFileSync(
  path.join(outputDir, 'mcp.json.example'),
  JSON.stringify(mcpJsonExample, null, 2)
);

// ============================================================
// mcp.json.alternative.example (for local/project installation)
// ============================================================
const mcpJsonAlternative = {
  mcp: {
    servers: {
      "mcp-local-llm": {
        command: "node",
        args: [
          "node_modules/mcp-local-llm/dist/index.js"
          // Config auto-discovered. Add path here to override.
        ]
      }
    }
  }
};

fs.writeFileSync(
  path.join(outputDir, 'mcp.json.alternative.example'),
  JSON.stringify(mcpJsonAlternative, null, 2)
);

// ============================================================
// .npmignore
// ============================================================
const npmIgnore = `# Development files
*.ts
!*.d.ts
tsconfig.json
vitest.config.ts
eslint.config.mjs
.prettierrc

# Test files
tests/
*.test.js
*.test.ts

# Dev dependencies
node_modules/

# Build artifacts
*.tgz
dist_package/

# IDE files
.vscode/
.idea/

# Git files
.git/
.gitignore

# Documentation (source) - keep README.md and INSTALL.md
*.md
!README.md
!INSTALL.md

# Scripts (dev only)
scripts/
start.bat
stop.bat
start.ps1
stop.ps1
install.bat
build_npm_package.bat
`;

fs.writeFileSync(path.join(outputDir, '.npmignore'), npmIgnore);

// ============================================================
// README.md
// ============================================================
const readmeMd = `# MCP Local LLM Server

A privacy-first MCP (Model Context Protocol) server that provides **unique LLM-enhanced tools** for VS Code Copilot. All analysis uses your local LLM - code never leaves your machine.

## Features

- **Privacy-First**: All LLM analysis runs locally - your code never leaves your machine
- **VS Code Copilot Optimized**: Designed to complement VS Code's built-in tools
- **LLM-Enhanced Tools**: Every tool adds intelligent analysis
- **Symbol-Aware**: Understands code structure, not just text patterns
- **Security Scanning**: Automatic detection of secrets, API keys, and vulnerabilities
- **Multiple Backends**: Ollama, LM Studio, OpenRouter support
- **Web UI Dashboard**: Built-in web interface for configuration and monitoring

## Prerequisites

1. **Node.js 18+** - Required to run the server
2. **Local LLM Backend** - One of:
   - [Ollama](https://ollama.ai/) (recommended) - \`ollama serve\`
   - [LM Studio](https://lmstudio.ai/) - Start the local server

## Installation

### Quick Install (Windows)

1. **Install**: Double-click \`install.bat\` (or run \`.\\install.bat\` in a terminal)
   - Installs the package globally
   - Automatically sets up your default configuration
   - Verifies Node.js installation

2. **Uninstall**: Run \`uninstall.bat\`
   - Removes the package globally

### Alternative Installation (Manual)

**Global:**
\`\`\`bash
npm install -g mcp-local-llm-X.X.X.tgz
\`\`\`

**Local (Per-Project):**
\`\`\`bash
cd your-project
npm install mcp-local-llm-X.X.X.tgz
\`\`\`

## Configuration

### Step 1: Configuration

When installed globally, a default settings file is automatically created at \`~/.mcp-local-llm/env.settings\`.

To create a project-specific settings file:

\`\`\`bash
cp env.settings.example ./env.settings
\`\`\`

Note: The repository \`env.settings.example\` is the canonical source of defaults. The package build copies this file into \`dist_package/env.settings.example\` so the package uses the same example. A CI parity test ensures the packaged example always matches the repository file.

Edit the configuration as needed. The defaults work for most Ollama setups.

### Step 2: Configure Your IDE

Choose your IDE below and copy the configuration exactly as shown.

---

### VS Code / GitHub Copilot

Create \`.vscode/mcp.json\` in your **project folder** (must be per-project, not global settings):

\`\`\`json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "mcp-local-llm",
        "args": ["--settings", "\${workspaceFolder}/env.settings", "--workspace", "\${workspaceFolder}"]
      }
    }
  }
}
\`\`\`

> **Important**: The mcp.json MUST be in your project's \`.vscode/\` folder, not VS Code user settings. Open a folder in VS Code before using.

---

### Antigravity IDE

Add to your MCP settings (Settings > MCP Servers):

\`\`\`json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "mcp-local-llm",
      "disabled": false
    }
  }
}
\`\`\`

> **Note**: Antigravity does not support variable expansion (like \`$\{workspaceFolder\}\`). The server will default to the current working directory. If you need a specific workspace, use an absolute path in args: \`["--workspace", "C:/absolute/path/to/project"]\`.

---

### TRAE AI IDE

Add to your MCP configuration:

\`\`\`json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "mcp-local-llm",
      "args": ["--workspace", "\${workspaceFolder}"],
      "disabled": false
    }
  }
}
\`\`\`

---

### Roo Code

Add to your MCP settings:

\`\`\`json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "mcp-local-llm"
    }
  }
}
\`\`\`

---

### Kilo Code

Add to your Kilo Code MCP settings:

\`\`\`json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "mcp-local-llm"
    }
  }
}
\`\`\`

---

### Claude Desktop

Edit \`claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "mcp-local-llm"
    }
  }
}
\`\`\`

> **Note**: Launch Claude Desktop from your project folder for correct path resolution.

---

### Cline

Create \`.cline/mcp.json\` in your project:

\`\`\`json
{
  "mcpServers": {
    "mcp-local-llm": {
      "command": "mcp-local-llm"
    }
  }
}
\`\`\`

---

### Local npm Install (any IDE)

If installed locally (\`npm install mcp-local-llm\`):

\`\`\`json
{
  "command": "node",
  "args": ["node_modules/mcp-local-llm/dist/index.js"]
}
\`\`\`

### Step 3: Start Your LLM Backend

Make sure Ollama or LM Studio is running:

\`\`\`bash
# For Ollama
ollama serve
\`\`\`

### Step 4: Reload VS Code

Reload VS Code window (Ctrl+Shift+P -> "Reload Window") to activate the MCP server.

## Web UI Dashboard

When the MCP server starts, it also launches a **Web UI Dashboard** for configuration and monitoring.

### Accessing the Web UI

Open your browser and navigate to:

\`\`\`
http://localhost:3000
\`\`\`

The port can be customized in your config file:

\`\`\`yaml
server:
  port: 3000      # Change this to use a different port
  host: 127.0.0.1 # Use 0.0.0.0 to allow external access
\`\`\`

### Web UI Features

| Tab | Purpose |
|-----|---------|
| **Configuration** | View system profile, configure backends, switch between production/testing modes |
| **Tool Governance** | Enable/disable tool groups, set active mode (MINIMAL, ANALYSIS, DEVELOPMENT, etc.) |
| **Model Capabilities** | View available models, their capabilities, and task suitability |
| **Scenarios** | Run pre-configured test scenarios |
| **Logs** | View real-time server logs and activity |

### Configuration Tab

- **System Profile**: Shows CPU, RAM, GPU info and model recommendations
- **Local Backend**: Select and configure Ollama/LM Studio backend and model
- **Testing Mode**: Enable SOTA (State-of-the-Art) backend for testing with external APIs

### Testing Mode

Testing mode allows you to use external LLMs (like OpenRouter) for comparison:

1. Toggle "Enable Testing Mode" in the Web UI
2. Choose SOTA type:
   - **Local Backend as SOTA**: Use a different local model
   - **OpenRouter**: Use cloud LLMs (requires API key from openrouter.ai)
3. Select a model
4. The \`llm_chat\` tool will now support \`role: "sota"\` for external LLM calls

> ⚠️ **Privacy Note**: Testing mode with OpenRouter sends data to external services.

### Multi-Instance & Global Config

You can use this MCP server in multiple IDEs simultaneously (e.g., VS Code + Claude Desktop + Cursor).

- **Unified Web UI**: The **first** instance you start will host the Web UI on port 3000. Subsequent instances will skip the Web UI to prevent port conflicts, but will still function fully as MCP servers.
- **Global Config Sync**: Any configuration change made in the Web UI (e.g., switching models or enabling tools) is **immediately synchronized** to all running instances. 

## Available Tools

The server provides 30+ tools organized into categories:

- **LLM-Enhanced Analysis**: analyze_file, explore_directory, local_code_review, etc.
- **Summarization**: summarize_path, summarize_repo
- **Core LLM**: llm_chat, codebase_qa
- **Code Navigation**: index_symbols, structured_search, cross_file_links
- **Security**: secret_scan, risk_score, redaction_preview
- **Code Quality**: aggregate_todos, analyze_test_gaps
- **And more...**

See the full tool list by asking Copilot: "What MCP tools are available?"

## Troubleshooting

### Server Not Starting
- Ensure Node.js 18+ is installed: \`node -v\`
- Check if Ollama is running: \`curl http://localhost:11434/api/tags\`
- Verify settings file path in mcp.json

### Tools Not Appearing
- Reload VS Code window
- Check VS Code Output panel for MCP errors
- Ensure the settings file exists at the specified path

### Web UI Not Accessible
- Check the configured port in env.settings (default: 3000)
- Ensure no other service is using the same port
- Look for \`[MCP] Server ready - Web UI: http://...\` in VS Code Output

## License

MIT
`;

fs.writeFileSync(path.join(outputDir, 'README.md'), readmeMd);

// ============================================================
// INSTALL.md
// ============================================================
const installMd = `# MCP Local LLM - Installation Guide

This guide provides detailed installation instructions for the MCP Local LLM server package.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation Methods](#installation-methods)
3. [Configuration](#configuration)
4. [VS Code Setup](#vs-code-setup)
5. [Web UI Dashboard](#web-ui-dashboard)
6. [Verification](#verification)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before installing, ensure you have:

### Required

1. **Node.js 18 or higher**
   \`\`\`bash
   node -v  # Should show v18.x.x or higher
   \`\`\`
   Download from: https://nodejs.org/

2. **A Local LLM Backend** (choose one):

   **Option A: Ollama (Recommended)**
   - Download from: https://ollama.ai/
   - Install and run: \`ollama serve\`
   - Pull a model: \`ollama pull qwen3:14b\` or \`ollama pull llama3.2:latest\`

   **Option B: LM Studio**
   - Download from: https://lmstudio.ai/
   - Download a model through the UI
   - Start the local server (default port: 1234)

### Recommended

- VS Code 1.85+ with GitHub Copilot extension
- At least 8GB RAM (16GB+ recommended for larger models)

---

## Installation Methods

### Method 1: Windows Quick Install (Recommended)

The package includes batch scripts for one-click installation and configuration.

1. **Install**:
   - Double-click \`install.bat\` (or run \`.\\install.bat\` in a terminal).
   - This installs the package globally and sets up your default configuration.

2. **Uninstall**:
   - Run \`uninstall.bat\`.

### Method 2: Global Installation (Manual)

If you prefer manual installation:

\`\`\`bash
# Install globally
npm install -g mcp-local-llm-1.0.0.tgz

# Verify installation
mcp-local-llm --help
\`\`\`

**Pros:**
- Single installation for all projects
- Cleaner project dependencies
- Easy to update

### Method 2: Local Installation (Per-Project)

Install as a project dependency.

\`\`\`bash
cd your-project
npm install mcp-local-llm-1.0.0.tgz
\`\`\`

**Pros:**
- Version pinned per project
- No global pollution
- Works in CI/CD environments

---

## Configuration

### Step 1: Configuration

When installed globally, a default settings file is automatically created at \`~/.mcp-local-llm/env.settings\`.

To create a project-specific config:

\`\`\`bash
# Copy to your project root
cp env.settings.example ./env.settings
\`\`\`

Note: The repository \`env.settings.example\` is the canonical source of defaults. The package build copies this file into \`dist_package/env.settings.example\` so the package uses the same example. A CI parity test ensures the packaged example always matches the repository file.

### Step 2: Edit Configuration

The default config works for most Ollama setups. Key sections to customize:

\`\`\`yaml
# Backend configuration
backends:
  - id: ollama
    type: ollama
    base_url: http://127.0.0.1:11434  # Change if using different port

# Workspace access control
workspace:
  roots:
    - "."  # Current directory
  defaultRoot: "."

# Security policy
policy:
  allowlistPaths:
    - "."  # Allow entire workspace
  maxFileBytes: 131072  # 128KB max file size

# Web UI server settings
server:
  port: 3000        # Web UI port
  host: 127.0.0.1   # Use 0.0.0.0 to allow external access
\`\`\`

---

## VS Code Setup

### Create MCP Configuration

Create \`.vscode/mcp.json\` in your project (or workspace):

**For Global Installation (Zero-Config):**
\`\`\`json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "mcp-local-llm"
      }
    }
  }
}
\`\`\`

**For Local Installation:**
\`\`\`json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "node",
        "args": [
          "node_modules/mcp-local-llm/dist/index.js"
        ]
      }
    }
  }
}
\`\`\`

**With Environment Variables (for shared configs):**
\`\`\`json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "mcp-local-llm",
        "args": [
          "\${env:HOME}/.mcp-local-llm/env.settings"
        ]
      }
    }
  }
}
\`\`\`

### Reload VS Code

After creating the configuration:
1. Press \`Ctrl+Shift+P\` (or \`Cmd+Shift+P\` on macOS)
2. Type "Reload Window"
3. Select "Developer: Reload Window"

---

## Web UI Dashboard

The MCP server includes a built-in **Web UI Dashboard** that provides visual configuration, monitoring, and testing capabilities.

### Accessing the Web UI

When VS Code activates the MCP server, the Web UI automatically starts. Open your browser and navigate to:

\`\`\`
http://localhost:3000
\`\`\`

> 💡 **Tip**: Look for \`[MCP] Server ready - Web UI: http://127.0.0.1:3000\` in the VS Code Output panel to confirm the server is running.

### Configuring the Web UI Port

Edit your \`env.settings\`:

\`\`\`yaml
server:
  port: 3000        # Change to your preferred port
  host: 127.0.0.1   # localhost only (secure)
  # host: 0.0.0.0   # Allow external access (use with caution)
\`\`\`

### Web UI Tabs

#### 1. Configuration Tab

The main configuration interface with three sections:

**System Profile**
- Displays your hardware information (CPU, RAM, GPU)
- Shows model suitability recommendations based on your hardware
- Indicates whether system profile is exposed to the LLM

**Local Backend Configuration (Production Mode)**
- Select your local backend (Ollama, LM Studio)
- Choose a specific model or use auto-select
- All processing stays on your machine - complete privacy

**SOTA Backend Configuration (Testing Mode)**
- Enable testing mode to use State-of-the-Art external LLMs
- Options:
  - **Local Backend as SOTA**: Use a different/larger local model
  - **OpenRouter**: Connect to cloud LLMs (Claude, GPT-4, Gemini, etc.)
- Requires API key for OpenRouter

#### 2. Tool Governance Tab

Control which tools are available:

- **Active Mode**: Choose from MINIMAL, ANALYSIS, PLANNING, FULL_ANALYSIS, or DEVELOPMENT
- **Tool Groups**: Enable/disable specific tool categories:
  - \`core.summary\`: Summarization tools
  - \`core.chat\`: Direct LLM access
  - \`llm.enhanced\`: LLM-enhanced analysis tools
  - \`analysis.extended\`: Code analysis tools
  - \`privacy\`: Security scanning tools
  - \`verification\`: Syntax validation
  - \`execution\`: Linter/formatter execution
  - \`system.info\`: System information tools
  - \`planning\`: Plan verification tools

#### 3. Model Capabilities Tab

View detailed information about available models:

- List of models from each backend
- Estimated capabilities per model
- Recommended tasks for each model
- Context window sizes

#### 4. Scenarios Tab

Pre-configured test scenarios to validate your setup:

- Security scan scenario
- Code review scenario
- Documentation generation scenario
- Run scenarios directly from the UI

#### 5. Logs Tab

Real-time server activity monitoring:

- HTTP request logs
- Backend status changes
- Error messages
- Settings changes

### Using Testing Mode

Testing mode allows you to compare local LLM results with state-of-the-art cloud LLMs.

**Step 1: Enable Testing Mode**
1. Open the Web UI at \`http://localhost:3000\`
2. Go to the Configuration tab
3. Toggle "Enable Testing Mode"

**Step 2: Configure SOTA Backend**

*Option A: Use Local Model as SOTA*
- Select "Use Local Backend as SOTA"
- Choose a different/larger model for comparison

*Option B: Use OpenRouter (External API)*
1. Select "OpenRouter (External API)"
2. Get an API key from [openrouter.ai](https://openrouter.ai/)
3. Enter your API key
4. Click the refresh button to load available models
5. Select a model (e.g., Claude 3 Opus, GPT-4 Turbo)

**Step 3: Use SOTA in Tools**

The \`llm_chat\` tool now supports a \`role\` parameter:

\`\`\`
@workspace Use llm_chat with role=sota to analyze this code
\`\`\`

> ⚠️ **Privacy Warning**: When using OpenRouter or other external backends, your code/prompts are sent to external services. Only use testing mode for non-sensitive work.

### API Endpoints

The Web UI also exposes REST API endpoints for programmatic access:

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/api/backends\` | GET | List all configured backends and their status |
| \`/api/backends/:id/models\` | GET | List models for a specific backend |
| \`/api/settings\` | GET | Get current environment settings |
| \`/api/settings\` | POST | Update environment settings |
| \`/api/settings/testing/enable\` | POST | Enable testing mode |
| \`/api/settings/testing/disable\` | POST | Disable testing mode |
| \`/api/system-profile\` | GET | Get system hardware profile |
| \`/api/logs\` | GET | Get recent server logs |
| \`/api/health\` | GET | Health check endpoint |

---

## Verification

### Check Server Status

1. Open VS Code Output panel (View -> Output)
2. Select "MCP" from the dropdown
3. Look for: \`[MCP] Server ready - Web UI: http://127.0.0.1:3000\`

### Verify Web UI

1. Open \`http://localhost:3000\` in your browser
2. Check that backends show as "Available" (green)
3. Verify your models are listed

### Test a Tool

In Copilot chat, try:
\`\`\`
@workspace Use the llm_chat tool to say hello
\`\`\`

Or:
\`\`\`
@workspace Use summarize_repo to give me an overview of this project
\`\`\`

---

## Troubleshooting

### Common Issues

#### "Command not found: mcp-local-llm"
- Ensure global npm bin is in PATH
- Try: \`npm config get prefix\` to find the installation directory
- Add \`<prefix>/bin\` (or \`<prefix>\` on Windows) to your PATH

#### "Cannot connect to Ollama"
- Ensure Ollama is running: \`ollama serve\`
- Check the URL in config matches Ollama's port
- Test: \`curl http://localhost:11434/api/tags\`

#### "Tools not appearing in Copilot"
- Reload VS Code window
- Check the Output panel for errors
- Verify config file path is correct

#### "Permission denied" errors
- Check \`workspace.roots\` includes your project
- Check \`policy.allowlistPaths\` allows access

#### "Web UI not accessible"
- Check the port isn't already in use: \`netstat -an | findstr :3000\`
- Verify the \`server.port\` setting in config
- Try a different port if 3000 is occupied

#### "Backend shows as unavailable"
- Ensure your LLM backend (Ollama/LM Studio) is running
- Check the \`base_url\` in your config matches the backend's address
- For Ollama: \`ollama serve\` and verify with \`ollama list\`

### Debug Mode

Enable verbose logging by setting environment variable:
\`\`\`json
{
  "mcp": {
    "servers": {
      "mcp-local-llm": {
        "command": "mcp-local-llm",
        "args": ["--settings", "\${workspaceFolder}/env.settings"],
        "env": {
          "MCP_DEBUG": "true"
        }
      }
    }
  }
}
\`\`\`

### Getting Help

- Check the GitHub repository for issues and updates
- Review the full documentation in the source repository
- Check the Logs tab in the Web UI for detailed error messages

---

## Quick Reference

| Task | Command / URL |
|------|---------------|
| Install globally | \`npm install -g mcp-local-llm-X.X.X.tgz\` |
| Install locally | \`npm install mcp-local-llm-X.X.X.tgz\` |
| Start Ollama | \`ollama serve\` |
| Pull a model | \`ollama pull qwen3:14b\` |
| Access Web UI | \`http://localhost:3000\` |
| Reload VS Code | \`Ctrl+Shift+P\` -> "Reload Window" |
| Check server status | VS Code Output panel -> "MCP" |

---

Happy coding with your local LLM! 🚀
`;

fs.writeFileSync(path.join(outputDir, 'INSTALL.md'), installMd);

console.log('All package files generated successfully!');
// ============================================================
// postinstall.js
// ============================================================
const postinstallJs = `/**
 * Post-install script for MCP Local LLM
 * Ensures users have the canonical env.settings file after installation.
 * Handles: missing files or existing files that differ from the canonical example.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function normalizeContent(value) {
  return value.replace(/\\r\\n/g, '\\n');
}

/**
 * Ensure user has the canonical env.settings file after installation.
 */
function ensureDefaultEnvSettings(homeDir, sourceFile) {
  const configDir = path.join(homeDir, '.mcp-local-llm');
  const targetFile = path.join(configDir, 'env.settings');

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
    } catch (err) {
      return { action: 'error', error: err.message };
    }
  }

  // Read source file
  let sourceContent;
  try {
    sourceContent = fs.readFileSync(sourceFile, 'utf8');
  } catch (err) {
    return { action: 'error', error: \`Cannot read source: \${err.message}\` };
  }

  // Case 1: File doesn't exist → create it
  if (!fs.existsSync(targetFile)) {
    try {
      fs.copyFileSync(sourceFile, targetFile);
      return { action: 'created', target: targetFile };
    } catch (err) {
      return { action: 'error', error: \`Cannot create: \${err.message}\` };
    }
  }

  // Case 2: File exists → check if it needs patching
  let existingContent;
  try {
    existingContent = fs.readFileSync(targetFile, 'utf8');
  } catch (err) {
    return { action: 'error', error: \`Cannot read existing: \${err.message}\` };
  }

  const normalizedSource = normalizeContent(sourceContent);
  const normalizedExisting = normalizeContent(existingContent);

  // Case 2a: Already matches canonical example → no-op
  if (normalizedSource === normalizedExisting) {
    return { action: 'noop', target: targetFile };
  }

  // Case 2b: Different content → replace with backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(configDir, \`env.settings.backup-\${timestamp}\`);

  try {
    // Create timestamped backup
    fs.copyFileSync(targetFile, backupFile);

    // Write atomically (write to temp, then rename)
    const tempFile = targetFile + '.tmp';
    fs.writeFileSync(tempFile, sourceContent, 'utf8');
    fs.renameSync(tempFile, targetFile);

    return { action: 'replaced', target: targetFile, backup: backupFile };
  } catch (err) {
    return { action: 'error', error: \`Cannot replace: \${err.message}\` };
  }
}

// Run postinstall
try {
  const sourceConfig = path.join(__dirname, 'env.settings.example');
  const result = ensureDefaultEnvSettings(os.homedir(), sourceConfig);

  if (result.action === 'error') {
    console.error('Post-install setup failed (non-fatal):', result.error);
    process.exit(0);
  }

  // Calculate absolute path to the server script for Kilo Code
  const serverScript = path.join(__dirname, 'dist', 'index.js').replace(/\\\\/g, '/');

  console.log('\\n========================================================');
  console.log('MCP Local LLM Installed Successfully!');
  console.log('========================================================');
  
  if (result.action === 'created') {
    console.log('✓ Created default configuration:', result.target);
  } else if (result.action === 'replaced') {
    console.log('✓ Replaced existing configuration:', result.target);
    console.log('  (Backup saved to:', result.backup + ')');
  } else if (result.action === 'noop') {
    console.log('✓ Configuration already up to date:', result.target);
  }

  console.log('\\n[FOR KILO CODE USERS]');
  console.log('To avoid "Shutdown complete" errors, use this EXACT configuration:');
  console.log(JSON.stringify({
    mcpServers: {
      "mcp-local-llm": {
        "command": "node",
        "args": [serverScript],
        "env": {
          "MCP_STDIN_SHUTDOWN": "0"
        }
      }
    }
  }, null, 2));
  console.log('========================================================\\n');
} catch (err) {
  console.error('Post-install setup failed (non-fatal):', err.message);
}
`;

fs.writeFileSync(path.join(outputDir, 'postinstall.js'), postinstallJs);


// ============================================================
// install.bat
// ============================================================
const installBat = `@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo ============================================================
echo      MCP Local LLM - One-Click Installer
echo ============================================================
echo.

REM Check for Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js first.
    echo Visit https://nodejs.org/ to download.

    exit /b 1
)

  REM Check for npm
  where npm >nul 2>&1
  if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm is not available. Please install Node.js which includes npm.
    exit /b 1
  )

REM Find the package file
for %%f in (mcp-local-llm-*.tgz) do set PACKAGE=%%f

if not defined PACKAGE (
    echo [ERROR] Could not find mcp-local-llm-*.tgz in current directory.
    echo Please ensure you have extracted the full package.

    exit /b 1
)

  REM ============================================================
  REM Pre-clean conflicting global installs / shims
  REM ============================================================
  REM On Windows, npm creates shims in %APPDATA%\\npm. If an older install
  REM (or a dev "npm link" of mcplocalllm) left shims behind, npm can fail
  REM with EEXIST when installing.
  set "NPM_BIN=%APPDATA%\\npm"

  REM Best-effort uninstall of both historical package names
  call npm uninstall -g mcp-local-llm >nul 2>&1
  call npm uninstall -g mcplocalllm >nul 2>&1

  REM Best-effort cleanup of leftover shims
  if exist "%NPM_BIN%\\mcp-local-llm" del /f /q "%NPM_BIN%\\mcp-local-llm" >nul 2>&1
  if exist "%NPM_BIN%\\mcp-local-llm.cmd" del /f /q "%NPM_BIN%\\mcp-local-llm.cmd" >nul 2>&1
  if exist "%NPM_BIN%\\mcp-local-llm.ps1" del /f /q "%NPM_BIN%\\mcp-local-llm.ps1" >nul 2>&1

  REM Best-effort cleanup of leftover global modules
  if exist "%NPM_BIN%\\node_modules\\mcp-local-llm" rmdir /s /q "%NPM_BIN%\\node_modules\\mcp-local-llm" >nul 2>&1
  if exist "%NPM_BIN%\\node_modules\\mcplocalllm" rmdir /s /q "%NPM_BIN%\\node_modules\\mcplocalllm" >nul 2>&1

echo [INFO] Installing %PACKAGE% globally...
echo.
call npm install -g "%PACKAGE%"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Installation failed.
    echo.
    echo Common fixes:
    echo   - Close any running mcp-local-llm processes / terminals.
    echo   - Re-run uninstall.bat, then install.bat.
    echo   - If you previously used npm link for mcplocalllm, ensure it is unlinked.
    echo.
    exit /b 1
)

REM ============================================================
REM Force postinstall to run (npm may skip it on reinstalls)
REM ============================================================
echo.
echo [INFO] Configuring MCP Local LLM...
for /f "delims=" %%i in ('npm root -g') do set "NPM_GLOBAL_ROOT=%%i"
if exist "%NPM_GLOBAL_ROOT%\\mcp-local-llm\\postinstall.js" (
    pushd "%NPM_GLOBAL_ROOT%\\mcp-local-llm"
    call node postinstall.js
    popd
)

echo.
echo ============================================================
echo [SUCCESS] MCP Local LLM installed successfully!
echo ============================================================
echo.
echo You can now use the 'mcp-local-llm' command anywhere.
echo.
exit /b 0


`;

fs.writeFileSync(path.join(outputDir, 'install.bat'), installBat);

// ============================================================
// uninstall.bat
// ============================================================
const uninstallBat = `@echo off
setlocal EnableExtensions
echo ============================================================
echo      MCP Local LLM - Uninstaller
echo ============================================================
echo.

echo [INFO] Uninstalling mcp-local-llm globally...
echo.
set "FAILED=0"

REM Uninstall both historical package names (best-effort)
call npm uninstall -g mcp-local-llm
if %ERRORLEVEL% neq 0 set "FAILED=1"
call npm uninstall -g mcplocalllm
if %ERRORLEVEL% neq 0 set "FAILED=1"

REM Best-effort cleanup of Windows shim files that can block reinstall (EEXIST)
set "NPM_BIN=%APPDATA%\\npm"
if exist "%NPM_BIN%\\mcp-local-llm" del /f /q "%NPM_BIN%\\mcp-local-llm" >nul 2>&1
if exist "%NPM_BIN%\\mcp-local-llm.cmd" del /f /q "%NPM_BIN%\\mcp-local-llm.cmd" >nul 2>&1
if exist "%NPM_BIN%\\mcp-local-llm.ps1" del /f /q "%NPM_BIN%\\mcp-local-llm.ps1" >nul 2>&1

REM Best-effort cleanup of leftover global modules
if exist "%NPM_BIN%\\node_modules\\mcp-local-llm" rmdir /s /q "%NPM_BIN%\\node_modules\\mcp-local-llm" >nul 2>&1
if exist "%NPM_BIN%\\node_modules\\mcplocalllm" rmdir /s /q "%NPM_BIN%\\node_modules\\mcplocalllm" >nul 2>&1

REM Best-effort stop of any running MCP node server processes (do NOT kill unrelated node.exe)
echo.
echo [INFO] Checking for running MCP server node processes...
powershell -NoProfile -Command "try { $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' -and ($_.CommandLine -match 'dist[\\/]+index\\.js' -or $_.CommandLine -match 'mcp-local-llm') }; if ($procs) { foreach ($p in $procs) { Write-Host ('[INFO] Stopping MCP process PID {0} - {1}' -f $p.ProcessId, $p.CommandLine); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } } else { Write-Host '[INFO] No MCP node server processes found.' } } catch { Write-Host '[WARN] Failed to enumerate/stop Node processes: ' $_.Exception.Message }"

if "%FAILED%"=="0" (
  echo.
  echo [SUCCESS] MCP Local LLM uninstalled successfully.
  exit /b 0
) else (
  echo.
  echo [WARN] Uninstall encountered errors, but cleanup was attempted.
  echo If reinstall still fails, close any running node processes and try again.
  exit /b 1
)


`;

fs.writeFileSync(path.join(outputDir, 'uninstall.bat'), uninstallBat);

console.log('All package files generated successfully!');
process.exit(0);
