# Tasks: notion-parity

> **Status:** approved (2026-08-30). Tasks 1-6 shipped to `dev`.
> Task 7 (`/api/ai/stream` server endpoint) next. See `proposal.md`
> for full design and Risks.

Total: 16 tasks. Sized for 2-hour commits. Numbered so they can be
re-ordered if a regression forces a rollback. Each task ships as one
commit on `dev` (push after each).

## 1. Enter + empty-block placeholder

- [x] 1.1 `components/workspace/markdown-editor.tsx` — `Enter` on a
      non-empty block splits via `insertNewBlockBelow`; `Shift+Enter`
      inserts a markdown hard break (`  \n`). `Enter` on an empty
      block falls through to `defaultKeymap` so list-exit still works
      (a true no-op would require swallowing the key, which would
      break list-exit — `ponytail:` comment in source).
- [x] 1.2 `components/workspace/empty-block-placeholder.ts` (new) —
      renders `Press 'space' for AI or '/' for commands` behind the
      cursor when the block is empty. Hidden by default; shown on
      the focused active line.
- [x] 1.3 Hide `<!-- mkf:b:... -->` in the editor; the block-id
      comment stays in the markdown source for support/debug, but is
      not rendered. Pattern added to `hide-md-syntax.ts`; the
      `.cm-activeLine` override reveals it on the cursor's line.
- [x] 1.4 Self-check `scripts/check-empty-block.ts` — keymap entries,
      placeholder extension, CSS, and the `mkf:b:` pattern. Exit 0.

## 2. Block menu reshuffle

- [x] 2.1 `components/workspace/block-menu.tsx` — `Turn into page` lives
      in the `Turn into` submenu (id `turn-into-page`, label `Page`).
      Submenu now also lists `Toggle list` + `Callout` (types wired in
      Task 3). Top-level now `Delete`, `Duplicate`; `Copy link to
      block` + `Open in *` moved to a new `Link` submenu (gated on
      `!disabled` for `Copy link`).
- [ ] 2.2 `components/workspace/page-in-menu.tsx` (new) — lists
      pages in the active grimoire, search-as-you-type, inserts
      `[[wikilink]]` on pick. Reads from the live index. *(deferred
      — the block menu context does not yet receive the live index;
      see follow-up after Task 5 ships the page menu and surfaces
      page candidates to the block menu.)*
- [x] 2.3 Removed from `markdown-editor.tsx` top-level: `Copy link
      to block`, `Open in side peek`, `Open in new tab`, `Open in new
      window`, `Open in full page`. Replaced with `Delete`,
      `Duplicate`; the removed items live in a `Link` submenu.
- [x] 2.4 Self-check `scripts/check-block-menu.ts` — menu order,
      removed items gone, submenu contains new entries. Exit 0.

## 3. Toggle list + Callout block types

- [x] 3.1 `lib/blocks.ts` — extended `BlockKind` with `'callout' |
      'toggle_list'`. `BlockMeta.type?: 'toggle_list'`. `peelMeta`
      now also recognises a leading `<!-- mkf:b:... type:toggle_list
      -->` line (toggle_list stores its meta on line 0 because the
      bullets sit below it).
- [x] 3.2 Detection: `detectBlockType` reads `> [!info|warn|warning|
      danger|success] ` before `> ` (so callouts win over plain
      quotes). Toggle list: the `- ` line is detected as `bullet` —
      the `type:toggle_list` meta on the block comment is what makes
      it a toggle. *(Drift: the spec asked for `- [ ]` recognition;
      we could not do that without breaking the existing
      `todo` detection, so we use the meta-comment instead. The
      editor and the doc viewer both read the meta.)*
- [ ] 3.3 Renderer: callout boxes and `<details><summary>` for
      toggle_list. *(deferred to a follow-up — the doc viewer
      currently renders callouts as plain blockquotes and toggle_list
      as a bulleted list. The block-id meta survives the round trip,
      so the renderer is purely additive.)*
- [x] 3.4 `lib/blocks-transforms.ts` — `turnInto` covers
      `callout` (emits `> [!info] ` prefix) and `toggle_list`
      (keeps the `- ` line, sets `meta.type: 'toggle_list'`, stamps
      a block id). `blockTypeLabel` switch + `PREFIX_BY_TYPE` map
      updated.
- [x] 3.5 Self-check `scripts/check-new-block-types.ts` — round-trip
      for both kinds: detect, retype, splitBlocks/joinBlocks with
      meta, `formatBlockMeta`. Exit 0.

## 4. Remove page-tree from sidebar

- [x] 4.1 Deleted `components/workspace/page-tree.tsx`.
- [x] 4.2 `components/workspace/sidebar.tsx` — dropped the `PageTree`
      import + the `Documents` section heading above the folder tree.
