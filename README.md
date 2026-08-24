# Markdown Workspace ("Morrow")

> A browser-native workspace for a connected Markdown vault, where the files stay the
> source of truth and any document can become a public URL in one click.

Your notes remain plain `.md` files you can open in vim, edit in Obsidian, and put in
git. This app adds an editor, a link graph, search, sharing and a recovery story on
top of them — and never becomes the only thing that can read them.

---

## What it does

### Editing

- **Obsidian-style live preview.** Headings, emphasis, inline code and `[[wikilinks]]`
  render inline while you type and reveal their raw syntax the moment the cursor
  enters them. The decorations are view-only: the buffer *is* the file, byte for byte.
- **Plain-Markdown formatting.** A floating format bar and `Mod-B`/`Mod-I`/`` Mod-` ``
  write the same bytes a person typing by hand would. There is no editor-specific
  syntax and no document model.
- **`[[` autocomplete** from the in-memory index — every document in the workspace,
  matched on title, filename *and* folder, narrowing as you type — and `Mod`+click to
  follow a link. `Mod-Space` reopens the list inside a `[[` you have dismissed.
- **Fenced code reads like code.** In the reading view a ` ```sql ` block is labelled,
  syntax-highlighted and copyable in one click. The colours come from the same
  CodeMirror grammars the editor uses, loaded only when a document actually contains
  code in that language, so a block does not change appearance when you press Edit.
- **Images by drag and drop, or paste.** The file lands in your vault under `assets/`,
  and the document gets `![alt](assets/2026/…png)` — plain CommonMark with a
  vault-relative path, so the same note opens with working pictures in Obsidian or a
  git checkout. Nothing is written to the document until the upload has actually
  succeeded, so a failed one leaves no half-finished link behind. Images render inline
  in the editor and reveal their raw link when the caret reaches them, exactly as
  every other bit of syntax does.
- **Click a picture to open it properly.** Any image in a document — reading view,
  editor, or a public share — opens in a viewer sized to the screen, where the wheel
  or a pinch zooms about the pointer, dragging pans, and double-click toggles between
  fitting the screen and the image's own pixels. `+` and `-` step, `0` refits, arrows
  pan, `Esc` closes. A large screenshot opens scaled to fit and never larger than 1:1,
  so a small icon is shown at its real size rather than blown up. In the editor the
  way in is the ⤢ button on the picture, or Ctrl/Cmd-click — a plain click still puts
  the caret on the line and reveals the raw `![alt](…)`, which is how alt text is
  edited. An image that cannot load names the file it was looking for instead of
  showing a broken-image icon.
- **Round-trip integrity is structural, not defended by tests.** Saving writes the
  buffer verbatim; normalization is an explicit action, never implicit.
- **A document knows when it was written.** The first in-app save stamps `created:`
  into frontmatter alongside its `id`, and never touches it again — so the date
  survives a move between storage backends, a restore from the trash and a `git
  clone`, none of which a file's own timestamps survive. "Updated" is the stored
  object's real modification time; reading a document does not restamp it.

### Navigating

- **Wikilinks and ghost pages.** `[[Note]]` and `[[Note|label]]` resolve by id, then
  title, then alias, then filename, then path — exact matches only. An unresolved link
  is visibly a ghost, and clicking it creates the document it names.
- **Ordinary Markdown links stay in the app.** `[label](../Other Note.md)` resolves
  against the vault — by path, then by name, the same way a wikilink does — and opens
  a tab here rather than asking the browser to load a filename as a URL. Only links
  that really do point at the web leave.
- **Backlinks**, with a context line per referencing document.
- **Outline** that jumps to the heading, computed with the same slugs the renderer
  emits, and aware that a `#` inside a fenced code block is a shell comment.
- **Server-side full-text search** on `Cmd/Ctrl+K`.
- **Rename rewrites inbound links** by byte-offset splicing, and reports per-file
  success or failure. When it cannot rewrite every link, the old title is recorded in
  the renamed document's `aliases:` so the stragglers keep resolving. The document's
  own H1 follows the new name too — a title comes from the heading first, so without
  that the sidebar, the tab and the breadcrumb all went on showing the old one and the
  rename looked as though it had not happened.

### Keeping your writing

- **Deleting is recoverable.** Documents and folders go to a trash for 30 days, with
  Undo on the toast and a restore list. A restore never overwrites a path that has
  been reoccupied.
- **A refused save is not a lost save.** When a file changed underneath you, the write
  is refused *and* your version is written beside it as `<name>.conflict.md`, named
  back to you as a link.
- **Backups that have been restored.** `npm run backup` snapshots the corpus, share
  tokens, the encrypted vault and trash; `--restore` and `--verify` ship with it.
- **The index is disposable.** It is derived data, rebuildable from the documents
  alone with `POST /api/storage?action=reindex`.

### Sharing

- **One-click public links**, resolvable **by token and nothing else** — never by
  title or path. Optional expiry and optional password (scrypt).
- **Every failure is an identical 404.** Unknown, revoked, expired, out of scope: one
  response, so a link can never become an existence oracle.
- **The reader page ships no editor bundle**, and out-of-scope wikilinks render as
  plain text rather than as broken links.
- **Images are scoped to the share.** A shared page serves only the pictures its own
  documents embed, through the token and never through the private asset route. An
  image belonging to a document you did not share answers the same 404 as one that
  does not exist — a link is not a key to the whole vault's pictures.

### Passwords

- **A zero-knowledge vault**, separate from your notes. Credentials are encrypted in
  the browser (PBKDF2-SHA256 at 600k iterations, AES-256-GCM) under a master password
  that is never sent anywhere. The server stores one opaque blob and cannot read it —
  neither can the bucket, a backup, a log, or a share.
- **Separate from your Morrow session.** Signing in gets you the app; the master
  password gets you the vault. The vault locks after 15 minutes idle, a minute after
  the tab goes to the background, and on every reload — there is nowhere it persists.
- **Not a document.** It is not in the index, not in search, not in the file tree, and
  not addressable through `/api/files`. `tests/vault.test.ts` asserts each of those.
- **Nothing can reset the master password**, including Morrow. That is what
  zero-knowledge costs, and the onboarding screen says so before you commit.

### Running it

- **Signed, expiring sessions** — the cookie carries no secret and slides while you
  use it. Constant-time password comparison, rate-limited sign-in.
- **Rate and size limits** on every write route.
- **`/api/health`** for uptime monitors, answering 503 when writes would not survive,
  plus a permanent in-app banner in that case.
- **Structured logs that never contain a path, a title, or a token** — for a private
  notes app, the filenames *are* the sensitive material.

---

## Architecture

### The shape

```
  browser
    │  index.json (metadata only)   ─ boot
    │  /api/files?path=…            ─ one document's bytes, on demand
    │  /api/search?q=…              ─ ten results
    ▼
  Next.js route handlers
    │
  WorkspaceStore        ← every rule lives here, exactly once:
    │                     etags, If-Match, path containment, index patching,
    │                     id assignment, trash, conflict copies
  Bucket                ← an interface that only moves bytes
   ┌──┴────────┬─────────────┐
 FsBucket   R2Bucket   MemoryBucket
```

`WorkspaceStore` owns the rules; backends only move bytes. `tests/backend.test.ts`
runs one scenario against all three and requires the resulting index to be identical —
so "the backends behave the same" is a tested claim, not an intention.

### What lives where in storage

| | Holds | Notes |
|---|---|---|
| documents | your `.md` files | the product; the only thing that is not derived |
| `index.json` | paths, titles, links, backlinks, excerpt, word count | **no document bodies** — disposable, rebuildable |
| `search.json` | document text plus the etag it was read at | server-side only; makes cold starts fast |
| `shares.json` | share tokens | live credentials, gitignored, survives a reindex |
| `password-vault.json` | the encrypted vault | ciphertext only — the server cannot read it. Gitignored, and the one file in a backup that nothing else can reconstruct |
| `.trash/` | deleted documents | outside the corpus keyspace, so nothing that reads the corpus can see them |

**Bodies are not in the index.** They were 81% of a 4.68 MB payload the browser parsed
on every boot and the server rewrote on every save. Reading a document fetches it;
search runs where the bodies already are. See [docs/index-split.md](docs/index-split.md).

### Measured, at 2,000 synthetic documents

Memory backend, so these are floor numbers — R2 adds a round trip. `npm run benchmark`.

| | |
|---|---|
| `index.json` | 1.23 MB (646 bytes/document) |
| one save, p50 | 13.8 ms |
| search query | 4–7 ms |
| first search after a cold start | 253 ms with a snapshot |
| rename with 53 inbound links | 1.1 s |
| full reindex | 5.1 s |

### Directory map

```
app/
  api/
    auth/         sign in and out (signed session cookie)
    files/        read, write, delete, move a document
    folders/      folder CRUD
    rename/       rename + inbound-link rewrite, with a dry run
    search/       server-side full-text search
    share/[token] public share read + unlock  (the only public route)
    shares/       share management (private — note the plural)
    trash/        list, restore, purge
    vault/        the encrypted password vault (ciphertext both ways)
    index/        the live workspace index
    storage/      diagnostics, and reindex
    health/       liveness and durability (public)
  login/          password gate
  share/[token]/  public reader page (no editor bundle)
components/workspace/
  workspace-app.tsx    state coordinator and layout
  markdown-editor.tsx  CodeMirror 6 editor
  live-preview.ts      inline rendering decorations (view-only)
  editor-commands.ts   formatting as plain-Markdown StateCommands
  doc-viewer.tsx       reading view
  sidebar.tsx          file tree, drawer below md
  search-dialog.tsx    Cmd+K
  {backlinks,toc,recent-edits,details}-panel.tsx
  {share,trash,workspace}-dialog(s).tsx
  passwords-dialog.tsx password vault; shares no state with the workspace
  password-item-form.tsx one credential, with the generator attached
lib/
  vault/               record format, WebCrypto, items, generator, lock state

  file-store.ts        the storage contract and its errors
  build-document.ts    raw text → document (title, links, excerpt, word count)
  index-patch.ts       incremental index maintenance (and body stripping)
  session.ts           signed session tokens (Edge-safe, Web Crypto)
  markdown/            frontmatter, links, wikilinks, headings, serializer
  server/
    workspace-store.ts the rules
    bucket.ts          the storage interface + MemoryBucket
    fs-bucket.ts       filesystem backend
    r2-bucket.ts       Cloudflare R2 backend
    search.ts          corpus, snapshot, query
    share-store.ts     share model and resolution
    rename.ts          rename planning and execution
    trash.ts / rate-limit.ts / request-limits.ts / observability.ts
middleware.ts          the access gate
instrumentation.ts     framework error seam
scripts/
  ingest.ts backup.ts benchmark.ts sync-storage.ts check-deps.mjs
```

---

## Quick start

```bash
npm install
```

Create `.env.local`:

```env
# Leave empty to run without a gate locally.
APP_PASSWORD=your_workspace_password
```

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000). With no R2 configured, the
app reads and writes the local `notes/` directory.

To load an existing vault:

```bash
npm run ingest -- ./my-obsidian-vault
```

---

## Configuration

| Variable | Purpose |
|---|---|
| `APP_PASSWORD` | The workspace password. Empty disables the gate — local development only. |
| `SESSION_SECRET` | Signing key for session cookies. **Set this in production.** Without it the key is derived from `APP_PASSWORD`, which couples every password change to a global sign-out. |
| `ERROR_WEBHOOK_URL` | Slack or Discord incoming webhook. Errors are posted here, with paths and tokens stripped. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Configure all four to use R2. Missing any one falls back to the filesystem. |
| `R2_PREFIX` | Key prefix for documents. Default `notes`. |
| `R2_META_PREFIX` | Key prefix for metadata. Default `_meta`. Change it only for test isolation — moving it orphans an existing `shares.json`. |
| `R2_JURISDICTION` | `eu` for EU-jurisdiction buckets. |
| `R2_ENDPOINT` | Override the endpoint. Must not include the bucket name. |
| `NOTES_DIR`, `META_DIR`, `INDEX_PATH`, `SHARES_PATH` | Filesystem backend locations. |
| `R2_TEST_BUCKET` | A **scratch** bucket for `npm run test:r2`. Deliberately not `R2_BUCKET`: that suite writes and deletes. |

---

## Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | the usual |
| `npm run verify` | deps → typecheck → lint → test → build. The gate CI runs. |
| `npm test` | fifteen suites: 336 checks, plus the round-trip property suite |
| `npm run test:r2` | R2 write-path suite; skips without `R2_TEST_BUCKET` |
| `npm run benchmark [n]` | corpus-scale measurements |
| `npm run backup` | snapshot; `-- --verify <dir>` and `-- --restore <dir>` |
| `npm run ingest -- <dir>` | load a corpus |
| `npm run sync -- --from fs --to r2` | copy a corpus between backends |

---

## Deployment (Vercel)

1. Push to your Git provider and import the project.
2. Set `APP_PASSWORD`, `SESSION_SECRET`, the four `R2_*` variables, and
   `ERROR_WEBHOOK_URL`.
3. Deploy, then check `/api/health` — it must report `durable: true`. If it does not,
   R2 is not configured and **every save will be lost at the next cold start**, which
   is why the app shows a permanent banner in that state.

---

## Documentation

| | |
|---|---|
| [production-readiness-plan.md](docs/production-readiness-plan.md) | The four gates, and what is left |
| [runbook.md](docs/runbook.md) | For whoever is holding this at 2am |
| [storage-backends.md](docs/storage-backends.md) | The Bucket split and R2 specifics |
| [index-split.md](docs/index-split.md) | Why bodies left the index, with numbers |
| [phase-1-data-safety.md](docs/phase-1-data-safety.md) | Trash, backups, concurrent writes, conflict files |
| [phase-2-access-control.md](docs/phase-2-access-control.md) | Sessions, limits, share hardening |
| [phase-3-operability.md](docs/phase-3-operability.md) | CI, logging and redaction, health |
| [phase-4-scale.md](docs/phase-4-scale.md) | The benchmark, mobile, accessibility |
| [sprint-3-editor-decision.md](docs/sprint-3-editor-decision.md) | Why CodeMirror and not a block editor |
| [sprint-6-share-model.md](docs/sprint-6-share-model.md) | Why a share resolves by token alone |
| [password-manager-plan.md](docs/password-manager-plan.md) | The vault: threat boundary, record format, and the Phase 0 decisions |

---

## Known limits

Stated plainly, because each is a deliberate trade rather than an oversight:

- **No per-session revocation.** Sessions are stateless signed tokens — the middleware
  that must reject them runs on the Edge runtime with no store to consult. Rotating
  `SESSION_SECRET` or `APP_PASSWORD` signs everyone out at once.
- **Rate limiting is per-instance.** On serverless, N instances mean N times the
  allowance. It raises the cost of an online attack; it is not a distributed limiter.
- **Rename is a foreground operation**, and every save still rewrites the whole index.
  Both are linear in corpus size.
- **No collaboration, no AI, no mobile app.** The link graph and file integrity are
  what this product competes on.
- **Setext headings** (`Title` over `=====`) do not appear in the outline; ATX only.
- **A forgotten master password is a lost vault.** No recovery key in this release, and
  Morrow genuinely cannot help — that is what zero-knowledge means, not a missing
  feature. The vault also has no trash: deleting a credential deletes it.
- **The vault's KDF is PBKDF2, not Argon2id.** Argon2id is the better choice and is
  where this is headed; the record format already carries its parameters so a vault
  can be re-sealed under it on a later unlock. See the plan for why the WebCrypto
  option shipped first.
- **The vault's user flows are not covered by an automated E2E suite**, because the
  project has no browser-test harness. The crypto, store, API, and isolation
  properties are covered by `tests/vault.test.ts`.

## License

MIT
