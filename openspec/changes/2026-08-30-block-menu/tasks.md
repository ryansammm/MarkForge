# Tasks: add-block-menu

## 1. Block id model

- [ ] 1.1 `lib/blocks.ts`: paragraph splitter (split on blank lines,
      preserve indentation of list items).
- [ ] 1.2 `lib/blocks.ts`: `newBlockId()` (base36 of 8 random bytes).
- [ ] 1.3 `lib/blocks.ts`: `parseBlockMeta(comment)` and
      `formatBlockMeta({ id, color, bg })` returning the comment
      string. Keys: `color`, `bg`.
- [ ] 1.4 `lib/blocks.ts`: `splitBlock(paragraph)` and
      `joinBlocks(blocks)` helpers used by the editor and the menu.
- [ ] 1.5 `lib/blocks.ts`: `ensureBlockHasId(paragraph)` — assigns a
      fresh id only if the paragraph is going to be transformed by a
      menu action that needs one.
- [ ] 1.6 `lib/blocks.ts`: `wordCount(paragraph)` — counts words
      (skipping markdown markers, code fences, and link syntax).

## 2. Reading view strip

- [ ] 2.1 `lib/markdown/strip-block-comments.ts` (or extend the
      existing serializer): regex removes `<!-- mkf:b:... -->` and
      any trailing blank line introduced by it.
- [ ] 2.2 `components/workspace/doc-viewer.tsx`: pass the body
      through the stripper before `linkifyWikilinks`.
- [ ] 2.3 Smoke: open a document, edit it to add a comment manually,
      save, switch to view mode, confirm the comment is not visible.

## 3. Drag handle (gutter widget)

- [ ] 3.1 `components/workspace/block-handle.ts`: CodeMirror
      `ViewPlugin` that returns one `WidgetType` per visible
      paragraph, rendered in the gutter (or as a line decoration on
      the first line).
- [ ] 3.2 Hover show/hide: widget opacity 0/1 with 100 ms debounce
      on `mousemove` over the editor DOM.
- [ ] 3.3 Click → opens `BlockMenu` anchored to the widget.
- [ ] 3.4 `markdown-editor.tsx`: register `blockHandle()` in the
      extension list, only when in edit mode.

## 4. Block menu

- [ ] 4.1 `components/workspace/block-menu.tsx`: Radix
      `DropdownMenu` with search input, type label, action list.
- [ ] 4.2 Turn into submenu: Text, H1-H4, Bulleted, Numbered, To-do,
      Quote, Code. Apply via `transformBlock` (see 4.6).
- [ ] 4.3 Color submenu: Default, Gray, Brown, Orange, Yellow, Green,
      Blue, Purple, Pink, Red. Apply by rewriting the `<!-- mkf:b:
      ... -->` comment's `color:` key.
- [ ] 4.4 Duplicate, Delete, Copy link to block items.
- [ ] 4.5 Keyboard nav: arrow keys, Enter, Esc, focus trap. Verify
      with the existing radix test or a manual smoke.
- [ ] 4.6 `lib/blocks-transforms.ts`: `turnInto`, `duplicate`,
      `delete`, `setColor`, `copyLink` pure functions over the
      paragraph range; used by both the menu and the editor
      keymap.
- [ ] 4.7 Anchor positioning: open below the handle, fall back to
      the right of the handle on narrow viewports.

## 5. Keyboard shortcuts

- [ ] 5.1 `Ctrl+D` → `duplicate` on cursor paragraph.
- [ ] 5.2 `Del` with non-empty selection → `delete` on the range.
- [ ] 5.3 `Alt+Shift+L` → `copyLink` (toast on success).
- [ ] 5.4 `Ctrl+Enter` → insert blank line below cursor, move
      cursor to the new paragraph, assign fresh id.
- [ ] 5.5 Verify none of these collide with `defaultKeymap` or
      `closeBracketsKeymap`.

## 6. Drag-and-drop reorder

- [ ] 6.1 `block-handle.ts`: the widget is `draggable="true"`. On
      `dragstart`, store the dragged paragraph range.
- [ ] 6.2 `markdown-editor.tsx`: a `dom` event handlers for
      `dragover` and `drop` translate the cursor coordinates to a
      document position and dispatch a single transaction that
      moves the range.
- [ ] 6.3 Drop indicator: a `Decoration.line` with a CSS class
      between paragraphs during drag.
- [ ] 6.4 Esc during drag cancels the drop.

## 7. Slash command `/page`

- [ ] 7.1 `components/workspace/slash-commands.ts`: add the `/page`
      command. Accepts `"Name"` inline; the inline form opens a
      small prompt on Enter if the name is missing.
- [ ] 7.2 On confirm, call `createDocument(parentDir, "Name")` via
      `lib/workspace-api.ts:77` (sibling of the current document).
- [ ] 7.3 Update parent frontmatter: add the new path to
      `subpages: [...]` and write the parent with `If-Match` from
      its current etag. Refresh local index.
- [ ] 7.4 New file gets frontmatter `parent: "<parent-path>"`.
- [ ] 7.5 Open the new page as a regular tab (not side peek).

## 8. Side peek

- [ ] 8.1 `lib/tabs.ts`: add `sidePeek?: boolean` to the tab state.
- [ ] 8.2 `components/workspace/side-peek.tsx`: 45% width overlay
      panel; renders the same `DocViewer` and `MarkdownEditor` for
      the peeked path.
- [ ] 8.3 `workspace-app.tsx`: render the peek alongside the active
      tab; only one peek at a time (replacing the previous one).
- [ ] 8.4 Close (X) and Esc both close the peek. Underlying tab
      remains active.
- [ ] 8.5 Trigger: a "Open in side peek" item in the tab context
      menu (and an optional `Ctrl+Alt+P` shortcut).

## 9. Verification

- [ ] 9.1 Lint (`pnpm lint`).
- [ ] 9.2 Typecheck (`pnpm typecheck`).
- [ ] 9.3 Encoding (`pnpm check:encoding`).
- [ ] 9.4 Manual smoke on `MarkForge-Offline.bat`:
      - Open a file, hover, see handle, click, menu opens.
      - Turn into H1 — first line rewrites.
      - Color Red — file gains `color:red` in the comment.
      - Duplicate — paragraph appears below, cursor at end.
      - Delete — paragraph gone, cursor lands below.
      - Copy link to block — clipboard has the URL, toast shown.
      - Drag handle between two blocks — drop indicator, reorder
        applies.
      - `/page "Sub"` — new sibling file appears, parent frontmatter
        updated, new tab opens.
      - Open tab in side peek — panel slides in from right; close
        (X) and Esc both close.

## 10. Wrap-up

- [ ] 10.1 One atomic commit per task group (1-8).
- [ ] 10.2 Push to `dev`.
- [ ] 10.3 Archive change (`openspec archive 2026-08-30-block-menu`).
