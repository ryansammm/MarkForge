@echo off
REM MarkForge Offline — launch the desktop app in fully-offline mode.
REM Your notes stay in local folders you choose; no account, no cloud, no R2.
setlocal
cd /d "%~dp0"
set MARKFORGE_OFFLINE=1
set ELECTRON_ENABLE_LOGGING=1

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

REM Kill orphaned MarkForge processes left by a previous (crashed) run.
REM Matched by our project path so unrelated Electron apps (Discord, VS Code) are safe.
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '*MarkForge*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*next dev*' -and $_.ExecutablePath -like '*MarkForge*') }; $k = 0; foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force; $k++ } catch {} }; Write-Host ('[MarkForge] killed ' + $k + ' orphan process(es)')"

REM Free port 3457 in case a non-MarkForge server still holds it
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :3457 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

if not exist ".next" (
  echo [MarkForge] Building the app (first time only, may take a minute)...
  call pnpm desktop > markforge-launch.local.log 2>&1
) else (
  call pnpm desktop:start > markforge-launch.local.log 2>&1
)

echo.
echo [MarkForge] MarkForge has exited. Last log lines:
powershell -NoProfile -Command "Get-Content markforge-launch.local.log -Tail 40 -ErrorAction SilentlyContinue"
pause
