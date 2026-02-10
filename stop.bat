@echo off
REM Wrapper: keep root entrypoint stable while implementation lives under scripts/windows.
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\windows\stop.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
