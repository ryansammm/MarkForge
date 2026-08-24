# Phase 3 — Operability

**Status:** Built. All four items closed in code; three of them need one action each
from the operator before they mean anything.
**Scope:** [production-readiness-plan.md](./production-readiness-plan.md) §Phase 3
**Gate:** *will we know it broke?*

---

## Outcome

| Item | State | Where |
|---|---|---|
| 3.1 CI | **Done** — branch protection is yours to enable | `.github/workflows/verify.yml`, `r2-integration.yml` |
| 3.2 Error tracking and structured logs | **Done** — needs `ERROR_WEBHOOK_URL` | `lib/server/observability.ts`, `instrumentation.ts` |
| 3.3 Health and durability surfacing | **Done** | `app/api/health/route.ts`, the banner in `workspace-app.tsx` |
| 3.4 Runbook | **Done** — unrehearsed | [runbook.md](./runbook.md) |

`npm test` — 230 checks across ten suites, plus the 34-document round-trip corpus.

---

## 3.1 — CI

`verify.yml` runs the whole gate on every push and pull request. Deliberately not
split into parallel jobs: the steps are ordered by how cheap they are, and a typecheck
error is not worth spending a build on.

It runs **without R2 credentials**, which matters more than it looks. The conformance
suite includes R2 when credentials are present, so a workflow with secrets available to
a fork's pull request would let an outside contributor run code against a real bucket.
`r2-integration.yml` carries the credentials instead: schedule and manual dispatch only,
pointed at `R2_TEST_BUCKET`, and it **fails loudly rather than skipping** if that secret
is missing — a green run that touched nothing is worse than a red one.

**Yours to do:** enable branch protection on `main` requiring `verify`, and add the
`R2_TEST_BUCKET` / `R2_TEST_ACCESS_KEY_ID` / `R2_TEST_SECRET_ACCESS_KEY` secrets. A
workflow file is not a gate until the repository refuses merges without it.

## 3.2 — What a log line is allowed to contain

The plan's line was *"No document paths, no titles, no tokens — log lines are a leak
surface for a private corpus."* That turned out to be the whole design.

For this product the **paths and titles are the sensitive material**.
`Divorce/Lawyer questions.md` leaks the substance of a note without leaking a byte of
its body. A share token is worse: it *is* the credential. And a log line is a copy of
that in somebody else's system — a hosting dashboard, an aggregator, a retention
bucket, a support ticket someone pastes it into.

So `redact()` strips by key (anything containing `path`, `title`, `token`, `password`,
`content`, `label`…), by shape (a 20+ character base64url run is treated as a
credential whatever it is called), and turns arrays into counts — a list of paths is
the most tempting thing to log after a rename and the most damaging, because it is a
map of somebody's private workspace. Error messages get scrubbed separately, since
`No such document: Divorce/Lawyer questions.md` carries a path in prose.

What survives is shape: scope, event, status, duration, counts. Which is what the log
was for.

`tests/observability.test.ts` asserts this against realistic secrets rather than
documenting it, because it is exactly the kind of rule that stops being true one
convenient `console.log` at a time.

**No vendor SDK.** `instrumentation.ts`'s `onRequestError` is the framework's own seam
and catches every route, including ones not written yet. `captureError` is where Sentry
goes if it ever goes anywhere — one call, in a function that already holds the error
and its context — rather than a dependency, an init file and a build plugin carried
whether or not anyone configured them.

**Yours to do:** set `ERROR_WEBHOOK_URL` to a Slack or Discord incoming webhook. Until
then errors are structured lines on stderr, and the launch criterion — *an error
reaches a human within 5 minutes* — is not met.

Note the discipline in `app/api/share/[token]`: an internal fault is now reported
internally and **still answers 404**. A 500 on a valid token and a 404 on an invalid
one are distinguishable, and that difference is the leak the share model exists to
avoid.

## 3.3 — Health

`GET /api/health` is public and exempt from the gate, because a health check that needs
a credential is one nobody wires up. That makes the payload an exercise in saying as
little as possible: liveness, backend class, durability. No counts, no paths, no
version. Detail stays behind the gate at `/api/storage`.

It answers **503 when `durable` is false**, so a monitor that never parses the body
still notices.

`backendHealth()` has reported durability since the R2 backend landed and nothing in
the UI ever read it. Now a deployment writing into an ephemeral filesystem shows a
permanent, non-dismissible banner. That failure mode — every save succeeding, every
save lost at the next cold start — is the worst one available, because it is
indistinguishable from working.

## 3.4 — Runbook

[runbook.md](./runbook.md) covers: is it broken, index/corpus disagreement, non-durable
storage, missing documents, restore from backup, login under attack, signing everyone
out, killing every share link, wiring error alerts, and rolling back. Plus a section on
things that look like emergencies and are not — a `.conflict.md` appearing, an empty
folder lost to `git clone`.

It names the rollback that is **not** safe: past commit `0c42614` restores the scheme
where the session cookie is `APP_PASSWORD`.

---

## What is still open

- **Nobody else has followed the runbook.** The plan's launch criterion asks for that
  explicitly, and it is the only way to find the step that assumes knowledge the author
  forgot they had. The "who to wake" section is a deliberate blank.
- **`ERROR_WEBHOOK_URL` and branch protection** are unset. Both are one action.
- **The durability banner has not been seen.** The endpoint it reads was verified live
  (`200`, `backend: r2`, `durable: true`) and the app calls it on mount, but the local
  deployment is durable, so the banner's *positive* case has never rendered. Forcing it
  means running a deployment with R2 misconfigured on purpose.
- **Request-level timing logs** were not built. The plan asked for method, route,
  status and duration per request; what exists is error and security events. Adding
  per-request logging means either touching every route or a wrapper layer, and it is
  worth doing once there is somewhere to send them.
