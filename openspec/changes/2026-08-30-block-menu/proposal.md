## Why

MarkForge is a markdown editor with the buffer-is-the-file model. Users
who think in paragraphs (Notion-style) currently get no per-paragraph
affordances — every menu action is whole-file. The change introduces a
paragraph-level editing layer that lives on top of the existing file
format: each paragraph gets a stable id encoded as a hidden HTML
comment, the editor reveals a drag handle, and a context menu performs
block-scoped transforms.

## What Changes

- Block model: paragraph-based, id as `<!-- mkf:b:<short> -->`
  comment at paragraph end.
- Drag handle: hover-revealed 6-dot widget in the left gutter, vertical
  to the first line of the block.
- Block menu: search input, type label, action list, submenus, keyboard
  navigation, focus trap.
- Menu actions: Turn into, Color (text + background), Duplicate, Delete,
  Copy link to block, Move to, Open in (new tab / new window / full
  page / side peek).
- Menu footer: "Last edited · <MMM D, YYYY, h:mm AM/PM>" and
  "Word count: <n> words".
- Drag-and-drop paragraph reorder through the handle.
- `Ctrl+Enter` inserts a blank line below cursor (escape paragraph).
- Slash command `/page "Name"` creates a sibling `.md` and links parent
  in frontmatter.
- Side peek: any tab can be opened as a 45% right-side overlay panel.
- AI / Suggest edits are out of scope (cancelled).
- Reading view strips `mkf:b:` comments; round-trip is preserved (no
  re-write of the file on save unless an action requires it).

## Capabilities

### New Capabilities
- `block-menu`: paragraph-scoped editing affordances (handle, menu,
  drag-reorder, submenus, keyboard nav, focus trap).
- `block-id-model`: stable paragraph ids stored as hidden HTML
  comments; the renderer strips them; editors and the menu read/write
  them.
- `side-peek`: a tab opened in a 45% right-side overlay panel with
  close (X) and Esc.
- `page-slash-command`: `/page "Name"` creates a sibling `.md` and
  links parent via frontmatter `subpages:` and child `parent:`.

### Modified Capabilities
None.

## Impact

New code:
- `lib/blocks.ts` — id generation, paragraph boundary detection,
  insert/remove/parse of `<!-- mkf:b:... -->` comments.
- `lib/blocks-color.ts` — apply/strip `color:` key inside the comment.
- `components/workspace/block-handle.ts` — CodeMirror gutter widget
  showing the 6-dot handle on hover, drag source for reorder.
- `components/workspace/block-menu.tsx` — menu UI (search, submenus,
  keyboard nav, focus trap) using Radix `DropdownMenu` (already in
  the project, see `components/ui`).
- `components/workspace/side-peek.tsx` — 45% overlay panel and
  close button.
- `components/workspace/slash-page.ts` — extend
  `components/workspace/slash-commands.ts` with the `/page` command.

Edited:
- `components/workspace/markdown-editor.tsx` — register the block
  handle extension, the menu hotkeys, `Ctrl+Enter` keymap, and the
  drag-and-drop reorder extension.
- `components/workspace/doc-viewer.tsx` — strip `mkf:b:` comments
  before passing the body to `ReactMarkdown`.
- `lib/tabs.ts` — add `sidePeek?: boolean` to the tab state.
- `components/workspace/workspace-app.tsx` — render the side-peek
  panel alongside the active tab; render the block menu trigger.
- `lib/build-document.ts` — read `color:` and other meta from the
  paragraph comments into `MarkdownDocument.frontmatter` is NOT done
  (those are block-level, not file-level). Block color is read live
  by the renderer and the menu.
- `lib/server/workspace-store.ts` — write `subpages:` and `parent:`
  into frontmatter on `/page` create; no schema change.
- `electron/preload.cjs` and `electron/main.cjs` — no changes (open
  in new window is v2).

Out-of-scope confirmation: AI and Suggest edits are cancelled.
