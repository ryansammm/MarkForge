# Sprint 3 Review — "I can edit a document and the file survives it"

**Dates:** Mon 1 Sep — Sun 14 Sep 2026
**Committed:** 16.5h across 6 P0 items
**Outcome:** All six P0 items delivered. One P1 came in free. Two gaps remain open and
are named below rather than quietly carried.

---

## Backlog outcome

| P | Item | Est | Status |
|---|---|---|---|
| P0 | Spike: Milkdown in App Router | 2h | **Done — gate fired, switched to CodeMirror 6** |
| P0 | `FileStore` writes: `write`/`move`/`remove` with `If-Match` | 2.5h | Done |
| P0 | Incremental `index.json` patching on write | 2h | Done |
| P0 | Editor integration + wikilink autocomplete on `[[` | 5h | Done |
| P0 | Canonical `remark-stringify`; round-trip suite green | 3h | Done |
| P0 | Debounced optimistic save (500ms) + save-state indicator | 2h | Done |
| P1 | Code block syntax highlighting | 1.5h | Done — arrived with the CodeMirror language bundle |
| P2 | Image paste-to-upload to R2 | 2h | Not started — still blocked on PRD **Q6** |

## The decision gate

Fired on the evidence, not on the clock. A parse → stringify round-trip through the
pipeline Milkdown drives escaped `[[Principles]]` into `\[\[Principles]]`, which no
longer parses as a wikilink. Opening and saving any document would have silently
deleted its edges from the link graph.

Full reasoning in [sprint-3-editor-decision.md](./sprint-3-editor-decision.md). The
short version: ProseMirror has no wikilink node, so fixing this inside Milkdown means a
custom remark extension plus node spec plus serializer before the sprint's real work
starts. CodeMirror has no serialization step at all — the buffer is the file.

**PRD Q5 is answered as a consequence:** normalization is opt-in and never implicit.
Files the app has not been explicitly asked to format stay byte-identical.

## Test coverage

`npm test` — 65 checks, all green.

| Suite | Checks | What it holds down |
|---|---|---|
| `tests/roundtrip.test.ts` | 32 documents × 5 properties | Idempotence, semantic stability, wikilink fidelity, link-graph stability, frontmatter preservation |
| `tests/store.test.ts` | 22 | Etag preconditions, path traversal, move/remove, 50-edit index consistency, write concurrency |
| `tests/api.test.ts` | 11 | `/api/files` contract: ETag header, 409 body shape, status codes |

The round-trip suite caught a real defect on its first run: `[[Target|]]` lost its
empty alias because the formatter used a truthiness check on the alias. Found by the
fixtures, not by a user.

---

## Definition of done

- [x] **Round-trip suite passes on the corpus** — green, but see gap 2: the in-repo
      corpus is 2 documents. `CORPUS_DIR=/path/to/vault npm run test:roundtrip` runs it
      against the real one.
- [x] **Open → save an unmodified document produces only formatting normalization,
      never semantic change** — stronger than required: an unmodified open → save is a
      *byte-level no-op*, because the editor writes its buffer verbatim and the buffer
      is the file. Normalization only happens when explicitly requested.
- [x] **A file hand-edited in another editor opens correctly on next load** — the store
      reads from disk rather than from the index, and returns an etag computed from the
      bytes it just read. Covered by `store.test.ts`, "a file hand-edited on disk opens
      with the on-disk text" and "the stale etag from before the hand-edit is refused".
- [~] **Editor state is never lost on a failed save — verified by killing the network
      mid-edit** — implemented and unit-reasoned, **not verified interactively**. See
      gap 1.
- [x] **`index.json` stays consistent after 50 consecutive edits** — verified by the
      strongest available form of the check: after the 50 edits, a full reindex is run
      from the corpus alone and the incrementally-patched index must equal it exactly.
      That is Sprint 5's reindex drill, run early.

---

## Open gaps

### Gap 1 — interactive verification did not run

The four behaviours that only exist in the browser are unverified: the editor
mounting, the `[[` autocomplete popup, the save-state indicator's transitions, and
buffer retention when the network dies mid-edit.

The dev server sits behind the `APP_PASSWORD` gate and the agent does not enter
credentials, so the UI was never driven. The logic beneath it is covered — the save
hook's failure paths, the 409 body it reads, the etag contract — but the wiring is
argued, not observed.

**To close it, ~15 minutes by hand:**
1. `npm run dev`, unlock, open a note, press Ctrl+E.
2. Type `[[` — the completion list should appear, filtered from the loaded index.
3. Watch the indicator go Unsaved → Saving… → Saved.
4. DevTools → Network → Offline, type more. Expect "Offline — not saved" with the
   text still in the editor. Go back online; it should flush and land.
5. Open the same note in a second tab, edit both. The second save should report
   "Changed elsewhere — not saved" rather than overwriting.

### Gap 2 — the write backend does not work on Vercel

`LocalFileStore` writes to the local filesystem. On Vercel the filesystem is read-only
apart from `/tmp`, and `/tmp` is ephemeral — `public/index.json` is a build artifact
and cannot be written at runtime at all. **Editing works locally and on any
self-hosted or VM deployment; on the current Vercel deployment it will fail.**

This is not a defect introduced this sprint — Sprint 1 shipped a generated static
`index.json` and no object storage was ever wired up. The PRD assumes R2. Sprint 3
completed the *interface* (R1) and one backend; the R2 backend is genuinely
outstanding work.

Everything reaches the filesystem through `WritableFileStore`, so the remaining work
is one new implementation of that interface plus a factory switch — no changes to the
routes, the editor, the save hook, or the index patcher. Estimate **3–4h**.

This collides with standing rule 5, "deploy every sprint." Sprint 3 deploys, but
deploys read-only. **Recommend taking the R2 adapter into Sprint 4 as a P0 and cutting
an equivalent 3–4h** — the honest candidate is the Document outline / TOC panel (2h)
plus Recently edited list (1.5h), both P1, per standing rule 3.

### Gap 3 — the corpus is 2 documents

"Green on your real corpus" is only as strong as the corpus. Two notes is a fixture
set with ambitions. The suite takes `CORPUS_DIR` precisely so it can be pointed at the
real vault, and it should be, before the round-trip claim is treated as settled.

---

## Carried into Sprint 4

1. **R2 `WritableFileStore` implementation** — 3–4h, recommended P0 (gap 2).
2. **Interactive verification pass** — ~15 min (gap 1).
3. **Round-trip run against the real vault** — ~5 min (gap 3).
4. **Image paste-to-upload (P2)** — unchanged, still waiting on PRD Q6.

## Notes for Sprint 4

The rename-with-inbound-link-rewrite item (5h, "the hard one") depends directly on
`lib/markdown/serializer.ts`. Rewriting a link means parse → modify → re-serialize —
exactly the operation that escaped brackets in the spike. Without this sprint's
wikilink node and handler, Sprint 4 would have written `\[\[Target]]` into every
document it touched during a rename. The round-trip suite is the regression guard for
that work; extend it with rename fixtures rather than starting a new suite.

`splitFrontmatter` already reads YAML in `CORE_SCHEMA` mode, so Sprint 4's DoD item
"`2026-08-15` stays a string; `NO` stays a string" is satisfied on the read side. The
write side — `id` assignment, Zod validation, soft-fail — is untouched and still R7.
