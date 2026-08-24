# Sprint 3 Decision Gate — Milkdown vs CodeMirror 6

**Decision date:** Day 3 (per sprint plan — "make this call on day 3, not day 11")
**Decision:** **CodeMirror 6 + live preview.** Milkdown/ProseMirror is out of v1.
**Status:** Decided, implemented.

---

## What the spike ran

Milkdown 7.22 installed cleanly against Next 16 / React 19 — peer ranges are `*`, so
dependency resolution was never the risk. The real risk was always serialization, so
the spike went straight at it: parse → stringify through the same remark pipeline
Milkdown drives underneath ProseMirror.

## What it found

7 of 10 Markdown constructs were altered by a default round-trip. One of them is fatal:

| Construct | Input | After round-trip |
|---|---|---|
| **Wikilink** | `See [[Principles]] for details.` | `See \[\[Principles]] for details.` |
| **Aliased wikilink** | `[[Principles\|the rules]]` | `\[\[Principles\|the rules]]` |
| Underscores | `snake_case_identifier` | `snake\_case\_identifier` |
| Setext heading | `Title\n=====` | `# Title` |
| Hard break | `line one··\nline two` | `line one\\\nline two` |
| Table delimiters | `\| --- \|` | `\| - \|` |
| Bullets | `- one` | `* one` |

The wikilink row is the whole ballgame. **Opening and saving a document would escape
every `[[link]]` in it**, and the escaped form no longer parses as a wikilink. One save
pass over the corpus silently destroys the link graph — the app's central feature —
and it destroys it in a way that looks like nothing happened.

## Why this kills Milkdown specifically

The escaping itself is fixable in a serializer, and it has been fixed (see
`lib/markdown/serializer.ts`). The Milkdown-specific problem is upstream of that:

ProseMirror has no wikilink node in its schema. `[[Principles]]` enters the document
model as ordinary text, and at that point the information that it was a *link* is
already gone. Making it survive needs a custom remark plugin, a custom ProseMirror node
spec, an input rule, and a matching serializer spec — before any of the sprint's actual
editor work starts. That is the "eats the sprint" risk the plan named, arriving on
schedule.

CodeMirror has no such problem, because there is no document model to convert to. The
buffer *is* the file. Bytes typed are bytes written.

## What was traded away

**Lost:** the WYSIWYG block-editor feel from the original vision. Editing is raw
Markdown with syntax-aware inline styling — the Obsidian model.

**Gained:** Markdown integrity becomes structurally impossible to break, rather than
something defended by test coverage. That was the sprint's stated non-negotiable.

Also gained: roughly the whole 5h editor budget stayed on editor work instead of going
into schema plumbing, and code-block highlighting (P1) came in as a side effect of the
language support already installed.

## The serializer still got built

Dropping WYSIWYG does not drop the canonical serializer — it changes its job:

- It is **not** on the save path. Saves write the buffer verbatim.
- It is an explicit, opt-in **Format Document** action.
- It is the engine Sprint 4's **rename-with-inbound-link-rewrite** will run on. Rewriting
  a link means parse → modify → re-serialize, which is precisely the operation that
  escaped the brackets above. Sprint 4 would have shipped that bug into the corpus.

The round-trip suite guards that path and runs green against the real corpus.

## PRD Q5 — answered

*Does the canonical serializer reformat existing notes invasively?*

**No — normalization is opt-in and never implicit.** Files the app has not been asked to
format stay byte-identical. Formatting is a deliberate user action on one document, with
the round-trip suite standing behind it. The recommendation in the sprint plan
("normalize only documents the app has written") is satisfied by the stronger form:
normalize only documents the user explicitly asks to normalize.
