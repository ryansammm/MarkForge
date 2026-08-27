# MarkForge — Offline Desktop

> A local-first Markdown workspace for your connected notes — plain `.md` files stay
> the source of truth, edited in place, with no account and no cloud.

MarkForge is a desktop app (Electron) for writing and organising a Markdown vault that
lives entirely on your disk. Your notes are plain `.md` files you can open in vim, edit
in Obsidian, and put in git. MarkForge adds an editor, a link graph, search and a
recovery story on top — and never becomes the only thing that can read them.

This branch (`offline`) is the **fully offline build**: the desktop app never talks to
Cloudflare R2, and there is no "sync to cloud". Everything stays in local folders you
choose.

---

## Features

### Editing

- **Obsidian-style live preview.** Headings, emphasis, inline code and `[[wikilinks]]`
  render inline while you type and reveal their raw syntax the moment the cursor enters
  them. The decorations are view-only: the buffer *is* the file, byte for byte.
- **Plain-Markdown formatting.** A floating format bar and `Mod-B` / `Mod-I` / `` Mod-` ``
  write the same bytes a person typing by hand would. No editor-specific syntax.
- **`[[` autocomplete** across the whole workspace — matched on title, filename and
  folder — plus `Mod`+click to follow links and `Mod-Space` to reopen the list.
- **Fenced code reads like code** in reading view: labelled, highlighted, copyable.
- **Images by drag & drop or paste** into `assets/`, referenced as plain CommonMark.
- **Slash commands** (`/`) for quick block insertion. The menu opens at the start of a
  line, after whitespace, and after punctuation — but not inside a word or a URL.

### Organising — multiple grimoire folders

A **grimoire** is a folder. Unlike a single-vault app, MarkForge can open **several root
folders at once**, each backed by a real directory on disk:

- **Add any folder** with *Buka folder grimoire…* (sidebar header, or the **File** menu).
  The chosen folder becomes a grimoire and its `.md` files are edited **in place** — no
  copy, no import step.
- **First run** prompts you to pick your main folder; after that the choice is remembered
  in the registry and the app reopens the same folders every launch.
- **Each grimoire is independent.** Notes live at `<folder>/<name>.md`; the folder you
  picked is never moved or deleted by MarkForge (deleting a grimoire only drops the entry,
  it never touches your files).
- You can still create grimoires *inside* the app's data folder via the normal
  "new grimoire" flow; those live under `%APPDATA%\MarkForge\notes`.

The explorer, search, wikilinks and rename/link-repair all work per grimoire.

### Organising

- **Explorer with drag & drop** from Windows Explorer: drop `.md` files or whole folders
  to import in bulk (create-only; re-import never overwrites).
- **Pinned rail & favourites**, recent-edits list, trash with restore, folder tree
  collapsed by default.
- **Rename/move with link repair** — every `[[wikilink]]` pointing at a moved file is
  rewritten.

### Safety

- **Trash-first deletes**, backup snapshots, asset garbage collection.
- **Password gate** for the private workspace; session cookie auth (local only).
- **Encoding gate** — every commit and CI run scans sources for mojibake/BOM so non-ASCII
  text (em-dashes, ⌘, ©, ellipses) can never silently corrupt again.
- **One-click local share links** (`/share/[token]`) with revocation — served by the
  app's own local server, not the internet.

### Where things are stored

| | Location |
|---|---|
| App data (default grimoires, registry, indexes) | `%APPDATA%\MarkForge\` (`notes/` + `meta/`) |
| External grimoires | the folder **you** picked — edited in place |
| Registry (grimoire list + last active) | `%APPDATA%\MarkForge\meta/grimoires.json` |

The registry persists which folders are grimoires. Removing a grimoire from the list does
**not** delete the underlying folder.

---

## Running it

### Prerequisites

- Node 18+ and **pnpm** (`npm i -g pnpm`).

### Build & launch the desktop app

```powershell
pnpm install
pnpm desktop        # next build, then launches the Electron app
```

To relaunch without rebuilding:

```powershell
pnpm desktop:start  # launches Electron against the already-built app
```

The desktop app spawns its own Next.js standalone server on `127.0.0.1:3457` via
Electron's embedded Node, then opens the window. On first launch it prompts for your main
folder; choose *Buka folder grimoire…* later to add more.

### Web (development only)

The same UI runs in a browser for development. Without R2 variables it uses the local
filesystem backend automatically:

```powershell
pnpm dev            # http://localhost:3000
```

### Verify before shipping

```powershell
pnpm verify         # deps + encoding gate + tsc + eslint + full test suite + build
```

---

## Architecture in one paragraph

Next.js 16 (App Router) renders the workspace UI and serves `/api/*` routes that talk to a
`WorkspaceStore` abstraction with two `Bucket` backends: `FsBucket` (plain files + `_meta`
JSON sidecars) and `R2Bucket` (S3-compatible, used only when R2 env is present). On the
`offline` branch the desktop shell forces `MARKFORGE_OFFLINE=1`, so `createBucket()` always
returns `FsBucket` and R2 credentials are blanked. A grimoire with a `path` gets its own
`FsBucket` rooted at that folder, so its document keys are relative to it. The Electron
shell (`electron/main.cjs`) is a thin launcher: in dev it runs `next dev`, packaged it boots
the traced standalone server as an embedded-Node child process and points Chromium at it.

## Repository layout

```
app/                 routes, API handlers, theme
components/          editor, explorer, sidebar, workspace shell
lib/server/          store abstraction: FsBucket, R2Bucket, WorkspaceStore, grimoire
electron/            main.cjs desktop launcher (offline, local only)
scripts/             check-encoding, build-portable, …
tests/               tsx test suites (run via pnpm test)
openspec/            spec-driven change history
```

## Documentation

- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — development workflow, packaging, troubleshooting
- Original web/cloud README history lives in `openspec/changes/archive/`.

## License

Private project. All rights reserved.
