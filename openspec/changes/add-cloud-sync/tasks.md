# Tasks: add-cloud-sync

## 1. Push engine

- [x] 1.1 `scripts/push-to-cloud.ts`: FsBucket → R2Bucket copy, create-only, single reindex, JSON result on stdout
- [ ] 1.2 Verify against real bucket (CLI run with R2_* env)

## 2. Desktop wiring

- [x] 2.1 `electron/main.cjs`: read repo `.env` for credentials, spawn the script via IPC (`markforge:sync-to-cloud`)
- [x] 2.2 `electron/preload.cjs`: expose `syncToCloud()`
- [x] 2.3 Sidebar "Sync to cloud…" button behind `isDesktop` gate, toast feedback

## 3. Verification

- [ ] 3.1 CLI push: new files upload, existing skipped (done manually — copied 2, skipped 141)
- [ ] 3.2 Button round-trip from the desktop window
- [ ] 3.3 Confirm web app (Vercel) sees pushed documents after its own reindex/refresh

## 4. Wrap-up

- [ ] 4.1 Commit + archive change
