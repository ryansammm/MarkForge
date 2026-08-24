## Why

The desktop is local-first by design: imports never leave the machine. The user wants cloud publishing to be an explicit, separate action rather than a side effect - so notes stay private until deliberately synced.

## What Changes

- Add a "Sync to cloud…" action (desktop shell only) that copies local documents to the configured R2 bucket on demand: one-way push first (`fs -> r2`), reusing the exact copy rules of `scripts/sync-storage.ts` (create-only, index rebuilt on the destination).
- Electron main reads R2 credentials from the repo `.env` itself for this action only; the workspace server stays filesystem-backed.
- Progress + result surfaced as toasts; no automatic/background syncing in v1.

## Capabilities

### New Capabilities
- `cloud-sync`: An explicit desktop action uploads selected-or-all local documents to R2 without changing what the editor reads locally; failures are reported per-file and never block local work.

### Modified Capabilities

## Impact

- `electron/main.cjs`: new IPC handler running the copy loop (reuses Bucket implementations already in the codebase).
- Sidebar: one button behind the existing `isDesktop` gate.
- No changes to API routes, storage backends, or the deployed web app.
