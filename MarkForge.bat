@echo off
rem MarkForge launcher - builds on first run, then opens the desktop app.
cd /d D:\Origin\Library\markdown-workspace
if not exist .next\BUILD_ID (
  echo Building MarkForge - first run only...
  call pnpm build
)
start "" /min cmd /c "pnpm desktop:start"