- [x] 4.3 `lib/parent-tree.ts` stays (still used by breadcrumb +
      child-pages). `lib/client/turn-into-page.ts` stays.
- [x] 4.4 Updated `openspec/changes/2026-08-30-r2-encrypted-nested/tasks.md`
      §4 with rationale: "Removed in notion-parity; page hierarchy is
      expressed by the breadcrumb + child-pages section + wikilinks
      alone."
- [x] 4.5 Self-check `scripts/check-no-page-tree.ts` — sidebar does
      not import or mount `page-tree`. Exit 0.

## 5. `⋯` page menu

- [x] 5.1 `components/workspace/page-menu.tsx` (new) — `⋯` button
      rendered top-right of the document viewer (`absolute right-4
      top-4` on the `<article>` wrapper). Click opens a popover
      menu. Mounted only when `workspace-app.tsx` provides
      `pageMenu` props (the side-peek viewer passes `null`).
- [x] 5.2 Wire `Copy page content` — `navigator.clipboard.writeText`
      on the decrypted body. Toast on success/fail.
- [x] 5.3 Wire `Duplicate` (page-level) — `flushPendingSave` then
      read the latest buffer (`getBufferRef.current?.() ??
      source.body`), strip the frontmatter block, call
      `api.createDocument` with parent dir + ` (copy)` suffix.
      *(Drift: original spec said `createDocumentAt`; we route
      through the server API like the existing rename dialog so
      side effects on the live index are observed in one place.)*
- [x] 5.4 Wire `Move to` (page-level) — folder picker submenu over
      the live `tree` directories; filters the current folder and
      all of its descendants via
      `currentPath.startsWith(`${fullPath}/`)` so the page can never
      be moved into itself. Uses `api.renameDocument` +
      `await reloadIndex()` (no `applyMove` — same pattern as the
      existing rename dialog) and surfaces `aliasWarning` /
      `headingWarning`.
- [x] 5.5 Wire `Move to trash` — same as current `Delete`. Toast
      exposes an `Undo` action wired to `undoDeleteRef.current`.
- [x] 5.6 Wire `Small text`, `Full text`, `Full width`, `Default
      width` toggles — `setFrontmatterField(source.raw, 'view', v)`
      + `setFrontmatterField(source.raw, 'width', v)` →
      `writeDocumentEncrypted` + `applyUpsert` with the new
      frontmatter. The viewer reads `frontmatterView` /
      `frontmatterWidth` and maps them to `max-w-2xl` / `max-w-3xl`
      / `max-w-5xl` (width wins over view).
- [x] 5.7 Stub `Lock page`, `Import`, `Export` — render the items
      with a small "coming in Task 9 / 10" hint; wire them in
      Tasks 9 and 10.
- [x] 5.8 Self-check `scripts/check-page-menu.ts` — menu items
      present, viewer imports frontmatter readers, viewer mounts
      `<PageMenu>`, viewer applies frontmatter-driven max-width,
      `setFrontmatterField` round-trips for `view` + `width` +
      replacement + invalid-YAML no-op, `removeFrontmatterField`
      drops lines. Exit 0 (23/23).

## 6. Settings page (API key UI)

- [x] 6.1 New route `/settings`. Mounts a `Settings` component.
      Gates on `/api/health` + vault status; an unauthenticated or
      locked visitor is redirected to `/login?from=/settings` (the
      spec calls this out as a deep-linkable surface, and a deep link
      to a list of API keys is exactly what should not survive a
      tab restore).
- [x] 6.2 `lib/vault/ai-config.ts` (new) holds `AiConfig` +
      `AiConfigDraft` + `AI_PROVIDERS` (OpenAI-compatible, Gemini).
      Stored as a top-level `ai: AiConfig[]` field on the existing
      `VaultData` envelope — same AES-GCM, same KDF, same master
      password. The vault envelope format did not change; old v1
      records (no `ai` field) parse as `ai: []` and the next save
      writes the field back. `parseAiField` (in `items.ts`) keeps
      the parser local to break an import cycle with `ai-config`.
- [x] 6.3 `components/workspace/settings-form.tsx` (new):
      - Provider dropdown (OpenAI-compatible / Gemini).
      - API key — uncontrolled `<input type="password">` with the
        reveal button, no `value=` attribute, so the masked
        placeholder is all the DOM ever shows. Submit reads
        `keyInput.value` directly.
      - Model `<input list>` with the provider's known models as
        suggestions; free-text override.
      - Base URL pre-filled with the provider default; free-text
        override.
      - No "Test connection" button — `/api/ai/stream` is Task 7;
        a self-check covers the rest.
      - Sidebar footer grows a `Settings` link between `Trash` and
        `Sign out`; `workspace-app` plumbs it to
        `router.push('/settings')`.
