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
