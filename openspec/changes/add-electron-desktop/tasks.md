# Tasks: add-electron-desktop

## 1. Shell

- [ ] 1.1 Install `electron` dev dependency
- [ ] 1.2 `electron/main.cjs`: spawn `next start -p 3457` with `NOTES_DIR`/`META_DIR` under `%APPDATA%\MarkForge`, wait for readiness, open BrowserWindow, quit on close
- [ ] 1.3 `electron/preload.cjs`: contextBridge with `chooseFiles()` / `chooseFolder()` IPC; main copies `.md` preserving relative paths, other files under asset prefix
- [ ] 1.4 package.json: `"main": "electron/main.cjs"`, scripts `"desktop"` (build + run) and `"desktop:start"` (run only)

## 2. UI hook

- [ ] 2.1 Sidebar "Import…" button, visible only when `window.markforge` exists; calls bridge then authenticated reindex + refresh

## 3. Verification

- [ ] 3.1 `pnpm desktop` launches window on localhost:3457; login works with local APP_PASSWORD
- [ ] 3.2 Import a test folder → documents appear without restart; git status stays clean
