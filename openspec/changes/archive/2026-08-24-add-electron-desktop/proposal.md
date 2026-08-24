## Why

The user wants a desktop app: same workspace, offline-capable, plus native ability to add local folders/files into the workspace without manual copy-paste.

## What Changes

- Add an Electron shell (`electron/main.cjs` + `preload`) that starts the existing Next.js production server locally and loads it in a window.
- Desktop data lives outside the repo (`%APPDATA%\MarkForge`: `notes\` + `meta\`) via `NOTES_DIR`/`META_DIR` env on the spawned server.
- Native "Import…" dialogs (files / folder) copy content into the workspace store, then the renderer triggers the existing authenticated `POST /api/storage?action=reindex`.
- Import UI appears only when running inside Electron (feature-detected via preload bridge).
- No changes to storage backends, API routes, or the deployed web app.

## Capabilities

### New Capabilities
- `desktop-shell`: The app runs as a desktop window with a local server; users can import local files/folders natively; imported content becomes workspace documents.

### Modified Capabilities

## Impact

- New dev dependency: `electron`. No runtime deps added to the web app.
- New files: `electron/main.cjs`, `electron/preload.cjs`, small sidebar addition.
- Web deploy unaffected (Electron code ignored by Next build).
