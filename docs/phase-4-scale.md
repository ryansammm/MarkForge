# Phase 4 — Scale and polish

**Status:** Built. §4.1 found what the plan warned it might: **the architecture does
not hold at 2,000 documents**, and the fix is a sprint, not a patch.
**Scope:** [production-readiness-plan.md](./production-readiness-plan.md) §Phase 4
**Gate:** *is it pleasant at scale?*

---

## Outcome

| Item | State |
|---|---|
| 4.1 Corpus scale | **Measured. Two tripwires already tripped** — see below |
| 4.2 Mobile | **Done** — the sidebar is a drawer; the document went from 119px to 375px |
| 4.3 Accessibility | **Done** — arrow-key tree, `aria-live` save state, `aria-current` |
| 4.4 Design shell | **Done** — breadcrumb, Details panel, collapsible rail |

`npm test` — 230 checks, 0 failures.

---

## 4.1 — The benchmark, and what it says

`npm run benchmark [count]` builds a synthetic corpus with a realistic link graph —
one hub per 50 documents, because a real vault concentrates inbound links on index
notes and an evenly-linked graph makes rename look free.

Run 7 August 2026, 2,000 documents (3.81 MB of Markdown), **MemoryBucket — no
network**. These are floor numbers; R2 adds a round trip to every line.

| | |
|---|---|
| `index.json` | **4.68 MB** |
| — of which document bodies | **81%** |
| metadata only (no bodies) | 917 KB |
| reindex from storage | 4,374 ms |
| one save, 2,000 docs | p50 **28.6 ms**, p95 39.2 ms |
| one save, 100 docs | p50 3.7 ms |
| rename with 53 inbound links | plan 169 ms, execute **1,768 ms** |
| search index build (Orama) | 205 ms |
| search query | 5–12 ms |

Gzip reports 187 KB, and that number is a lie worth naming: generated prose reuses a
20-word vocabulary and compresses about ten times better than real writing. The
uncompressed size is the honest one anyway, because `JSON.parse` and the JS heap pay
that, not the compressed size.

### Tripwire 1 — the client index (predicted, and worse than predicted)

The plan guessed the index payload would fail first. It does, and the reason is
sharper than "it is big": **81% of it is document bodies**, shipped to the browser on
every boot so that in-memory search can exist. At 2,000 documents that is a 4.68 MB
JSON parse on the main thread before anything renders, held in memory, and then
indexed again by Orama.

Cutting bodies out takes it to 917 KB — an 80% reduction — but **that breaks full-text
search**, which is the whole reason they are there. So the fix is not "strip a field";
it is: metadata-only index, bodies fetched on demand, and search moved server-side or
into a prebuilt index. That is a redesign of the "zero-database client index" premise
this product was built on, and it is a sprint of work.

### Tripwire 2 — every save rewrites the whole index (not predicted)

This one the plan did not anticipate. `WorkspaceStore` patches `index.json` and writes
it back on every document write. At 2,000 documents that is **a 4.68 MB PUT per save**,
and saves are debounced at 500 ms while typing.

On MemoryBucket it costs 29 ms. On R2 it is a multi-megabyte upload per save — seconds
of latency, egress on every keystroke pause, and a compare-and-set retry loop that gets
more likely to collide the longer each write takes. Save cost scales linearly with
corpus size, which is the wrong shape entirely: saving one note should not get slower
because you own more notes.

### Tripwire 3 — rename is a foreground operation

1.77 seconds for 53 inbound links, with no network. On R2 that is 53 read-modify-write
round trips plus the index — plausibly 10–30 seconds — during which the UI shows a
modal spinner and nothing else. It works, and it reports per-file outcomes honestly.
It just cannot stay in the foreground at this size.

### What this means for the plan

The plan said §4.1 "can invalidate the plan's own estimates." It has. **Ship-to-others
is not gated on this** — the corpus that exists is two documents, and every safety
property from Phases 1–3 holds regardless of size — but the growth path is now a known
quantity rather than a hope:

| Corpus | State |
|---|---|
| ≤ 200 documents | Comfortable. Index ~470 KB, saves ~5 ms. |
| ~500 documents | Usable. Index 1.16 MB, saves ~8 ms. Watch the boot payload. |
| ~1,000 documents | Degrading. Index 2.33 MB parsed on every load. |
| ≥ 2,000 documents | **Not viable as built.** |

**Recommended next sprint, with this as its evidence:** split the index into metadata
and bodies, move search off the client index, and take rename out of the foreground.
Roughly 12–16h, and it should be argued on these numbers rather than on principle.

> **Done.** The split shipped — see [the index split](./index-split.md) for the design
> and the after numbers. Rename is still in the foreground.

---

## 4.2 — Mobile

`globals.css` had a rule hiding `.workspace-sidebar` below 768px. **No component ever
carried that class**, so the rule had never once applied: at 375px the sidebar took
256 pixels and left 119 for the document. Measured, not inferred.

It is a drawer now — off-canvas below `md`, with a backdrop, an Escape handler, and
closing on selection, because on a phone the drawer is covering the thing you just
chose to read. Verified at 375×812: sidebar at `-256px` when closed, `0` when open,
document at the full 375, no horizontal overflow.

The context rail is now `lg`-and-up as well as toggleable: a 288px rail on a 768px
tablet is most of the viewport, and the document is the point.

**Not verified:** the share reader page with an actual document on mobile. Its
not-found state was checked at 375px, but rendering a real shared article would mean
creating a live public link to a real document, which is not mine to do for a layout
check.

## 4.3 — Accessibility

- **Arrow-key tree navigation.** Tab reached every row, but stepping through a hundred
  documents one Tab at a time is not navigation. Up/Down move, Right opens a folder,
  Left closes it, Home/End jump. Driven off the rendered DOM in document order, so
  what the eye sees and what the keys follow cannot drift apart. Verified in the
  browser: focus trail `ped → Permit Digitalization → Testing`, and Left/Right
  collapsing and expanding.
- **The save indicator now speaks.** It was the only thing that ever said a save did
  not land, and it said it in colour and an icon. There is an `aria-live` region —
  `assertive` for failures and conflicts, because continuing to type into a buffer
  that is not being written is the thing to prevent, and it names the `.conflict.md`
  file in the announcement.
- **`aria-current="page"`** on the active document and the last breadcrumb segment.

**Not done:** a full contrast audit of both themes. Spot values look fine; nobody has
run a checker over every token pair.

## 4.4 — The design's remaining shell

Breadcrumb (folder segments plus the document's *title*, not its filename), a Details
panel with created/updated/words, and a collapsible context rail whose state persists
across sessions and tabs.

Created only appears when frontmatter carries it. The index does not track creation
time, and deriving one from `updatedAt` would be a plausible-looking lie.

Deliberately still absent, per the plan: workspace switching (ruled out by the
single-corpus decision) and the per-user footer, which implies accounts this product
does not have.

### Found while building it

`usePersistedFlag` read a value left by an earlier iteration of the same feature and
parsed it as `false`, so the rail silently stayed closed. It now falls back on
anything that is not exactly `"true"` or `"false"` — a stale value should not turn a
feature off. Small, but it is the shape of bug that ships: nobody would have reported
"the rail is closed", they would have assumed it was meant to be.
