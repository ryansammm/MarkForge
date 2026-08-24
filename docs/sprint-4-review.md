# Sprint 4 Review — "I can restructure without breaking links"

**Dates:** Mon 15 Sep — Sun 28 Sep 2026
**Committed:** 15h across 5 P0 items
**Outcome:** All five P0 items delivered. All four DoD items met with automated tests.

## Backlog Summary

- **Frontmatter contract (PRD R7)** – Done (3 h)
- **File & folder CRUD in the tree** – Done (3 h)
- **Move / rename with path update** – Done (2 h)
- **Rename with inbound‑link rewrite** – Done (5 h)
- **Ghost page creation** – Done (2 h)
- **Document outline / TOC panel** – Not started (2 h)
- **Recently edited list** – Not started (1.5 h)


Three deviations and two gaps are named below.

---

## Backlog outcome

| P | Item | Est | Status |
|---|---|---|---|
| P0 | Frontmatter contract (PRD R7) | 3h | Done |
| P0 | File & folder CRUD in the tree | 3h | Done |
| P0 | Move / rename with path update | 2h | Done |
| P0 | **Rename with inbound-link rewrite** | 5h | Done |
| P0 | Ghost page creation | 2h | Done |
| P1 | Document outline / TOC panel | 2h | Not started |
| P1 | Recently edited list | 1.5h | Not started |

The two P1s were stretch and stayed stretch. Committed load was 15h against a ≤16h
rule; taking them would have meant planning to 100%.

## Definition of done

- [x] **Rename a document with ≥5 inbound links; every link resolves afterward** —
      tested with 6 linking documents. All rewritten, backlinks repointed, no stale
      index entries.
- [x] **Simulate a mid-rename failure; the report names exactly which files did not
      update** — simulated honestly: the plan captures etags, then two files are
      changed on disk behind the app's back so their If-Match preconditions genuinely
      fail. No mocks. The report names `b.md` and `d.md` and credits `a.md` and
      `c.md`, the concurrent edits survive unclobbered, and the summary reads
      *"Renamed. 2 of 4 links updated — 2 failed: b.md, d.md"*.
- [x] **A document created outside the app, with no frontmatter, is fully usable and
      gets an `id` on first save** — and the id is spliced in as a single line rather
      than by re-dumping the YAML, so quoting, key order and comments survive.
- [x] **`2026-08-15` stays a string; `NO` stays a string** — `CORE_SCHEMA` does not
      resolve YAML 1.1 timestamps or the `yes`/`no`/`on`/`off` aliases.

## Test coverage

`npm test` — 110 checks, all green.

| Suite | Checks | Added this sprint |
|---|---|---|
| `roundtrip.test.ts` | 32 docs × 5 | — |
| `frontmatter.test.ts` | 14 | **new** — R7 contract, id assignment, type preservation |
| `store.test.ts` | 22 | 4 assertions updated for the folder/id behaviour changes |
| `rename.test.ts` | 23 | **new** — rewriting, rename, partial failure, folders, resolution |
| `api.test.ts` | 19 | +8 for the folder and rename routes |

---

## Three deviations from the plan

### 1. Wikilinks do not carry ids

The plan proposed *"wikilinks carrying an optional id"* so that a rename which fails
to rewrite some links still resolves them.

**Not done, deliberately.** Any id-bearing link syntax is syntax Obsidian and every
other Markdown tool cannot read, and round-tripping with those tools is a premise of
this product rather than a nice-to-have. Writing `[[Target|id:abc]]` into a user's
corpus would trade the thing the app is for against a failure case.

**What replaces it,** achieving the same "turn a correctness bug into a cosmetic one"
outcome:

- Resolution is **id first, then title, then aliases, then filename, then path** —
  the ordering the plan asked for, applied to a link syntax that stays standard.
- When a rename cannot rewrite every inbound link, the old title is recorded in the
  renamed document's `aliases:` frontmatter. The links that failed to update keep
  resolving. `aliases` is the standard Obsidian field for exactly this and costs no
  compatibility.

Limitation: if the document already has an `aliases` key, the entry is not merged in
— appending to a YAML list means handling inline arrays, block sequences, quoting and
comments, and getting that subtly wrong corrupts frontmatter a user wrote by hand. The
report says so, and adding the line by hand is one keystroke.

