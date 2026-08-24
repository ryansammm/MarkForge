# The index split

**Status:** Built.
**Why:** [phase-4-scale.md](./phase-4-scale.md) — the benchmark that made the case.

---

## The problem, in one sentence

`index.json` carried every document's body, so the browser downloaded and parsed 4.68
MB before it could render anything, and the server rewrote all 4.68 MB on every save.

Bodies were **81% of the payload**. They were there for one reason: search ran in the
browser, over the index.

## The change

| | Before | After |
|---|---|---|
| `index.json` (2,000 docs) | 4.68 MB | **1.23 MB** |
| entries carrying a body | 2,000 | **0** |
| per document | 2,394 bytes | 646 bytes |
| one save, p50 | 28.6 ms | **13.8 ms** |
| rename, 53 inbound links | 1,768 ms | **1,117 ms** |
| search query | 5–12 ms (client) | **4–7 ms** (server) |
| first search after a cold start | — | 253 ms with a snapshot, 4.9 s without |
| full reindex | 4,374 ms | 5,093 ms |

Same machine, same corpus, `npm run benchmark 2000`, 7 August 2026. Memory backend, so
these remain floor numbers.

The one thing that got slower is the reindex, by 0.7 s, because building a document
now also derives an excerpt and a word count. That is a rare operation paying so that
a universal one — every page load, every save — gets cheaper.

### What the index holds instead

`toIndexEntry` strips `content` at the single point where a document enters the index,
so the rule is enforced in one place rather than remembered at every call site. In its
place, two derived fields that are ~200 bytes rather than ~2 KB:

- `excerpt` — the first ~160 characters of prose, with headings, fences and link
  syntax removed. The backlinks panel shows it.
- `wordCount` — so the details panel needs no body.

`MarkdownDocument.content` is now **optional**, and its presence means something
specific: this document was read from storage, not taken from the index. The editor,
the share route and the reading view all get it that way.

### Reading a document is now a fetch

The reading view used `document.content` from the index. It takes a `body` prop now,
fetched by the same code path the editor already used — which also means the reading
view no longer shows a stale body for a note edited in vim since the last ingest.

A skeleton covers the fetch, not a spinner: the title and metadata above it are
already real, and swapping a spinner for text moves the page.

## Search

Moving bodies out of the index means moving search to where the bodies are. The hard
part was never the search — it is the **cold start**, because a serverless instance
that must read 2,000 objects before answering its first query is unusable.

So the corpus is persisted as one object, `search.json`, holding path, title, text and
**the etag each text was read at**. On load, that snapshot is reconciled against the
index by etag, and only genuinely drifted documents are re-read — normally none.

Three properties fall out of that design:

- **A cold instance with a snapshot answers in 253 ms**, not 4.9 s.
- **Correctness does not depend on notifications.** A write on another instance, a
  rename, a restore from trash — none of them tell the search index anything, and all
  of them are caught by the etag comparison within five seconds. `noteWritten` from
  `/api/files` is an optimisation for "find what I just typed", not the mechanism.
- **The snapshot is written rarely** — only once 25 documents have drifted — because
  writing it is the same multi-megabyte write this whole change exists to avoid.

The Orama engine also left the client bundle with the search dialog, which now
debounces at 180 ms and sends a query string.

### Two regressions found by re-running the benchmark

Worth recording, because both were introduced by this change and both were invisible
in the tests:

1. **Reindex went 4.3 s → 12.9 s.** `deriveExcerpt` ran eight regexes over whole
   documents to produce 160 characters. It works on the first 2,000 characters now.
   `countWords` was a chain of multiline regexes; it is one pass.
2. **The first search took 15.6 s.** Reconciliation read stale documents one at a
   time. It reads them 24 at a time now.

Neither would have been caught by a correctness test. They were caught by running the
same benchmark that motivated the work.

---

## Migrating an existing deployment

An index written before this change still has bodies and no `excerpt` or `wordCount`.
Nothing breaks: reading, editing and search all work, because they no longer depend on
index bodies. But until an entry is rewritten, the backlinks panel has no context line
for it and the details panel reports zero words.

Entries upgrade themselves whenever a document is opened or saved. To do the whole
corpus at once:

```
POST /api/storage?action=reindex
```

That is the same repair the runbook already describes, and it is safe by construction:
nothing in it reads the existing index.

## Not done

- **Rename is still a foreground operation.** 1.1 s for 53 inbound links with no
  network; on R2 that is 53 read-modify-write round trips behind a modal spinner. It
  is faster than it was and still the wrong shape.
- **The save still rewrites the whole index.** 1.23 MB instead of 4.68 MB, but the
  cost is still linear in corpus size. Sharding the index — or moving to per-document
  metadata objects — is the next thing to measure if a corpus gets past a few thousand
  documents.
- **The revised ceiling has not been re-derived.** The old guidance said "not viable at
  2,000". With a 1.23 MB index and 14 ms saves that is now pessimistic, but the honest
  answer needs a run at 5,000 rather than an extrapolation.
