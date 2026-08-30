# Tasks: r2-encrypted-nested

Estimated total: 4–5 weeks, single dev. Tasks are sized to fit in
2-hour commits so review is cheap.

> **Revisions from initial proposal (2026-08-30):**
> - Task 1.1 is wrong: `lib/server/workspace-store.ts` is the
>   abstract `WorkspaceStore` class used by both backends, not a
>   filesystem implementation. The file to keep is `lib/server/
>   r2-bucket.ts` (the R2 `Bucket` implementation). The file to
>   demote-to-test-only is `lib/server/fs-bucket.ts`.
> - `lib/server/store.ts` is the dispatcher; the change is to make
>   `createBucket()` throw on missing R2 env instead of falling
>   back to FsBucket.
> - 7 test files use FsBucket directly (not via `createBucket()`),
>   so they keep working. One test
>   (`tests/grimoire-scope.test.ts`) nullifies R2 to force the
>   fallback — that test needs to construct FsBucket explicitly.
> - Total effort revised from 3–4 weeks to 4–5 weeks to account
>   for the test refactor.

## 1. R2-only at boot (FsBucket test-only)

- [ ] 1.1 `lib/server/missing-r2-config.ts` — new file.
      `MissingR2ConfigError` class + `REQUIRED_R2_VARS` constant
      listing the four env var names.
- [ ] 1.2 `lib/server/store.ts` — `createBucket()` calls
      `r2ConfigFromEnv()`. If true, returns `new R2Bucket()`.
      If false, throws `MissingR2ConfigError` with the four var
      names. The `FsBucket` import and the filesystem branch are
      removed. The `BackendKind` type loses `'filesystem'` —
      it is `'r2' | 'unknown'` (the unknown case is what the
      boot screen reports).
- [ ] 1.3 `lib/server/store.ts` — `backendHealth()` returns
      `{ kind: 'r2', durable: true }` when `r2ConfigFromEnv()` is
      true, `{ kind: 'unknown', durable: false, warning: ... }`
      otherwise. The Vercel/ephemeral filesystem branch is
      removed.
- [ ] 1.4 `tests/grimoire-scope.test.ts` — refactor so it
      constructs `FsBucket` directly instead of relying on
      `createBucket()` falling back. `getGrimoireStore` is
      called with an explicit bucket, or the test is rewritten
      to skip the `getGrimoireStore` path entirely. Goal: the
      test still proves the grimoire-scope logic but does not
      require the FsBucket fallback in production code.
- [ ] 1.5 `app/api/storage/route.ts` — return `{ backend: 'r2',
      bucket: env.R2_BUCKET }` unconditionally.
- [ ] 1.6 `app/api/health/route.ts` — return 503 when R2 env vars
      are missing. Update the spec to match.
- [ ] 1.7 `app/layout.tsx` (or the env-loading entry) — if any
      `R2_*` is missing, render a one-screen
      `MarkForge requires R2 configuration` page. List the four
      env vars. Do not mount the editor.
- [ ] 1.8 `electron/main.cjs` — drop the `%APPDATA%\MarkForge`
      user-data directory setup. The Electron shell only loads
      the dev URL and passes env vars through.
- [ ] 1.9 `.env.example` — remove the "Without these, a local run
      falls back to your disk" sentence. Make the R2 vars
      non-optional in the template.
- [ ] 1.10 `pnpm verify` — should still pass. Dev server boots
      on `localhost:3457` and serves the workspace when env vars
      are set; otherwise shows the config-missing page.

## 2. Encrypted body on the wire

- [ ] 2.1 `package.json` — add `@noble/hashes` (Argon2id) and
      `@noble/ciphers` (AES-GCM). No native deps; runs in the
      browser and on the server.
- [ ] 2.2 `lib/crypto/derive-key.ts` — Argon2id wrapper.
      Parameters: `t=3, m=64MB, p=1`, 32-byte output, 16-byte
      random salt stored at `R2 key vaults/.salt`. Salt is
      plaintext (Argon2id salt is not a secret).