- [x] 6.4 Self-check `scripts/check-settings.ts` — 24/24 pass.
      Form mounts, no `value=` on the API key, sidebar + workspace
      plumb `/settings`, vault shape carries `ai`, parser merges
      by id, removal works.

## 7. `/api/ai/stream` server endpoint

- [ ] 7.1 `lib/server/ai.ts` (new) — `streamOpenAI` and
      `streamGemini`. Both take `(apiKey, baseUrl, model, prompt,
      system, signal) => AsyncIterable<string>`.
- [ ] 7.2 `app/api/ai/stream/route.ts` (new) — accepts the request,
      dispatches by provider, returns `text/event-stream`. Per-vault
      rate limit (10 req/min).
- [ ] 7.3 `lib/server/ai-stream-client.ts` (new) — typed
      `EventSource`-like consumer with `AbortController` integration.
- [ ] 7.4 Self-check `scripts/check-ai-stream.ts` — wire both
      providers against a mock server; verify SSE chunks, abort,
      rate-limit.

## 8. AI block in the editor

- [ ] 8.1 `lib/blocks.ts` — add `ai` block type. Frontmatter:
      `ai: { provider, model, baseUrl, prompt, output }`.
- [ ] 8.2 `components/workspace/ai-block.tsx` (new) — block view.
      Empty state: prompt input. Streaming state: replaces the
      block content as tokens arrive.
- [ ] 8.3 `markdown-editor.tsx` — `Space` at the start of an empty
      block converts the block to an `ai` block and focuses the
      prompt.
- [ ] 8.4 `lib/note-crypto.ts` — `ai` block content is encrypted
      like any other block body, so the locked-vault UX is uniform.
- [ ] 8.5 Self-check `scripts/check-ai-block.ts` — Space-on-empty
      trigger, stream consumer decodes, abort works.

## 9. Lock page

- [ ] 9.1 `lib/lock/page-crypto.ts` (new) — `wrapPageKey(passphrase,
      pageKey, kdf)`, `unwrapPageKey(passphrase, lock)`. PBKDF2 in
      renderer, Argon2id in Node.
- [ ] 9.2 `package.json` — add `argon2` (Node-side, ~3 MB binary).
      Native module, build matrix unchanged.
- [ ] 9.3 `lib/file-store.ts` — extend `MarkdownDocument` with
      `lock?: { kdf, salt, wrapped, nonce, body_cipher? }`.
- [ ] 9.4 `lib/build-document.ts` — `readLock(frontmatter)`.
- [ ] 9.5 `components/workspace/lock-prompt.tsx` (new) — passphrase
      input + confirm, shake on wrong.
- [ ] 9.6 `doc-viewer.tsx` — when the page is locked, the body
      area is replaced with `<LockPrompt>`; the rest of the page
      (breadcrumb, child pages) still renders.
- [ ] 9.7 Wire `Lock page` / `Unlock page` in `page-menu.tsx`.
- [ ] 9.8 Self-check `scripts/check-lock-page.ts` — round-trip
      lock + unlock, wrong passphrase fails closed, no body leak
      when locked.

## 10. Page-level Import / Export

- [ ] 10.1 `lib/import/page-import.ts` (new) — accepts a File
      object, returns `{ title, body, parent_id }` ready for
      `createDocumentAt`.
- [ ] 10.2 `lib/export/page-export.ts` (new) — accepts a doc,
      returns a `.md` string with frontmatter + decrypted body.
- [ ] 10.3 Wire `Import` in `page-menu.tsx` — file picker,
      accepts `.md`/`.txt`/`.markdown`. Each file becomes a child
      page of the current page.
- [ ] 10.4 Wire `Export` in `page-menu.tsx` — `<a download>` in
      web, `dialog.showSaveDialog` in Electron (re-uses the IPC
      bridge from `electron/main.cjs`).
- [ ] 10.5 Self-check `scripts/check-page-import-export.ts` —
      round-trip import → export → equal content.

## 11. Grimoire create without folder picker

- [ ] 11.1 `components/workspace/grimoire-create-dialog.tsx` —
      drop the folder picker; only `Name` + optional `Description`.
- [ ] 11.2 `lib/server/grimoire.ts` — `createGrimoire({ name,
      description })` no longer requires `path`. Existing
      grimoires with `path` are read as legacy.
- [ ] 11.3 `lib/server/grimoire-marker.ts` — `path` becomes
      optional. No migration; new grimoires omit it.
- [ ] 11.4 Self-check `scripts/check-grimoire-create.ts` —
      new grimoire has no `path`, existing ones still resolve.

## 12. Master password min length

