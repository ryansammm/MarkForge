## Why

The block-menu spec (archived `2026-08-30-block-menu`) shipped the
paragraph model, drag handle, and 6-dot menu, but the day-to-day
editing flow was rough around the edges. Three concrete batches
shipped on top of it:

- §19 — 9 UX fixes the menu exposed but the editor did not honour
  (new-page modal routing, frontmatter-region keymaps, Enter vs
  Shift+Enter, 6-dot block-handle hit area, AI fence chip, the
  `requireRange` null guard, "Turn into page", the page-ref chip,
  list-marker persistence).
- §20 — the data-model grew: `BlockKind` is a shared exported
  type, `divider` is a real kind, and toggle-heading 1-4 sit in
  the kind union (no widget yet; the data model is in place so
  future widgets can layer on).
- §21 — read-mode tables render Notion-y (header bg, cell padding,
  row borders) and the table markdown survives the
  `stripBlockComments` pass. Columns are explicitly out of the
  markdown model and stay deferred.

The changes are additive: the markdown on disk is still
the source of truth, the `<!-- mkf:b:<id> ... -->` comment scheme
is the only metadata channel, and the editor keeps CodeMirror.

## What Changes

- `lib/blocks.ts` — `BlockKind` exported; `BlockMeta.type` widened
  to `toggle_list | toggle_h1 | toggle_h2 | toggle_h3 | toggle_h4`.
  `PREFIX_BY_TYPE`, `parseKeys`, `detectBlockType` (recognises
  `/^---+$/` as `divider`) updated.
- `lib/blocks-transforms.ts` — `blockTypeLabel(state)` consults
  `meta.type` for toggle disambiguation; `turnInto` handles
  `toggle_h1..4` (sets `meta.type`, keeps prefix, no line reshape)
  and `divider` (drops body for text→divider, emits empty body
  for divider→text).
- `components/workspace/block-menu.tsx` — `BlockKind` imported
  via `import('@/lib/blocks').BlockKind`; `TURN_INTO` adds
  divider + 4 toggle-h entries.
- `components/workspace/toggle-list-edit.ts` — `▼`/`▶` widget;
  click flips `meta.open` flag.
- `components/workspace/workspace-app.tsx` — `Mod-N` reads
  `openNewDocumentRef.current('')`; ref mirrored via `useEffect`
  from `openNewDocument` to avoid stale closure.
- `app/globals.css` — read-mode table CSS (Notion-y borders,
  padding, header bg).
- `scripts/check-new-block-types.ts` — extended with divider (4)
  + toggle_h2 (5) assertions; 20 total.
- `scripts/check-table.ts` — new self-check; GFM pipe-table parses
  and survives `stripBlockComments` + cell text round-trip.
- `scripts/check-sidebar-plus.ts` — drive-by fix: 2 regex
  assertions updated for `openNewDocumentRef.current` (was
  `createDocumentAtRef.current`).

## Risks

- **Toggle list widget is decorative only.** The `meta.open` flag
  flips in the editor but the read view does not consult it, so
  collapsed state is lost on read. The data model is in place;
  the widget is a follow-up. **Acceptable** because the spec for
  this change does not require persistence; users can collapse
  in the editor and re-collapse on next edit.
- **Columns deliberately deferred.** Notion columns live outside
  the markdown model — implementing them well would require a
  structural change (block-tree data source, not markdown).
  Out of scope for this change; covered by the rewrite effort
  estimate saved in memory.
- **Drive-by: `check-sidebar-plus.ts`** references
  `openNewDocumentRef` instead of the old `createDocumentAtRef`
  (renamed in §19). The test now matches the editor.
