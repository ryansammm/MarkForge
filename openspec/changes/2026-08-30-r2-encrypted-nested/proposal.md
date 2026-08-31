## Why

MarkForge today is a markdown vault that talks to Cloudflare R2 when env
vars are set, and to a local filesystem when they are not. Three problems
with that:

1. **Two storage backends, one truth.** Local-mode and R2-mode drift in
   subtle ways (trash retention, etag, search reindex, share
   metadata). A user who has run both has two inconsistent vaults and no
   warning when one falls behind.
2. **Notes sit in R2 in plaintext.** R2 is a private bucket but the
   bytes are still readable by anyone with the credentials (Cloudflare
   staff, leaked access key, future-me with a forensics tool). The
   password-vault dialog already proves the in-browser key-derivation
   model works; that same model should cover notes.
3. **No real "page in page".** `/page` (slashed from the block menu)
   creates a sibling `.md` and links it from the parent's frontmatter.
   That is a link, not a subpage. The sidebar cannot show a tree, the
   child page has no body marker that says "I belong to that one", and
   "Turn into page" does not exist as a transform.

This change addresses all three: it makes R2 the only backend, encrypts
the document body (and the password-vault blob, by reusing the existing
key) before it lands in R2, and adds a real nested-page model with
`parent_id` in the index, a sidebar tree, and a `Turn into page` block
transform.

## What Changes

- **R2-only storage.** `lib/server/store.ts:createBucket()` no
  longer falls back to `FsBucket` — it requires `R2_*` env vars and
  throws a clear error otherwise. `lib/server/fs-bucket.ts` is
  retained for tests that exercise it directly (it is a `Bucket`
  implementation, used by `tests/{backend,assets,grimoire-scope,
  data-safety,rename,vault,store}.test.ts` and as a backend in the
  backend-conformance suite). The Electron shell's
  `%APPDATA%\MarkForge` user-data directory is no longer written to.
  `pnpm dev` requires `R2_*` env vars to start; missing vars → a
  one-screen "Configure R2" message instead of falling back to disk.
- **Encrypted body on the wire.** The client derives an AES-GCM key
  from the master password (Argon2id) on first unlock. Every `PUT
  /api/files` body is encrypted client-side before it leaves the
  browser; the server stores ciphertext. The server never sees the
  key. The client decrypts on read. Index entries (path, title,
  parent_id, mtime, etag) stay plaintext so the sidebar can render
  without an unlocked vault.
- **Master password scope expands.** Today the master password unlocks
  the password-vault blob. After this change, the same master password
  unlocks note bodies. Lost master password = lost notes and lost
  vault. The existing "There is no way to recover this password" warning
  applies to both.
- **Soft delete with 30-day undo.** `DELETE /api/files` moves the
  ciphertext to `R2 prefix .trash/<unix_ts>/<path>` instead of removing
  it. A new `Trash` panel in the sidebar lists trashed items; restoring
  moves the file back to its original path (move-back, undo-style, not
  copy). After 30 days the server-side sweeper deletes the tombstone.
