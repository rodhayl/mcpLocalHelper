# MCP Local LLM Server - Start Script
# This script will install dependencies, build, and start the server

Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "MCP Local LLM Server - Start Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed!" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$nodeVersion = node --version
Write-Host "Node.js version: $nodeVersion" -ForegroundColor Green
Write-Host ""

# Check if npm is installed
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: npm is not installed!" -ForegroundColor Red
    Write-Host "Please install Node.js (includes npm) from https://nodejs.org/" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Install dependencies if needed
Write-Host "[2/5] Checking dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "Dependencies not found. Installing..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to install dependencies!" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Dependencies installed successfully." -ForegroundColor Green
} else {
    Write-Host "Dependencies already installed." -ForegroundColor Green
}
Write-Host ""

# Build the project
Write-Host "[3/5] Building project..." -ForegroundColor Yellow
if (-not (Test-Path "dist")) {
    Write-Host "Build directory not found. Building project..." -ForegroundColor Yellow
} else {
    Write-Host "Rebuilding to ensure latest changes..." -ForegroundColor Yellow
}

npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to build project!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "Project built successfully." -ForegroundColor Green
Write-Host ""

# Check if server is already running and stop it
Write-Host "[4/5] Checking for existing server..." -ForegroundColor Yellow

# Check if port 3000 is in use
$portInUse = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" } | Select-Object -First 1
if ($portInUse) {
    $processId = $portInUse.OwningProcess
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") {
        Write-Host "Found existing server using port 3000 with PID $processId. Stopping it..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force
        Start-Sleep -Seconds 2
        Write-Host "Existing server stopped." -ForegroundColor Green
    }
} else {
    Write-Host "No existing server found." -ForegroundColor Green
}
Write-Host ""

# Start the server
Write-Host "[5/5] Starting the server..." -ForegroundColor Yellow
Write-Host "Server will be available at http://127.0.0.1:3000" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Cyan
Write-Host "" 
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

npm start
