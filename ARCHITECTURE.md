# MarkForge — Architecture

A fully-offline, privacy-first Markdown editor that ships as a desktop app
(Electron) on top of a Next.js web app. This document describes how the pieces
fit together. It is the companion to `README.md` (how to run) and the
`openspec/` specs (why things were decided); it focuses on *how the code is
laid out and flows*.

High-level shape:

```
┌──────────────┐   localhost:3457    ┌────────────────────────────┐
│  Electron    │ ──────────────────► │  Next.js (App Router)      │
│  (shell)     │   (http://127.0.0.1)│  └ middleware (session)    │
└──────────────┘                     │  └ /api/* route handlers   │
                                     │  └ ─ lib/server/* (logic)  │
                                     │       └ ─ Bucket (I/O)     │
                                     └────────┬───────────────────┘
                                              │
                              ┌───────────────▼────────────────┐
                              │  MemoryBucket | FsBucket | R2  │
                              └────────────────────────────────┘
```

## Core principle: one store, swappable backends

The whole data layer is split at the same seam:

- **`lib/server/workspace-store.ts`** — *all* the interesting rules: etags,
  If-Match preconditions, path containment, incremental index patching, id
  assignment, trash, grimoire scoping. There is exactly ONE implementation.
- **`lib/server/bucket.ts`** (`Bucket` interface) — just moves bytes. Three
  concrete backends implement it: `MemoryBucket` (tests), `FsBucket`
  (filesystem/local), `R2Bucket` (Cloudflare R2 / S3-compatible).

This split exists so two parallel stores can never drift, and the claim the
whole product rests on stays a property of the code: **the index is disposable,
and a rebuild from storage alone agrees with a sequence of edits.** The same
conformance test suite runs against every backend (`tests/backend.test.ts`,
`tests/store.test.ts`).

### The `Bucket` surface (`lib/server/bucket.ts`)

- **Documents** — `readText`, `writeText`, `deleteObject`, `objectExists`,
  `listKeys(prefix?)`. `listKeys` means "the corpus": real backends filter to
  `.md`, so images and metadata are never mistaken for documents.
- **Binary** — `readBinary`/`writeBinary` (+ `listBinaryKeys`, `statObject`
  for asset GC). Images live in the same keyspace as documents, under
  `ASSET_PREFIX` (`assets/`), because that is where a vault keeps them.
- **Folders** — `createFolder`, `deleteFolder`, `folderExists`, `listFolders`.
  Object storage has no directories, so empty folders are first-class and the
  backend decides how to record them.
- **Metadata** — `readMeta`/`writeMeta`/`listMeta`/`deleteMeta` +
  `writeMetaIfUnchanged`. Everything that is *not* the corpus (index,
  grimoires, shares, trash, search snapshot) lives here, kept out of the
  document keyspace so `listKeys` stays exactly "the corpus".
- **`writeMetaIfUnchanged`** is the compare-and-set that makes concurrent index
  writes safe across serverless processes: two instances can each read
  `index.json`, patch a different document, and write — without silently
  dropping the other's change.

### Backend selection (`lib/server/store.ts`)

`createBucket()` picks the backend from the environment:

- `MARKFORGE_OFFLINE === '1'` → `FsBucket` (forced offline; sees through any
  stale `R2_*` vars). This is what the desktop app sets.
