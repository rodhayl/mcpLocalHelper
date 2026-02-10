# Wrapper: keep root entrypoint stable while implementation lives under scripts/windows.
$scriptPath = Join-Path $PSScriptRoot 'scripts\windows\stop.ps1'
if (-not (Test-Path $scriptPath)) {
    Write-Error "Missing script: $scriptPath"
    exit 1
}
& $scriptPath @args
exit $LASTEXITCODE
