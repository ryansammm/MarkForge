@echo off
REM MarkForge Offline — launch the desktop app in fully-offline mode.
REM Your notes stay in local folders you choose; no account, no cloud, no R2.
setlocal
cd /d "%~dp0"

set MARKFORGE_OFFLINE=1

where pnpm >nul 2>nul || (
  echo pnpm not found. Install it first:  npm i -g pnpm
  pause
  exit /b 1
)

if not exist ".next" (
  echo First launch: building MarkForge (this can take a minute)...
  call pnpm desktop
) else (
  call pnpm desktop:start
)
