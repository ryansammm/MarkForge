# Runbook

**For:** whoever is holding this at 2am.
**Assumes:** shell access, the R2 credentials, and nothing else. No prior knowledge of
the codebase.

Every procedure here has been run at least once except where it says otherwise.

---

## First: is it actually broken?

```bash
curl -s https://<your-host>/api/health
```

```jsonc
{ "ok": true, "backend": "r2", "durable": true, "time": "…" }
```

| Response | Meaning | Go to |
|---|---|---|
| `200`, `durable: true` | The app is up and writes survive | Probably not a storage problem |
| `503`, `durable: false` | **Writes are being accepted and discarded** | [Storage is not durable](#storage-is-not-durable) |
| No response | The deployment is down | Your hosting dashboard |

`/api/health` is public and deliberately says almost nothing. For detail, sign in and
open `/api/storage` — same information plus the resolved endpoint, bucket, prefix, a
live round-trip latency, and a specific hint for whatever the failure was.

---

## The index and the corpus disagree

**Symptoms:** documents missing from the sidebar that exist in the bucket; documents
listed that were deleted; search finding nothing; the workspace showing files nobody
recognises.

**This is not data loss.** The index is derived. The documents are the truth, and the
index can always be thrown away and rebuilt from them.

```bash
curl -X POST -b "markforge_session=<your cookie>" \
  "https://<your-host>/api/storage?action=reindex"
```

```jsonc
{ "ok": true, "documentCount": 128, "folderCount": 14, "durationMs": 1193 }
```

Check `documentCount` against what you expect. If it is far too low, stop — the problem
is the corpus, not the index, and reindexing will not help. Go to
[Documents are missing](#documents-are-missing-from-the-bucket).

**Known cause:** running the test suite with real R2 credentials in the environment
used to write a scenario over the live index. Fixed — the suite namespaces its
metadata now — but any tool pointed at the real bucket can still do this.

---

## Storage is not durable

`/api/health` reports `durable: false`, and the workspace shows a permanent red banner.

**What is happening:** R2 is not configured, so the app fell back to the filesystem
backend. On a serverless or container host that filesystem is ephemeral: every save
succeeds and every save is lost at the next cold start.

**Fix:** set all four variables and redeploy.

```
R2_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=…
```

Then confirm with `/api/storage` — `connection: "ok"` and a latency figure.

**If it still fails,** `/api/storage` returns a `hint` naming the setting to check.
The common ones:

| Symptom | Cause |
|---|---|
| `EPROTO … handshake failure … alert number 40` | A typo or trailing newline in `R2_ACCOUNT_ID`, or an EU bucket needing `R2_JURISDICTION=eu`. Not a credentials problem, despite how it reads. |
| `SignatureDoesNotMatch` | Wrong secret, or the key belongs to another account |
| `NoSuchBucket` | `R2_BUCKET` wrong, or the token cannot see it |
| Endpoint rejected at startup | `R2_ENDPOINT` includes the bucket name. The bucket belongs in `R2_BUCKET`. |

---

## Documents are missing from the bucket

**Check the trash first.** Deletes are recoverable for 30 days and a deleted document
is invisible to the index by design.

```bash
curl -s -b "markforge_session=<cookie>" https://<your-host>/api/trash
```

Restore one:

```bash
curl -X POST -b "markforge_session=<cookie>" -H 'Content-Type: application/json' \
  -d '{"id":"<entry id>"}' https://<your-host>/api/trash
```

A restore never overwrites: a path that has been reoccupied is skipped and reported,
and the entry stays in the trash. Nothing is lost by trying.

**If they are not in the trash,** restore from a backup — next section.

---

## Restore from backup

```bash
# What is in the snapshot, and how it differs from live storage right now
npm run backup -- --verify ./backups/<timestamp>

# Restore. Refuses if the target already holds documents, unless --force
npm run backup -- --restore ./backups/<timestamp>
```

A restore rebuilds the index rather than restoring it, so the result is internally
consistent by construction.

**Restoring into a bucket that already has documents merges the two** — the restore
does not delete. If you want the snapshot's state exactly, restore into an empty
bucket and repoint `R2_BUCKET`.

Snapshots include `shares.json`. Restoring a corpus without it silently revokes every
share link anyone has ever been sent.

### Taking a backup

```bash
npm run backup                       # → ./backups/<timestamp>/
npm run backup -- --verify ./backups/<timestamp>
```

**Verify every backup you take.** A backup that has never been restored is a belief.

---

## Somebody is attacking the login

`logSecurityEvent` writes `auth-failed` and `auth-rate-limited` lines. In your log
search:

```
scope=security event=auth-failed
```

The limiter allows 5 attempts per 15 minutes per client and is **per-instance** — on
serverless, N instances mean N times that. It raises the cost of an online attack; it
does not stop a distributed one.

**If it is sustained:** rotate `APP_PASSWORD`. This also invalidates every session
everywhere, which is the intended blunt instrument.

---

## Sign everyone out

There is no per-session revocation — sessions are stateless signed tokens, because the
middleware that must reject them runs on the Edge runtime with no store to consult.

**Rotate the signing key.** Either works, and both take effect on the next request:

- Change `SESSION_SECRET` — signs everyone out, password unchanged.
- Change `APP_PASSWORD` — signs everyone out *and* changes the password.

Redeploy for the new value to take effect.

---

## Kill every share link at once

There is no bulk revoke. List them, then revoke each:

```bash
curl -s -b "markforge_session=<cookie>" https://<your-host>/api/shares
curl -X DELETE -b "markforge_session=<cookie>" \
  "https://<your-host>/api/shares?token=<token>"
```

**In a real emergency**, delete `_meta/shares.json` from the bucket. Every link dies
immediately, because a share resolves only against that file. It cannot be undone —
take a copy first if the tokens might be wanted back.

---

## Errors are not reaching anyone

Set `ERROR_WEBHOOK_URL` to a Slack or Discord incoming webhook. Every `captureError`
posts to it, with paths, titles and tokens stripped
(`tests/observability.test.ts` asserts that).

Without it, errors are structured JSON lines on stderr and reach whatever your host
collects — which nobody reads at 2am, which is the point of setting the variable.

To send them somewhere with real triage instead, wire Sentry inside `captureError` in
`lib/server/observability.ts`. It is one call, in a function that already holds the
error and its context.

---

## Rolling back

The app is stateless apart from the bucket. Redeploy the previous commit; no migration
runs, and nothing in storage changes format on deploy.

**The exception is Phase 2's session change.** Rolling back past commit `0c42614`
restores the scheme where the cookie value *is* `APP_PASSWORD`. Do not roll back past
it to fix an unrelated bug — fix forward. If you must, rotate the password immediately
afterwards, because the rollback reintroduces the vulnerability for every session
issued under it.

---

## The bucket is filling up with images

Nothing deletes an image automatically. Deleting a document leaves its pictures in the
vault, deliberately: the trash stashes and restores Markdown only, so a cascade would
be a delete with no undo — and a quiet one, because the restored document would look
whole and render nothing.

Collecting them is a thing a person does, having read a list:

```
npm run gc:assets                 # report only, deletes nothing
npm run gc:assets -- --force      # delete the orphans older than 7 days
npm run gc:assets -- --min-age 30 --force
```

Two things the report already accounts for, so you do not have to:

- **A document in the trash still counts as a reference.** Its images are not listed as
  orphans, because a restore inside the 30-day window has to bring back a document
  whose pictures still load.
- **Recent uploads are never deleted**, even with `--force`. An image uploaded moments
  ago has no reference yet — the document save comes after the upload — and is
  indistinguishable from an abandoned one except by age.

Read the list before passing `--force`. An orphan is not necessarily rubbish: an image
you removed from a note this morning and intend to put back this afternoon looks
exactly the same as one nobody has wanted since last year.

Do not schedule this. It is not idempotent in the way a cron job needs — what counts as
an orphan depends on when it runs.

---

## Things that look like emergencies and are not

| Looks like | Actually |
|---|---|
| A `.conflict.md` appeared next to a document | Working as designed. Two people saved the same file; the refused version was preserved rather than dropped. Merge and delete it. |
| The index is empty after a deploy | Almost always `durable: false` — check `/api/health` before anything else. |
| A wikilink stopped resolving after a rename | Check the renamed document's `aliases:` frontmatter. A rename that could not rewrite every inbound link records the old title there. |
| A share link returns "Not found" | Revoked, expired, or the token is mistyped. All three answer identically on purpose. Check `/api/shares`. |
| An empty folder vanished after `git clone` | Git does not track empty directories. Not a bug in this app. |
| An image is still in the bucket after its document was deleted | Working as designed. See "The bucket is filling up with images" — the trash restores documents, not pictures, so nothing cascades. |

---

## Who to wake

Fill this in. A runbook that does not say who to call is a runbook that ends at the
person reading it.

- **Owner:** …
- **Escalation:** …
- **Cloudflare account holder:** …
