# Tasks: deploy-vercel

## 1. Cloudflare R2 (user-side)

- [ ] 1.1 Confirm/create R2 bucket and note its name
- [ ] 1.2 Create R2 API token with Object Read & Write for the bucket; collect Account ID, Access Key ID, Secret Access Key

## 2. Vercel project

- [ ] 2.1 Import GitHub repo `ryansammm/MarkForge` into Vercel (or create project via CLI)
- [ ] 2.2 Set env vars in Vercel: `APP_PASSWORD`, `SESSION_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- [ ] 2.3 Trigger first deployment and wait for build success

## 3. Verification

- [ ] 3.1 `GET /api/health` returns healthy
- [ ] 3.2 `GET /api/storage` reports R2 as active backend
- [ ] 3.3 Login with `APP_PASSWORD`; create a doc, save, reload — content persists
- [ ] 3.4 Create a share link; open it logged-out — shared content visible, workspace still gated

## 4. Wrap-up

- [ ] 4.1 Record production URL; commit openspec docs
- [ ] 4.2 `openspec archive deploy-vercel`
