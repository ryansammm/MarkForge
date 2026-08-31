# block-types Specification

## Purpose

Specifies the Notion-style block kinds and the data-model that
backs the paragraph-based block menu. The data model is
markdown-shaped (the file on disk is the source of truth) with
block metadata riding in `<!-- mkf:b:<id> ... -->` comments.

## Requirements

### Requirement: Block kinds

`BlockKind` is the closed union of types a block can take. It
is exported from `lib/blocks.ts` and shared by the editor, the
transform layer, and the menu.

```
type BlockKind =
  | 'text'
  | 'h1' | 'h2' | 'h3' | 'h4'
  | 'bullet' | 'numbered' | 'todo'
  | 'quote' | 'callout'
  | 'toggle_list'
  | 'toggle_h1' | 'toggle_h2' | 'toggle_h3' | 'toggle_h4'
  | 'code'
  | 'divider';
```

#### Scenario: BlockKind is a single source of truth

- **WHEN** any surface (editor, doc viewer, menu, slash
  commands) needs to know "what is a block?"
- **THEN** it imports `BlockKind` from `lib/blocks.ts`; no other
  file redeclares the union

### Requirement: Block metadata is a hidden HTML comment

Each block carries a stable id and optional metadata as a hidden
HTML comment. The `type` key disambiguates a bullet line that
should render as a toggle list, and a heading that should render
as a toggle heading.

Format: `<!-- mkf:b:<short> [type:toggle_list|toggle_h1|..] [open:1] -->`

#### Scenario: toggle_list kind

- **WHEN** a `- ` line is followed by `<!-- mkf:b:.. type:toggle_list -->`
- **THEN** the block is reported as `toggle_list`, not `bullet`,
  and the menu shows "Turn into" entries consistent with the
  toggle-list kind

#### Scenario: toggle_h1..4 kinds

- **WHEN** an `# ` line is followed by
  `<!-- mkf:b:.. type:toggle_h1 -->`
- **THEN** the block is reported as `toggle_h1` and the menu
  shows "Toggle heading 1" in its "Turn into" submenu

#### Scenario: open flag (decorative)

- **WHEN** a block carries `open:1` in its metadata
- **THEN** the editor's toggle widget shows the open arrow
  (▼); `open:0` shows the closed arrow (▶). The read view
  currently does not consult this flag — the spec notes the
  limitation so future widget work can layer on without a
  data-model change.

### Requirement: Divider is a real kind

A block whose body is a single line matching `/^---+$/` is
detected as `divider`. The `Turn into` submenu offers "Divider"
as a destination kind; `retypeBlock` handles the text→divider
and divider→text transitions losslessly for the user-visible
shape (text body drops; divider body emits empty).

#### Scenario: empty body + `---` is a divider

- **WHEN** the buffer for a block is `---`
- **THEN** `detectBlockType` returns `'divider'`

#### Scenario: text → divider drops the body

- **WHEN** the menu's "Turn into → Divider" is invoked on a
  non-empty text block
- **THEN** the resulting block has prefix `---` and an empty
  body

### Requirement: Read-mode table styling

The reading view renders GitHub-flavoured pipe-tables with
Notion-style spacing and borders so tables are visually
distinguishable from the surrounding prose.

#### Scenario: header row

- **WHEN** a table's first row is rendered
- **THEN** each `<th>` has `px-3 py-2 font-semibold bg-muted/40`
  and a `border-b border-border` separator from the body

#### Scenario: body rows

- **WHEN** a table's body rows are rendered
- **THEN** each `<td>` has `px-3 py-2 align-top
  border-b border-border/60`; the last visible row drops its
  bottom border via `tr:last-child td { border-bottom: 0 }`

#### Scenario: table survives stripBlockComments

- **WHEN** the body of a document containing a pipe-table is
  passed through `stripBlockComments`
- **THEN** the pipe-table syntax (`|`, `---`, row cells) is
  preserved and only the trailing `<!-- mkf:b:.. -->` comment is
  removed

### Requirement: Toggle list widget is decorative in the editor

`components/workspace/toggle-list-edit.ts` shows a `▼` / `▶`
glyph and flips a `meta.open` flag on click. The read view
ignores the flag.

#### Scenario: closed → open

- **WHEN** the user clicks the `▶` on a toggle_list block in
  the editor
- **THEN** the glyph flips to `▼` and the block's metadata
  gains `open:1` (or has `open:0` removed)

### Requirement: New page modal routing

`workspace-app.tsx` exposes `openNewDocument` to both the
sidebar's `+` button and the `Mod-N` keymap. A
`useImperativeHandle`-style ref (`openNewDocumentRef`) is
mirrored from the `useCallback` so the keydown handler can
reference the function before its declaration.

#### Scenario: Mod-N opens the new-page modal

- **WHEN** the editor has focus and `Mod-N` is pressed
- **THEN** the new-page modal opens (same surface as the
  sidebar's `+ New page`)

#### Scenario: ref mirrors the latest callback

- **WHEN** `openNewDocument` is recreated by React
- **THEN** `openNewDocumentRef.current` points at the latest
  closure (no stale reference)

### Requirement: Page-ref chip

A `[[Page Title]]` wikilink in a block renders as a chip in
the editor and as a link in the reader. The chip's text is the
page title; the chip's target is the workspace-relative path
of the referenced page.

#### Scenario: chip text matches the page title

- **WHEN** a block contains `[[Project Plan]]` and a page
  titled "Project Plan" exists in the active grimoire
- **THEN** the editor renders a chip whose text is "Project
  Plan" and whose click target opens the page
