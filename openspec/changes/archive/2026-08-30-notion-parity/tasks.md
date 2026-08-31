# Tasks: notion-parity

> **Status:** approved (2026-08-30). Tasks 1-17 shipped to `dev`
> (commit `764ee51`). Task 18 (post-§17 fix batch + MarkForge rename)
> next. See `proposal.md` for full design and Risks.

Total: 18 tasks. Sized for 2-hour commits. Numbered so they can be
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

- [x] 7.1 `lib/server/ai.ts` (new) — `streamOpenAI` and
      `streamGemini`, both `(apiKey, baseUrl, model, prompt,
      system?, signal?) => AsyncGenerator<string, void, void>`.
      Generic `parseSse` reads a `text/event-stream` response and
      hands each `data:` line to a provider-specific `extract`
      (delta for OpenAI, candidates.parts.text for Gemini).
      `dispatchStream(provider, options)` picks the right one.
- [x] 7.2 `app/api/ai/stream/route.ts` (new) — POST body
      `{ provider, baseUrl, model, apiKey, prompt, system? }`,
      rate-limited per client (10/min via a new `AI_LIMIT` in
      `lib/server/rate-limit.ts`) and returns
      `text/event-stream`. Each event is `data: <token>` and
      `data: [DONE]`; failures become `event: error` +
      `data: { error }`. The upstream `fetch` is wired to
      `request.signal` so an aborted browser request cancels the
      provider call mid-stream. Middleware already gates the
      route; no in-route auth check.
- [x] 7.3 `lib/client/ai-stream-client.ts` (new) —
      `streamCompletion` is an `AsyncGenerator<string>` over
      `fetch` + `ReadableStream` (so we can set `Authorization`
      semantics and a body, which `EventSource` cannot).
      `complete(options)` collects the full text. Abort through
      `AbortController.signal`; 429 surfaces as
      `AiClientError` with the status.
- [x] 7.4 Self-check `scripts/check-ai-stream.ts` — 14/14 pass.
      Spins up three real HTTP listeners (OpenAI, Gemini, abort
      trap) on ephemeral ports and exercises the providers
      end-to-end: chunk counts, joined text, headers, system
      messages, abort, and 11-call rate limit with positive
      `Retry-After`.

## 8. AI block in the editor

- [x] 8.1 No schema change. The block is a ` ```ai ` fenced body
      with a small JSON header (`{"configId":"…"}`) on the opening
      fence, and the prompt and (after a run) the model output live
      inside the fence. Encryption rides on the existing note-crypto
      envelope: the fence is just markdown, so anything that already
      encrypts the document encrypts the AI block.
- [x] 8.2 `components/workspace/ai-block.tsx` (new) — block view.
      Header shows the provider + model, a prompt textarea, a Run /
      Stop button, and the streaming output as it arrives. Picks the
      active provider from the vault's `AiConfig` list; the first
      one is the default and the fence's `configId` overrides it.
- [x] 8.3 `markdown-editor.tsx` — `Space` at the start of an empty
      block converts the line into an ` ```ai ` fence and places the
      cursor inside the `configId` value. `slash-commands.ts` adds
      an `AI block` entry that does the same thing via the `/` menu.
- [x] 8.4 Encryption: automatic. No new code in `lib/note-crypto.ts`.
- [x] 8.5 Self-check `scripts/check-ai-block.ts` — fence parser
      (configId + body), header round-trip, and `codeBlockFromNode`
      integration (`language-ai` -> `AiBlock`, other languages
      still hit `CodeBlock`). 11/11 pass.

## 9. Lock page

- [x] 9.1 `lib/lock/page-lock.ts` (new) — `makeLock(passphrase)` /
      `verifyPassphrase(passphrase, lock)` / `isPageLock(value)`.
      PBKDF2-SHA256 100k via WebCrypto, base64url salt + hash.
      Drift from proposal: no `argon2` (Task 9 became a UI gate
      rather than an at-rest re-encryption), no body re-encryption
      either. The master note-crypto envelope still owns the file
      at rest; the lock only blocks writes from the editor.