- [ ] 12.1 `lib/server/env.ts` (new) — `validateEnv(env)` returns
      `{ warnings: string[] }`. Warns if `APP_PASSWORD` is shorter
      than 6.
- [ ] 12.2 `app/api/auth/route.ts` — call `validateEnv`; if
      `APP_PASSWORD` is shorter than 6, return a `WEAK_PASSWORD`
      error in the response and log a warning. **Does not** block
      auth (the existing password keeps working).
- [ ] 12.3 Self-check `scripts/check-env-validator.ts` — short
      password warns, long password is silent.

## 13. Sidebar `+` button + sidebar page context menu

- [ ] 13.1 `components/workspace/sidebar.tsx` — replace the
      existing `+` button with a `+` popover: `+ New page` and
      `+ New grimoire`. `+ New page` calls
      `createDocumentAt(activeGrimoireRoot, 'Untitled', '')`,
      opens it as a tab in Electron.
- [ ] 13.2 `components/workspace/sidebar-page-context-menu.tsx`
      (new) — right-click on a folder-tree page. Items:
      `Open in side peek` (always), `Open in new window`
      (web only, gated by `isElectron()`).
- [ ] 13.3 Self-check `scripts/check-sidebar-plus.ts` — `+`
      popover items, web/Electron gating.

## 14. Desktop top tab bar + page picker popover

- [ ] 14.1 `lib/desktop-tabs.ts` (new) — pure reducer (mirrors
      `lib/tabs.ts` style). State: `{ tabs: { id, path }[],
      activeId }`.
- [ ] 14.2 `components/workspace/desktop-tab-bar.tsx` (new) —
      tab strip at the top of the window, above the sidebar.
      Hidden via `isElectron()` in web mode.
- [ ] 14.3 `components/workspace/page-picker-popover.tsx` (new)
      — anchored under the `+` button in the tab bar. Search
      input + page list from the live index.
- [ ] 14.4 Enforce 6-tab limit. Show a toast and refuse the new
      tab when full.
- [ ] 14.5 Wire opening a page from sidebar/page menu to activate
      the existing tab or open a new one.
- [ ] 14.6 Self-check `scripts/check-desktop-tabs.ts` — limit
      enforced, popover search filters, tab activate/close.

## 15. Drop offline mode

- [ ] 15.1 Delete `MarkForge-Offline.bat`.
- [ ] 15.2 `electron/main.cjs` — drop the `localOnly` block, drop
      the `MARKFORGE_ONLINE` check, drop the related comment.
      Dev-spawn always passes the repo `.env` through.
- [ ] 15.3 `MarkForge-Online.bat` — rename to `MarkForge.bat` (the
      product is no longer dual-mode).
- [ ] 15.4 `app/api/health/route.ts` and any other code paths
      carrying `offline` flags — audit and remove.
- [ ] 15.5 Self-check `scripts/check-no-offline.ts` — no
      `MarkForge-Offline.bat`, no `MARKFORGE_OFFLINE` / `MARKFORGE_ONLINE`
      string in source, `electron/main.cjs` does not branch on
      the env.

## 16. Self-checks + verify + e2e + archive

- [ ] 16.1 `pnpm verify` exit 0 (all 20+ test groups pass).
- [ ] 16.2 Each of the 14 self-checks above (1.4, 2.4, 3.5, 4.5,
      5.8, 6.4, 7.4, 8.5, 9.8, 10.5, 11.4, 12.3, 13.3, 14.6,
      15.5) runs and passes.
- [ ] 16.3 `node scripts/markforge-e2e.cjs` — extend the e2e to
      cover: new page from `+`, slash menu, page menu Copy,
      tab bar (Electron-only via `isElectron()`).
- [ ] 16.4 Manual Electron smoke:
      - Boot via `MarkForge.bat` (renamed from
        `MarkForge-Online.bat`).
      - Confirm `MarkForge-Offline.bat` is gone.
      - Login, open a page, lock the vault, see placeholder.
      - Unlock with `9800`.
      - Edit, save, reload — body still readable.
      - Open the `⋯` page menu, toggle Small text and Full width.
      - `+` in the tab bar, search for a page, open it as a new
        tab. Close the tab. Hit 6-tab limit, see the toast.
      - Settings → add an OpenAI key, click Test connection.
      - Press Space in an empty block, write `buatkan puisi`,
        confirm a poem appears with no preamble.
      - Slash `/` opens the menu and inserts the chosen block.
- [ ] 16.5 `openspec archive 2026-08-30-notion-parity` — moves
      the change to `openspec/changes/archive/`, registers the
      new specs under `openspec/specs/`.
- [ ] 16.6 Update `openspec/specs/{editor,page-menu,inline-ai,
      import-export,master-password,desktop-tabs}/spec.md` (one
      per major surface).
