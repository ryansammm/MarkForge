@echo off
REM Build portable .exe end-to-end (manual, on-demand).
REM
REM Vercel does NOT need this — it deploys `.next/standalone` directly.
REM This script is for users who want a single .exe they can put on a USB
REM or hand to someone else. Double-click this file from the repo root
REM (or run it from a shell). Output goes to `dist\`.
REM
REM Equivalent to: `pnpm build` (with BUILD_FOR_ELECTRON=1) then
REM `pnpm exec electron-builder --win --x64`.

setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%"

set "BUILD_FOR_ELECTRON=1"
call pnpm build
if errorlevel 1 goto :fail

call pnpm exec electron-builder --win --x64
if errorlevel 1 goto :fail

echo.
echo Done. Portable exe is in dist\
popd
endlocal
exit /b 0

:fail
echo.
echo BUILD FAILED.
popd
endlocal
exit /b 1
