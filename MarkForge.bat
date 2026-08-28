@echo off
rem MarkForge launcher - opens the desktop app from this repo (%~dp0).
cd /d "%~dp0"

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
