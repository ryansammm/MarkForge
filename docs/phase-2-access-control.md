# Phase 2 — Access control

**Status:** Built. All three items closed; two limitations are structural and stated
rather than hidden.
**Scope:** [production-readiness-plan.md](./production-readiness-plan.md) §Phase 2
**Gate:** *can someone else get in?*

---

## Outcome

| Item | State | Where |
|---|---|---|
| 2.1 Replace the password gate | **Done** | `lib/session.ts`, `middleware.ts`, `app/api/auth/route.ts` |
| 2.2 Rate-limit and size-limit the write API | **Done** | `lib/server/rate-limit.ts`, `lib/server/request-limits.ts` |
| 2.3 Share hardening | **Done** | `lib/share.ts`, `lib/server/share-password.ts`, `app/api/share/[token]/route.ts` |

`npm test` — 217 checks across nine suites, plus the 34-document round-trip corpus.

---

## 2.1 — the three things that were wrong

| Problem | Fix |
|---|---|
| The cookie value **was** `APP_PASSWORD` — the master secret sat verbatim in every browser jar and rode along with every request | A signed token carrying `{sid, iat, exp}` and no secret at all |
| `password === expected` short-circuits on the first differing byte | Both sides hashed to a fixed 32 bytes, compared with `timingSafeEqual` |
| No rate limit on `/api/auth` — unlimited guesses, nothing logged | 5 attempts per 15 minutes per client, cleared on success |

Sessions also now expire (7 days) and slide: a token past half its life is re-issued by
the middleware with the same `sid`, so daily use never signs you out and a fortnight
away does.

### The constraint that shaped it

The plan called for session records in the bucket. **The middleware is where a token
has to be rejected, and it runs on the Edge runtime** — no `node:crypto`, no AWS SDK,
no bucket. Even with the Node.js runtime it would mean a storage round trip on every
request, and R2 reads on this deployment measure 150–400ms.

So verification is a pure HMAC computation over the cookie, with Web Crypto, and there
is no session store. That is a real trade, and it costs exactly one thing:

> **There is no per-session revocation.** Signing out clears the cookie on that device.
> A token already copied elsewhere stays valid until it expires. Rotating
> `APP_PASSWORD` or `SESSION_SECRET` invalidates every session at once — that is the
> "sign out everywhere" control, and there is a test asserting it works.

Per-device revocation arrives with real accounts, because that is when the session
store has to exist anyway. Until then the limitation is written at the bottom of
`lib/session.ts`, where someone changing that file will read it.

### Upgrade behaviour

Anyone holding the old `app_access_token` cookie is signed out on first request and
sent to the login page. That is deliberate, and there is a regression test —
`the old password-as-cookie no longer opens the gate` — because the failure mode of
getting it wrong is that the old scheme silently keeps working.

Set `SESSION_SECRET` to a long random value in production. Without it the signing key
is derived from `APP_PASSWORD`, which works and is documented, but means every password
change is also a global sign-out.

## 2.2 — limits

`enforceWriteRate` (120 requests/minute/client) and `readJsonBody` (1MB per document,
64KB per control message) on `/api/files`, `/api/folders`, `/api/rename`, `/api/shares`
and `/api/trash`. Refusals are 429 and 413 at the edge of the route, rather than a
generic 500 from inside the store where a caller cannot tell a refusal from a fault.

**This limiter is per-instance.** On serverless, N instances mean N times the
allowance, and a cold start resets the count. It is not a distributed limiter and
`rate-limit.ts` says so twice. What it buys is turning "unlimited guesses from one
connection" into "a handful per window", at no infrastructure cost.

## 2.3 — share hardening

**Expiring links.** Optional `expiresAt`, enforced inside `isLive` so an expired link
takes the identical 404 path as a revoked one. An unparseable expiry counts as
expired — a corrupt record must not become a link that outlives its own deadline.

**Password-protected links.** scrypt, not a fast hash: `shares.json` is a file in a
bucket that also holds the backups, and a leaked copy should not yield an offline
attack. The hash never leaves the server — `ShareStore.list` returns summaries with
`hasPassword` instead, and there are tests asserting that neither the create response,
the manage list, nor `shares.json` contains the password.

### The one deliberate exception to "every failure is a 404"

A protected share answers **401 `PASSWORD_REQUIRED`**. This is a narrow, considered
break from PRD R8, and it is safe for a specific reason: it is returned **only to
someone who already presented a valid, live token**. They have the link; they already
know the share exists. The alternative is a password-protected link that looks broken.

Everything else still collapses: unknown token, revoked, expired, out of scope, wrong
password on unlock — all 404, all identical. The unlock endpoint is rate-limited per
token and client, since it is a password-guessing surface on an unauthenticated route.

---

## What is still open

- **Per-session revocation** — above. Structural, not an oversight.
- **A distributed rate limiter** — arrives with the shared session store.
- **`SESSION_SECRET` is not yet set on the deployment.** Until it is, the signing key
  is derived from `APP_PASSWORD`. Nothing is broken; global sign-out is just coupled to
  password rotation.
- **The login flow has not been driven in a browser.** The local dev server runs with
  `APP_PASSWORD` empty, so the gate is off; exercising it means typing a password into
  a form, which this agent does not do. The machinery is covered by 21 unit checks
  (forgery, tampering, expiry, renewal, rotation, limits) and 4 middleware checks
  (exempt routes, the plural trap, the gate itself, the legacy cookie). What has not
  been observed end to end is the redirect → form → cookie → workspace round trip.

## Found in passing

`scripts/check-deps.mjs` matched `from "expired"` **inside a doc comment** and reported
a missing package called `expired`. It now strips comments before scanning. A checker
that fails on prose is a checker people learn to ignore.
