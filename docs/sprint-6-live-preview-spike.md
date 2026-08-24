# Sprint 6 Backlog Item — Inline live preview (spike-gated)

**Priority:** P1 · **Estimate:** 3h, hard timebox
**Sprint:** 6 (Mon 13 Oct — Sun 26 Oct 2026)
**Status:** **Built.** See "Outcome" at the end of this document.
**Origin:** [competitive-brief-notion-editor.md](./competitive-brief-notion-editor.md)

---

## Scope accounting (standing rule 3)

Every addition needs a removal, written down.

| | Item | Est |
|---|---|---|
| **Added** | Inline live preview (this item) | +3h |
| **Removed** | Tag browsing (P1) | −2h |
| **Already shipped** | Dark mode (P1) — `next-themes`, `ThemeProvider`, full token set including the editor's. **This is dead scope in the plan and should be struck.** | −1.5h |
| **Net** | | **−0.5h** |

Committed load is unchanged at **11.5h** — this is a P1↔P1 swap and does not touch the
sprint's P0 commitment.

## Preconditions — do not start until all three are true

1. **Every Sprint 6 P0 is done**, including "send 3 real share links to real people."
   The share link is the sprint goal; this is polish.
2. **The R2 `WritableFileStore` gap is closed.** An editor upgrade on a deployment that
   cannot save is worth nothing. If R2 slipped out of Sprint 5, this item is cut, not
   deferred.
3. **Sprint 5 did not slip.** Standing rule 4 warns that after five sprints of build
   fatigue, Sprint 6 is exactly when a fun feature starts looking like a good reason to
   avoid unglamorous work. This item is the most likely candidate for that. If Sprint 5
   carryover exists, it takes this slot.

---

## Why

Our editor shows raw syntax — `## Heading`, `**bold**`, `[[Wikilink]]` — and reading is a
separate mode behind a toggle. Every serious competitor renders inline while keeping the
source editable. It is the only row in the competitive feature matrix where we are behind
on *user experience* rather than on deliberate scope.

**This is explicitly not a step toward a block editor.** Decorations are view-only; the
document is never modified. That is what keeps the Sprint 3 guarantee intact — the buffer
is still the file, byte for byte. Notion's broken Markdown export is what happens when
the document model gets richer than the format; nothing here touches the document model.

## Scope

### In — four node types, nothing else

| Node | Behaviour |
|---|---|
| ATX headings | Hide the `#`/`##` markers and the following space. Size/weight styling already exists. |
| Emphasis / strong | Hide `*`, `_`, `**`, `__` markers. Styling already exists. |
| Inline code | Hide the backticks. Styling already exists. |
| **Wikilinks** | Hide the `[[` `]]` and the `|` + target when aliased; render the visible text link-styled, with the resolved/ghost distinction the reading view already makes. |

Every one of these reveals its raw syntax when the cursor or selection enters the node's
range — the Obsidian model. Nothing renders as a widget; nothing is replaced with
generated content.

### Out — name these so they cannot creep in

Tables, image widgets, task-list checkboxes, blockquote decoration, list bullets,
footnotes, link URLs, frontmatter folding. Slash commands, block drag handles,
multi-column. Any change to `DocViewer` or reading mode. Any change to the save path,
the serializer, or the index.

## Approach

**Hour 1 — build vs buy, decided on evidence.**

