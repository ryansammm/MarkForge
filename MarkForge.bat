@echo off
rem MarkForge launcher - cloud R2 storage (from .env). Run from this repo.
cd /d "%~dp0"
rem Kill orphaned MarkForge desktop server (port 3457 only - never other processes).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3457 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul
if not exist node_modules ( call pnpm install )
start "" /min cmd /c "pnpm desktop:start"
