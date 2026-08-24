# Phase 1 — Data safety

**Status:** Built. Four of five items closed; item 1.3 needs a bucket only the user can
provide.
**Scope:** [production-readiness-plan.md](./production-readiness-plan.md) §Phase 1
**Gate:** *can it lose data?*

---

## Outcome

| Item | State | Where |
|---|---|---|
| 1.1 Trash instead of delete | **Done** | `lib/trash.ts`, `WorkspaceStore.remove/removeDirectory/restoreFromTrash/purgeTrash`, `/api/trash`, `trash-dialog.tsx` |
| 1.2 Backup and restore drill | **Done, drill run** | `scripts/backup.ts` |
| 1.3 Prove R2's write path | **Suite built, not run** | `tests/r2-write.test.ts` — see below |
| 1.4 Cross-instance write safety | **Done** | `Bucket.writeMetaIfUnchanged`, `WorkspaceStore.mutateIndex` |
| 1.5 Conflict files | **Done** | `WorkspaceStore.writeConflictCopy`, `ConflictError.conflictPath` |

`npm test` — 171 checks, 0 failures (was 148).

---

## The decision that shaped 1.1: where trashed bytes live

A trashed document goes into the **metadata namespace**, beside `index.json` and
`shares.json`, not into a `.trash/` folder inside the corpus.

That is the difference between one rule and five. `Bucket.listKeys` is "the corpus",
and the index, a full reindex, search, and share-scope resolution all read the corpus
through it. Putting the trash outside that keyspace makes a deleted document invisible
to every one of them **by construction**. Putting it inside would have required each
reader to remember to exclude it — and the first one that forgot would have published
somebody's deleted file through a share link.

Two consequences worth knowing:

- Entry ids are `<base36 millis>-<6 hex>`, not ISO timestamps. The id becomes a
  directory name under the filesystem backend, and ISO timestamps contain colons,
  which are legal object-storage keys and illegal Windows filenames. That would have
  broken deleting entirely on one backend and nowhere else. There is a test.
- **Restoring never overwrites.** A path reoccupied since the delete is skipped and
  reported, and the entry stays in the trash so nothing is lost. A restore that
  destroys something is the same bug wearing a friendlier name.

There is deliberately **no "delete permanently" button**, in the UI or the API. Purging
is by retention window only (30 days, plus a sweep for orphaned bytes whose manifest
never landed). A control that destroys a recoverable document would reintroduce exactly
what this item removes.

## The decision that shaped 1.4: what a precondition means

`writeMetaIfUnchanged(name, body, expected)` is compare-and-set. On R2 it is a
conditional `PUT`, and HTTP can only express the precondition as an ETag — so the ETag
returned with the body on read is remembered, keyed by a hash of that body. If the
caller passes the same body back as `expected`, its ETag is known exactly and nothing
is assumed about how Cloudflare derives one. The MD5 fallback (what S3 and R2 return
for a single-part upload) applies only when that memory is missing, such as after a
cold start, and failing it is safe in the direction that matters: the write is refused,
the caller re-reads, and the retry has the exact ETag.

**A `HEAD` to fetch the current ETag would have been subtly wrong** — it binds the
precondition to what the object holds *now* rather than to what was read, so a write
landing between the read and the `HEAD` would be silently overwritten. That is the
precise lost update the method exists to prevent.

The test for this is only worth something because it fails without the mechanism.
Neutering `MemoryBucket.writeMetaIfUnchanged` into an unconditional write makes
*two stores over one bucket do not drop each other's entries* fail with
`the index lost documents to a concurrent write`. That was checked, not assumed.

## 1.5: what changed, and what did not

The refusal did not change — a stale `If-Match` is still refused, because the file on
storage is somebody else's newer work. What changed is what happens next: the rejected
content is written to `<name>.conflict.md` (`-2`, `-3` … if taken), indexed so it can be
found, and named back to the client as `conflictPath`, which the save indicator renders
as a link. Before this, "your save was refused" was an honest report of losing an
hour's typing.

Create-only collisions are excluded: nothing has been lost when a file the caller asked
to create already exists, and a conflict copy per duplicate-name attempt would litter
the corpus.

## 1.2: the drill, actually run

```
npm run backup                     snapshot the configured backend
npm run backup -- --verify <dir>   diff a snapshot against live storage
npm run backup -- --restore <dir>  write a snapshot into an empty backend
```

Run against the local corpus on 6 August 2026: backup (4 documents) → restore into an
empty bucket → `--verify` clean → `diff -r` of source and restored trees **byte-
identical**. The snapshot carries the corpus, `shares.json` (live credentials — a
restore without it silently revokes every link anyone was ever sent) and the trash.
`index.json` is deliberately not backed up: it is derived, and a restore rebuilds it,
which makes every restore a reindex drill as well.

---

## What is still open

### 1.3 — run, 7 August 2026, against a real bucket

**11 of 13 checks passed on the first run, and the two failures were both defects in
the suite, not in the product.** The R2 write path did what it claims:

