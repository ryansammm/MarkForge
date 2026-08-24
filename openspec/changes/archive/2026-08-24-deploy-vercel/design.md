## Context

The app already supports three storage backends selected by environment: R2 when all four `R2_*` vars are set, filesystem locally, and it explicitly detects `VERCEL` to avoid trusting ephemeral disk (`lib/server/store.ts`). Auth is a single shared password (`APP_PASSWORD`) plus session cookie signed with `SESSION_SECRET`. Repo lives at GitHub `ryansammm/MarkForge`.

## Goals / Non-Goals

- Goals: production URL on Vercel; zero data loss across serverless invocations; same UX as local.
- Non-Goals: multi-user accounts, custom domain (later), CI/CD pipelines beyond Vercel's default GitHub integration.

## Decisions

- **GitHub integration over CLI deploys**: Vercel watches the repo; every push deploys. No local toolchain dependency. (Alternative considered: `vercel` CLI — adds manual step, drifts from repo state.)
- **R2 as the only prod backend**: matches the built `R2Bucket`; S3-compatible, free 10 GB tier. Filesystem is dev-only.
- **Env vars via Vercel dashboard/CLI, never committed**: `.env` is gitignored; values mirror local ones already present on this machine.
- **No code changes first pass**: deploy as-is, verify with `/api/health` + `/api/storage` + a save round-trip; fix only what breaks.

## Risks / Trade-offs

- [Serverless function size/timeouts] → App is plain Next.js route handlers, no heavy native deps; monitor first deploy.
- [R2 credentials exposure] → Secrets only in Vercel env settings; `.env` stays untracked (already enforced).
- [Share links become publicly reachable] → Share tokens are already capability URLs with optional passwords; acceptable by design.

## Migration Plan

1. Create/confirm R2 bucket + API token (user-side, Cloudflare dashboard).
2. Create Vercel project from the GitHub repo.
3. Set env vars in Vercel: `APP_PASSWORD`, `SESSION_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
4. Deploy, smoke-test health/storage/save-round-trip.
5. Rollback: delete Vercel project or redeploy previous commit; data lives in R2, untouched.

## Open Questions

None blocking; custom domain deferred.
