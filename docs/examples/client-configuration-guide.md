# MCP Client Configuration Guide

This folder contains sample MCP configuration files for different VS Code clients and extensions.

## Prerequisites

1. Build this project so `dist/index.js` exists.
2. Set `MCP_LOCAL_LLM_PATH` to your local installation path.

Windows (PowerShell):
```powershell
[Environment]::SetEnvironmentVariable("MCP_LOCAL_LLM_PATH", "C:/path/to/mcpLocalLLM", "User")
```

macOS/Linux:
```bash
export MCP_LOCAL_LLM_PATH="/path/to/mcpLocalLLM"
```

## Setup by Client

### Kilo Code

1. Copy `kilocode-mcp.json` to `.kilocode/mcp.json` in your target workspace.
2. Reload the IDE window.

### Roo Code

1. Copy `roocode-mcp.json` to `.roo/mcp.json` in your target workspace.
2. Reload the IDE window.

### VS Code Native MCP

1. Copy `vscode-mcp.json` to `.vscode/mcp.json` in your target workspace.
2. Reload the IDE window.

## Path Format

Use forward slashes in config paths:

- Correct: `C:/path/to/mcpLocalLLM/dist/index.js`
- Avoid: `C:\path\to\mcpLocalLLM\dist\index.js`

## Verify the Connection

1. Open Command Palette (`Ctrl+Shift+P`).
2. Run `Developer: Reload Window`.
3. Check MCP server status for `mcp-local-llm`.
4. Confirm status is connected.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `spawn node ENOENT` | `node` not in PATH | Install Node.js and reopen terminal/IDE |
| `Connection closed` | Server startup failed | Verify `MCP_LOCAL_LLM_PATH` and `dist/index.js` |
| `Timeout` | Backend unavailable | Start your configured local backend (for example LM Studio/Ollama) |
| `Not connected` | MCP config not loaded | Recheck file location and JSON validity |
