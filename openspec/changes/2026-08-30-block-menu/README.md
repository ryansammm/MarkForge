# add-block-menu

Notion-style block menu for the markdown editor. A "block" here is a
markdown paragraph (or list group): a chunk of text terminated by a blank
line. Each block carries a stable id stored as a hidden HTML comment, and
the menu acts on the block the cursor is in, or on a multi-paragraph range
when one is selected.

## Scope

In:

- Block id model (id encoded as `<!-- mkf:b:<short> -->` at paragraph end).
- Hover drag-handle gutter widget in edit mode.
- Block menu: search, submenus, keyboard nav, focus trap.
- Items: Turn into, Color (text only), Duplicate, Delete, Copy link to block.
- Drag-and-drop paragraph reorder through the handle.
- Ctrl+Enter as "new paragraph below cursor".
- Slash command `/page "Name"` creates a sibling `.md`.
- Side peek: a tab opens as a 45% overlay panel on the right.

Out (v2):

- AI / Suggest edits / Move-to modal / open in new window (electron `BrowserWindow`).
- Color background (text only in v1).
- Per-block metadata beyond color (id is enough; lastEdited is implicit from `updatedAt`).
