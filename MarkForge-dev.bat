@echo off
rem MarkForge dev mode - Next.js dev server (port 3000).
cd /d "%~dp0"

rem Kill orphaned dev server (port 3000 only - never other processes).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3000 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo Starting MarkForge dev server...
echo Logs: http://localhost:3000
echo.
call pnpm dev