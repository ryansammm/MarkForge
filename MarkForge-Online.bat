@echo off
rem MarkForge ONLINE mode - cloud R2 storage (from .env). Run from this repo.
cd /d "%~dp0"
if not exist node_modules ( call pnpm install )
start "" /min cmd /c "set MARKFORGE_ONLINE=1&& pnpm desktop:start"
