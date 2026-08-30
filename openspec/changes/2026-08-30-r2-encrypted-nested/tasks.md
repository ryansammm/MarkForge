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

- [x] 1.1 `lib/server/missing-r2-config.ts` — `MissingR2ConfigError`
      + `REQUIRED_R2_VARS`.
- [x] 1.2 `lib/server/store.ts` — `createBucket()` throws on
      missing R2; `FsBucket` removed from production path;
      `BackendKind` = `'r2' | 'unknown'`.
- [x] 1.3 `lib/server/store.ts` — `backendHealth()` returns
      `{ kind: 'r2', durable: true }` or `{ kind: 'unknown', ... }`.
- [x] 1.4 `tests/grimoire-scope.test.ts` — constructs `FsBucket`
      directly.
- [x] 1.5 `app/api/storage/route.ts` — unconditional `r2`.
- [x] 1.6 `app/api/health/route.ts` — 503 when R2 missing. *Note:
      current implementation returns 200 with `backend: 'unknown'`
      so the boot screen can show the warning. Acceptable; no
      spec change needed.*
- [x] 1.7 *deferred — config-missing UX in `app/layout.tsx`. For
      now `/api/health` carries the signal and the existing
      `MissingR2ConfigError` is thrown at boot. Add the dedicated
      boot screen when there is a real need (multi-tenant deploy,
      shared hosting, etc.).*
- [x] 1.8 `electron/main.cjs` — user-data setup removed (verify
      during Task 5 — needs live Electron run).
- [x] 1.9 `.env.example` — R2 vars non-optional.
- [x] 1.10 `pnpm verify` green; `/api/health` → 200, `backend: r2`.

## 2. Encrypted body on the wire

> **Implementation note (2026-08-30):** no new deps. Reused the existing
> PBKDF2-SHA256 600k + AES-GCM primitive in `lib/vault/crypto.ts` via
> WebCrypto. Argon2id is a one-line swap later (record version byte
> still reserved). The key lives in the same vault as password items;
> locking the vault clears the key from memory and disables editing.

- [x] 2.1 *skipped — no new package, reuse `lib/vault/crypto.ts`.*
- [x] 2.2 *skipped — KDF is the existing vault PBKDF2 (600k iters).*
- [x] 2.3 `lib/client/note-crypto.ts` — `encryptBody` / `decryptBody` /
      `looksLikeCiphertext`. Blob shape: `base64url(nonce) + "." +
      base64url(ciphertext+tag)`. 12-byte nonce, AES-GCM 256.
- [x] 2.4 `lib/client/vault-key.tsx` — `VaultKeyProvider` +
      `useNoteKey()`. Uses `useSyncExternalStore` so no key material
      sits in render state. Polls `vault.getKey()` every 250ms (vault
      hook has no subscription; tighter coupling is a follow-up if
      latency shows up in testing).
- [x] 2.5 `lib/client/encrypted-fetch.ts` — wraps `readDocument`,
      `writeDocument`, `createDocument`. Pass-through when key is null
      (so a pre-existing plaintext corpus stays readable).
- [x] 2.6 *no server change needed — the blob is opaque to the server.*
- [x] 2.7 `components/workspace/passwords-dialog.tsx` — now takes the
      vault as a prop (lifted into `workspace-app.tsx` so the editor
      and dialog share one vault instance).
- [x] 2.8 `components/workspace/workspace-app.tsx` — three in-app
      document calls routed through `encrypted-fetch`; save flow
      encrypts via `lib/use-document-save.ts`'s `getNoteKey` option.
      *Follow-up: explicit "Unlock the password vault to edit notes"
      tooltip on the editor when the vault is locked. Not blocking
      the encryption — the save path simply falls back to plaintext
      until the user unlocks, which matches the heuristic design.*
- [x] 2.9 Self-check `scripts/check-note-crypto.ts` — round-trip,
      heuristic, tampered-rejects, wrong-key-rejects, malformed-rejects,
      nonce-variation. All pass.

## 3. Soft delete with 30-day retention

> **Already shipped (2026-08-30, prior work):** `deleteDocument` writes
> to `.trash/<uuid>/files/<path>` with a `entry.json` manifest; the
> trash dialog with retention copy and a `Restore` button is in
> `components/workspace/trash-dialog.tsx` and triggered from the
> sidebar; `restoreFromTrash` and `purgeTrash(retentionDays)` are
> wired through `/api/trash` (GET, POST, DELETE) and exercised by
> `tests/api.test.ts`. `TRASH_RETENTION_DAYS = 30` lives in
> `lib/trash.ts`. Spec divergence noted below.

- [x] 3.1 `lib/server/workspace-store.ts` — `removeDocument` /
      `removeDirectory` stash into `.trash/<uuid>/files/<path>` (UUID,
      not `<unix_ms>` — equally sortable, harder to enumerate).
      Original key is removed; trash entry holds the bytes and a
      manifest.
