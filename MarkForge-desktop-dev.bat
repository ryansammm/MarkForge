@echo off
rem MarkForge desktop dev mode - Electron + Next.js dev server (port 3457).
cd /d "%~dp0"

rem Kill orphaned MarkForge desktop server (port 3457 only - never other processes).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3457 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo Starting MarkForge desktop in dev mode...
echo.
call pnpm desktop:start