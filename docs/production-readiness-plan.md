# Production Readiness Plan — Markdown Workspace ("Morrow")

**Date:** 6 August 2026
**State assessed:** `main` @ `b6ddbe7`, after Sprint 6 (share model, R2 backend, corpus sync)
**Question this answers:** what stands between here and a deployment that other
people's notes can live in.

---

## Verdict first

The product is **feature-complete for v1 and not yet safe to run as a service.**

Six sprints went into correctness — round-trip integrity, link-graph safety, index
convergence, share-token opacity — and that work is genuinely good. What has not been
built is everything that assumes a *second* person, a *second* server instance, and a
*bad day*: real accounts, backups, concurrency across instances, and any way to know
something broke.

Three items below are hard blockers. Nothing ships to anyone but the author until they
are done.

| | Blocker | Why it blocks | Est | Status |
|---|---|---|---|---|
| **B1** | The password gate is not an authentication system | The session cookie *is* the plaintext secret, comparison is not constant-time, and `/api/auth` has no rate limit | 6h | **Closed** — see [phase-2-access-control.md](./phase-2-access-control.md) |
| **B2** | R2's **write** path has never run against real Cloudflare credentials | The only durable backend on the deployment target is untested where it matters | 3h | **Closed** — run 7 Aug 2026; the write path held, both failures were defects in the suite |
| **B3** | Deletion is permanent and there are no backups | One misclick or one bad `moveDirectory` and a corpus is gone | 5h | **Closed** — see [phase-1-data-safety.md](./phase-1-data-safety.md) |

---

## How this plan is organised

Four gates. Each gate is a question with a yes/no answer, and the phase below it is
what makes the answer yes. Gates are ordered by what a failure costs: data loss beats
downtime beats polish.

```
Gate 1  Can it lose data?          →  Phase 1 — Data safety        (16h)
Gate 2  Can someone else get in?   →  Phase 2 — Access control     (12h)
Gate 3  Will we know it broke?     →  Phase 3 — Operability        (11h)
Gate 4  Is it pleasant at scale?   →  Phase 4 — Scale & polish     (14h)
```

Total ≈ 53h. At the sprint cadence this repo has run (≈15h committed, ≤16h ceiling)
that is **four sprints**: Sprints 7–10.

---

## Phase 1 — Data safety (Gate 1: "can it lose data?")

> **Built.** Outcome, deviations and what still needs the user's own bucket:
> [phase-1-data-safety.md](./phase-1-data-safety.md).

Everything here is P0. This phase is the whole reason the product can claim
"your notes stay files you can open in vim."

### 1.1 Trash instead of delete — 3h · **B3**

`DELETE /api/files` and `removeDirectory` unlink immediately. `confirmDelete` in
[workspace-app.tsx](../components/workspace/workspace-app.tsx) shows a good confirm
dialog listing folder contents — and then the bytes are gone.

- Move deletes to `.trash/<iso-timestamp>/<original-path>` inside the same bucket.
- Restore action in the UI; purge older than 30 days on a scheduled route.
- `.trash/` is excluded from the index walk, from search, and from share scope
  resolution. The scope test in `share.test.ts` gets a sibling for it — a shared
  folder must not start publishing its own deleted files.

**Done when:** deleting a folder of 5 documents and restoring it yields byte-identical
files and an index that matches a fresh reindex.

### 1.2 Backup and restore drill — 2h · **B3**

There is no backup story at all. R2 supports versioning; nothing turns it on.

- Enable object versioning on the bucket; document the lifecycle rule.
- `scripts/backup.ts` — stream the whole corpus plus `shares.json` to a local tarball.
- **Run a restore into an empty bucket and diff it.** A backup that has never been
  restored is a belief, not a backup.

**Done when:** a restore drill is recorded in `docs/` with the timing and the diff
result.

### 1.3 Prove R2's write path against real credentials — 3h · **B2**

[storage-backends.md](./storage-backends.md) says the backend has never run against
real Cloudflare credentials. That is now half out of date and worth stating precisely:
a dev server against the configured bucket serves `/api/index` and `/api/files` with
`X-Storage-Backend: r2` and `X-Storage-Durable: true`, so **reads are proven**. Every
write — `PUT`, rename, folder move, delete, `shares.json` — still is not, and those are
the operations that can lose something.

- Run `tests/backend.test.ts` against a real scratch bucket, not `MemoryBucket`.
- Exercise what only a real endpoint can fail on: 5xx retry behaviour, `If-Match` /
  ETag semantics against R2's actual implementation (the store hashes content itself,
  so verify the two agree), >1MB documents, keys with spaces and non-ASCII names.
- Wire it as an opt-in CI job gated on secrets, so it never silently stops running.

**Done when:** the full backend suite is green against R2 and the run is reproducible
from a documented command.

### 1.4 Cross-instance write safety — 5h