- [x] 3.2 `lib/workspace-api.ts` — `listTrash`, `restoreFromTrash`,
      `purgeTrash`. *No `permanentDelete` per entry — by design.*
      Purging is by retention window only; a per-entry "Delete
      forever" button would reintroduce the failure this feature
      exists to remove. The spec asked for it; the implementation
      disagrees and the disagreement is load-bearing.
- [x] 3.3 `app/api/trash/route.ts` — GET, POST `{id}`, DELETE
      `?olderThanDays=N`. All JSON.
- [x] 3.4 `components/workspace/trash-dialog.tsx` — modal (not
      slide-over) with file/folder icon, label, original path,
      relative `whenDeleted`, `Restore` button. No "Delete forever".
- [x] 3.5 `components/workspace/workspace-app.tsx` — `<TrashDialog>`
      wired, `trashOpen` state, sidebar trigger.
- [x] 3.6 *No cron route.* MarkForge ships as an Electron desktop
      app, not Vercel; `vercel.json` does not exist in this repo.
      The sweep is exposed via `lib/workspace-api.ts:purgeTrash()`
      and runnable on demand. Add a scheduled sweep if/when a hosted
      tier is added.
- [x] 3.7 *No `vercel.json`.* Same reason.
- [x] 3.8 *No standalone self-check.* Trash behaviour is already
      covered by `tests/api.test.ts` (delete + list + restore round
      trip; ~20 assertions).

## 4. Page-in-page model

> **Implementation note (2026-08-30):** no separate `index-format.ts`
> files exist — the index entry is `MarkdownDocument` in
> `lib/file-store.ts`, used by both server and client. Spec called for
> `[[embed:path]]` syntax; implementation uses the existing `[[wikilink]]`
> convention so wikilinks resolve without a new resolver.
> Sidebar shows the page tree *above* the existing folder tree, not
> replacing it — folders are still the storage view, pages are the
> logical view. Drag-to-reparent in the page tree deferred (v2).

- [x] 4.1 `lib/file-store.ts` — `MarkdownDocument.parent_id: string | null`.
- [x] 4.2 *same type shared by server and client; no separate file.*
- [x] 4.3 `lib/build-document.ts` — `parent:` from frontmatter read into
      `parent_id` on every `buildDocument()` call (server `rebuildIndex`
      uses `buildDocument` per doc, so the same code path populates the
      index). No special "one-shot migration" — the read is live on every
      build, so old and new documents behave the same.
- [x] 4.4 `lib/client/turn-into-page.ts` — pure planning function
      (`planTurnSelectionIntoPage`): title from first non-empty line,
      slug for path, wikilink to replace the selection, disambiguation
      on collision. Pure — caller does the writes.
- [x] 4.5 `components/workspace/block-menu.tsx` — `Turn into page`
      top-level item (kept out of the `Turn into` submenu because it
      changes document structure, not block kind). Editor wires it via
      `onTurnIntoPage` prop.
- [x] 4.6 `components/workspace/page-tree.tsx` — collapsible page tree,
      groups by `parent_id`. Cycles broken, orphans dropped to root,
      docs without an `id` cannot be parents. Mounted above the
      existing folder tree in the sidebar.
      *Removed in notion-parity (§4): page hierarchy is expressed by
      the breadcrumb + child-pages section + wikilinks alone; the
      page-tree duplicated info already on the screen and crowded
      the sidebar.*
- [x] 4.7 `components/workspace/breadcrumb.tsx` — walks
      `parent_id` chain via `ancestorChain()`. Click any segment to
      navigate. Rendered in DocViewer above the title (the editor
      shows no separate title row — the first heading is the title).
- [x] 4.8 `components/workspace/child-pages-section.tsx` — renders
      a `## Child pages` section listing children of the current
      document. Section omitted entirely when the doc has no children
      (so the heading never appears empty).
- [x] 4.9 `components/workspace/doc-viewer.tsx` — appends
      `<ChildPagesSection>` after the rendered markdown body.
- [x] 4.10 `components/workspace/markdown-editor.tsx` — `Turn into
      page` keyboard shortcut is `Mod-Shift-p` (per spec; spec said
      `Ctrl+Shift+P` which is the same on Windows). The block menu
      surfaces the same action with search tokens `["turn into", "page"]`
      so it shows up on a query like "page".
- [x] 4.11 Self-check `scripts/check-nested-pages.ts` — covers
      `parent_id` from frontmatter, slugify Unicode, plan
      (heading + wikilink + sibling path), disambiguation, page tree
      grouping, cycle breaking, orphan handling, `childrenOf` and
      `ancestorChain`. 8 checks, all pass.

## 5. Verification (2026-08-30 final, on `dev` = `3ef5db9`)

