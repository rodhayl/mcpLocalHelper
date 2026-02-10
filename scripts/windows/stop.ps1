# MCP Local LLM Server - Stop Script
# This script will stop any running server processes

Write-Host "========================================"  -ForegroundColor Cyan
Write-Host "MCP Local LLM Server - Stop Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Searching for running server processes..." -ForegroundColor Yellow
Write-Host ""

$stopped = $false

# Method 1: Check port 3000
$portInUse = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq "Listen" } | Select-Object -First 1

if ($portInUse) {
    $processId = $portInUse.OwningProcess
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    
    if ($process -and $process.ProcessName -eq "node") {
        Write-Host "Found server process using port 3000: PID $processId" -ForegroundColor Yellow
        try {
            Stop-Process -Id $processId -Force
            Write-Host "Successfully stopped server with PID $processId" -ForegroundColor Green
            $stopped = $true
        }
        catch {
            Write-Host "Failed to stop server with PID $processId" -ForegroundColor Red
        }
    } else {
        Write-Host "Port 3000 is in use by non-Node process: PID $processId" -ForegroundColor Yellow
    }
}

# Method 2: Find all node processes running index.js (backup method)
if (-not $stopped) {
    try {
        $nodeProcesses = Get-WmiObject Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*index.js*"
        }
        
        if ($nodeProcesses) {
            foreach ($proc in $nodeProcesses) {
                Write-Host "Found node process running index.js: PID $($proc.ProcessId)" -ForegroundColor Yellow
                try {
                    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                    Write-Host "Successfully stopped PID $($proc.ProcessId)" -ForegroundColor Green
                    $stopped = $true
                }
                catch {
                    Write-Host "Failed to stop PID $($proc.ProcessId): $_" -ForegroundColor Red
                }
            }
        }
    }
    catch {
        # WMI might fail, silently continue
    }
}

Write-Host ""
if ($stopped) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Server stopped successfully." -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
} else {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "No running server processes found." -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Cyan
}

Write-Host ""