### 2. Empty folders are now first-class — a Sprint 3 behaviour change

Sprint 3 pruned a directory as soon as its last document left, matching an ingest that
skipped empty directories. Sprint 4 needs folder creation, so folders became objects
the user makes deliberately and that outlive their contents — as in every file
manager.

This changed four Sprint 3 assertions in `store.test.ts`, all updated with the reason
recorded at the assertion. A rebuild and a run of incremental patches still converge:
`ingest.ts` now keeps empty directories too, and the convergence test covers renames,
folder moves and deletes.

Note that an empty directory will not survive a `git clone` — git does not track them.
That is a property of git, not a defect here, but it is worth knowing before relying
on an empty folder as structure.

### 3. Link resolution no longer matches substrings — **this is user-visible**

The Sprint 1 resolver matched `doc.path.toLowerCase().includes(target)`. So
`[[Note]]` would resolve to `Archive/2019/Notebook.md`: a link that appeared to work
while pointing somewhere nobody intended.

Resolution is now exact at every level. **Some links that previously appeared to
resolve will now show as ghosts.** That is the correct reading of them — they never
pointed where the text said — but it will look like a regression the first time it
happens. Clicking such a link now creates the document it actually names.

---

## Open gaps

### Gap 1 — the write backend still does not work on Vercel

Unchanged from Sprint 3, and now carrying four more sprints' worth of features behind
it. `LocalFileStore` writes to the local filesystem; Vercel's is read-only apart from
an ephemeral `/tmp`, and `public/index.json` is a build artifact.

Everything still reaches storage through `WritableFileStore`, so this remains one new
implementation of that interface plus a factory switch. **Estimated 3–4h.** Sprint 4
added `createDirectory`, `removeDirectory` and `moveDirectory` to that interface, so
the R2 implementation is slightly larger than it was — a reason to do it sooner, not
later.

**Recommendation stands: take it into Sprint 5 as P0.** Sprint 5 is committed at 16h,
so per standing rule 3 something has to come out. The honest candidate is the
integrity-check maintenance panel (2h) plus part of the bug backlog buffer (2h) —
though note that Sprint 5's reindex drill is far more meaningful run against the real
storage backend than against a local folder, which is an argument for doing R2 *first*
in that sprint.

### Gap 2 — interactive verification still has not run

The dev server is behind `APP_PASSWORD` and the agent does not enter credentials, so
none of this sprint's UI has been driven in a browser. The logic beneath it is covered
by 110 automated checks, including every API contract the UI calls, but the wiring
between button and call is argued rather than observed.

Sprint 4 added a lot of UI surface, so this gap is bigger than it was. **~20 minutes
by hand:**

1. `npm run dev`, unlock, then use the **+** buttons in the sidebar header to create a
   document and a folder. Confirm both appear in the tree and on disk.
2. Create a document, save it, then open the file in an editor — it should have gained
   an `id:` line, and the editor should not have lost your cursor when it appeared.
3. Rename a document that several others link to. The dialog should say how many
   documents will be updated *before* you confirm; afterwards the links should point
   at the new name.
4. In a document, write `[[Something That Does Not Exist]]`, switch to read mode, and
   click it. A document should be created beside the current one and open in the
   editor.
5. Delete a folder containing documents. The confirm should list them by path.
6. Rename a folder. Documents beneath it should move with it and keep their links.

### Gap 3 — the corpus is still 2 documents

Unchanged. `CORPUS_DIR=/path/to/vault npm run test:roundtrip`.

---

## Notes for Sprint 5

Sprint 5's reindex drill has been partly rehearsed already: `rename.test.ts` performs
renames, folder moves, a folder delete and a document delete, then rebuilds the index
from the corpus alone and requires it to match the incrementally-patched one exactly.
That is the drill's core assertion, running on every test run.

What Sprint 5 still owns is doing it against the real backend, at real corpus size,
with the timing numbers the tripwires need — which is the strongest argument for
landing R2 at the start of that sprint rather than the end.

Conflict handling (`<name>.conflict.md`) has one more caller than it did: a rename
refuses per-file on etag mismatch and reports it. When Sprint 5 turns refusals into
conflict files, the rename path should route through the same mechanism rather than
growing its own.
