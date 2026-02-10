@echo off
REM ============================================================
REM MCP Local LLM - NPM Package Builder
REM ============================================================
REM This script creates a distributable npm package that can be
REM installed globally and used from any VS Code workspace.
REM 
REM Output: dist_package\mcp-local-llm-{version}.tgz
REM ============================================================

setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo    MCP Local LLM - NPM Package Builder
echo ============================================================
echo.

REM Get the script's directory (where the project is)
set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

REM ============================================================
REM Step 1: Prerequisites Check
REM ============================================================
echo [STEP] 1/8: Checking prerequisites...

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js first.
    exit /b 1
)

where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm is not installed. Please install npm first.
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
for /f "tokens=*" %%i in ('npm -v') do set NPM_VERSION=%%i
echo [OK] Node.js %NODE_VERSION%, npm v%NPM_VERSION% found

REM ============================================================
REM Step 2: Clean Previous Build
REM ============================================================
echo.
echo [STEP] 2/8: Cleaning previous build...

if exist "dist" (
    rmdir /s /q "dist"
    echo [OK] Removed old dist folder
)

if exist "dist_package" (
    rmdir /s /q "dist_package"
    echo [OK] Removed old dist_package folder
)

mkdir "dist_package"
echo [OK] Created dist_package folder

REM ============================================================
REM Step 3: Install Dependencies (if needed)
REM ============================================================
echo.
echo [STEP] 3/8: Checking dependencies...

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install dependencies
        exit /b 1
    )
) else (
    echo [OK] Dependencies already installed
)

REM ============================================================
REM Step 4: TypeScript Compilation
REM ============================================================
echo.
echo [STEP] 4/8: Compiling TypeScript...

call npm run build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] TypeScript compilation failed
    exit /b 1
)
echo [OK] TypeScript compiled to dist/

REM ============================================================
REM Step 5: Create Package Structure
REM ============================================================
echo.
echo [STEP] 5/8: Creating package structure...

REM Copy compiled JavaScript
xcopy "dist" "dist_package\dist" /E /I /Q >nul
echo [OK] Copied compiled JavaScript

REM ============================================================
REM Step 6: Generate Package Files
REM ============================================================
echo.
echo [STEP] 6/8: Generating package files...

REM Create the distribution package.json using Node.js
node -e "const pkg = require('./package.json'); const distPkg = { name: 'mcp-local-llm', version: pkg.version, description: 'MCP Local LLM Server - Agent-like, Plug-and-Play LLM integration with privacy-first local analysis', main: 'dist/index.js', bin: { 'mcp-local-llm': 'dist/index.js' }, scripts: { start: 'node dist/index.js', postinstall: 'node postinstall.js' }, keywords: ['mcp', 'llm', 'vscode', 'copilot', 'local-llm', 'ollama', 'lmstudio', 'ai', 'code-analysis'], author: pkg.author || '', license: pkg.license || 'MIT', repository: pkg.repository, bugs: pkg.bugs, homepage: pkg.homepage, engines: { node: '>=18.0.0' }, dependencies: pkg.dependencies }; require('fs').writeFileSync('dist_package/package.json', JSON.stringify(distPkg, null, 2));"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to create package.json
    exit /b 1
)
echo [OK] Created package.json

REM Generate all documentation files using Node.js (avoids batch file escaping issues)
node "%~dp0scripts\generate_package_files.js" "%~dp0dist_package"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to generate package files
    exit /b 1
)

echo [OK] Created env.settings.example
echo [OK] Created mcp.json.example
echo [OK] Created mcp.json.alternative.example
echo [OK] Created .npmignore
echo [OK] Created README.md
echo [OK] Created INSTALL.md
echo [OK] Created install.bat
echo [OK] Created uninstall.bat
echo [OK] Created postinstall.js

REM ============================================================
REM Step 7: Pack the Package
REM ============================================================
echo.
echo [STEP] 7/8: Creating npm package...

cd dist_package
call npm pack
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to create npm package
    cd ..
    exit /b 1
)
cd ..

REM Find the package file name
for %%f in (dist_package\*.tgz) do (
    echo [OK] Package created: %%~nxf
    set "PACKAGE_FILE=%%~nxf"
)

REM ============================================================
REM Step 8: Summary
REM ============================================================
echo.
echo ============================================================
echo    BUILD COMPLETE!
echo ============================================================
echo.
echo [OK] Package Location: dist_package\%PACKAGE_FILE%
echo.
echo To install globally:
echo   npm install -g dist_package\%PACKAGE_FILE%
echo.
echo To install in a project:
echo   npm install dist_package\%PACKAGE_FILE%
echo.
echo After installation, see dist_package\INSTALL.md for setup instructions.
echo.
echo Files included in dist_package\:
echo   - %PACKAGE_FILE%              (the npm package)
echo   - env.settings.example         (default settings template)
echo   - mcp.json.example             (VS Code MCP config - global install)
echo   - mcp.json.alternative.example (VS Code MCP config - local install)
echo   - README.md                    (package documentation)
echo   - INSTALL.md                   (detailed installation guide)
echo.
echo ============================================================
exit /b 0
