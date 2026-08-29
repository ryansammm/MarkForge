@echo off
rem MarkForge launcher - opens the desktop app from this repo (%~dp0).
cd /d "%~dp0"

rem Kill orphaned MarkForge desktop server (port 3457 only - never other processes).
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":3457 "') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

rem First run only: install deps + build once.
if not exist node_modules (
  echo Installing dependencies...
  call pnpm install
)
if not exist .next\BUILD_ID (
  echo Building MarkForge - first run only...
  call pnpm build
)

start "" /min cmd /c "pnpm desktop:start"