- **Page-in-page model.**
  - `index.json` gets a new `parent_id: string | null` per document
    (the parent's path, or null for root).
  - Slash `/page "Name"` becomes `/page "Name" <parent-or-child>` —
    default child of the current document. Existing parents in
    frontmatter (`subpages:`, `parent:`) keep working as legacy links.
  - `Turn into page` block-menu action: extracts the selected text into
    a new child document named after the first line (or "Untitled"),
    replaces the selection with a `[[embed:relative/path]]` link in the
    parent body, sets the child's `parent_id`, and refreshes the
    index.
  - Sidebar gains a collapsible tree view (parent → children) above the
    flat document list. `Breadcrumb` at the top of the editor shows
    `… / parent / current`.
  - The body of a parent page renders an auto-generated
    `## Child pages` section at the bottom: a list of links to each
    child document whose `parent_id` matches. The section is generated
    by the renderer from the index, not stored in the body.
- **Backup is the trash itself.** No separate backup system. The 30-day
  `.trash/` retention is the safety net for "I deleted the wrong file".
  For R2-bucket-wide disaster (credential rotation, accidental bucket
  delete), the existing `D:\Origin\Backups\r2-backup-1787911827524`
  local archive remains the user-managed cold backup.

## Capabilities

### New Capabilities

- `encrypted-r2`: client-side encryption of note bodies and the
  password-vault blob. AES-GCM with a key derived from the master
  password via Argon2id. Index metadata stays plaintext.
- `nested-pages`: `parent_id` in the index, sidebar tree, breadcrumb,
  `Turn into page` action, and a renderer-generated child-pages
  section in parent bodies.
- `r2-only`: R2 is the only storage backend. No local-fs fallback.
  Missing `R2_*` env vars block startup with a one-screen message.
- `trash-30d`: deleted files move to `R2 .trash/<ts>/<path>` for 30
  days. `Trash` panel in the sidebar lists them. Restore = move back.
  Server-side sweeper deletes after 30 days.

### Modified Capabilities

- `cloud-sync` → **superseded** by `r2-only`. The `cloud-sync` spec is
  about explicit push from local; with no local there is nothing to
  push from. The archived spec is preserved for history.
- `desktop-shell`: the Electron shell no longer writes to
  `%APPDATA%\MarkForge`. The local data directory is unused; the spec's
  "Isolated local data" requirement is **dropped** (no longer
  applicable), and replaced with a "R2 env vars required" requirement.

## Impact

New code:

- `lib/server/missing-r2-config.ts` — `MissingR2ConfigError` class +
  the four env var names exported as a constant. The boot-time
  configuration screen reads them.
- `lib/crypto/derive-key.ts` — Argon2id wrapper over
  `@noble/hashes/argon2`. Takes a master password, returns a 32-byte
  `CryptoKey` for AES-GCM.
- `lib/crypto/encrypt.ts` / `lib/crypto/decrypt.ts` — `encrypt(plain,
  key) → { iv, ciphertext, tag }`, `decrypt(blob, key) → plain`. IV
  is 12 random bytes per encrypt. The blob shape on the wire is
  `base64(iv) + "." + base64(ciphertext+tag)`.
- `lib/crypto/vault-key.ts` — exposes the unlocked key as
  `useVaultKey(): CryptoKey | null`. Reads from a React context
  populated by the existing `PasswordsDialog` unlock flow.
- `lib/client/encrypted-fetch.ts` — wraps `fetch` for
  `/api/files`: on PUT, encrypt body before send; on GET, decrypt
  after receive. Other routes (auth, index, share, trash) are not
  wrapped.
- `lib/client/index-format.ts` — extend `IndexDocument` with
  `parent_id: string | null`. Server-side `lib/server/index-format.ts`
  mirrors the change.
- `lib/client/turn-into-page.ts` — `turnSelectionIntoPage({path,
  selection, parentId}) → { newDocPath, newBody, newIndex }`. Used by
  the block menu.
- `lib/server/trash-sweeper.ts` — Vercel cron route at
  `/api/cron/sweep-trash` deletes `.trash/*` older than 30 days. Run
  daily at 03:00 UTC.
- `components/workspace/sidebar-tree.tsx` — collapsible tree above
  the flat list. Reads the same `IndexDocument` array, groups by
  `parent_id`.
- `components/workspace/breadcrumb.tsx` — derived from the path of
  the active document and its chain of `parent_id` in the index.
- `components/workspace/child-pages-section.tsx` — bottom of the
  reading view, generated from the index. Clicking a child opens it
  in the same tab.
- `components/workspace/turn-into-page-item.tsx` — block-menu action.
  Visible only when the selection is non-empty and resolves to a single
  paragraph or contiguous range.

Edited:

- `lib/workspace-api.ts` — `readDocument` returns ciphertext today;
  after this change the client wrapper handles the encrypt/decrypt, and
  the server's `readDocument` returns the ciphertext blob (base64
  string). Add `createChildDocument`, `restoreFromTrash`,
  `listTrash`, `permanentDelete`.
