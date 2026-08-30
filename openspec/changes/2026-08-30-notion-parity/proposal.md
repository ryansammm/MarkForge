# Change: notion-parity — editor + page-menu + AI + import

> **Status:** proposal awaiting approval.
> **Branch:** `dev` (after `2026-08-30-r2-encrypted-nested` is archived).
> **Smoke gate:** `2026-08-30-r2-encrypted-nested` §5.6 must pass before this work starts.

Brings the editor, page chrome, and import flow up to Notion parity on top of
the R2-only + encrypted + nested-pages baseline. Adds an opt-in inline-AI block
under the user's own API key (vault-stored). Removes the page-tree that
shipped in `2026-08-30-r2-encrypted-nested` §4.6 (user changed their mind).
Drops the legacy offline mode (see "Drop offline mode" in What changes).

## Why

The previous changes hardened storage (R2-only, encryption, trash, nested
pages) but left the editor feeling distinct from Notion:

- The page-tree in the sidebar duplicates information that's already in the
  folder tree and the breadcrumb.
- The block menu has a top-level `Turn into page` that is conceptually a
  block transform but is grouped separately.
- No callout, no toggle list, no per-page width/text-size preference, no
  page-level menu (Notion's `⋯` at top-right).
- No inline AI despite the master-password gate existing for this kind of
  feature.
- Import (file/folder) was disabled at some point and never re-enabled.
- `Ctrl-Enter` showed the `<!-- mkf:b:... -->` block-id comment, a debug aid
  that shouldn't be visible in the editor.
- `Open in new window` was added to the editor context menu even though the
  flow it triggers only works in the web app, not in Electron.
- Master-password gate had no minimum length.
- Grimoire creation still asks for a root folder even though the backend is
  R2-only and the folder is irrelevant.
- Desktop Electron has no top tab bar; multi-page work is a single
  in-app document-tab system, not the Notion-equivalent browser-tab UX.
- The offline mode (`MarkForge-Offline.bat`, `MARKFORGE_ONLINE` env
  switch, the `localOnly` pin-off in `electron/main.cjs`) is dead
  weight — MarkForge is fully online now.

## What changes

### Editor

- `Enter` and `Ctrl-Enter` semantics switch to Notion-style:
  - `Enter` on a non-empty block: split into a new paragraph below.
  - `Enter` on an empty block: leave the empty block, do **not** create a
    sibling. Empty paragraph stays empty.
  - `Enter` at end of an empty list item: exit the list, become a paragraph.
  - `Ctrl-Enter` (or `Cmd-Enter`): insert a hard line break inside the
    current block. Visible marker, no `mkf:b:` comment.
- Empty block shows a placeholder: `Press 'space' for AI or '/' for commands`.
  Placeholder is rendered behind the cursor, never persisted.
- `Space` at the start of an empty block: replace the block with an AI
  prompt block (see AI section). The block is now an `ai` block; the user
  types the prompt; on submit, the block is replaced with the streamed
  response. The block keeps an `ai: true` flag in frontmatter.
- `/` opens the slash command menu. (Regression to fix as part of this
  change — confirmed broken in user repro; the existing `slash-commands`
  test passes, so the bug is in wiring, not the menu itself.)

### Block menu

- Top-level items (current order, top to bottom): `Turn into`, `Color`,
  `Duplicate`, `Copy link to block`, `Delete`, `Move to`.
- `Turn into` submenu contents (new):
  - `Text` → paragraph
  - `Heading 1`, `Heading 2`, `Heading 3`
  - `Bulleted list`, `Numbered list`, `Toggle list` (new)
  - `Quote`, `Callout` (new)
  - `Divider`
  - `Turn into page` (moved here from top-level)
  - `Page in` (new — see below)
- `Copy link to block`, `Open in side peek`, `Open in new tab`,
  `Open in new window`, `Open in full page` are **removed** from the
  editor context menu.
- `Move to` stays at top level (block-level move across documents, already
  shipped in polish 3).

### Turn into → Page in

- `Page in` opens a sub-submenu listing all pages in the active grimoire
  (search-as-you-type). Selecting a page inserts a `[[wikilink]]` to that
  page at the current cursor position. Notion-equivalent.
- The list is populated from the live index, not the folder tree. Documents
  with no resolvable title are excluded.

### New block types

- **Toggle list** (`- [ ]` syntax, Notion's collapsible list). Renders as
  `<details><summary>...</summary>...</details>`. Persisted as `- [ ]` in
  markdown.
- **Callout** (`> [!info]` syntax, Obsidian-compatible). Renders with an
  icon (default: `💡` for `info`, `⚠️` for `warn`, `❌` for `danger`, `✅`
  for `success`) and a coloured background. Persisted as `> [!type]`.

### Page chrome

- Top-right `⋯` menu in the document viewer (Notion-style). Contents:
  - `Copy page content` — copy the **decrypted** markdown to clipboard.
  - `Duplicate` — page-level duplicate: same path, suffix ` (copy)`,
    same body, new id, `parent_id` cleared.
  - `Move to` — pick a destination folder in the active grimoire. Same
    file-rename primitive the existing `Move to` block flow uses, but
    applied to the document.
  - `Move to trash` — same as the current `Delete` action.
  - `Small text` — toggle. `Full width` — toggle. Both **per-page**,
    stored in frontmatter (`view: small | full`, `width: full | default`).
  - `Lock page` — see Lock section.
  - `Import` — upload a file from the OS into the **current page** as a
    child page (page-level). Notion-equivalent.
  - `Export` — download the **current page** as `.md` (decrypted, with
    frontmatter). The reverse of Import.
- `Lock page`/`Unlock page` toggles based on lock state.

### Desktop top tab bar (Electron only)

- **Scope:** Electron only. Web mode does not render the tab bar;
  the proposal does not add a web tab system.
- **Top tab bar** inside the existing window, above the sidebar:
  - Each tab is a document from the active grimoire.
  - Tab shows the page title (truncated to ~30 chars with ellipsis)
    and a close `×` button on hover.
  - Active tab is highlighted. Click a tab to switch.
  - The currently-open page in the editor is always reflected as
    an active tab; opening a page from the sidebar or the page menu
    activates its tab if it exists, or opens a new one if not.
  - `+` button at the end of the strip opens the **page picker
    popover**.
- **Page picker popover:**
  - Anchored under the `+` button.
  - Search input at the top (filter as you type, by title).
  - List of pages in the active grimoire (from the live index, not
    the folder tree).
  - Selecting a page adds a new tab and activates it.
  - `Esc` or click-outside closes the popover without selecting.
- **In-memory only.** Tab list is not persisted. Closing the app
  loses all tabs. Re-opening starts with the previously-active
  document as the single tab (existing behavior).
- **State lives in `lib/tabs.ts`** (already there for in-app editor
  tabs) — but as a separate slice to avoid coupling. The new slice
  is `lib/desktop-tabs.ts` with the same pure-reducer style.
- **Limits:** maximum **6 tabs** open at once. Hitting the limit
  shows a toast and refuses the new tab.

### Sidebar

- `Pages` section from §4.6 of `2026-08-30-r2-encrypted-nested` is
  **removed**. Sidebar keeps: grimoire switcher, folder tree, Trash
  button, settings.
- Per-page context menu (right-click on a page in the folder tree)
  gains:
  - `Open in side peek`
  - `Open in new window` — only rendered in web mode. In Electron
    (`isElectron()`), the item is hidden.
- Sidebar's `+` button is replaced with a Notion-equivalent:
  - `+ New page` — creates an empty page in the active grimoire (R2
    only, no folder picker).
  - `+ New grimoire` — opens the grimoire-create dialog. The dialog no
    longer asks for a root folder (see below).
- Sidebar's "Import file / Import folder" is **not** added back; the
  page menu's `Import` is the canonical entry point per the dedupe
  decision (page menu only). If the user later wants sidebar import,
  add it as a new task.

### Grimoire creation

- Remove the folder picker. The grimoire dialog asks for `Name` and
  optional `Description`, then calls `createGrimoire({ name, description })`
  with no `path`. The grimoire becomes a key prefix in R2 — no local
  directory involved.
- Existing grimoires (with a `path`) keep working for one cycle; the
  `path` field is treated as legacy metadata and not surfaced in the UI.
  New grimoires have no `path`. Migration is in-place (the R2 layout is
  the same; only the field on `grimoires.json` is optional).

### Master password

The previous task's "min length 6 on `APP_PASSWORD`" was the wrong
shape: the gate secret is short by design, and the credential that
actually matters is the vault master. Two changes:

- **App gate** (`APP_PASSWORD`) is replaced by a 6-digit **PIN**
  (`APP_PIN`). Default `123098`. Exactly 6 digits, numeric-only.
  UI placeholder is `123456` (a generic 6-digit hint, not the
  real default — the real default is the env value, surfaced
  in the keypad only by typing it). The PIN is also the
  "sign out everywhere" key: rotating it invalidates every
  session. **Vercel deployments** must update their env: drop
  `APP_PASSWORD`, add `APP_PIN`. The server prints a one-line
  warning if `APP_PASSWORD` is still set.
- **Vault master password** minimum length: **8 characters**.
  Enforced at every entry point (`deriveKey`, `createEnvelope`,
  `openRecord`) so a tampered call site cannot bypass it. A
  distinct error class (`VaultPasswordTooShortError`) lets the
  UI say "use a longer password" rather than "wrong password".

The PIN lives in `app-settings.json` in the bucket so an
operator can rotate it from the Settings page without redeploying.
Resolution order: **env > stored > default**.

### Inline AI

- **Opt-in.** The feature is invisible until the user opens Settings and
  adds an API key. No telemetry, no remote calls without a key.
- **Two providers**, one UI:
  - **OpenAI-compatible** (default). Base URL: `https://api.openai.com`
    by default. Model: dropdown of well-known small models
    (`gpt-4o-mini`, `gpt-4o`, `gpt-4.1-mini`, `gpt-3.5-turbo`),
    plus a free-text override field.
  - **Native Gemini**. Base URL: `https://generativelanguage.googleapis.com`
    by default. Model: dropdown (`gemini-2.5-flash`, `gemini-2.5-pro`,
    `gemini-2.0-flash`), plus a free-text override.
  - **Free-text base URL** available in both: user can paste
    `https://openrouter.ai/api/v1` for OpenRouter, `http://localhost:11434/v1`
    for Ollama, etc.
- **Settings UI** (`/settings` or a dialog):
  - Provider dropdown (OpenAI-compatible / Gemini).
  - API key (masked `type=password`, persisted as a vault item).
  - Model dropdown + free-text override.
  - Base URL (pre-filled with the default for the chosen provider,
    free-text override).
  - "Test connection" button — sends a 1-token completion, shows the
    result. No telemetry.
- **Vault storage**. The API key is a vault item (encrypted with the
  master-password vault key, same primitive as `lib/vault/crypto.ts`).
  Read via `VaultKeyProvider`. Locking the vault hides the AI
  capability — Space-typing still shows the placeholder, but the
  prompt is read-only until the vault unlocks.
- **Stream**. Server endpoint `POST /api/ai/stream` accepts
  `{ prompt, provider, model, baseUrl, apiKey, system }` and proxies
  to the upstream API. The response is an SSE stream
  (`text/event-stream`). The client decodes tokens and replaces the
  block content as they arrive. Block abort: closing the tab or
  navigating away cancels the stream via `AbortController`.
- **System prompt** is fixed, not user-editable:
  `You are a writing assistant. Output ONLY the requested content.
  No preamble, no explanation, no closing question, no follow-up
  suggestions. Match the language of the user's prompt.`
- **No data leaves the box except for the API call itself.** The
  prompt and the streamed response are the only things sent to the
  upstream. The vault key and master password never leave the box.
  Documented in the Settings UI and in `lib/server/ai.ts` JSDoc.

### Lock page

- **Per-page passphrase, independent of master password.**
- Storage: in the page's frontmatter,
  `lock: { kdf: 'pbkdf2-sha256' | 'argon2id', salt: '...', wrapped: '...', nonce: '...' }`.
  The page body is encrypted with a 32-byte random key (`pageKey`),
  AES-GCM-256. The page key is wrapped with the user's passphrase via
  Argon2id (m=64MB, t=3, p=1) → unwrap on unlock.
- New dep: `argon2` (Node-side) and `@node-rs/argon2` is not allowed
  in the renderer; in the renderer, use `lib/vault/crypto.ts`-equivalent
  via WebCrypto's `PBKDF2` (no Argon2 in the browser without WASM).
  Decision: **use PBKDF2-SHA256 (200k iters) in the renderer, Argon2id
  in the server-side re-wrap path during export.** The wrapped key
  format records the KDF used so unlock knows which one to run. The
  pageKey itself is random 32 bytes either way.
- Lock UX:
  - `Lock page` menu item prompts for a passphrase + confirm.
  - On submit, server encrypts the body with a fresh `pageKey` and
    stores the wrapped key in frontmatter.
  - On open, if the page is locked, the viewer shows a passphrase
    prompt. Correct passphrase decrypts in place. Wrong passphrase
    shakes the input + log attempt.
  - `Unlock page` menu item does the same prompt inline.
- Lost passphrase = lost page content. (The user accepts this; it's
  the same contract as Notion's per-page lock.)
- The page is **still in the index**; the title, breadcrumb, child
  list, etc. all work. Only the body is encrypted.
- AI on a locked page: the AI block is hidden (replaced by the
  passphrase prompt) until unlocked.

### Import / Export (page menu)

- `Import` (page menu): opens a file picker. Accepts `.md`, `.txt`,
  `.markdown`. Each file becomes a child page of the current page:
  `Current Page/<file-stem>`. Body is the file's content. `parent_id`
  is the current page's id.
- `Export` (page menu): downloads the current page as
  `<safe-title>.md` with the decrypted body + frontmatter. Browser uses
  `<a download>`; Electron uses `dialog.showSaveDialog`.

## Out of scope (deferred)

- Per-user override of `Small text` / `Full width`. Per-page only.
- Page-level version history. Notion has it; we don't, and the index
  + encrypted body makes it non-trivial. Add a separate change.
- Multi-user collaboration on locked pages. Single-user only.
- OpenAI-compatible **tool use** / function calling. Text completion
  only.
- Web search / image generation through the AI block.
- Migrating existing encrypted bodies to a per-page lock model (the
  `lock:` field is new; pre-existing pages are unlocked by default).
- Migrating Vercel environments from `APP_PASSWORD` to `APP_PIN`.
  The server prints a one-line deprecation warning if `APP_PASSWORD`
  is still set; deployment is the operator's call.

## Data model changes

- `MarkdownDocument` (already has `id`, `parent_id`):
  - `view?: 'default' | 'small'`
  - `width?: 'default' | 'full'`
  - `lock?: { kdf: 'pbkdf2-sha256' | 'argon2id', salt: string,
    wrapped: string, nonce: string, body_cipher?: string }`
  - `ai?: { provider: 'openai' | 'gemini', model: string, baseUrl: string,
    prompt: string, output: string }` (only on AI blocks; not on the
    page itself)
- `MarkdownDocument.encrypted_body` is extended to optionally carry
  the per-page locked body. When `lock` is present, the normal
  `encrypted_body` is unused.
- `Grimoire` (in `grimoires.json`): `path` becomes optional. New
  grimoires don't set it.

## Tasks

> Sized for 2-hour commits so review is cheap. Numbered so they
> can be re-ordered if a regression forces a rollback.

1. **Empty block + Enter semantics.** Replace `Enter`/`Ctrl-Enter`
   behaviour, add the placeholder. No new dep.
2. **Block menu reshuffle.** Move `Turn into page` into the submenu,
   remove the five editor context-menu items, add `Page in`,
   `Toggle list`, `Callout`.
3. **Toggle list + Callout block types.** Block-level changes, plus
   the markdown parser/renderer. Two new types in the block schema.
4. **Remove page-tree from sidebar.** Revert §4.6 of the previous
   change. Update tasks.md for `2026-08-30-r2-encrypted-nested`
   with the rationale.
5. **`⋯` page menu.** New component. `Copy page content`,
   `Duplicate` (page-level), `Move to` (page-level), `Move to trash`,
   `Small text`, `Full width`. Stubs for `Lock page`, `Import`,
   `Export` — wired in later tasks.
6. **Settings page (API key UI).** New route or dialog. Vault-stored
   key, masked input, provider/model/base-URL with defaults and
   overrides. "Test connection" button.
7. **`/api/ai/stream` server endpoint.** SSE proxy to OpenAI and
   Gemini. Rate limit per vault. Cancel on `AbortController`.
8. **AI block in the editor.** `Space`-on-empty trigger. Block-level
   state (`ai: true`). Stream consumer. Replace-on-done.
9. **Lock page.** Passphrase prompt UI. Per-page encryption with a
   random page key. Frontmatter lock record. Unlock flow.
10. **Page-level Import/Export.** File picker → child page. Download
    decrypted page.
11. **Grimoire create without folder picker.** Drop the `path`
    field from the dialog and from new grimoires.
12. **Master password min length.** Boot validator. `auth` route
    reads the env validator's warning.
13. **Sidebar `+` button + sidebar page context menu.** `Open in
    side peek`, `Open in new window` (web only), `+ New page`,
    `+ New grimoire`.
14. **Desktop top tab bar + page picker popover.** Electron-only
    `lib/desktop-tabs.ts` slice, tab strip component, popover, 6-tab
    limit. Hidden in web mode via `isElectron()`.
15. **Drop offline mode.** Delete `MarkForge-Offline.bat`. Remove
    the `MARKFORGE_ONLINE` env switch from `electron/main.cjs`:
    the dev-spawn block always passes the repo's `.env` through to
    `next dev`. Remove the now-dead comment about the offline
    default. The `localOnly` pin-off block is gone.
16. **Self-checks + verify + e2e + archive.**

## Risks

- **Fully online**. This change adds a real network call to an
  external service. MarkForge is no longer shipped with an offline
  mode — see the launcher change (Task 16 below). Mitigations:
  - User's own API key (no vendor lock-in, no telemetry).
  - Settings UI documents what leaves the box.
  - No background or auto-send; the user must press `Space` and
    type a prompt.
- **New dep**: `argon2` (Node-side) for the page-lock re-wrap path
  during export. ~3 MB binary. Used only when a page is being
  locked or exported; cold start unaffected.
- **Renderer crypto**: PBKDF2 (not Argon2id) in the renderer.
  Acceptable because the attacker model for a page passphrase is
  offline-after-R2-breach, and 200k PBKDF2 is well above the
  Notion baseline. Documented in `lib/lock/page-crypto.ts`.
- **Slash menu regression**: root cause unknown until the user's
  F12 repro is captured. Mitigated by `1` (Enter/placeholder work)
  being a separate commit so bisection is clean.
- **PC**: no measurable impact. AI is a server round-trip, not
  local inference. Settings page is a single new route.