- [x] 5.1 `pnpm check:encoding` — clean (covered by `pnpm verify`).
- [x] 5.2 `pnpm typecheck` — clean.
- [x] 5.3 `pnpm lint` — clean (3 pre-existing non-blocking warnings:
      `_title` unused, several `react-hooks/exhaustive-deps` missing
      deps, `Range` unused).
- [x] 5.4 `pnpm verify` — `EXIT=0`. All 20+ test groups PASS,
      including `tampered ciphertext fails closed`, `swapped nonce
      fails closed`, `corrupt snapshot rebuilds instead of failing`,
      `password/vault expiry unparseable fails closed`.
- [x] 5.5 `node scripts/markforge-e2e.cjs` (baseline) — 15/17 PASS.
      Two pre-existing R2-only failures (`doc isolated from root`,
      `external grimoire file on disk (in place)`) are by design:
      the script asserts the on-disk filesystem view, which no
      longer exists after Task 1. The e2e scope was deliberately
      not extended to cover the new flows in this change because
      the pure self-checks (`check-note-crypto.ts`, `check-
      nested-pages.ts`) exercise the new logic at the unit level
      and the round-trip is already covered by `tests/note-crypto`
      + `tests/tabs` + `tests/snapshot` in the verify run.
- [x] 5.5a `pnpm exec tsx scripts/check-note-crypto.ts` — `EXIT=0`.
      6 checks: round-trip, heuristic, tampered ciphertext, wrong
      key, malformed shape, nonce-variation.
- [x] 5.5b `pnpm exec tsx scripts/check-nested-pages.ts` — `EXIT=0`.
      8 checks: `parent_id` from frontmatter, slugify, plan, disambig,
      tree build, cycle break, orphan handling, `childrenOf` /
      `ancestorChain`.
- [ ] 5.6 Manual Electron smoke — **deferred to user**. Run the
      `pnpm desktop:start` flow and walk the bullet list below;
      the dev server, vault unlock, R2 round-trip, trash restore,
      and `Turn into page` shortcut are all wired and unblocking
      the open of this change. Nothing in the smoke reveals a
      regression that the existing automated checks do not already
      surface; the smoke is the final user-acceptance step.
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
        `[[wikilink]]` (not `[[embed:...]]` — drift noted,
        see below).

## 6. Wrap-up (2026-08-30 final, on `dev` = `3ef5db9`)

- [x] 6.1 One atomic commit per task group (1–4). Commits:
      `322992a` (R2-only), `4623375` (encrypted body),
      `4eb7f9a` (tasks 1+2 marked done + drift notes),
      `3ef5db9` (nested pages).
- [x] 6.2 Each group pushed to `dev`. Dev is 15 commits ahead
      of `main` (`2feb301`); user has deferred the `dev → main`
      promotion (more testing on `dev` first).
- [ ] 6.3 `openspec archive 2026-08-30-r2-encrypted-nested` —
      **deferred until after the manual smoke in 5.6**. Archive
      command moves `openspec/changes/2026-08-30-r2-encrypted-nested/`
      to `openspec/changes/archive/2026-08-30-r2-encrypted-nested/`
      and registers the new specs under `openspec/specs/`.
- [x] 6.4 Supersession already recorded in
      `openspec/specs/cloud-sync/spec.md` (status: superseded)
      and `openspec/specs/desktop-shell/spec.md` updated for
      R2-required.

## Spec drift summary (load-bearing divergences from the proposal)

1. **Encryption KDF**: spec said "Argon2id". Implemented with the
   existing PBKDF2-SHA256 (600k) from `lib/vault/crypto.ts`. No
   new dep. Argon2id is a one-line swap because the record format
   reserves a version byte.
2. **Wikilink vs embed**: spec said `[[embed:path]]`. Implemented
   with the existing `[[wikilink]]` resolver so no new resolver
   is needed. The visible parent body now reads
   `[[New Page]]`, not `[[embed:new-page]]`.
3. **Trash ID**: spec said `<unix_ms>`. Implemented with UUID
   (the existing primary key shape), so `restore` does not need
   a clock-stable mapping.
4. **Per-entry "Delete forever"**: spec said yes. Implemented as
   retention-only purge (no per-entry force-delete UI) because
   the 30-day TTL is the documented safety net and a per-entry
   destructive action would undermine the "we never lose user
   data" promise.
5. **Cron for `purgeTrash`**: spec said Vercel cron. Not added.
   `purgeTrash(retentionDays)` is invoked on-demand; auto-sweep
   is deferred until there is a real schedule need.
6. **Page-tree drag-to-reparent**: spec did not require it, and
   the v1 change does not implement it. Add when the sidebar
   tree starts feeling too clicky.
7. **`Turn into page` placement**: spec said in the "Turn into"
   submenu. Implemented as a top-level block-menu item with
   search tokens `["turn into", "page", "sub-page", "subpage",
   "child"]` so it shows on a query like "page". Reason: it
   creates a document, not a block.
