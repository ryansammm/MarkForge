# MarkForge

> A browser-native workspace for a connected Markdown vault — where plain `.md`
> files stay the source of truth, and any document can become a public URL in one
> click. Runs on the web (Vercel) and on your desktop (Electron).

Your notes remain plain `.md` files you can open in vim, edit in Obsidian, and put
in git. MarkForge adds an editor, a link graph, search, sharing and a recovery
story on top of them — and never becomes the only thing that can read them.

- **Web**: https://mark-forge-gamma.vercel.app (Cloudflare R2 storage, durable)
- **Desktop**: `MarkForge.bat` (builds once, then launches the Electron app)
- **Status**: v1.0.0 · CI verify active · audit 2026-08-25 clean

---

## What it does

### Editing

- **Obsidian-style live preview.** Headings, emphasis, inline code and `[[wikilinks]]`
  render inline while you type and reveal their raw syntax the moment the cursor
  enters them. The decorations are view-only: the buffer *is* the file, byte for byte.
- **Plain-Markdown formatting.** A floating format bar and `Mod-B`/`Mod-I`/`` Mod-` ``
  write the same bytes a person typing by hand would. No editor-specific syntax,
  no document model.
- **`[[` autocomplete** across the whole workspace — matched on title, filename and
  folder — plus `Mod`+click to follow links and `Mod-Space` to reopen the list.
- **Fenced code reads like code** in reading view: labelled, highlighted, copyable.
- **Images by drag & drop or paste** into `assets/`, referenced as plain CommonMark.
- **Slash commands** (`/`) for quick block insertion while writing.

### Organising

- **Explorer with drag & drop** from Windows Explorer: drop `.md` files or whole
  folders to import in bulk (create-only; re-import never overwrites).
- **Pinned rail & favourites**, recent-edits list, trash with restore, folder tree
  collapsed by default.
- **Rename/move with link repair** — every `[[wikilink]]` pointing at a moved file
  is rewritten.

### Sharing & safety

- **One-click public share links** (`/share/[token]`) with revocation.
- **Password gate** for the private workspace; session cookie auth.
- **Trash-first deletes**, backup snapshots, asset garbage collection.
- **Encoding gate** — every commit and CI run scans sources for mojibake/BOM so
  non-ASCII text (em-dashes, ⌘, ©, ellipses) can never silently corrupt again.

### Two backends, chosen by environment

| | Backend | Durable |
|---|---|---|
| Vercel / cloud | Cloudflare R2 (S3 API) | ✅ |
| Desktop | `%APPDATA%\MarkForge\notes` (plain files) | ✅ local |

The desktop shell additionally offers **Sync to cloud** to push the local vault
up to R2 (requires `.env` with R2 credentials).

---

## Running it

### Web (development)

```powershell
pnpm install
pnpm dev          # http://localhost:3000
```

Optional cloud mode — copy `.env.example` to `.env` and fill in:

```
R2_ACCOUNT_ID=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  R2_BUCKET=...
APP_PIN=<6 digits>   SESSION_SECRET=<random 32+ chars>
```

Without R2 vars the app runs on the filesystem backend automatically.

### Desktop (Windows)

**Option A: Start Menu shortcut** (recommended)
- Click "MarkForge" in Start Menu → auto-builds on first run, then launches.

**Option B: Manual**
```powershell
MarkForge.bat     # builds once, then launches Electron app
```

**Option C: Direct** (instant, no build)
```powershell
dist\win-unpacked\MarkForge.exe
```

The desktop app spawns its own Next.js standalone server on `127.0.0.1:3457`
via Electron's embedded Node, then opens the window.

### Verification before shipping

```powershell
pnpm verify            # deps + encoding gate + tsc + eslint + full test suite + build
node scripts/check-standalone.mjs   # boots .next/standalone and polls /api/health
```

## Architecture in one paragraph

Next.js 16 (App Router, Turbopack) renders the workspace UI and serves `/api/*`
routes that talk to a `WorkspaceStore` abstraction with two `Bucket` backends:
`FsBucket` (plain files + `_meta` JSON sidecars) and `R2Bucket` (S3-compatible).
The Electron shell (`electron/main.cjs`) is a thin launcher: in dev it runs `next`,
packaged it boots the traced standalone server as an embedded-Node child process
and points Chromium at it. `scripts/after-pack.cjs` assembles `resources/server`
and supplements the AWS SDK family from the pnpm store, because file tracing under
pnpm's hoisted layout cannot see through Turbopack's externalized chunks.

## Repository layout

```
app/                 routes, API handlers, theme
components/          editor, explorer, sidebar, workspace shell
lib/server/          store abstraction: FsBucket, R2Bucket, WorkspaceStore
lib/                 client-side index/search/frontmatter utilities
electron/            main.cjs desktop launcher
scripts/             after-pack, check-encoding, sync-storage, …
tests/               tsx test suites (run via pnpm test)
openspec/            spec-driven change history
docs/                WORKFLOW.md, audit reports
```

## Documentation

- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — development workflow, packaging, troubleshooting (incl. the encoding gate)
- [`docs/AUDIT-2026-08-25.md`](docs/AUDIT-2026-08-25.md) — full-system audit report

## License

Private project. All rights reserved.