- [x] 9.2 No `argon2` dependency. Skipped.
- [x] 9.3 No `MarkdownDocument.lock` field. The lock lives in
      `frontmatter.lock` (a small object) and is read via
      `frontmatterLock(frontmatter)`. The schema gained a
      `lock: { kdf, salt, iterations, hash }` entry. Frontmatter
      is the same store the page menu already uses.
- [x] 9.4 `lib/markdown/frontmatter.ts` — `frontmatterLock(frontmatter)`
      accessor + schema entry + a sibling `setFrontmatterObject`
      writer that serialises the lock as a flow-style YAML block.
- [x] 9.5 `components/workspace/lock-prompt.tsx` (new) —
      passphrase input + Unlock button. Wrong passphrase fires a
      one-shot CSS `lock-shake` keyframe (`globals.css`); the
      form clears the input and resets the animation on the next
      keystroke.
- [x] 9.6 `components/workspace/workspace-app.tsx` — gate the
      `MarkdownEditor` mount. When the active page carries a
      `lock:` and the path is not in the in-memory
      `unlockedPaths` set, the editor is replaced with
      `<LockPrompt>`. The DocViewer (read-only path) is
      unaffected — the lock is a write-time gate.
- [x] 9.7 `components/workspace/page-menu.tsx` — `Lock page` /
      `Unlock page` items now call into the workspace. The
      `isLocked` flag flips the label. `Lock page` reads the
      passphrase from `window.prompt()` (single popover kept).
- [x] 9.8 Self-check `scripts/check-page-lock.ts` — 29/29 pass.

## 10. Page-level Import / Export

- [x] 10.1 `lib/import/page-import.ts` (new) —
      `readMarkdownFile(file)` + `isImportableFile(file)`. Reads
      a `File`-shaped object as UTF-8, splits frontmatter, picks
      a title from `title: …`, the first `# H1`, or the filename
      (in that order). Body is the file's text with the
      frontmatter block removed.
- [x] 10.2 `lib/export/page-export.ts` (new) —
      `buildExportName(document)` + `downloadMarkdown(filename, content)`.
      The former turns a workspace path into a clean filename
      (drops folders, guarantees a `.md` extension). The latter
      triggers a browser download via a transient anchor + blob.
- [x] 10.3 Wire `Import` in `page-menu.tsx` + `workspace-app.tsx`.
      The page menu builds a hidden `<input type="file">` on the
      fly; the workspace handler calls `createDocumentAt` for
      each accepted file. Files become **siblings** of the
      active page in the same folder (drift: spec said "child
      page", but a sub-folder per import is more friction than
      help; the page tree can re-parent afterwards).
- [x] 10.4 Wire `Export`. The page menu's `Export` action calls
      `window.markforge.saveFile(...)` when running in Electron
      (native `dialog.showSaveDialog`) and `downloadMarkdown(...)`
      in the web build. The Electron bridge gained a new IPC
      channel (`markforge:save-file`) and a `saveFile` method on
      the `markforge` global. `DesktopBridge` in
      `components/workspace/sidebar.tsx` carries the typed
      surface.
- [x] 10.5 Self-check `scripts/check-page-import-export.ts` —
      23/23 pass.

## 11. Grimoire create without folder picker

- [x] 11.1 `components/workspace/grimoire-switcher.tsx` —
      `handleCreate` no longer calls `markforge.selectDirectory()`
      after `POST /api/grimoires`. A grimoire without a root
      folder is a normal state, not a stub. The settings sheet
      still lets the user pick one later.
      *Drift:* the spec mentioned an optional `Description`
      field on the create row. No `description` exists on the
      `Grimoire` type, the server endpoint, or any other
      surface, and the spec lists no other place that would
      store or display it. Skipped — Name only.
- [x] 11.2 `lib/server/grimoire.ts` — `createGrimoire` already
      takes `opts?: { path?: string }`; no change needed.
      Existing grimoires with `path` continue to flow through
      `addGrimoireToMarker` from `app/api/grimoires/route.ts`.
