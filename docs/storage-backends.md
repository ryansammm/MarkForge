# Storage backends

**Status:** R2 built. Closes the gap carried since Sprint 3.

---

## The shape

```
  routes / rename / shares
            │
      WorkspaceStore          ← every rule lives here, exactly once
            │
         Bucket               ← an interface that only moves bytes
      ┌─────┴─────┬─────────┐
   FsBucket   R2Bucket   MemoryBucket
```

`WorkspaceStore` owns etags, If-Match preconditions, path containment, incremental
index patching, `id` assignment, and reindexing. Backends implement `Bucket` and do
nothing else.

The split is not architecture for its own sake. A second store would have meant a
second copy of the index-patching rules, and the first thing to break when those
drift is the claim this product rests on — that the index is disposable and a
rebuild agrees with a sequence of edits. With one implementation, that is a property
of the code rather than an intention.

It also makes the equivalence testable. `tests/backend.test.ts` runs one scenario —
writes, a rename, a folder move, a delete, an empty folder — against every backend
and requires the resulting index to be identical, then reindexes each from storage
alone and requires *that* to match too.

## Choosing a backend

The choice comes from the environment, not a flag:

| Condition | Backend |
|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` all set | **R2** |
| otherwise | **filesystem** |

Deliberately implicit. A deployment that had to remember a flag could run on the
filesystem backend and *appear* to work — writes succeed into an ephemeral container
and vanish at the next cold start, which is the worst failure mode available because
it is indistinguishable from success.

`backendHealth()` reports when that is happening: on Vercel or Lambda without R2
configured it returns `durable: false` and an explanatory warning. `/api/index`
surfaces it as `X-Storage-Backend` and `X-Storage-Durable` headers.

## Configuration

```bash
# R2 — production
R2_ACCOUNT_ID=…            # from the Cloudflare dashboard
R2_ACCESS_KEY_ID=…         # R2 API token
R2_SECRET_ACCESS_KEY=…
R2_BUCKET=my-notes
R2_PREFIX=notes            # optional, defaults to "notes"
R2_ENDPOINT=…              # optional; derived from the account id otherwise
R2_JURISDICTION=eu         # only for EU-jurisdiction buckets

# Filesystem — local and self-hosted
NOTES_DIR=./notes          # corpus root
INDEX_PATH=./public/index.json
SHARES_PATH=./shares.json
```

## Seeding the bucket

Configuring R2 does not put anything in it. A correct configuration against an empty
bucket shows an empty workspace, which looks identical to a broken one — the first
live deployment reported `connection: ok` with `documentCount: 0`.

`npm run sync` copies a corpus between backends, in either direction:

```bash
# preview what would be copied
npm run sync -- --from fs --to r2 --dry-run

# seed the bucket from the local vault
npm run sync -- --from fs --to r2

# pull production back down, e.g. for a backup
npm run sync -- --from r2 --to fs --dest ./backup
```

R2 credentials come from the environment, so run it with the same values that are set
in Vercel.

Two deliberate properties:

- **It refuses a non-empty destination** unless `--force`. The copy does not delete,
  so anything not in the source would survive and the result would be two corpora
  mixed together.
- **The destination index is rebuilt, never copied.** An index copied between
  backends would be trusted rather than derived, and the entire premise is that it is
  derived. It also means every sync doubles as a reindex drill against real storage.

## Diagnosing a broken R2 configuration

`GET /api/storage` (behind the password gate) reports the selected backend, the
resolved endpoint, bucket and prefix, and the result of a live round trip — with the
underlying error and a hint when it fails. Credentials are never included; the
endpoint and bucket are configuration, and withholding them is what made the first
real failure slow to diagnose.

### Path style is mandatory, and omitting it breaks everything

The first deployment with R2 configured failed every request with:

```
Error: write EPROTO … ssl3_read_bytes:tls alert handshake failure … alert number 40
```

which reads like a network or credentials fault and is neither. With the AWS SDK
default (virtual-hosted style) a request goes to
`<bucket>.<account>.r2.cloudflarestorage.com`. Cloudflare serves a wildcard
certificate for `*.r2.cloudflarestorage.com`, and **a wildcard matches exactly one
label** — so that two-label host is not covered and the server aborts the handshake
before any request is sent.

`forcePathStyle: true` keeps the host at `<account>.r2.cloudflarestorage.com` and
moves the bucket into the path, where the certificate matches. There is a test
asserting the flag stays set.

### The settings that fail confusingly, and what happens now

| Mistake | Was | Now |
|---|---|---|
| Trailing newline on a pasted value | Invalid hostname, TLS failure | Trimmed |
| Full URL pasted into `R2_ACCOUNT_ID` | `https://https://…` | Refused with an explanation |
| Dashboard "S3 API" URL, which ends in the bucket | Requests to `/<bucket>/<bucket>/<key>` | Refused — the bucket belongs in `R2_BUCKET` |
| EU-jurisdiction bucket | TLS failure against the default host | Set `R2_JURISDICTION=eu` |

## What object storage does not have

**Directories.** The keyspace is flat; a folder is a key prefix. Sprint 4 made empty
folders first-class, so an empty folder is recorded as a zero-byte `<prefix>/.keep`
marker. Markers are filtered out of `listKeys`, so they never reach the index or a
reindex — without that filter a rebuild would invent a note called `.keep` in every
folder. They are visible to anyone browsing the bucket directly, which is the
standard cost of this convention.

**Atomic rename.** A move is copy-then-delete, in that order. If the write fails the
source is still there: losing the destination is recoverable, losing both is not.

**Cross-process locking.** `WorkspaceStore` serializes its operations, but only
within one process. On serverless that is per-instance, so two lambdas writing the
same document can still interleave. The If-Match precondition catches the common
case and turns it into a 409. Closing it completely needs conditional writes at the
bucket layer and belongs with Sprint 5's conflict handling.

## The live index

The client used to fetch `/index.json`, the statically served build artifact. That
works locally, where the file on disk is the file the store writes, and is silently
wrong on object storage, where the artifact is frozen at deploy time and every edit
since is invisible.

It now fetches `/api/index`, which reads through the store. The build artifact
remains for the ingest CLI and local development.

## Testing

`tests/backend.test.ts` runs against memory and filesystem on every `npm test`. It
runs against R2 too when credentials are present, and **reports R2 as skipped when
they are not** — a green suite that never touched the backend it claims to cover is
worse than a red one.

To exercise the real thing:

```bash
R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=… \
  npm run test:backend
```

It writes under a `conformance-<timestamp>` prefix so it cannot collide with a real
corpus.

## Not verified

- **No run against real R2.** The first live attempt failed on path style (fixed above), which is precisely the kind of defect a test against the interface cannot catch. The bucket implementation is otherwise exercised only through
  the interface it shares with the other backends. The S3 wiring itself — endpoint
  derivation, credential handling, pagination past 1,000 keys, `DeleteObjects`
  batching — has never touched Cloudflare. The conformance suite is written to cover
  it the moment credentials exist; until then, treat R2 as untested integration
  rather than proven.
- **No latency numbers.** Sprint 5's tripwires (index size, write-to-persisted p95,
  cold load p95) are still unmeasured, and they matter more on R2 than on a local
  disk because every index read is now a network round trip.