- `lib/server/store.ts` — `createBucket()` requires R2 env vars
  (throws `MissingR2ConfigError` with the four var names when
  absent). `backendHealth()` returns `kind: 'r2'` unconditionally
  and `durable: true` (R2 is the only supported backend). The
  filesystem branch and the `BackendKind: 'filesystem'` variant are
  removed.
- `lib/server/files-route.ts` — on DELETE, move to `.trash/<ts>/<path>`
  instead of removing. On PUT of an existing path, overwrite in place
  (no per-write versioning).
- `app/api/storage/route.ts` — return `r2` unconditionally.
- `app/api/health/route.ts` — fail if R2 env vars are missing instead
  of returning `ok` for local mode.
- `components/workspace/markdown-editor.tsx` — wrap outgoing writes
  through `encrypted-fetch`. Wrap incoming reads on mount. No
  CodeMirror-level changes (block-id, hide-syntax, drag handle all
  keep working).
- `components/workspace/doc-viewer.tsx` — append
  `<ChildPagesSection path={path} />` at the bottom of the rendered
  body. Body itself is decrypted before reaching the renderer.
- `components/workspace/block-menu.tsx` — add `Turn into page` to the
  `Turn into` submenu, after `Quote` and before `Code`. Disabled when
  the selection is empty.
- `components/workspace/sidebar.tsx` — render `<SidebarTree>` above
  the existing document list. Add a `Trash` button that opens a
  slide-over panel.
- `components/workspace/passwords-dialog.tsx` — the same unlock flow
  now also unlocks note encryption. The dialog copy changes from
  "A separate vault, encrypted in your browser. MarkForge stores it
  without being able to read it." to "Unlocks your notes and the
  password vault. Without this, the app can read your titles but not
  the bodies."
- `app/layout.tsx` (or wherever the env is read at boot) — if R2 env
  vars are missing, render a one-screen
  `MarkForge requires R2 configuration` page with the four env var
  names. The editor never mounts.
- `electron/main.cjs` — drop the `%APPDATA%\MarkForge` setup. The
  Electron shell becomes a thin wrapper around the web app: it loads
  the dev server URL, passes through the env vars, and otherwise adds
  nothing.
- `.env.example` — remove the "Without these, a local run falls back to
  your disk (fine)" sentence. Make `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` non-optional
  in the template.
- `openspec/specs/cloud-sync/spec.md` — marked superseded.
- `openspec/specs/desktop-shell/spec.md` — drop the "Isolated local
  data" requirement, add "R2 env required".

Out-of-scope confirmation:

- Real-time collaboration (multi-user cursors, presence). Single-user
  app; `If-Match` etag on writes is enough.
- Per-write versioning / snapshots beyond the 30-day trash. The
  existing `D:\Origin\Backups` archive is the cold backup.
- Migrating existing data from local or plaintext-R2 to encrypted-R2.
  Fresh-start per user decision. Existing notes in
  `D:\Origin\Backups\r2-backup-1787911827524` remain as a read-only
  archive, not auto-imported.
- Key rotation. The master password is set once. Rotating it means
  re-encrypting every body in R2, which is a v2 feature.
- Search across encrypted bodies. The index (titles + paths) is
  searchable; full-text search inside bodies is client-side and only
  works after the user unlocks. No server-side full-text search.
- Mobile / touch UI optimization. Web app and Electron desktop
  only.

## Non-goals

- **Not a Notion clone.** The 30+ Notion block types (callout, columns,
  toggle, math, embed, etc.) are out of scope. MarkForge is markdown;
  block-scoped actions are the only "Notion-like" piece.
- **Not a CMS.** No public sharing beyond the existing share dialog.
- **Not a migration tool.** Existing users start fresh.