- [x] 11.3 `lib/server/grimoire-marker.ts` — `path` is already
      optional on `Grimoire`. No migration required; new
      grimoires simply omit it.
- [x] 11.4 Self-check `scripts/check-grimoire-create.ts` —
      new grimoire has no `path`; legacy entry with `path`
      round-trips; mixed registry (one with, one without)
      round-trips. 12/12.

## 12. Vault master min length + app PIN gate

Replaces the old "master password min length on `APP_PASSWORD`" task
in two halves: the vault master password gets a real floor, and the
app gate becomes a 6-digit PIN that the user can rotate from settings.

### 12a. Vault master password ≥ 8

- [x] 12a.1 `lib/vault/record.ts` — `MIN_VAULT_MASTER_LENGTH = 8`
      and `isValidVaultMaster(value)` export. Strict allowlist
      preserved; the constant lives next to the other KDF floors.
- [x] 12a.2 `lib/vault/crypto.ts` — `deriveKey` throws
      `VaultPasswordTooShortError` when the input is below the
      floor. `createEnvelope` and `openRecord` go through
      `deriveKey`, so the check covers all three entry points.
      The error is a distinct class from `VaultUnlockError` so
      the UI says "use a longer password", not "wrong password".
- [x] 12a.3 `components/workspace/passwords-dialog.tsx` —
      create form's length check drops from 12 to 8, matching the
      server. Wrong-but-valid-length passwords still surface as
      "could not open" via `VaultUnlockError`.
- [x] 12a.4 Self-check `scripts/check-vault-master-min.ts` —
      17/17.

### 12b. App gate becomes a 6-digit PIN

- [x] 12b.1 `lib/app-settings-shared.ts` (new) — client-safe
      `APP_PIN_LENGTH = 6`, `isValidAppPin`, placeholder constant.
      The server-only store at `lib/server/app-settings.ts`
      re-exports these so there is one source of truth.
- [x] 12b.2 `lib/server/app-settings.ts` (new) — `AppSettings`
      envelope (`version`, `appPin`, `updatedAt`) with a strict
      allowlist parser. `AppSettingsStore.setAppPin` writes to
      `app-settings.json` in the bucket. `resolveAppPin(env,
      stored)` honours the order **env > stored > default**
      (`123098`).
- [x] 12b.3 `lib/server/env.ts` (new) — `validateEnv(env)`
      returns `{ warnings, gated }`. Warns when `APP_PASSWORD` is
      still set (deprecation), when `APP_PIN` is not 6 digits,
      and when nothing gates the route. Never throws.
- [x] 12b.4 `lib/session.ts` — `sessionSecret(env)` now reads
      `APP_PIN` (with `SESSION_SECRET` still winning) and bumps
      the namespace to `markforge-session-v2:pin:<pin>`. Old
      `APP_PASSWORD`-derived cookies are no longer valid; this is
      the intended forced re-login.
- [x] 12b.5 `app/api/auth/route.ts` — `POST { pin }` instead of
      `{ password }`. Reads the resolved PIN via
      `resolveAppPin(...)`. `constantTimeEquals` is unchanged.
- [x] 12b.6 `app/api/settings/pin/route.ts` (new) — `GET` and
      `PUT /api/settings/pin`. Both routes verify the session
      cookie themselves because the auth-exempt list in
      middleware is a string-prefix test one edit away from being
      wrong.
- [x] 12b.7 `components/workspace/pin-keypad.tsx` (new) — six
      single-cell inputs in a row. Auto-advance on type,
      backspace moves left, paste of 6 digits fills the row and
      auto-submits. `inputMode="numeric"`, `type="password"`,
      `autoComplete="one-time-code"` on the first cell.
- [x] 12b.8 `app/login/page.tsx` — replaced the single password
      input with `PinKeypad`. Placeholder reads `123456` (visual
      hint, not the real default — see spec section 12b.9).