- [ ] 2.3 `lib/crypto/encrypt.ts` / `lib/crypto/decrypt.ts` —
      `encrypt(plain: string, key: CryptoKey): Promise<string>`
      and `decrypt(blob: string, key: CryptoKey): Promise<string>`.
      Blob shape: `base64url(iv) + "." + base64url(ciphertext)`.
      Tag is appended to ciphertext by the AES-GCM API.
- [ ] 2.4 `lib/crypto/vault-key.ts` — `useVaultKey(): CryptoKey |
      null`. Reads from a `VaultKeyProvider` context. The provider
      holds the derived key in memory only; refresh wipes it.
- [ ] 2.5 `lib/client/encrypted-fetch.ts` — wraps
      `readDocument` and `writeDocument`. On read, the server
      returns the ciphertext blob; the client decrypts before
      returning. On write, the client encrypts before sending.
      The `createDocument` and `writeDocument` paths share the
      same encrypt-then-PUT flow.
- [ ] 2.6 `lib/server/files-route.ts` — on GET, return the raw
      bytes as a base64 string. On PUT, accept the base64 string
      and store it verbatim. The server does not look inside the
      blob.
- [ ] 2.7 `components/workspace/passwords-dialog.tsx` — on
      unlock, the derived key is also written into
      `VaultKeyProvider`. On lock (`vault.lock()`), the key is
      cleared. The dialog copy updates to mention notes.
- [ ] 2.8 `components/workspace/markdown-editor.tsx` — read
      goes through `encrypted-fetch.readDocument`. Write goes
      through `encrypted-fetch.writeDocument`. While the vault is
      locked, write buttons are disabled with a tooltip "Unlock
      the password vault to edit notes".
- [ ] 2.9 Self-check `scripts/check-crypto.ts` — round-trip
      `encrypt → decrypt` with a known key, assert plaintext is
      restored, assert tampered ciphertext throws. Run as
      `node_modules/.bin/tsx scripts/check-crypto.ts` from CI.

## 3. Soft delete with 30-day retention

- [ ] 3.1 `lib/server/files-route.ts` — on DELETE, build a
      target key `R2 .trash/<unix_ms>/<path>`. Copy the object
      there, then delete the original. Return the trash path.
- [ ] 3.2 `lib/workspace-api.ts` — add `listTrash(): Promise<
      TrashEntry[] >`, `restoreFromTrash(trashId, originalPath):
      Promise<void>`, `permanentDelete(trashId): Promise<void>`.
- [ ] 3.3 `lib/server/trash-route.ts` — GET (list), POST
      (restore), DELETE (permanent). All return JSON.
- [ ] 3.4 `components/workspace/trash-panel.tsx` — slide-over
      from the right, lists trash entries with `Deleted <time>`
      and `Original path`. Each row has `Restore` and `Delete
      forever` buttons. Restore = move back; delete = remove
      from R2 permanently.
- [ ] 3.5 `components/workspace/sidebar.tsx` — add a `Trash`
      button below the document list. Click opens the panel.
- [ ] 3.6 `lib/server/trash-sweeper.ts` — Vercel cron route at
      `/api/cron/sweep-trash`. Lists `.trash/*`, deletes entries
      older than 30 days. Returns `{ swept: n }`.
- [ ] 3.7 `vercel.json` — add the cron schedule:
      `{ "crons": [{ "path": "/api/cron/sweep-trash", "schedule":
      "0 3 * * *" }] }`.
- [ ] 3.8 Self-check `scripts/check-trash.ts` — write a file,
      delete it, list trash, restore it, confirm the file is
      back at the original path with the same body.

## 4. Page-in-page model

- [ ] 4.1 `lib/server/index-format.ts` — extend
      `IndexDocument` with `parent_id: string | null`. Default
      `null` for the index loaded today.
