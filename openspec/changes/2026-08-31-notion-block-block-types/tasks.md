# Tasks: notion-block-block-types

> **Status:** approved (2026-08-31). Tasks §19-§21 shipped to `dev`
> (§19 `99932ac`, §20 `e211a86`, §21 `77074f8`).
> §22 is the wrap-up: archive, sync specs, no new code unless a
> regression forces one. See `proposal.md` for full design.

Total: 4 tasks. Sized for single commits. Numbered so they can be
re-ordered. Each task ships as one commit on `dev` (push after each).

## 19. Block UX fixes (1 commit, 9 fixes)

- [x] 19.1 New page modal routing:
      `workspace-app.tsx` `onCreatePageDirect` and `Mod-N` keymap
      both route through `openNewDocument('')` (no path arg). The
      old `createDocumentAtRef` was renamed to `openNewDocumentRef`
      and declared early (~line 170); a `useEffect` mirrors the ref
      from the `useCallback` so the keydown handler can reference
      it before declaration. (Spec drift: key was wired before,
      but routed through the wrong callback.)
- [x] 19.2 Frontmatter region guard: `Enter` inside a frontmatter
      block stays a no-op; `defaultKeymap` handles it (per
      existing `ponytail:` comment). Verified by
      `check-empty-block.ts` (4 assertions).
- [x] 19.3 `Enter` / `Shift+Enter` distinction:
      `markdown-editor.tsx` `Enter` on a non-empty block splits
      via `insertNewBlockBelow`; `Shift+Enter` inserts a markdown
      hard break (`  \n`).
- [x] 19.4 6-dot block-handle hit area: `block-handle.ts`
      widened to a 24×24 button so the click target matches the
      visible glyph. Hover/active states preserved.
- [x] 19.5 AI fence chip: ` ```ai ` is recognised by the
      slash-menu; `codeBlockFromNode` routes the node to
      `<AiBlock>` when `language === 'ai'`.
- [x] 19.6 `requireRange` null guard: `editor-commands.ts` no
      longer crashes when the active selection is collapsed;
      falls back to a no-op (or single-cursor).
- [x] 19.7 `Turn into Page`: `blockTypeLabel` + `turnInto` know
      about `page`; `lib/client/turn-into-page.ts` emits the
      sub-document.
- [x] 19.8 Page-ref chip: `[[Page Title]]` (wikilink) renders as
      a chip in the editor and links in the viewer.
- [x] 19.9 List-marker persistence: empty bullet / numbered lines
      keep their marker across renders (was losing `- ` on empty
      lines in some CodeMirror states). Toggle list widget
      (`toggle-list-edit.ts`) is **decorative only** — click
      flips a `meta.open` flag in the editor; the read view does
      not consult it. Acceptable per spec.

## 20. Block types batch (1 commit)

- [x] 20.1 `lib/blocks.ts` — `BlockKind` exported as a type from
      the source-of-truth module; `BlockMeta.type` widened to
      `toggle_list | toggle_h1 | toggle_h2 | toggle_h3 | toggle_h4`.
- [x] 20.2 `divider` is a real kind: `PREFIX_BY_TYPE.divider = '---'`;
      `detectBlockType` matches `/^---+$/`. `retypeBlock` drops
      the body when going text→divider and emits an empty body
      when going divider→text.
- [x] 20.3 `toggle_h1..4` menu entries + meta flag: `TURN_INTO`
      in `block-menu.tsx` exposes 4 new entries; `turnInto`
      sets `meta.type`, keeps the prefix, no line reshape.
- [x] 20.4 `lib/markdown/remark-toggle-list.ts` is a no-op
      pass-through, kept as a named seam for future work.
- [x] 20.5 `blockTypeLabel` consults `meta.type` for
      disambiguation so `bullet` lines with `meta.type:
      'toggle_list'` show as "Toggle list" not "Bulleted list".
- [x] 20.6 `scripts/check-new-block-types.ts` extended with
      divider (4 assertions) + toggle_h2 (5 assertions); 20
      assertions total. All green.

## 21. Columns + Table (1 commit)

- [x] 21.1 Read-mode table CSS (`app/globals.css`): `thead`
      border-b border-border, `th` px-3 py-2 font-semibold
      bg-muted/40, `td` px-3 py-2 align-top border-b
      border-border/60, `tr:last-child td` border-b-0.
- [x] 21.2 `scripts/check-table.ts` (new): GFM pipe-table
      parses, survives `stripBlockComments`, cell text
      round-trips. Uses inline `fileShim` to avoid pulling in
      `vfile` (not in `package.json`; `check:deps` would fail).
- [ ] 21.3 **Columns — deferred.** Notion columns live outside
      the markdown model. Implementing them well requires a
      structural change (block-tree data source, not markdown).
      The `::: columns` remark-plugin path is ~1 week and is the
      recommended next step if the user wants columns.

## 22. Wrap-up (1 commit)

- [x] 22.1 This archive: `openspec/changes/2026-08-31-notion-block-block-types/{proposal.md, tasks.md, .openspec.yaml, specs/block-types/spec.md}`.
- [x] 22.2 Sync `openspec/specs/block-menu/spec.md` and
      `openspec/specs/editor/spec.md` to reflect divider,
      toggle_h1-4, table read-mode styling, and the
      frontmatter-region + `openNewDocument` rename.
- [x] 22.3 Drive-by: `scripts/check-sidebar-plus.ts` updated
      to assert `openNewDocumentRef` (not `createDocumentAtRef`).
- [x] 22.4 `pnpm verify` exit 0; `pnpm run check:encoding` exit 0;
      26 self-checks all green.
- [x] 22.5 Memory updated.
