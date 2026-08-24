## Why

The workspace only runs on localhost. Deploying to Vercel makes notes reachable from any device and activates public share links, using infrastructure the codebase already targets (`store.ts` detects `VERCEL`, R2 bucket backend is built and tested).

## What Changes

- Add production deployment on Vercel (GitHub repo `ryansammm/MarkForge` → Vercel project).
- Require Cloudflare R2 as the storage backend in production; local filesystem stays for local dev.
- Configure env vars: `APP_PASSWORD`, `SESSION_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- No application code changes expected unless deployment smoke tests reveal gaps.

## Capabilities

### New Capabilities
- `deployment`: The app builds and serves on Vercel; all note data persists in R2 when R2 env vars are present; auth password gates the workspace.

### Modified Capabilities

## Impact

- Infra: Vercel project + Cloudflare R2 bucket (free tiers).
- Env: 6 vars set in Vercel dashboard/CLI.
- Code: none planned; verification via deployed health endpoint (`/api/health`) and storage report (`/api/storage`).