- a document written to R2 reads back byte-identical
- keys with spaces and non-ASCII (`Ärchiv/Notas de reunião — 2026.md`) survive signing
- `If-Match` is enforced against a real etag, and the refusal writes a conflict copy
- **conditional writes hold** — a stale precondition is refused, a cold cache
  reconstructs the etag, create-only refuses to overwrite, and two stores racing over
  one real bucket lose no index entries. That is item 1.4's guarantee, proven on the
  deployment target rather than argued.
- metadata is isolated by prefix
- an empty folder survives and its marker is not a document
- deleting fills the trash and restores from it
- **a reindex from R2 alone found all ten documents**, including the nested and
  non-ASCII paths

The two failures:

1. *"the large document was truncated"* — it was not. The read-back was **30 bytes
   longer** than what was sent, which is exactly `---\nid: <16 chars>\n---\n\n`: the
   frontmatter id the first save injects (R7). The check compared against the
   submission instead of against what was written.
2. *"a reindex from R2 alone matches the patched index"* — the reindex was correct and
   the **patched index was the broken side**. The isolation check above it wrote its
   probe to `index.json`, clobbering the suite's own live index with a stub; every
   later patch then applied to an empty index, leaving one document. The generic
   expected/actual wording made it read as the opposite, so the assertion now names
   which side is which.

Both fixed, along with two things the run surfaced: the suite arranged `_meta` *inside*
the document prefix, which no deployment does and which would put trashed `.md` files
back in the corpus keyspace; and `PutObject` was called with an unmeasured empty body
for folder markers, which the SDK warns about and some S3-compatible endpoints reject.

**Re-run to confirm the fixes:**

```bash
R2_TEST_BUCKET=your-scratch-bucket npm run test:r2
```

### The original note, kept for context

`tests/r2-write.test.ts` exists and covers what only a real service can fail:
conditional `PUT` semantics, keys with spaces and non-ASCII, documents over 1MB,
`If-Match` against real etags, the trash on object storage, and two stores racing over
one real bucket.

It is **opt-in and points at `R2_TEST_BUCKET`, never `R2_BUCKET`** — it writes and
deletes, and a stray environment variable must not be able to aim it at a real corpus.
Without that variable it reports skipped rather than passing.

```bash
R2_TEST_BUCKET=your-scratch-bucket npm run test:r2
```

Partial evidence in the meantime: the dev server against the real bucket answers
`GET /api/trash` with 200, so `R2Bucket.listMeta` works against the live service.
`writeMetaIfUnchanged` — the one carrying 1.4's guarantee — has **not** been exercised
against R2, and until it is, cross-instance safety on the deployment target is
argued rather than proven.

### The trash UI has not been driven end to end

Opening the trash dialog against the live backend was verified: it loads, reports its
retention window, and shows the empty state, with no console errors. Delete → undo →
restore was not driven, because this dev server writes to the real corpus and a
cosmetic verification is not worth a write to somebody's notes. The path is covered by
23 store-level checks and 3 API-level ones.

### Found by running it: the conformance suite overwrote the live index

`npm run test:backend` on a machine with real R2 credentials in the environment
includes R2 in the backends under test, scoped with `documentPrefix:
conformance-<timestamp>`. That isolates the documents. It did not isolate anything
else, because `metaKey()` was `_meta/<name>` — **one metadata namespace shared by
every prefix in the bucket**. So the scenario wrote its index straight over the live
one, and its deleted fixture landed in the live trash.

Observed on 6 August 2026: the deployment's index listed `Archive/Gamma.md`,
`Notes/Beta Renamed.md` and `Testing.md`; the trash held an `Alpha.md` entry.

**The corpus was never in danger.** The documents were under `notes/`, the scenario
under `conformance-…/`, and `shares.json` was untouched (the share suite runs on
`MemoryBucket`). What broke was derived data — which is exactly the failure mode the
architecture is designed to make survivable, and the first time that design has been
load-tested by an actual mistake.

Three changes:

- `R2Bucket` takes a `metaPrefix` (env `R2_META_PREFIX`), **defaulting to `_meta`
  unchanged** — moving it would orphan an existing deployment's `shares.json` and
  break every link already sent. Tests set it; deployments do not.
- The conformance suite namespaces both prefixes and deletes its objects afterwards.
  It was also never cleaning up, so each run left a `conformance-…/` prefix behind.
- `POST /api/storage?action=reindex` — the repair, and the runbook operation §3.4
  asked for. Nothing in it reads the existing index, so the worst case is recomputing
  what was already true.

Recovery took one request: reindex rebuilt the index from the two real documents, and
`DELETE /api/trash?olderThanDays=0` cleared the junk entry. `olderThanDays` is an
operator control, deliberately absent from the UI.

The lesson worth keeping: **isolating documents without isolating metadata isolates
nothing that matters.** `tests/r2-write.test.ts` now asserts the separation directly.

### Found in passing: tests were writing into the repository

`store.test.ts`, `rename.test.ts` and `api.test.ts` built their `FsBucket` without
`metaDir`, which defaults to `process.cwd()`. Harmless while the metadata namespace
held only `index.json` (which they did override) — but the trash landed in the
repository root, so running the suite left 26 stray objects in the working tree. Fixed
at the source, with `.trash/` and `backups/` gitignored as the second line of defence.
