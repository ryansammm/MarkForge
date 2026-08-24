# Tasks: deploy-vercel

## 1. Cloudflare R2 (user-side)

- [x] 1.1 Confirm/create R2 bucket and note its name
- [x] 1.2 Create R2 API token with Object Read & Write for the bucket; collect Account ID, Access Key ID, Secret Access Key

## 2. Vercel project

- [x] 2.1 Import GitHub repo `ryansammm/MarkForge` into Vercel (or create project via CLI)
- [x] 2.2 Set env vars in Vercel: `APP_PASSWORD`, `SESSION_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- [x] 2.3 Trigger first deployment and wait for build success (CLI deploys get Blocked on this account — Git push deploys fine, ~22s build)

## 3. Verification

- [x] 3.1 `GET /api/health` returns healthy (200, durable:true, backend:r2)
- [x] 3.2 `GET /api/storage` reports R2 as active backend (authenticated: backend=r2, docs=140)
- [x] 3.3 Login with `APP_PASSWORD`; create a doc, save, reload — content persists (API round-trip PUT→GET→DELETE ok)
- [ ] 3.4 Create a share link; open it logged-out — shared content visible, workspace still gated (manual check in UI)

## 4. Wrap-up

- [ ] 4.1 Record production URL (https://markforge.vercel.app custom domain pending; current: mark-forge-gamma.vercel.app); commit openspec docs
- [x] 4.0 Obsidian vault imported: 140 docs via `scripts/sync-storage.ts --from fs --to r2`
- [ ] 4.2 `openspec archive deploy-vercel`