Evaluate [`@atomic-editor/editor`](https://github.com/kenforthewin/atomic-editor)
(CodeMirror 6, React, already handles `[[target]]` / `[[target|label]]` with async
resolution and autocomplete, plus a reading mode) against hand-rolling the four
decorations above.

Buy is only viable if all of these hold — check them in this order, stop at the first
failure:

- It composes as extensions into **our** `EditorView`, rather than owning the editor.
  We have wiring it must not displace: the `[[` completion source reading our in-memory
  index, the `docPath`-keyed remount, and the `minimalEdit` dispatch that reconciles a
  server-injected frontmatter `id` without moving the cursor.
- It does not pull the wikilink resolution away from `lib/resolve-link.ts`. Two
  resolvers would drift, and the symptom would be a link that renders as resolved but
  navigates nowhere.
- Its bundle cost is acceptable against the Sprint 6 P0 that says the public share route
  must ship **no editor bundle at all**.

Otherwise build. The hand-rolled version is a single `ViewPlugin` producing a
`DecorationSet` from `syntaxTree(state)`: `Decoration.replace()` over marker ranges,
skipped when `state.selection` intersects the node. Roughly 150 lines, and the wikilink
case — the part that would cost most elsewhere — is already ours.

**Hours 2–3 —** implement the four node types, then run the gate below.

## Decision gate — at the 3h mark, not later

Sprint 3's gate is the model: a hard timebox and a pre-agreed fallback. The fallback here
is trivial — remove the extension, keep source mode, lose nothing.

**Ship only if all five hold:**

1. **Round-trip suite green.** Non-negotiable. Decorations cannot change the document, so
   this should be untouched — and if it is not, something is very wrong and the item is
   dead on the spot.
2. **Copy yields raw Markdown.** Select across a hidden marker and copy: the clipboard
   must contain `**bold**` and `[[Target]]`, not `bold` and `Target`. Decorations are
   view-only so this should hold by construction; verify it rather than assume it,
   because silently lossy copy would be a data-integrity bug wearing a cosmetic disguise.
3. **The cursor stays put.** Typing at a decoration boundary, arrowing through a hidden
   marker, and Home/End on a decorated line must all behave. Cursor instability is the
   documented hard part of live preview and is the most likely reason to abandon.
4. **No visible lag** on the largest document in the corpus.
5. **Undo is intact.** Ctrl+Z after typing inside a decorated node restores what was
   typed, not a decoration artifact.

**If any fail: revert the extension and stop.** Integrity is the product; preview is
polish. Do not spend hour 4 on it.

## Acceptance criteria

- [ ] Headings, emphasis, inline code and wikilinks render inline while the cursor is
      elsewhere, and reveal their syntax when the cursor enters
- [ ] Resolved and ghost wikilinks are visually distinct, using the same resolver as the
      reading view (`lib/resolve-link.ts`)
- [ ] `[[` autocomplete still works, still sourced from the in-memory index
- [ ] Save, save-state indicator, and frontmatter-`id` reconciliation are unaffected
- [ ] Public share route bundle contains no editor code — re-measured, since this item
      grows the editor chunk
- [ ] `npm test`, `typecheck`, `lint`, `build` all green
- [ ] Works in both themes

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cursor instability at decoration boundaries | The feature is unusable | Gate criterion 3; revert is free |
| Copy silently loses Markdown syntax | Data integrity bug that looks cosmetic | Gate criterion 2, checked explicitly |
| Editor bundle grows and leaks into the public route | Breaks a Sprint 6 P0 | Re-measure the bundle as an acceptance criterion |
| A bought library owns the EditorView | Loses the save and reconciliation wiring | Hour-1 evaluation stops at the first failing condition |
| Scope creep into tables, widgets, slash commands | Eats the sprint | The "Out" list above is the contract |
| It becomes the reason Sprint 5 carryover slips | The actual danger | Precondition 3 |

## Test plan

The round-trip suite is the regression guard and needs no new fixtures — decorations do
not touch the document, so the existing 32-document × 5-property suite already asserts
the property that matters.

Add to the manual verification pass (which is itself still carried from Sprint 3):

1. Open a document containing a heading, bold text, inline code and a wikilink. Confirm
   all four render inline.
2. Click into each. Confirm the raw syntax appears and the cursor lands where clicked.
3. Select the whole document, copy, paste into a plain text editor. Confirm it is
   byte-identical to the file.
4. Type at the very start and very end of a decorated node.
5. Undo a few edits inside a decorated node.
6. Toggle to reading mode and back; confirm nothing is stuck.

## Not in v1

Slash commands, block drag handles, multi-column layout, callout blocks. These are the
Notion-shaped features, they require a document model richer than Markdown, and they are
a v2 conversation to be argued on their own merits — not on Notion having them.

---

## Outcome

**Built, hand-rolled.** The hour-1 build-vs-buy check stopped at the first condition:
`@atomic-editor/editor` is packaged as an editor component rather than as extensions
composed into an existing `EditorView`, and taking it would have displaced the `[[`
completion source, the `docPath`-keyed remount and the `minimalEdit` frontmatter
reconciliation. The hand-rolled version is
[live-preview.ts](../components/workspace/live-preview.ts) — one `ViewPlugin` over
`syntaxTree`, plus a regex pass for wikilinks against the app's own `WIKILINK_PATTERN`
so there is still exactly one definition of that syntax.

One design note worth recording: **the parser never sees a wikilink.** `[[Target]]`
arrives as an ordinary `[Target]` Link node wrapped in stray brackets, so the decoration
cannot come from the tree. It comes from a text scan that skips anything inside
`FencedCode`, `CodeText`, `InlineCode` or HTML — which is why `` `[[Target]]` `` in a code
span stays raw, as it must.

### Gate results

| # | Criterion | Result |
|---|---|---|
| 1 | Round-trip suite green | **Pass** — 34 documents × 5 properties, untouched |
| 2 | Copy yields raw Markdown | **Pass** — selecting a line whose `**` markers are hidden and firing a `copy` event puts `- ⚡ **Zero-Database Client Index**: … \`.md\` …` on the clipboard, not the painted text |
| 3 | Cursor stays put | **Partly verified.** `EditorView.atomicRanges` makes each hidden marker a single arrow-key step, and placing the caret in a heading reveals `# Permit Digitalization` in place. Typing at a decoration boundary was **not** exercised interactively — see below |
| 4 | No visible lag | **Pass** on the 4.4KB corpus document. Not meaningful evidence; decorations are computed over `visibleRanges` only, and the real test is the benchmark in the production-readiness plan §4.1 |
| 5 | Undo intact | **Not verified interactively** — see below |

### What was not verified, and why

The dev server is wired to the **live R2 bucket** (`X-Storage-Durable: true`) holding
real documents, and the editor autosaves. Every interactive check above was therefore
restricted to selection changes, which dispatch no document change; the server log for
the session shows `GET` only. Typing tests — gate criteria 3 and 5 — would have written
to a real corpus to prove a cosmetic feature, which is the wrong trade.

They should be run once against a scratch document. Both are structurally defended in
the meantime: decorations are view-only, so they are outside the undo history entirely,
and `changeByRange` is what keeps the selection mapped through the formatting commands.

### Scope actually shipped

The four agreed node types, plus two additions from the original design that were not in
this spec:

- **A floating format bar** ([editor-toolbar.tsx](../components/workspace/editor-toolbar.tsx))
  over plain-Markdown `StateCommand`s ([editor-commands.ts](../components/workspace/editor-commands.ts)):
  bold, italic, wikilink, heading cycle, bullet list, inline code, with `Mod-b` / `Mod-i` /
  ``Mod-` `` / `Mod-Shift-x` bound to the same commands.
- **Mod-click on a rendered wikilink** navigates, through `lib/resolve-link.ts` — the
  reading view's resolver, not a second one.

Serif headings in the editor come from the same design. Everything on the "Out" list
above stayed out.

### Test coverage

[tests/live-preview.test.ts](../tests/live-preview.test.ts) — 33 checks, run by
`npm run test:preview` and as part of `npm test`. No DOM: `previewNodes` was split out
of the `ViewPlugin` precisely so the question that matters — *which bytes get painted
away* — is answerable from an `EditorState` alone. The strongest assertion there is that
the rendered text is always a **subsequence** of the file, which is the property that
makes "the editor cannot show you something your document does not say" testable rather
than argued.