- [ ] 4.2 `lib/client/index-format.ts` — mirror the change in
      the client type.
- [ ] 4.3 `lib/server/workspace-store.ts` — `rebuildIndex`
      walks the workspace and reads `parent:` from frontmatter
      into `parent_id` (one-shot migration of the existing
      frontmatter convention into the index field). After this
      build, frontmatter `parent:` is ignored.
- [ ] 4.4 `lib/client/turn-into-page.ts` — pure function:
      `turnSelectionIntoPage({path, body, selection, index}) →
      { newDocPath, newBody, newIndexEntry }`. The first line of
      the selection becomes the title; the new doc starts as
      `## <title>\n\n<selection>`. The parent body replaces
      the selection with `[[embed:newDocPath]]`.
- [ ] 4.5 `components/workspace/turn-into-page-item.tsx` —
      block-menu item in the `Turn into` submenu. Calls
      `turnSelectionIntoPage`, creates the child doc, updates
      the parent body, refreshes the index. Shows a toast with
      a `Open` action that opens the new child in a new tab.
- [ ] 4.6 `components/workspace/sidebar-tree.tsx` — collapsible
      tree above the flat list. Reads `IndexDocument[]`, groups
      by `parent_id`. Click a parent node to expand/collapse.
      Drag a child onto another parent to reparent (later — v2).
- [ ] 4.7 `components/workspace/breadcrumb.tsx` — derived from
      the path of the active document and its `parent_id`
      chain. Click any segment to navigate.
- [ ] 4.8 `components/workspace/child-pages-section.tsx` —
      appends at the bottom of the reading view. Lists children
      of the current document as a `## Child pages` section
      with links. The section is renderer-generated, not stored
      in the body.
- [ ] 4.9 `components/workspace/doc-viewer.tsx` — append
      `<ChildPagesSection>` to the rendered body.
- [ ] 4.10 `components/workspace/markdown-editor.tsx` — render
      `<Breadcrumb>` above the title. The `Turn into page` key
      shortcut is `Ctrl+Shift+P`.
- [ ] 4.11 Self-check `scripts/check-nested-pages.ts` — build
      a parent, turn a selection into a child, assert the
      child exists in the index with the right `parent_id`,
      assert the parent body has the embed link, assert the
      sidebar tree renders the child under the parent.

## 5. Verification

- [ ] 5.1 `pnpm check:encoding`.
- [ ] 5.2 `pnpm typecheck`.
- [ ] 5.3 `pnpm lint`.
- [ ] 5.4 `pnpm verify` (the existing gate).
- [ ] 5.5 `node scripts/markforge-e2e.cjs` — extends to cover
      the new flows: encrypt-decrypt round-trip in the
      end-to-end run, trash + restore, page-in-page create +
      sidebar tree + child-pages section rendering.
- [ ] 5.6 Manual smoke on the Electron shell:
      - Boot, see the workspace load from R2.
      - Open a file, lock the vault, confirm the body becomes
        the placeholder "Unlock to read".
      - Unlock with the master password, confirm the body
        renders.
      - Edit, save, reload — body still readable.
      - Delete a file, open Trash, restore it, file is back.
      - Slash `/page "Sub"` — new child appears, sidebar
        tree shows it under the parent, breadcrumb shows
        `parent / Sub`.
      - Select a paragraph, block menu, `Turn into page` —
        paragraph becomes a child, parent body has the
        `[[embed:...]]` link.

## 6. Wrap-up

- [ ] 6.1 One atomic commit per task group (1–4).
- [ ] 6.2 Push each group to `dev`.
- [ ] 6.3 `openspec archive 2026-08-30-r2-encrypted-nested`
      after the smoke test passes.
- [ ] 6.4 Update `openspec/specs/cloud-sync/spec.md` to mark
      itself superseded. Update `desktop-shell/spec.md` to
      drop the local-data requirement.