`WorkspaceStore.queue` serialises index mutations **per process**, and its own comment
says so: on serverless that is per-instance, and two lambdas racing are caught only by
`If-Match`. But the *index* read-patch-write has no such precondition — two concurrent
saves to different documents can each read `index.json`, patch, and write, and the
second silently drops the first document's entry. The document bytes survive; the
index forgets one. It self-heals on reindex, which is exactly why it will go unnoticed.

- Write `index.json` with a conditional put (R2 supports `If-Match` on ETag); on
  precondition failure, re-read, re-patch, retry with backoff, cap at 5.
- Add a test that runs 20 concurrent writes through two `WorkspaceStore` instances
  sharing one bucket and requires the final index to equal a fresh reindex.

**Done when:** that test is green, and it fails if the conditional put is removed.

### 1.5 Conflict files — 3h

Carried since Sprint 3 and still open: a failed `If-Match` refuses the write and the
UI reports it. The plan of record is `<name>.conflict.md` plus a non-blocking notice.
Sprint 4 added a second caller (rename refuses per-file on etag mismatch); both should
route through one mechanism rather than growing separate ones.

**Done when:** editing the same document in two browser tabs produces one saved file
and one `.conflict.md`, with neither edit lost.

---

## Phase 2 — Access control (Gate 2: "can someone else get in?")

> **Built.** Outcome, the Edge-runtime constraint that changed the session design, and
> what it costs: [phase-2-access-control.md](./phase-2-access-control.md).

### 2.1 Replace the password gate — 6h · **B1**

[middleware.ts](../middleware.ts) and [api/auth](../app/api/auth/route.ts) share one
secret for the whole app, and the implementation has three specific problems:

| Problem | Where | Consequence |
|---|---|---|
| The cookie value **is** `APP_PASSWORD` | `route.ts:12`, `middleware.ts:38` | The long-lived secret is stored verbatim in the browser jar and sent on every request. Any log, proxy, or backup that captures a cookie header captures the master password. |
| `password === expectedPassword` | `route.ts:8` | Not constant-time. A remote timing attack is impractical over the internet, but this is a one-line fix and there is no reason to leave it. |
| No rate limit on `POST /api/auth` | — | Unlimited guesses against a single human-chosen password, and no lockout, no log, no alert. |

Also: `maxAge` is 30 days with no rotation and no way to invalidate a session short of
changing the password for everyone.

**Replacement:** signed, opaque session tokens — random id in the cookie, session
record in the bucket beside `shares.json`, HMAC-signed, 7-day sliding expiry, and a
"sign out everywhere" that revokes. Keep `APP_PASSWORD` as the credential for now;
this is about the session, not about accounts.

Then, separately: rate-limit `/api/auth` (5 attempts / 15 min / IP) and use
`timingSafeEqual`.

**Done when:** the cookie value appears nowhere in the environment, a revoked session
is refused on the next request, and the 6th login attempt in a window is refused.

### 2.2 Rate-limit and size-limit the write API — 3h

`/api/files`, `/api/folders`, `/api/rename`, `/api/shares` have no rate limit and no
request-size cap. One authenticated client can fill the bucket. Add a per-session
token bucket and a payload ceiling (1MB/document is generous for Markdown), returning
429 and 413 rather than failing deep in the store.

### 2.3 Share hardening — 3h

The share model is the strongest part of the codebase and its own doc names what is
missing. Two of those items are security, not features:

- **Expiring links** — revocation is manual today, so every link ever sent is live
  until someone remembers it. Add optional `expiresAt`, enforced in the same 404 path
  as revocation so it leaks nothing new.
- **Password-protected shares** — a token is all-or-nothing; a link forwarded once is
  public forever.

Keep the invariant that made this work: **one 404 for every failure**, and never a
lookup keyed on anything human-readable.

---

## Phase 3 — Operability (Gate 3: "will we know it broke?")

> **Built.** What a log line is allowed to contain, and the three operator actions
> still outstanding: [phase-3-operability.md](./phase-3-operability.md).

### 3.1 CI — 3h

There is no `.github/` directory. `npm run verify` chains deps → typecheck → lint →
test → build and is a genuinely good gate that nothing enforces; six sprints of tests
protect the repo only when someone remembers to run them.

- GitHub Actions on push and PR: `npm run verify` on Node 22, plus the R2 job from 1.3
  on a schedule.
- Branch protection on `main`.

### 3.2 Error tracking and structured logs — 3h

Routes `console.error` and return an opaque 500. In production nobody reads those.

- Sentry (or equivalent) on client and server, with the share routes' 404-for-
  everything discipline preserved — report the internal error, still answer 404.
- Structured request logs: method, route, status, duration, backend kind. No document
  paths, no titles, no tokens. **Log lines are a leak surface for a private corpus.**

### 3.3 Health and storage-durability surfacing — 2h

`backendHealth()` already reports `durable: false` when R2 is unconfigured, and
`/api/index` returns it as `X-Storage-Durable`. Nothing in the UI reads it. A user
whose deployment is silently writing to an ephemeral filesystem should be told, loudly
and permanently, not discover it when the instance recycles.

