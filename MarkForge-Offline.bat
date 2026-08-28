@echo off
rem MarkForge OFFLINE mode - local storage (R2 pinned off). Run from this repo.
cd /d "%~dp0"
if not exist node_modules ( call pnpm install )
start "" /min cmd /c "set MARKFORGE_ONLINE=0&& pnpm desktop:start"