- [x] 12b.9 `app/pin/page.tsx` (new) — PIN rotation page.
      Verifies the current PIN against `/api/auth`, then PUTs the
      new one. The "rotating signs everyone out" warning is the
      page, not decoration. Auth-gated only (not vault-gated) so
      a user can rotate before the vault is unlocked.
- [x] 12b.10 `app/settings/page.tsx` — new "App PIN" card with a
      `Change PIN` button that links to `/pin`. The vault-gated
      AI settings live below.
- [x] 12b.11 `scripts/check-app-pin.ts` — 28/28. Covers
      `isValidAppPin`, `resolveAppPin` priority, the store
      round-trip, `validateEnv` warnings, and `sessionSecret`
      rotation.
- [x] 12b.12 Audit: `APP_PASSWORD` and `9800` removed from
      `.env`, `README.md`, scripts (`audit-parent-orphans.ts`,
      `markforge-e2e.cjs`, `visual-task1.py`), tests
      (`session.test.ts`, `share.test.ts`, `vault.test.ts`),
      `lib/workspace-api.ts`, `middleware.ts`, and the
      `deployment/spec.md`. `APP_PASSWORD` is intentionally still
      in `lib/server/env.ts` as a deprecation warning, and
      references in archived change documents are untouched
      (history).

## 13. Sidebar `+` button + sidebar page context menu

- [x] 13.1 `components/workspace/sidebar.tsx` — replace the
      existing `+` button with a `+` popover: `+ New page` and
      `+ New grimoire`. `+ New page` calls
      `createDocumentAt(activeGrimoireRoot, 'Untitled', '')`,
      opens it as a tab in Electron.
      *Drift:* the spec mentions `activeGrimoireRoot` as the
      `parentDir`; the workspace app already targets the active
      grimoire through `fileStore.setGrimoireId`, so the parent dir
      passed in is `''`. The per-folder `+ New file / + New folder`
      hover buttons stay (they keep the rename dialog), and the
      top-level `+` is now a popover (no "New folder" at the top
      level per spec). `+ New grimoire` is wired through a new
      `useImperativeHandle` on `GrimoireSwitcher`
      (`requestCreate()`) — first `forwardRef` in the codebase,
      no other path to trigger the existing create-grimoire input
      from outside the dropdown.
- [x] 13.2 `components/workspace/sidebar-page-context-menu.tsx`
      (new) — right-click on a folder-tree page. Items:
      `Open in side peek` (always), `Open in new window`
      (web only, gated by `isElectron()`).
      *Drift:* no `isElectron()` helper exists in the repo; the
      sidebar's existing `isDesktop` boolean (which reads
      `window.markforge`) is the closest. The "Open in new window"
      item is hidden when `isDesktop` is true; on the web it falls
      back to the tab reducer (no per-doc URL route).
- [x] 13.3 Self-check `scripts/check-sidebar-plus.ts` — `+`
      popover items, web/Electron gating. 33/33 pass.

## 14. Desktop top tab bar + page picker popover

- [x] 14.1 `lib/desktop-tabs.ts` (new) — pure reducer (mirrors
      `lib/tabs.ts` style). State: `{ tabs: { id, path }[],
      activeId }`.
- [x] 14.2 `components/workspace/desktop-tab-bar.tsx` (new) —
      tab strip at the top of the window, above the sidebar.
      Hidden via `isElectron()` in web mode.
      *Drift:* `isElectron()` does not exist as a helper in the
      repo; the bar reads `Boolean(window.markforge)` via
      `useSyncExternalStore` (same pattern as the sidebar).
- [x] 14.3 `components/workspace/page-picker-popover.tsx` (new)
      — anchored under the `+` button in the tab bar. Search
      input + page list from the live index.
- [x] 14.4 Enforce 6-tab limit. Show a toast and refuse the new
      tab when full. The `+` button is also `disabled` at the cap,
      not just toast-on-overflow.
