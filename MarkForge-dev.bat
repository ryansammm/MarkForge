@echo off
rem MarkForge dev mode - Next.js dev server
cd /d D:\Origin\Library\markdown-workspace

rem Kill ALL orphan node processes (next dev servers, stale electron, etc.)
taskkill /IM node.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

echo Starting MarkForge dev server...
echo Logs: http://localhost:3000
echo.
call pnpm dev
