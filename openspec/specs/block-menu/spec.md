# block-menu Specification

## Purpose
Specifies the paragraph-based block menu, block ids, drag handle, side
peek, and the `/page` slash command in the MarkForge markdown editor.

## Requirements

### Requirement: Block boundary is a blank line

A block is a run of consecutive non-blank lines. A blank line (or the
start/end of the document) terminates a block.

#### Scenario: Single line is one block

- **WHEN** the buffer contains `hello world` with no blank line around it
- **THEN** the entire buffer is one block

#### Scenario: Two paragraphs

- **WHEN** the buffer contains `first\n\nsecond`
- **THEN** the buffer is two blocks: `first` and `second`

#### Scenario: List is one block

- **WHEN** the buffer contains `- a\n- b\n- c`
- **THEN** the buffer is one block (the list as a whole)

### Requirement: Block id is a hidden HTML comment

Each block carries a stable id written as a hidden HTML comment at the
end of the block, on its own line if the block is multi-line.

Format: `<!-- mkf:b:<short> -->` where `<short>` is a base36 of a random
8-byte value, lowercased (e.g. `a3f2kq18`).

Optional keys inside the same comment, space-separated:

- `color:<name>` — text color
- `bg:<name>` — background color

Example: `<!-- mkf:b:a3f2kq18 color:red bg:yellow -->`.

#### Scenario: Id appears in raw

- **WHEN** a paragraph is created or first edited by the menu
- **THEN** the saved file contains `<!-- mkf:b:a3f2kq18 -->` at the end of
  that paragraph, on its own line

#### Scenario: Raw without ids still works

- **WHEN** a file on disk has no `mkf:b:` comments
- **THEN** the editor and reading view treat each block as having no id;
  the menu still operates (Duplicate, Delete, Turn into) but Copy link to
  block and Color are skipped for that block

#### Scenario: Render strips the comment

- **WHEN** the reading view renders a document containing `<!-- mkf:b:... -->`
- **THEN** the comment is not visible in the output and does not add
  whitespace or affect prose layout

### Requirement: Drag handle is a hover-only gutter widget

In edit mode, hovering the line at the visual top of a block reveals a
6-dot handle (`⠿`) in the left gutter, vertically aligned with the first
line of the block.

#### Scenario: Handle shows on hover

- **WHEN** the mouse pointer is over the first line of a block
- **THEN** the handle for that block is visible (opacity 1) and clickable

#### Scenario: Handle hides on leave

- **WHEN** the mouse leaves the block and the editor
- **THEN** the handle is hidden (opacity 0, pointer-events none)

### Requirement: Click handle opens the menu

Clicking the handle opens a context menu positioned just below the
handle, anchored to the left edge of the editor pane.

#### Scenario: Menu contents

- **WHEN** the menu is open
- **THEN** it shows (top to bottom): a search input, the block-type
  section label (e.g. "Heading 1"), then the action list

#### Scenario: Search filters actions live

- **WHEN** the user types in the search input
- **THEN** the action list below is filtered to items whose label
  contains the query (case-insensitive); submenus are flattened to their
  children during search

#### Scenario: Esc closes the menu

- **WHEN** the menu is open and Esc is pressed
- **THEN** the menu closes and the editor regains focus at the original
  cursor position

### Requirement: Menu items

The menu contains these items:

- Turn into (submenu): Text, Heading 1, Heading 2, Heading 3, Heading 4,
  Bulleted list, Numbered list, To-do list, Quote, Code.
- Color (submenu): Default, Gray, Brown, Orange, Yellow, Green, Blue,
  Purple, Pink, Red. Submenu of background colors too (Default, Gray,
  Brown, Orange, Yellow, Green, Blue, Purple, Pink, Red).
- Duplicate.
- Delete.
- Copy link to block.
- Move to.
- Open in (submenu): New tab, New window, Full page, Side peek.
- Footer: "Last edited · <MMM D, YYYY, h:mm AM/PM>" (timestamp of the
  block's last edit, taken from the frontmatter `updatedAt` of the
  document) and "Word count: <n> words" rendered below the action list,
  in muted text.

#### Scenario: Turn into changes the line prefix

- **WHEN** the user picks a block type from Turn into
- **THEN** the first line of the block is rewritten to the matching
  markdown prefix (`# `, `## `, ..., `- `, `1. `, `- [ ] `, `> `,
  `\`\`\``) preserving the original text after the prefix; if a prefix
  was already present, it is replaced; if the new type is Text the
  prefix is removed

#### Scenario: Turn into a list wraps subsequent block lines

- **WHEN** a multi-line block is turned into a bulleted list
- **THEN** every non-blank line of the block gets `- ` prepended

#### Scenario: Color stores inline meta

- **WHEN** the user picks a non-default text color
- **THEN** the block ends with `<!-- mkf:b:<id> color:<name> -->` (or
  the existing comment is updated); Default removes the `color:` key
- A background color writes `<!-- mkf:b:<id> color:<name> bg:<name> -->`
  (both keys may be present independently)

#### Scenario: Duplicate copies block below

- **WHEN** Duplicate is invoked on a block (or selected range of blocks)
- **THEN** a copy of those blocks is inserted immediately after the
  selection; new blocks get fresh ids; the cursor lands at the end of
  the new copy

#### Scenario: Delete removes block

- **WHEN** Delete is invoked on a block (or selected range of blocks)
- **THEN** the blocks are removed; the cursor lands on the line that
  follows the deletion (or end of file if at the very end)

#### Scenario: Copy link to block

- **WHEN** the user picks Copy link to block on a block with an id
- **THEN** the URL `<current-document-url>#mkf:b:<id>` is written to the
  clipboard and a toast `Link copied` is shown; if the block has no id
  the item is absent from the menu

