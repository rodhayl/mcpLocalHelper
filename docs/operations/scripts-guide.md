# Server Management Scripts

This document describes the automated scripts for managing the MCP Local LLM Server on Windows.

## Overview

Two pairs of scripts are provided for easy server management:
- **Batch files** (`.bat`): Simple double-click execution, calls PowerShell scripts
- **PowerShell scripts** (`.ps1`): Contains the actual logic

## Scripts

### start.bat / start.ps1

**Purpose:** Start the MCP Local LLM server with automatic dependency management.

**What it does:**
1. Verifies Node.js is installed
2. Checks and installs npm dependencies if missing
3. Builds the TypeScript project (or rebuilds if already built)
4. Detects and stops any existing server instances
5. Starts the server on http://127.0.0.1:3000

**Usage:**
```cmd
# Double-click start.bat in Windows Explorer, or run:
start.bat

# Or run PowerShell script directly:
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

**Output:**
- Colored progress messages showing each step
- Server status and backend availability
- Web UI URL when ready

**First-time users:**
The script is designed for zero-configuration setup. Just download the repository and run `start.bat` - it will handle everything automatically.

### stop.bat / stop.ps1

**Purpose:** Gracefully stop any running MCP Local LLM server instances.

**What it does:**
1. Searches for server processes using multiple methods:
   - Checks port 3000 for listening processes
   - Searches for node.exe processes running index.js
2. Stops all found server processes
3. Confirms shutdown

**Usage:**
```cmd
# Double-click stop.bat in Windows Explorer, or run:
stop.bat

# Or run PowerShell script directly:
powershell -ExecutionPolicy Bypass -File .\stop.ps1
```

**Output:**
- Lists found server processes with PIDs
- Confirms successful shutdown
- Reports if no server is running

## Detection Methods

The stop script uses multiple detection methods to ensure reliability:

1. **Port-based detection** (Primary): Finds processes listening on port 3000
2. **Command-line detection** (Fallback): Searches for node.exe running index.js

This dual approach ensures the server is found even if it's starting up or in an unusual state.

## Restart Behavior

The `start.bat` script automatically handles restarts:
- If a server is already running, it will be stopped before starting a new instance
- This ensures you always get a clean start with the latest code changes

## Troubleshooting

### "Node.js is not installed"
- Install Node.js from https://nodejs.org/ (version 18 or higher)
- Ensure Node.js is in your system PATH

### "Failed to install dependencies"
- Check your internet connection
- Try running `npm cache clean --force` then run start.bat again
- Ensure you have write permissions in the project directory

### "Failed to build project"
- Check for TypeScript errors in the output
- Ensure all source files are present
- Try deleting the `dist` folder and running start.bat again

### "Port 3000 is already in use"
- Another application is using port 3000
- Run stop.bat to stop any MCP servers
- Check for other applications using port 3000: `Get-NetTCPConnection -LocalPort 3000`
- Configure a different port in `env.settings` (`[advanced] SERVER_PORT` or `server.port` in `CONFIG_JSON`)

### Server won't stop
- Use Task Manager to manually kill node.exe processes
- Check if the process is truly hung or just taking time to shut down
- As a last resort: `taskkill /F /IM node.exe` (warning: kills ALL node processes)

## Technical Details

### Why Both .bat and .ps1?

- **Batch files (.bat)**: 
  - Easy to double-click in Windows Explorer
  - No execution policy restrictions
  - Wrapper that launches PowerShell with proper settings

- **PowerShell files (.ps1)**:
  - Rich scripting capabilities
  - Better error handling
  - Colored output for better UX
  - More reliable process management

### Process Detection

The scripts detect server processes by:
1. Checking TCP connections on port 3000 (HTTP server)
2. Using WMI to query node.exe command lines for "index.js"

This ensures the server is found regardless of how it was started.

### Automatic Restart Logic

When `start.bat` runs:
1. Checks if port 3000 is in use
2. If yes, identifies the process ID
3. Verifies it's a node.exe process
4. Stops it forcefully
5. Waits 2 seconds for cleanup
6. Starts a fresh server instance

This makes development iteration seamless - just run start.bat whenever you want to restart.

## Examples

### Development Workflow
```cmd
# Edit code...
# Run start.bat to rebuild and restart
start.bat

# Test the server...

# Stop when done
stop.bat
```

### Agent Scenario Runner (Local LLM + MCP)
Use this to smoke-test that your selected local LLM can (a) plan and execute repo tasks with built-in tools and (b) drive external MCP tools (e.g. `chrome-devtools`).

```powershell
# Build first (updates dist/ used by the script)
npm run build

# Run against LM Studio (OpenAI-compatible server) with the requested model
$env:MCP_LOCAL_LLM_BACKEND_ID='lmstudio'
$env:MCP_LOCAL_LLM_MODEL='gguf-gpt-oss-20b-derestricted'
node scripts\run_agent_scenarios.mjs
```

Environment variables supported:
- `MCP_LOCAL_LLM_SETTINGS_PATH` (preferred; default: auto-discovery or `./env.settings`)
- `MCP_LOCAL_LLM_CONFIG` (legacy alias; treated as a settings file path)
- `MCP_LOCAL_LLM_BACKEND_ID` (e.g. `lmstudio`, `ollama`)
- `MCP_LOCAL_LLM_MODEL` (e.g. `gguf-gpt-oss-20b-derestricted`)
- `MCP_LOCAL_LLM_LMSTUDIO_BASE_URL` (default: `http://127.0.0.1:1234`)
- `MCP_LOCAL_LLM_SCENARIOS` (optional comma-separated scenario IDs to run, e.g. `repo_summary,mcp_server_probe`)
- `MCP_ORCHESTRATION_PLANS_DIR` (override plan persistence directory; default: `.orchestration-plans`)
- `LLM_CHAT_TIMEOUT_MS` (default: `300000`) - increases time allowed for slow local models
- `LLM_LIST_MODELS_TIMEOUT_MS` (default: `8000`) - model listing timeout for local backends
- `LLM_HTTP_TIMEOUT_MS` (default: `300000`) - fallback timeout for backend HTTP calls
### Checking Server Status
```powershell
# Check if server is running
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue

# See server process details
Get-Process node | Where-Object { $_.CommandLine -like "*index.js*" }
```

### Manual Cleanup
```powershell
# Stop all node processes (nuclear option)
Stop-Process -Name node -Force

# Check what's using port 3000
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess

# Prune runtime artifacts created by backups and orchestration plans
npm run cleanup:runtime

# Preview cleanup actions without deleting files
node scripts/cleanup-runtime-artifacts.js --dry-run
```

Runtime cleanup defaults:
- Removes `.mcp-backups/tests/` (test-only backup artifacts)
- Removes backup files older than 14 days and keeps only the newest 1000 backup files
- Removes orchestration plans older than 14 days and keeps only the newest 200 plans
- Removes orphan `*.tmp` files in `.orchestration-plans/`

## Integration with Development Tools

The scripts are designed to work seamlessly with:
- VS Code tasks (can be called from tasks.json)
- Windows Terminal
- PowerShell ISE
- Command Prompt
- Windows Task Scheduler (for auto-start)

## Security Notes

- The PowerShell scripts use `-ExecutionPolicy Bypass` to avoid execution policy restrictions
- This is safe because the .bat wrappers explicitly call known local scripts
- No network access is required for the scripts themselves (only for npm install)
- Scripts only interact with local processes and ports

