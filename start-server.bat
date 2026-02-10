@echo off
REM ========================================
REM MCP Local LLM Server - Shared Instance Start Script
REM 
REM This script starts a SINGLE SHARED server instance that 
REM ALL MCP clients can connect to, avoiding multiple instances.
REM 
REM Usage:
REM   start-server.bat             - Start with default config
REM   start-server.bat my-settings.settings - Start with custom settings
REM
REM After starting, use the MCP configuration printed below
REM in your client's MCP settings (VS Code, Claude Desktop, etc.)
REM ========================================

setlocal EnableDelayedExpansion

REM Change to script directory
cd /d "%~dp0"

REM Configuration
set "SETTINGS_FILE=%~1"
if "%SETTINGS_FILE%"=="" set "SETTINGS_FILE=env.settings"
set "SCRIPT_DIR=%~dp0"
set "DIST_INDEX=%SCRIPT_DIR%dist\index.js"
set "PORT=3000"
set "HOST=127.0.0.1"

echo.
echo ========================================
echo MCP Local LLM Server - Shared Instance
echo ========================================
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if dist exists
if not exist "dist" (
    echo Build not found. Running npm run build...
    call npm run build
    if %ERRORLEVEL% neq 0 (
        echo ERROR: Build failed!
        pause
        exit /b 1
    )
)

REM Check if port is already in use
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%PORT%.*LISTENING"') do (
    echo.
    echo [INFO] Server already running on port %PORT% (PID: %%a)
    echo.
    goto :show_config
)

echo Starting MCP server on http://%HOST%:%PORT%...
echo.

REM ========================================
:show_config
echo ========================================
echo MCP CLIENT CONFIGURATION
echo ========================================
echo.
echo Use ONE of the following configurations in your MCP client:
echo.
echo --- OPTION 1: SSE Transport (RECOMMENDED for shared instance) ---
echo This allows multiple clients to share a single server process.
echo.
echo For Claude Desktop / VS Code / Other Clients (JSON format):
echo {
echo   "mcp-local-llm": {
echo     "transport": "sse",
echo     "url": "http://%HOST%:%PORT%/sse"
echo   }
echo }
echo.
echo --- OPTION 2: Stdio Transport (per-client instance) ---
echo Each client spawns its own server process.
echo.
echo For VS Code (settings.json mcp section):
echo {
echo   "mcp-local-llm": {
echo     "command": "node",
echo     "args": ["%DIST_INDEX:\=/%", "--settings", "%SCRIPT_DIR:\=/%env.settings"]
echo   }
echo }
echo.
echo --- Web UI ---
echo Open http://%HOST%:%PORT% in your browser for the admin UI.
echo.
echo ========================================
echo.
echo Press Ctrl+C to stop the server.
echo ========================================
echo.

REM Check if we should actually start (or just show config for running server)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%PORT%.*LISTENING"') do (
    echo Server is already running. Configuration shown above.
    echo.
    pause
    exit /b 0
)

REM Set environment for single-instance mode
set "MCP_STDIN_SHUTDOWN=0"
set "MCP_LOCAL_LLM_SETTINGS_PATH=%SETTINGS_FILE%"

REM Start the server
node "%DIST_INDEX%" --settings "%SETTINGS_FILE%"

endlocal
