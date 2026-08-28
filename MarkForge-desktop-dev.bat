@echo off
rem MarkForge desktop dev mode - Electron + Next.js dev server
cd /d "%~dp0"

rem Kill ALL orphan node processes (next dev servers, stale electron, etc.)
taskkill /IM node.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

echo Starting MarkForge desktop in dev mode...
echo.
call pnpm desktop:start