- `/api/health` for uptime checks: backend kind, durability, index document count,
  last write timestamp.
- A persistent banner in the workspace when `durable: false`.

### 3.4 Runbook — 3h

One document, in `docs/`: how to restore from backup, how to force a reindex, what to
do when the index and the bucket disagree, how to revoke every share at once, how to
rotate `APP_PASSWORD`, and who to wake. Written before it is needed, because it will
be needed at 2am.

---

## Phase 4 — Scale and polish (Gate 4: "is it pleasant at scale?")

> **Built, and §4.1 invalidated part of this plan exactly as it warned it might.**
> The measured limits, and the sprint they imply: [phase-4-scale.md](./phase-4-scale.md).

### 4.1 Corpus scale — 4h

Named as an open gap since Sprint 4 and still true: the corpus is **4 documents**. The
architecture bets on a client-held index and in-memory search, and that bet has never
been tested where it might fail.

- Generate a synthetic 2,000-document / 40MB corpus with a realistic link graph.
- Measure and record: `/api/index` payload size, cold load to first paint, Cmd+K
  latency, rename-with-50-inbound-links duration, full reindex duration.
- Set tripwires. The likely first failure is the index payload: at 2,000 documents,
  shipping every document's body to the client on boot stops being reasonable, and the
  fix — a metadata-only index with bodies fetched on demand — is a real piece of work
  that should be discovered by a benchmark, not by a user.

**This item can invalidate the plan's own estimates.** Run it early in the phase.

### 4.2 Mobile — 4h

`globals.css:208` hides the sidebar entirely below 768px, with nothing in its place:
on a phone there is no navigation and no way to reach another document. The share
reader page, which is the surface most likely to be opened on a phone, has not been
checked at all.

- Sidebar becomes a drawer under 768px, with a header trigger.
- Verify the reader page and the editor at 375px.

### 4.3 Accessibility pass — 3h

Row actions already handle `focus-within`, which is a good sign. Not yet done: a full
keyboard traversal of the tree (arrow keys, not just tab), focus return after dialogs
close, `aria-live` on the save indicator so a screen reader hears "saved", and a
contrast check of both themes including the new editor decorations.

### 4.4 The design mockup's remaining shell — 3h

The first design carries shell affordances the app has not grown yet, all cheap and
all independent of each other:

- **Breadcrumb** (`Getting started › Welcome…`) replacing the mono path string.
- **Details panel** — created, updated, word count. `updatedAt` is already indexed.
- **Backlink count badge** on the panel header.
- Collapsible left and right rails with persisted state.
- "Recent" and "Shared with me" nav sections — the second is a UI over
  `GET /api/shares`, which already exists.

Deliberately **not** in this phase, and not in v1: workspace switching (the
single-corpus decision in [prd-q1-q3-decisions.md](./prd-q1-q3-decisions.md) rules it
out), and the per-user footer, which implies accounts this product does not have.

---

## Sprint mapping

| Sprint | Focus | Items | Est |
|---|---|---|---|
| **7** | Nothing can lose bytes | 1.1, 1.2, 1.3, 1.4 | 13h |
| **8** | Nobody gets in, and we know when they try | 1.5, 2.1, 2.2 | 12h |
| **9** | We find out before the user does | 2.3, 3.1, 3.2, 3.3, 3.4 | 14h |
| **10** | It holds up at real size | 4.1, 4.2, 4.3, 4.4 | 14h |

Standing rule 3 applies throughout: **every addition needs a written removal.**

## Launch criteria

Ship to people other than the author when all of these are true:

- [x] **B1 closed** — sessions are signed tokens, the password is out of the cookie
- [x] **B2 closed** — the R2 write suite ran against a real bucket; conditional writes,
      key signing, large documents, trash and reindex all held
- [x] **B3 closed** — deletes are recoverable, backups exist and restore
- [x] A restore drill has been run, not just written — 6 Aug 2026, byte-identical
- [x] `npm run verify` runs in CI on every push — **branch protection still to enable**
- [x] A benchmark exists at ≥1,000 documents with recorded numbers — **and it found
      that the client index does not hold past ~1,000**; see
      [phase-4-scale.md](./phase-4-scale.md)
- [ ] The runbook exists and someone other than the author has followed it once — it
      exists; nobody has followed it
- [ ] An error in production reaches a human within 5 minutes — needs `ERROR_WEBHOOK_URL`
- [x] The app is usable on a phone — the sidebar is a drawer; the document went from
      119px to the full 375px
- [x] A revoked share is dead within one request — and now an expired one too

## Explicitly out of scope for v1

Real-time collaboration, AI features, multi-workspace switching, per-user accounts and
billing, custom domains for shares, and a mobile app. Each is a product decision, not a
readiness gap, and none of them belong in a plan whose job is to make the current
product safe.
