@echo off
rem MarkForge launcher - builds on first run, then opens the desktop app.
cd /d "%~dp0"

rem Kill orphaned MarkForge desktop server (port 3457 only - never other processes).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3457 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

if not exist .next\BUILD_ID (
  echo Building MarkForge - first run only...
  call pnpm build
)

start "" /min cmd /c "pnpm desktop:start"