- [x] 14.5 Wire opening a page from sidebar/page menu to activate
      the existing tab or open a new one. `navigateTo` mirrors
      `newTab: true` opens into the strip; a sync effect activates
      the matching tab when the in-app active path changes.
      *Drift:* in-place opens do not grow the strip — only
      `newTab: true` does. The first `activePath` seeds a single
      tab on mount (per spec: "Re-opening starts with the
      previously-active document as the single tab").
- [x] 14.6 Self-check `scripts/check-desktop-tabs.ts` — limit
      enforced, popover search filters, tab activate/close. 40/40
      pass.

## 15. Drop offline mode

- [x] 15.1 Delete `MarkForge-Offline.bat`.
- [x] 15.2 `electron/main.cjs` — drop the `localOnly` block, drop
      the `MARKFORGE_ONLINE` check, drop the related comment.
      Dev-spawn always passes the repo `.env` through.
- [x] 15.3 `MarkForge-Online.bat` — rename to `MarkForge.bat` (the
      product is no longer dual-mode).
- [x] 15.4 `app/api/health/route.ts` and any other code paths
      carrying `offline` flags — audit and remove.
      *Audit:* the only `offline` references left in active code are
      the *runtime* "browser is disconnected" kind
      (`save-indicator.tsx`, `use-document-save.ts`, `service-worker`
      tests) which are unrelated to the launcher mode being dropped.
      The stale comment in `workspace-app.tsx` ("drives the offline
      root-folder gate") and the "running offline server" headers in
      `markforge-e2e.cjs` / `markforge-smoke.cjs` were updated. The
      dead `storageKind === 'cloud'` branch in `sidebar.tsx` (the
      `Sync to cloud` button) is left in place — out of scope for
      Task 15 and a follow-up.
- [x] 15.5 Self-check `scripts/check-no-offline.ts` — no
      `MarkForge-Offline.bat`, no `MARKFORGE_OFFLINE` / `MARKFORGE_ONLINE`
      string in source, `electron/main.cjs` does not branch on
      the env. 12/12 pass.

## 16. Self-checks + verify + e2e + archive

- [x] 16.1 `pnpm verify` exit 0 (all 20+ test groups pass).
- [x] 16.2 Each of the 14 self-checks above (1.4, 2.4, 3.5, 4.5,
      5.8, 6.4, 7.4, 8.5, 9.8, 10.5, 11.4, 12.3, 13.3, 14.6,
      15.5) runs and passes.
- [x] 16.3 `node scripts/markforge-e2e.cjs` — extend the e2e to
      cover: new page from `+`, slash menu, page menu Copy,
      tab bar (Electron-only via `isElectron()`).
- [ ] 16.4 Manual Electron smoke:
      - Boot via `MarkForge.bat` (renamed from
        `MarkForge-Online.bat`).
      - Confirm `MarkForge-Offline.bat` is gone.
      - Login, open a page, lock the vault, see placeholder.
      - Unlock with the PIN from `.env` (default `123098`).
      - Edit, save, reload — body still readable.
      - Open the `⋯` page menu, toggle Small text and Full width.
      - `+` in the tab bar, search for a page, open it as a new
        tab. Close the tab. Hit 6-tab limit, see the toast.
      - Settings → add an OpenAI key, click Test connection.
      - Press Space in an empty block, write `buatkan puisi`,
        confirm a poem appears with no preamble.
      - Slash `/` opens the menu and inserts the chosen block.
- [x] 16.5 `openspec archive 2026-08-30-notion-parity` — moves
      the change to `openspec/changes/archive/`, registers the
      new specs under `openspec/specs/`.
- [x] 16.6 Update `openspec/specs/{editor,page-menu,inline-ai,
      import-export,master-password,desktop-tabs}/spec.md` (one
      per major surface).

## 17. Post-§16 fix batch

Seven fixes landed in one commit on `dev`. No new spec; each item
is a follow-up to an existing task.

- [x] 17.1 Shortcut audit (`components/workspace/markdown-editor.tsx`):
      - `Mod-d` (duplicate block) -> `Mod-Shift-d` (`Mod-d` is
        browser bookmark; conflict in web and Electron).
      - `Mod-Shift-p` (turn into page) -> `Mod-Shift-k` (Firefox +
        Chrome private window).
      - `Mod-N` (new page) wired in `workspace-app.tsx` to
        `createDocumentAt('', 'Untitled', '')` via a
        `createDocumentAtRef` so the keydown handler can reference
        the function before its declaration.
      - `Mod-Shift-N` (new grimoire) wired through
        `lib/shortcut-bus.ts` so the workspace can fire the action
        without lifting `grimoireSwitcherRef`.
- [x] 17.2 Side peek flush to top (`workspace-app.tsx`): moved
      `<SidePeek>` from inside the editor content `<div>` to a
      sibling of it, child of the editor column. Web mode now
      covers the full content area; Electron mode stays below
      `DesktopTabBar` (acceptable per user).
- [x] 17.3 Tab strip + new tab aligned with the editor header
      (`workspace-app.tsx` + `components/workspace/tab-strip.tsx`):
      collapsed the two-row header (TabStrip + 14h bar) into a
      single 10h bar with TabStrip inlined into the left cluster.
      `TabStrip` grew an optional `flush?: boolean` that drops
      its own `border-b bg-sidebar/40` when set.
- [x] 17.4 Sidebar `+` popover replaced with two icon buttons
      (`components/workspace/sidebar.tsx`,
      `components/workspace/sidebar-plus-popover.tsx` deleted,
      `lib/shortcut-bus.ts` new): `FilePlus` and `FolderPlus` in
      the Folders header. `grimoireSwitcherRef` stays local to the
      sidebar; `Mod-Shift-N` fires the bus.
- [x] 17.5 Sticky `⋯` page menu (`components/workspace/page-menu.tsx`,
      `components/workspace/doc-viewer.tsx`): wrapper changed from
      `absolute right-4 top-4` to `sticky top-4` and moved into
      the article's content flex column so it pins inside the
      scroll container instead of scrolling out of view.
- [x] 17.6 Settings page redirect bug (`app/settings/page.tsx`):
      the auth probe switched from `/api/health` (public, 200
      unauth) to `/api/vault` (401 -> bounce to
      `/login?from=/settings`). Locked/absent vault now opens the
      inline `PasswordsDialog`; App PIN card is independent of
      vault status and always renders.
- [x] 17.7 PIN placeholder hint (`app/login/page.tsx`,
      `components/workspace/pin-keypad.tsx`): login placeholder
      changed from `123456` to `······` (don't train shoulder
      surfers). Added a first-run hint naming the actual default
      `123456` so the user can still type it.
- [x] 17.8 `scripts/check-sidebar-plus.ts` rewritten for the new
      design: popover file gone, sidebar imports neither
      `SidebarPlusPopover`, two icon buttons with the expected
      titles, `grimoireSwitcherRef` local, sidebar subscribes to
      `'open-new-grimoire'`, workspace uses
      `createDocumentAtRef.current` + `fireShortcutAction`,
      `shortcut-bus.ts` exports both functions, `block-menu` still
      exports `OpenTarget` with `side-peek` + `new-window`.

## 18. Post-§17 fix batch + MarkForge rename

Seven fixes plus a full `Morrow` -> `MarkForge` (and `Sena` -> `Xyks`)
rename landed in one commit on `dev`. Self-checks 1-18 (25 total
runner rows) all pass; `pnpm verify` exits 0; e2e 20/22 (pre-existing
R2 + encrypted-nested fails are unchanged).

- [x] 18.1 Untitled.md duplicate retry
      (`lib/workspace-api.ts`, `components/workspace/workspace-app.tsx`):
      added `findUniquePath(parentDir, baseTitle, takenPaths)`. Walks
      `Object.keys(indexData.documents)`, returns the first free
      `Untitled.md` / `Untitled 2.md` / `Untitled 3.md` ... up to
      10k (throws after). `ponytail:` comment marks the linear
      scan + the workspace-flat namespace. `createDocumentAt`
      consumes the helper; `indexData` added to the `useCallback`
      deps.
- [x] 18.2 Header `⋯` meatball page menu
      (`components/workspace/page-menu.tsx`,
      `components/workspace/doc-viewer.tsx`,
      `components/workspace/workspace-app.tsx`): `PageMenu` now lives
      in the workspace header (gated by `activeDoc && source`,
      visible in both read + edit mode). All 10 menu actions wired
      (copy / duplicate / move to / trash / set view / set width /
      lock / unlock / import / export). `pageMenu` prop and the
      sticky wrapper inside `DocViewer` are gone. Rail toggle
      loosened from `mode === 'read'` to `activeDoc` so it shows
      in edit mode too.
- [x] 18.3 Sidebar icons re-arranged
      (`components/workspace/sidebar.tsx`,
      `components/workspace/grimoire-switcher.tsx`): Folders header
      carries `FilePlus` (new page) + `FolderPlus` (new folder ->
      `onCreateFolder('')`). The grimoire `+` (new grimoire) moved
      into the grimoire switcher header next to the Settings button.
- [x] 18.4 Import file / Import folder above Passwords
      (`components/workspace/sidebar.tsx`,
      `components/workspace/workspace-app.tsx`): two new icon
      buttons (`FileUp`, `FolderUp`) above the Passwords button.
      File import reuses `importPages`; folder import is a new
      `importFolder` callback that uses `webkitdirectory` +
      `webkitRelativePath` to recreate sub-folders via
      `api.createFolder` and write each `.md`/`.markdown`/`.txt`
      through `createDocumentAt`. `ponytail:` comment on
      `webkitdirectory` (only portable signal).
- [x] 18.5 Drop Root folder field on grimoire settings
      (`components/workspace/grimoire-switcher.tsx`): removed the
      `Root folder` label, value display, and `selectDirectory`
      Electron IPC call entirely. Settings sheet still toggles via
      the `Settings` button.
- [x] 18.6 Settings three-way theme
      (`app/settings/page.tsx`): new Appearance card above App
      PIN with a three-way `light` / `dark` / `system` segmented
      control wired through `next-themes` `useTheme().setTheme`.
      `aria-pressed` reflects the active value. Header
      `ThemeSwitcher` still works as a quick toggle.
- [x] 18.7 Self-checks: `check-page-menu.ts` rewritten to assert
      the header-mounted `PageMenu` and the absence of the
      `pageMenu` prop in `DocViewer`; `check-sidebar-plus.ts`
      rewritten for `FilePlus` + `FolderPlus` (folder calls
      `onCreateFolder('')`), grimoire switcher carries New grimoire,
      Root folder gone, and sidebar `onImportFile` + `onImportFolder`
      wired. New `check-theme.ts` (5 assertions) +
      `check-unique-name.ts` (7 assertions).
- [x] 18.8 Full `Morrow` -> `MarkForge` rename: 28 source files
      touched. Session secret namespace
      `markforge-session-v2:pin:<pin>`; cookie `markforge_session`;
      localStorage keys `markforge:tabs`, `markforge:rail-open`,
      `markforge:rail-width`, `markforge:sidebar-width`;
      service-worker cache `markforge-shell-v2`; test origin
      `https://markforge.test`; e2e cookie capture updated;
      `audit-parent-orphans.ts` cookie match updated; `docs/`
      curl examples + tab + password-manager + production-readiness
      + architecture.html updated; `lib/vault/crypto.ts` error
      messages + `use-vault` comment; `pwa-install` install title;
      `passwords-dialog` copy.
- [x] 18.9 Full `Sena` -> `Xyks` rename: 6 sites (3 tests, 2 docs).
      Test fixtures `Xyks/MarkForge Project.md` and
      `C:\Users\Xyks\shot.png`; sprint-7-plan + prd-q1-q3-decisions
      doc authors.