- Otherwise R2 **if** every `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
  `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` is present (any empty string disables
  R2 → `FsBucket`).
- The choice is made from the environment rather than a flag so a deployment
  cannot silently "work" on an ephemeral filesystem and forget every edit.

`getStore()` returns a process-wide singleton (shared write queue). `backendHealth()`
reports `kind` and `durable` for the UI warning.

## Grimoires: multi-root isolated note groups

A **grimoire** is like an Obsidian vault / VS Code workspace — a self-contained
group of notes with its own tree. See `lib/server/grimoire.ts` and
`components/workspace/grimoire-switcher.tsx`.

- The **registry** lives at the metadata key `grimoires.json`
  (`GrimoireRegistry`), created/listed/renamed/deleted through
  `/api/grimoires` and `/api/grimoires/[id]`.
- Each grimoire has `{ id, name, createdAt, lastActive, path? }`. `path` is an
  **absolute folder on disk** for external grimoires (offline desktop);
  absent means notes live under `notes/<name>/`.
- Grimoire scoping is two-pronged:
  - **Index**: a grimoire's index is `_grimoires/{id}/index.json` (meta
    namespace), never the shared `index.json`.
  - **Documents**: `WorkspaceStore` is constructed per grimoire with
    `grimoireId`. Offline (desktop) grimoires — external *and* subfolder — each
    get a **dedicated `FsBucket`**: external rooted at the user's folder (edited
    in place), subfolder rooted at `notes/<name>/`. Rooting a bucket per grimoire
    keeps note keys relative to the grimoire's own folder, so a grimoire's writes
    can never collide with or leak into the ROOT namespace. The shared-bucket +
    `grimoireName`-prefix model was removed because the prefix was only ever
    applied by reindex, not by read/write/move, so every subfolder write leaked
    into root. The index lives in the shared meta namespace either way.
- External grimoires are never deleted by the app — only the registry entry
  and index are dropped, because the folder belongs to the user.
- Cached per id in `grimoireStores`; `clearGrimoireStore(id)` invalidates after
  rename/delete.

### How a request selects a grimoire (`lib/server/resolve-store.ts`)

`resolveStore(request)` returns the store for a request:

1. `X-Grimoire-Id` request header, else
2. `?grimoireId=` query parameter, else
3. the default root store.

The query-param fallback exists because `<img src>` asset URLs cannot set
headers; `assetUrl()` appends `&grimoireId=...` for exactly that reason.

### Client-side grimoire state (`lib/grimoire-client.ts`)

A tiny module mirrors the active grimoire into `localStorage`
(`markforge-active-grimoire`) and exposes `getActiveGrimoireId()`,
`setActiveGrimoireId(id)`, `grimoireHeaders()` (`{ 'X-Grimoire-Id': id }`),
and `onGrimoireChange`. On grimoire switch the workspace clears cached source
bytes and open tabs so no stale content from another grimoire can surface.

> **Scope bugs fixed (Fase 2):** index reload, search, asset rendering, and
> the switch-state reset were all once hard-wired to the root store. Now every
> client request carries the active grimoire (header or query param), and each
> grimoire has its own search index and search snapshot key
> (`_grimoires/{id}/search.json`).

## Search (`lib/server/search.ts`, `/api/search`)

Full-text search is served by Orama (`@orama/orama`). The corpus snapshot
(`search.json`, or per-grimoire `_grimoires/{id}/search.json`) stores each
document's path, title, text, and the etag it was read at.

- **Cold start** reconciles the snapshot against the index by etag and only
  re-reads drifted documents (in parallel, `READ_CONCURRENCY = 24`).
- **Within a process**, `noteWritten`/`noteRemoved` patch the corpus directly
  (cheap); the Orama instance is rebuilt lazily on next query.
- The snapshot is only rewritten once enough documents have drifted
  (`PERSIST_AFTER_DRIFT = 25`) to make the next cold start slow.
- `getSearchIndex(store)` is cached **per grimoire** (keyed by `grimoireId ?? '__root__'`),
  so searching the active grimoire searches that grimoire, and each grimoire's
  snapshot does not collide with the others'.

## Session & access control (`middleware.ts`, `lib/session.ts`)

- The gate sits in **middleware** (Edge runtime), so it runs on every request.
  It only performs a pure HMAC check — no I/O.
- The cookie (`morrow_session`) is a signed, expiring token
  `v1.<payload>.<HMAC-SHA256>` (Web Crypto only, no Node builtins). It carries
  **no secret**; a captured token is a time-limited session, not the password.
- No password configured (`APP_PASSWORD`/`SESSION_SECRET` absent) means no gate
  — the documented local-dev case.
- Sliding expiry: tokens re-issued past half their life; stop for a week and
  you're signed out. Rotating `APP_PASSWORD`/`SESSION_SECRET` invalidates every
  session at once (there is no per-session revocation list — see the note in
  `lib/session.ts`).
- `isPublic()` whitelists `/login`, `/api/auth`, `/api/health`, `/share/*`,
  `/api/share/*`, PWA assets. **Trailing slashes are load-bearing**: `/api/shares`
  (plural, the private management route) is deliberately NOT exempt.

## Request routing & helpers

- **Rate/size limits** (`lib/server/request-limits.ts`, `rate-limit.ts`):
  `assertDeclaredSize`, `enforceWriteRate`, `MAX_ASSET_BYTES`,
  `WRITE_LIMIT`/`checkRateLimit`. Applied at the top of mutating/expensive
  handlers.
- **Observability** (`lib/server/observability.ts`, `dev-log.ts`): `captureError`
  and structured `devLog` used consistently across handlers.
- Client-side, `lib/workspace-api.ts` is a typed wrapper over the routes: one
  place that knows how errors come back, plus `assetUrl()`/`resolveImageSrc()`
  (the only place URL shape leaks into views) and grimoire-aware calls.

### API surface (`app/api/*`)

| Route | Purpose |
|-------|---------|
| `GET/POST /api/grimoires`, `PATCH/DELETE /api/grimoires/[id]` | List/create/rename/delete grimoires (registry) |
| `GET/POST /api/index` | Read index / (helpers) for the active grimoire or root |
| `GET/POST/PATCH/DELETE /api/files` | Read/write/rename/delete documents (etag + If-Match) |
| `POST/DELETE /api/folders` | Create/delete folders |
| `GET/POST /api/assets` | Image delivery / upload (sniffed, size-limited) |
| `POST /api/rename` | Plan + execute renames (dry-run support) |
| `GET /api/search` | Full-text search, scoped to active grimoire |
| `POST /api/import` | Import notes |
| `GET /api/trash`, `POST /api/trash` | List trash; restore/empty |
| `GET /api/vault` … | Encrypted password vault (see below) |
| `POST /api/shares`, `/api/share/[token]`, `/api/share/[token]/asset` | Public read-only shares |
| `GET /api/storage` | Backend/durability health |
| `GET /api/health` | Public liveness + durability |
| `GET /api/auth` | Sign-in (password → mint session cookie) |

>`app/api/share/[token]/asset` and `app/api/share/[token]` serve the same bytes
>as `/api/assets` but unlock via a share token instead of a session — kept
>separate so an unauthenticated reader can't use `/api/assets` as an existence
>oracle for the whole vault.

## Assets (`lib/server/assets.ts`)

- Content type is **sniffed from the bytes** (`sniffImageType`), never trusted
  from the request; SVG is deliberately excluded to stop a declared-`image/png`
  payload from executing as HTML.
- `assetKeyFor`/`isAssetKey` centralize the `assets/` keyspace; `listBinaryKeys`
  + `statObject` power the asset garbage collector (`scripts/gc-assets.ts`).
- Storage path is chosen server-side, so the client cannot supply a path to
  escape from. Uploads return a vault-relative path the client stores in Markdown.

## Trash (`lib/server/trash.ts`)

Deletes are soft: bytes move into the metadata namespace under `TRASH_PREFIX`
with an id (`trashId`), which is what makes delete undoable. Trash is
invisible to the index, search, and share-scope resolution because none of them
can see the metadata namespace. `TRASH_RETENTION_DAYS` bounds recovery.

## Password vault (`lib/vault/*`, `app/api/vault/*`)

An encrypted password manager inside the app (client-side crypto, see
`lib/vault/crypto.ts`). The vault bytes are stored via the server; decryption
happens in the browser so a server compromise does not expose stored secrets.

## Shares (`lib/server/share-store.ts`, `lib/share.ts`)

Read-only sharing of documents/workspace scopes through opaque tokens
(`/share/[token]`). Resolution is by token alone; if it ever accepts a
human-readable name the middleware's share exemption must be revisited (see the
comment in `middleware.ts`).

## Frontend architecture

- **`app/**`** — App Router pages: `app/page.tsx` (signed-in workspace),
  `app/login/page.tsx`, `app/share/[token]/page.tsx` (public share view).
- **`components/workspace/workspace-app.tsx`** — the main workspace: tab
  session (`useTabSession`), document tree/sidebar, editor, viewer, dialogs,
  grimoire switcher, search. It orchestrates most client state.
- **`components/workspace/`** — sidebar, tab-strip, markdown-editor (CodeMirror),
  doc-viewer, search/trash/share/passwords dialogs, panels (backlinks, TOC,
  recent-edits, details), image lightbox/zoom.
- **`lib/`** — pure, browser-agnostic logic heavily used: markdown
  (frontmatter, headings, links, wikilinks, serializer), `tabs.ts` (pure tab
  reducer), `index-patch.ts` (incremental index merging), `build-document.ts`,
  `resolve-link.ts`, `use-document-save.ts`, `use-persisted.ts`.
- Editor-specific logic (live preview, slash commands, wikilink completion,
  image drop) lives in `components/workspace/*.ts`.

The design leans on **pure functions with no React** for the pieces that must
not lose a document (tabs, index-patch, file-store), which is exactly why they
are the ones covered by unit tests most heavily.

## Offline / desktop (`electron/main.cjs`, `MarkForge-Offline.bat`)

- `pnpm desktop` = `next build && electron .`; Electron loads the app served on
  `127.0.0.1:3457` (an offline-only localhost server) with
  `MARKFORGE_OFFLINE=1` to force `FsBucket` (never touches R2).
- `pnpm dist:portable` builds a portable bundle (`scripts/build-portable.mjs`).
- `scripts/markforge-smoke.cjs` starts headless Chromium against a running app
  to assert the page boots with zero console/page errors (used in testing).

## Testing & verification

- **Test runner: Vitest.** `pnpm test` (`vitest run`) runs the whole suite.
  Per-suite `test:foo` scripts are repointed at individual files. Tests run with
  all `R2_*` env vars nullified (`vitest.config.ts`) so they never open live R2
  or hit a production bucket; `pnpm test:r2`
  (`vitest.r2.config.ts`) is the opt-in real-R2 run.
- Key suites: `store`/`backend` (drop-in backend conformance against the same
  logic + `MemoryBucket`), `api`, `rename`, `share`, `search`, `tabs`, `assets`,
  `session`, `vault`, plus markdown/editor suites (frontmatter, headings, links,
  wikilinks, live-preview, slash-commands, reconcile, image-zoom, code-highlight).
- **`npm run verify`** is the full gate:
  `check:deps → check:encoding → typecheck → lint → test → next build`.
- `check:encoding` scans for mojibake/BOM (see `AGENTS.md`: files must be valid
  UTF-8 **without** BOM — PowerShell 5.1 pipelines corrupt non-ASCII text, so
  edit via UTF-8-safe tools/scripts, never `Get-Content`/`Set-Content`).
- `scripts/ui-verify.test.ts` (`pnpm ui:verify`) exercises the UI via
  Playwright (`@playwright/test`).

## Configuration (environment)

| Variable | Meaning |
|----------|---------|
| `MARKFORGE_OFFLINE` | `1` forces `FsBucket` (desktop) |
| `NOTES_DIR` / `META_DIR` | Filesystem bucket roots (corpus vs metadata) |
| `APP_PASSWORD` | Master password; absence = no gate (local dev) |
| `SESSION_SECRET` | Optional explicit session signing key |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Enables R2 backend (all four must be present & non-empty) |
| `R2_TEST_BUCKET` | For the opt-in `test:r2` suite |

`.env` currently holds **live R2 credentials** — tests strip them; do not use
them for default runs.

## Keeping the spec honest

Before large structural changes, read the relevant `openspec/specs/*` and
`docs/*` (especially `docs/storage-backends.md`, `docs/sprint-6-share-model.md`,
`docs/phase-4-scale.md`) and update this file alongside any change that moves
the seams described above (a new backend, a changed `Bucket` method, a changed
grimoire key layout, a changed search snapshot shape).