#### Scenario: Move to opens a destination picker

- **WHEN** the user picks Move to
- **THEN** a modal opens with a search input listing all known pages
  (by title and path); on confirm, the selected block range is removed
  from the current document and appended to the destination document;
  the destination document is saved (its server etag is checked)

#### Scenario: Open in new tab

- **WHEN** the user picks Open in → New tab on a `[[wikilink]]` block
- **THEN** a new regular tab opens with the target document loaded

#### Scenario: Open in new window

- **WHEN** the user picks Open in → New window on a `[[wikilink]]`
  block
- **THEN** a new electron `BrowserWindow` opens pointing at the
  workspace URL with the target document's path deep-linked

#### Scenario: Open in full page

- **WHEN** the user picks Open in → Full page
- **THEN** the current tab is replaced with the target document

#### Scenario: Open in side peek

- **WHEN** the user picks Open in → Side peek
- **THEN** the target document opens in the 45% right-side overlay
  panel; the underlying tab stays active

#### Scenario: Footer shows last-edited and word count

- **WHEN** the menu is open
- **THEN** the footer shows `Last edited · <timestamp>` (taken from
  the document's `updatedAt`) and `Word count: <n> words` for the
  current block; word count counts words in the block, not the whole
  document

### Requirement: Keyboard shortcuts work without opening the menu

These shortcuts are bound at the editor level and operate on the cursor
paragraph (or selected range):

- `Ctrl+D` → Duplicate
- `Del` → Delete (only when selection is non-empty; the default
  forward-delete for empty selection is left intact)
- `Alt+Shift+L` → Copy link to block
- `Ctrl+Enter` → Insert blank line below cursor (escape current
  paragraph and start a new one with a fresh id)

#### Scenario: Ctrl+D duplicates

- **WHEN** `Ctrl+D` is pressed and the cursor is in block B
- **THEN** a copy of B is inserted directly after B with a fresh id and
  the cursor lands at the end of the copy

#### Scenario: Alt+Shift+L copies link

- **WHEN** `Alt+Shift+L` is pressed in a block with an id
- **THEN** the block's anchor URL is copied and a toast is shown

#### Scenario: Ctrl+Enter breaks paragraph

- **WHEN** `Ctrl+Enter` is pressed mid-paragraph
- **THEN** a blank line is inserted at the cursor and the cursor moves
  to the first character of the new empty paragraph below

### Requirement: Drag handle is also a drag handle

Clicking and holding the handle, then dragging, reorders the block.

#### Scenario: Drop indicator shows between blocks

- **WHEN** the user drags a handle
- **THEN** a horizontal indicator appears between the two blocks the
  cursor is between, showing where the dragged block will land

#### Scenario: Drop reorders

- **WHEN** the user releases the mouse over a drop target between two
  blocks
- **THEN** the dragged block is removed from its original position and
  inserted at the drop position; block ids are preserved

#### Scenario: Cancel on Esc during drag

- **WHEN** Esc is pressed while dragging
- **THEN** the drag is cancelled and the buffer is unchanged

### Requirement: Slash command `/page` creates a sibling

Typing `/page "Name"` in the editor and selecting the suggestion opens a
small inline form for the page name (or accepts the quoted name as-is)
and creates a new `.md` file in the same directory as the current
document. The current document's frontmatter gets a `subpages:` array
entry pointing to the new file's path; the new file's frontmatter gets
the inverse `parent:` reference.

#### Scenario: New page becomes a tab

- **WHEN** the page is created
- **THEN** a new tab opens in the workspace pointing at the new file

#### Scenario: Parent frontmatter updated

- **WHEN** the page is created
- **THEN** the parent document is saved with `subpages: ["<new-path>"]`
  in its YAML frontmatter (added to existing array, not replacing it)

#### Scenario: No parent write when name is empty

- **WHEN** the user dismisses the slash command without confirming a
  name
- **THEN** no file is created and the buffer is unchanged

### Requirement: Side peek opens a tab as a 45% overlay

A tab can be opened in side-peek mode. Side peek renders the document
in a 45%-width panel sliding in from the right of the workspace, with
the current tab still active underneath.

#### Scenario: Open side peek from tab context

- **WHEN** the user invokes "Open in side peek" on a tab (menu item or
  shortcut)
- **THEN** a new side-peek panel appears on the right with the document
  loaded; the underlying tab stays active

#### Scenario: Close side peek

- **WHEN** the user clicks the panel's close (X) button or presses Esc
- **THEN** the panel slides out and the underlying tab is still active

#### Scenario: Only one side peek at a time

- **WHEN** a side peek is already open and the user opens another
- **THEN** the new peek replaces the old one (the old one's tab is
  unaffected)

### Requirement: Menu is keyboard-accessible

The menu can be navigated with arrow keys, Enter activates an item, Esc
closes, focus is trapped inside the menu while it is open.

#### Scenario: Arrow nav

- **WHEN** the menu is open
- **THEN** `ArrowDown` moves focus to the next item, `ArrowUp` to the
  previous; `ArrowRight` on a submenu item opens the submenu and moves
  focus into it

#### Scenario: Focus trap

- **WHEN** the menu is open and the user tabs past the last item (or
  shift-tabs before the first)
- **THEN** focus wraps to the opposite end of the menu

### Requirement: Backward-compatible with plain markdown

A document that has no `mkf:b:` comments, no `subpages:`, and no
`parent:` opens and edits as before. Block operations still work, but
Copy link to block, Color, and `/page` are gated on having the
necessary id or being a recognised location.

#### Scenario: Round trip without menu

- **WHEN** a file with no `mkf:b:` comments is opened, edited in plain
  text mode, and saved
- **THEN** the saved file is byte-identical to the original (no
  comments are injected unless a menu action requires them)
