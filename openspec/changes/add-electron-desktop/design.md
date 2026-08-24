## Context

The web app already runs anywhere Node runs; `next start` + `FsBucket` gives a complete local instance. `POST /api/storage?action=reindex` rebuilds the index behind auth. Electron is the approved shell (PC-first assessment done).

## Goals / Non-Goals

- Goals: one-command desktop launch from the repo; native import dialogs; zero changes to deployed web behavior.
- Non-Goals: installer/packaging (later), R2 sync on desktop, auto-update, multi-window.

## Decisions

- **Spawn `next start`, don't embed a server**: reuses the exact prod code path. Port 3457 to avoid clashing with dev on 3000.
- **Data outside repo**: `NOTES_DIR`/`META_DIR` env → `%APPDATA%\MarkForge\notes|meta`; both are plain env reads in `fs-bucket.ts`. Repo stays clean.
- **Auth reuse**: child server loads repo `.env` (APP_PASSWORD) — user logs in once inside the window; no bypass code in middleware.
- **Renderer-driven reindex**: preload exposes only `chooseFiles()/chooseFolder()` via `contextBridge` (contextIsolation on, nodeIntegration off). The renderer — which owns the session cookie — calls the existing reindex endpoint after IPC reports copied paths. Main process never touches the API.
- **Copy rules in main**: `.md` keeps relative path; other files go under the asset prefix used by `lib/server/assets`.

## Risks / Trade-offs

- [Electron download ~120 MB] → one-time dev install, machine has ample disk/RAM.
- [Port conflict if two instances] → main checks port free before spawn; second launch focuses existing… v1: just fails visibly with a clear log line.
- [.env missing locally] → server starts with gate off (existing behavior); acceptable for personal desktop use.

## Migration Plan

New files only; nothing to migrate. Rollback = delete `electron/` + script entries.

## Open Questions

None.
