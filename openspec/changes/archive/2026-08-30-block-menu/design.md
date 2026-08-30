## Context

MarkForge's editor is a CodeMirror 6 view of the raw markdown buffer.
There is no per-block state today. Notion-style block affordances
(drag handle, context menu, drag-and-drop reorder) are useful for
users who think in paragraphs rather than whole files, but adding them
must not break the buffer-is-the-file property, the frontmatter
round-trip, or the offline-first guarantee.

The block id lives as a hidden HTML comment at the end of a paragraph.
Hidden means: visible in the raw `.md` file (so the file is self-contained
and readable in any editor), invisible in the rendered output (so it
does not affect the reading view or anyone else's view of the file
outside MarkForge).

The drag handle is a CodeMirror gutter widget — same pattern as
`components/workspace/hide-frontmatter-id.ts`. It only renders in edit
mode and only on hover.

The menu uses the Radix `DropdownMenu` primitive (already a project
dependency via `components/ui/dropdown-menu.tsx`), which gives focus
management, keyboard nav, and click-outside dismiss for free.

Side peek is a single 45%-width overlay panel rendered alongside the
active tab. The active tab continues to own the left side; the peek
owns the right. Only one peek is open at a time.

## Goals / Non-Goals

- Goals:
  - Per-paragraph block id as a hidden HTML comment.
  - Hover drag handle and drag-reorder paragraphs.
  - Block menu with Turn into / Color (text + background) / Duplicate
    / Delete / Copy link to block / Move to / Open in (new tab / new
    window / full page / side peek), with search, submenus, keyboard
    nav, focus trap.
  - Menu footer: "Last edited · <timestamp>" and word count.
  - `Ctrl+Enter` to escape paragraph.
  - `/page "Name"` slash command creates a sibling `.md`.
  - Side peek (45% right overlay, single, closeable).
- Non-Goals:
  - AI / Suggest edits (cancelled).
  - Multi-select on the same paragraph (only contiguous paragraph
    range is a single selection).
  - Render of id-aware ToC, search-by-id, or any "block graph" UI.

## Decisions

- **Block = paragraph, not line.** Markdown convention: blank line
  terminates a paragraph. This matches Notion's mental model and
  treats a list as a single atomic block.
- **Id = hidden HTML comment, not frontmatter.** Frontmatter is
  file-level; per-paragraph metadata belongs in-band with the
  paragraph. The renderer strips `<!-- mkf:b:... -->` before display.
- **Id format: `<!-- mkf:b:<short> -->`**, where `<short>` is base36
  of 8 random bytes. Stable across saves; the menu only assigns a
  new id when the user takes an action that requires one (Duplicate,
  Turn into on a previously id-less block).
- **Drag handle = CodeMirror gutter widget.** Same module pattern as
  `hide-frontmatter-id.ts`. The widget is only visible when the
  mouse is inside its block's vertical range and the editor is in
  edit mode.
- **Menu uses Radix `DropdownMenu`.** Already a project dependency;
  focus trap, keyboard nav, submenu handling, and click-outside
  dismiss are built in.
- **Reorder via drag = CodeMirror transaction**, not a global state
  change. Drop coords are translated to `state.doc.posAtCoords`,
  then a transaction splices the dragged paragraph range to the drop
  position. No external reorder state.
- **`Ctrl+Enter` = new paragraph below cursor** — single-line
  keymap addition. Plain `Enter` keeps the markdown newline
  behaviour. The two together cover both writing styles.
- **Side peek = overlay panel, not a second tab group.** Simpler
  layout, one extra element in `workspace-app.tsx`, no new tab
  group machinery.
- **Page sibling via `createDocument` API.** Already exists in
  `lib/workspace-api.ts:77`. The parent frontmatter write is a
  separate `writeDocument` call with `If-Match` from the parent's
  current etag.
- **`Color` writes `color:<name>` inside the existing
  `<!-- mkf:b:... -->` comment.** No new metadata channel; renderer
  reads it on the fly.

## Risks / Trade-offs

- **HTML comments in the file.** Any non-MarkForge editor sees them
  as inert text. `react-markdown` and `remark` parse them as
  comments and ignore them. Git diff shows them — acceptable; they
  are short and tied to paragraph boundaries.
- **Drag handle can flicker** if a user moves the mouse quickly
  across many blocks. Mitigated by 100 ms debounce on the hover
  show/hide.
- **Radix `DropdownMenu` submenu behavior on long lists** — the
  Color submenu has 10 items, the Turn into submenu has 10 items,
  both fit in one viewport. No virtualisation needed in v1.
- **Side peek blocks underlying tab focus** while open. Esc and
  the close button both close it. Not configurable in v1.
- **Block menu in the file means file size grows by a few bytes
  per paragraph.** Negligible for the target document size (notes,
  not a 10k-line encyclopedia).
- **Reading view must strip the comment on every render.** Trivial
  regex; added to `lib/markdown/serializer.ts` once and shared with
  `doc-viewer.tsx`.

## Migration Plan

- New file format is a strict superset: files without `mkf:b:`
  comments open and edit unchanged. The first time a user takes a
  block-menu action on a paragraph, that paragraph gains an id.
- No data migration, no schema migration, no API change.
- Rollback = revert the commit (the new files are isolated; the
  `markdown-editor.tsx` extension additions are small).

## Open Questions

- **Should `/page` open the new page in side peek or as a regular
  tab?** Currently spec says regular tab. Confirm in review.
- **Color names: English (`red`) or human (`Red`)?** Spec uses
  lowercase keys (CSS-friendly). Confirm in review.
- **Side peek keyboard shortcut?** Spec doesn't assign one. Add
  later if requested.
