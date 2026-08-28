@echo off
REM MarkForge Offline — launch the desktop app in fully-offline mode.
REM Your notes stay in local folders you choose; no account, no cloud, no R2.
setlocal
cd /d "%~dp0"
set MARKFORGE_OFFLINE=1

where pnpm >nul 2>nul || (
  echo [MarkForge] pnpm not found. Install it first:  npm i -g pnpm
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [MarkForge] First run: installing dependencies (this can take a few minutes)...
  call pnpm install
  if errorlevel 1 (echo [MarkForge] pnpm install failed. & pause & exit /b 1)
)

echo [MarkForge] Starting... progress is logged to markforge-launch.local.log
if not exist ".next" (
  echo [MarkForge] Building the app (first time only, may take a minute)...
  call pnpm desktop > markforge-launch.local.log 2>&1
) else (
  call pnpm desktop:start > markforge-launch.local.log 2>&1
)

echo.
echo [MarkForge] MarkForge has exited. Last log lines:
powershell -NoProfile -Command "Get-Content markforge-launch.local.log -Tail 30 -ErrorAction SilentlyContinue"
pause
