# Sprint 7 Plan — "Images in the vault"

**Dates:** 12 August 2026 (Wed) — 25 August 2026 (Tue) · **Team:** 1 engineer (solo)
**Branch:** `feat/image-insertion` (created, no commits yet — clean start)

**Sprint goal:** Dropping or pasting an image into the editor puts a real file in the
vault and a plain `![alt](path)` in the document — and that image renders in the
editor, the reading view, and a public share, without weakening any invariant the
project already holds.

> **Tracker note.** No project tracker is authorized in this session (Linear, Jira,
> Asana, Notion, Slack connectors are all unauthenticated), so this document *is* the
> sprint board. Points are relative sizes on a 1/2/3/5/8 scale, not hours.

---

## Why this is not a small feature

The one-line request — "drag and drop an image like Notion" — sits on top of a storage
layer that has never held a byte that was not text.

- `Bucket` ([lib/server/bucket.ts](../lib/server/bucket.ts)) exposes `readText` /
  `writeText` and nothing else. Three implementations follow it: `MemoryBucket`,
  `FsBucket`, `R2Bucket`.
- `R2Bucket.readText` calls `Body.transformToString()`
  ([r2-bucket.ts:169](../lib/server/r2-bucket.ts)) and writes a hard-coded
  `text/markdown` or `application/json` content type ([r2-bucket.ts:192](../lib/server/r2-bucket.ts)).
- `readJsonBody` ([lib/server/request-limits.ts](../lib/server/request-limits.ts)) is
  the only body reader on the write surface, and it reads `request.text()`.
- Both real backends already filter `listKeys` to `.md`
  ([fs-bucket.ts:88](../lib/server/fs-bucket.ts), [r2-bucket.ts:257](../lib/server/r2-bucket.ts)).
  That is a gift: assets stored under `assets/` are invisible to the corpus, the
  index, and share-scope resolution *for free* — but it has to be asserted, not
  assumed.

So the feature is one UI gesture riding on a storage change, a new authenticated
route, a new *public* route, and one rendering change per surface.

---

## Capacity

| Person | Available | Allocation | Notes |
|--------|-----------|------------|-------|
| Xyks | 10 of 14 days | 30 pts | Solo; part-time evenings/weekend, no on-call |
| **Total** | **10 days** | **30 pts** | |

**Planned capacity: 30 pts · Committed (P0): 27 pts (90%) · Stretch (P2): 7 pts**

> Updated 12 Aug: item 2b (2 pts) added to P0 during item 1. **All 27 P0 points and
> both P1 items are complete** — 32 of the 30 planned, since 2b was added mid-sprint.
> Only the P2 stretch remains, and none of it is needed for the feature to be whole.

83% is above the 70–80% target this repo plans to. The overage is deliberate and has a
named lever: **item 4 (inline images inside the editor) is the designated cut.** If
the sprint runs hot, images still upload, still live in the vault, and still render in
the reading view and in shares — the editor just shows `![alt](assets/…)` as text,
which is the behaviour today. See Risks.

---

## Sprint backlog

| Pri | # | Item | Est | Depends on | Note |
|-----|---|------|-----|------------|------|
| P0 | 1 | Binary objects in `Bucket` + all three backends — **done** | 5 | — |
| P0 | 2 | `POST/GET /api/assets` — upload and serve — **done** | 6 | 1 |
| P0 | 2b | Assets in `backup.ts` and `sync-storage.ts` — **done** | 2 | 1 |
| P0 | 3 | Drop & paste in the editor → upload → `![alt](path)` — **done** | 5 | 2 |
| P0 | 4 | Inline rendering: editor widget + reading view — **done** | 4 | 3 |
| P0 | 5 | Images on the public share page, token-scoped — **done** | 5 | 2 |
| P1 | 6 | Toolbar "Insert image" + file picker + alt-text edit — **done** | 2 | 3 |
| P1 | 7 | Orphan policy + `scripts/gc-assets.ts` — **done** | 3 | 1 |
| P2 | 8 | Client-side downscale before upload — **done** | 3 | 3 |
| P2 | 9 | Width syntax (`![alt\|400](…)`) | 2 | 4 | **blocked on a decision — conflicts with D2** |
| P2 | 10 | Service-worker caching of assets for offline reading | 2 | 2 | **blocked on a decision — conflicts with a tested rule** |

### 1 — Binary objects in `Bucket` (5 pts) — **done**

Additive only. `readText`/`writeText` work exactly as they did; nothing that existed
changed shape.

Shipped:

- [lib/server/assets.ts](../lib/server/assets.ts) — new. The one place that knows the
  asset namespace: the `assets/` prefix, the accepted image types (no SVG), and
  content-type derivation.
- [bucket.ts](../lib/server/bucket.ts) — `readBinary`, `writeBinary`,
  `listBinaryKeys` on the interface, plus `MemoryBucket`. `deleteObject` and
  `objectExists` cover both keyspaces rather than being duplicated.
- [fs-bucket.ts](../lib/server/fs-bucket.ts) — bytes written through the same atomic
  temp-file-then-rename path, which now takes a `Uint8Array` without a UTF-8 detour.
- [r2-bucket.ts](../lib/server/r2-bucket.ts) — `transformToByteArray()` on read and a
  real `ContentType` on write. `listKeys` and `listBinaryKeys` are now two filters
  over one listing helper.
- [workspace-store.ts](../lib/server/workspace-store.ts) — the namespace is
  **reserved** and **hidden**, in one place each.
- [tests/assets.test.ts](../tests/assets.test.ts) — 23 checks, wired into `npm test`.

**Two things the implementation turned up that the plan did not have:**

1. **`listFolders` leaks what `listKeys` does not.** Filtering documents to `.md` hides
   the image *objects*, but every backend still reports the directories holding them —
   a filesystem has them for real, R2 derives them from key segments. Left alone,
   `assets/` and `assets/2026/` would have shown in the file tree as permanently empty
   folders, and `reindex()` would have put them back every time. Filtered in
   `WorkspaceStore.corpusFolders()`, so the three backends cannot disagree.

2. **A writable `assets/` folder is an undo-less delete.** `removeDirectory` stashes
   the Markdown it finds in the trash and then calls `deleteFolder`, which is recursive
   at the bucket layer — so deleting a folder called `assets` would have destroyed every
   image in the vault while trashing nothing. The store now refuses the whole namespace
   as a document or folder path, case-insensitively (on Windows `Assets/` *is*
   `assets/`). Consequence to state plainly: a vault that already had a folder named
   `assets` full of notes would find them unaddressable through the app. This vault has
   no such folder — checked — but a hosted deployment would need a migration note.

**Verified:** `npm run typecheck` clean · full `npm test` chain green including the new
suite · `npm run build` clean. `npm run lint` fails on stale `.next` output inside
`.claude/worktrees/` — pre-existing, unrelated, and blocking the DoD until the
worktrees are removed or the path is ignored.

### 2b — Assets in backup and sync (2 pts) — **done**

`scripts/backup.ts` and `scripts/sync-storage.ts` both enumerated the corpus with
`listKeys` + `listFolders`, so as written they would have produced a snapshot and a
migration containing no images at all. Landed with item 2, because the first upload is
the moment that gap becomes real data loss.

- The manifest gains an `assets` array, hashed with a new `computeBinaryEtag` — kept
  separate from `computeEtag` rather than widening it, because hashing an image
  through the UTF-8 path returns a stable, plausible, and completely wrong answer.
- Images land at the snapshot root under their own vault key, so the snapshot
  directory mirrors the vault and nothing is re-derived on the way back in.
- `--verify` and `--restore` cover them too. A snapshot taken before assets existed
  skips the section entirely rather than reporting every live image as new.
- `backup.ts` now guards `main()` behind `require.main === module` and exports its
  three verbs, so the suite drives a real backup → verify → restore instead of
  simulating one. Without the guard, importing it would have taken a backup of
  whatever the ambient environment pointed at.

**Verified:** full `npm run verify` green — including `npm run lint`, now that the
stale worktree output is gone. `tests/assets.test.ts` is at 38 checks.

### 2 — `/api/assets` upload and serve (6 pts) — **done**

Shipped as [app/api/assets/route.ts](../app/api/assets/route.ts), modelled on
[app/api/files/route.ts](../app/api/files/route.ts): same error mapping, same
`enforceWriteRate`. Alongside it: `writeAsset`/`readAsset` on the store,
`sniffImageType` and `assetKeyFor` in `assets.ts`, `MAX_ASSET_BYTES` in
`request-limits.ts`, and `uploadAsset`/`assetUrl` in
[lib/workspace-api.ts](../lib/workspace-api.ts) for item 3 to call.

Two properties worth naming, because they are what the tests are actually defending:

- **The client never names a path.** The key is minted from the bytes, so there is no
  attacker-supplied path to contain in the first place — traversal is not defended
  against on upload, it is unreachable. On the way out, `readAsset` refuses anything
  outside `assets/`, so the image endpoint cannot be turned into a way around every
  rule `/api/files` enforces. Four attempts, including `assets/../Secret.md`, are
  asserted to never be served.
- **The type comes from the bytes.** A `Content-Type` on an upload is a claim by the
  uploader; the browser derives its own from the file extension. An SVG named `.png`
  and declared `image/png` is refused, which is the case that matters — the share
  route will serve these bytes same-origin to unauthenticated readers.

The original plan's optional `width`/`height` in the response was dropped: PNG and GIF
give dimensions cheaply but JPEG needs an SOF scan, and nothing needs them until
layout shift becomes visible in item 4. Noted there rather than built here.

*Original spec, kept for the record:*

- `POST /api/assets` — `multipart/form-data`, single file per request.
  - MIME allowlist: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. **No SVG**
    (see D3).
  - Validate by **magic bytes**, not by the declared `Content-Type`.
  - `MAX_ASSET_BYTES = 4 * 1024 * 1024` (see R2 in Risks). New `readBinaryBody` next
    to `readJsonBody`, with the same "header is an optimisation, measurement is the
    check" discipline. Over the cap → 413 with a message a human can act on.
  - Key: `assets/<yyyy>/<sha256-first-8>-<slugged-original-name>.<ext>` (D1). Same
    bytes twice → same key → one object, no second write.
  - Response: `{ path, bytes, contentType, width?, height? }`.
- `GET /api/assets?path=assets/…` — behind the session gate, path-containment checked
  by the same helper documents use, `Cache-Control: public, max-age=31536000, immutable`
  (safe: the key is content-addressed).
- **Acceptance:** oversized → 413; `.png` with a PDF header → 400; `../` escape → 400;
  unknown path → 404 identical to a forbidden one; rate limit fires.

### 3 — Drop and paste in the editor (5 pts) — **done**

Shipped as [components/workspace/image-drop.ts](../components/workspace/image-drop.ts),
wired into the extension list next to `livePreview()`. `dropCursor()` went in with it —
the theme had styled `.cm-dropCursor` since sprint 3, but nothing ever drew one.

**The plan's placeholder design was wrong, and was replaced.** It called for inserting
`![Uploading pastel.png…]()` as text and swapping it out on success. That text is in
the buffer, the buffer is the file, and autosave does not know to wait — a slow upload
would have written a half-finished link into the user's document, and a failed one
would have depended on cleanup code running to take it back out. The progress
indicator is a **widget decoration** instead, the same paint-time-only device
live-preview uses: nothing enters the document until the bytes are stored, so a failure
has nothing to clean up. Verified in the browser: a refused upload left the document
byte-identical with no leftover placeholder.

One entry in the state field per drop rather than per file — it behaves as a second
cursor that walks forward as each image lands, which keeps a multi-file drop in order
without several positions competing for the same offset, and keeps mapping correctly
while the user types during the upload.

**A real bug the tests caught before the browser did:** block placement first looked
only at the line dropped on. Dropping on the blank line *above* a paragraph looks like
it needs no separator — but `![x]\nSome text` is a single paragraph in CommonMark, so
the image would have rendered inline with the text it was dropped above. Placement now
consults the neighbouring lines; one newline short was not cosmetic.

**Verified in a browser**, against a sandbox vault on the filesystem backend — *not*
the dev environment, whose `.env` points at the live R2 bucket, where test drops would
have written into the real vault. `/api/health` was checked for `backend: filesystem`
before anything was uploaded.

- A real `File` on a real `DataTransfer`, dropped on `.cm-content`: `POST /api/assets`
  → 201, and `![Pastel Sketch](assets/2026/ebf4f635-pastel-sketch.png)` in the buffer.
- A second drop landed under the pointer with a blank line separating it — `posAtCoords`
  resolves the drop point correctly.
- The bytes are on disk at `notes/assets/2026/…png`, inside the vault where Obsidian
  would find them, and `index.json` contains no asset path.
- `GET` served them back: 67 bytes, `image/png`, `private, …, immutable`, `nosniff`.
- A 5 MB file: document unchanged, no leftover widget, toast reading
  `huge.png: Request body is 5243061 bytes; the limit is 4194304.`
- No console errors.

Same bytes under two filenames produced two objects sharing a hash prefix
(`ebf4f635-pastel-sketch.png`, `ebf4f635-second.png`) — the documented D1/D6 trade-off,
observed rather than assumed.

### 4 — Inline rendering (4 pts) — **done**, and not cut

The fifth preview node type, which sprint 6 had explicitly ruled out
(docs/sprint-6-live-preview-spike.md: "Nothing renders as a widget"). That boundary
protected a spike's timebox; it is knowingly changed here, and the module comment says
so rather than leaving the two documents contradicting each other.

- Editor: an image widget in
  [live-preview.ts](../components/workspace/live-preview.ts), obeying the same rule
  every other decoration obeys — **paint-time only, the buffer keeps every byte** —
  with the raw `![alt](path)` revealed whenever the caret is on that line.
- Reading view: an `img` entry in the `components` map of
  [doc-viewer.tsx](../components/workspace/doc-viewer.tsx), and a shared
  `resolveImageSrc` in [workspace-api.ts](../lib/workspace-api.ts) so the editor and
  the reading view cannot drift into disagreeing about what a `src` means.

**Three things the browser caught that the tests could not:**

1. **A freshly dropped image never rendered.** Item 3 left the caret at the end of the
   image's own line, and a caret on the line is exactly what reveals raw syntax — so
   every drop showed `![alt](…)` until the user happened to click elsewhere. The caret
   now lands on the line *below*, which also matches what someone does next, which is
   carry on writing under the picture. Item 3's insertion tests were rewritten around
   the new rule.
2. **`Block decorations may not be specified via plugins`** — a runtime exception that
   broke the whole editor, not just the image. CodeMirror refuses block decorations
   from a `ViewPlugin`, and `livePreview` is one. The widget is an inline-block
   replacement of the image *node* instead, while the *line* remains the reveal range —
   two ranges that must not be merged, now asserted.
3. **`next/image` is the wrong tool here** and the lint rule recommending it is
   suppressed with the reason in place: the Next optimizer fetches the URL server-side
   with no browser session, so every image behind the session gate would come back 401
   — and a private vault's pictures would land in a public cache.

**Verified in the sandbox** (filesystem backend, `/api/health` checked first, as in
item 3):

- Editor: widget renders, `src` resolved to `/api/assets?path=assets%2F2026%2F…`, alt
  preserved, real bytes loaded.
- Reveal cycle both ways: clicking the picture brings back
  `![Pastel Sketch](assets/2026/…png)`; moving the caret away restores the picture.
- Reading view: three images, correct URLs, two loaded and the deliberately missing one
  failing.
- A missing asset shows `Missing image: assets/2026/deadbeef-missing.png` in the editor
  rather than empty space — the same stance ghost wikilinks take.
- No console errors on a fresh load.

**Known gap, not worth a point yet:** the *reading view* shows a missing image as the
browser's default broken-image icon, where the editor names the file. Worth unifying
when item 6 touches this area.

### 5 — Images on the public share page (5 pts) — **done**

Shipped as [app/api/share/\[token\]/asset/route.ts](../app/api/share/[token]/asset/route.ts)
plus `resolveAsset` on [share-store.ts](../lib/server/share-store.ts) and
`shareImageSrc` in [lib/share.ts](../lib/share.ts).

- The route lives under `/api/share/` because that prefix — **with its trailing
  slash** — is what middleware exempts. Anywhere else, every image on every shared
  page would be a 401. Now asserted both ways: the share asset route is exempt, and
  `/api/assets` is still 401 to an unauthenticated caller.
- **Scope is "some document inside this share references it."** Serving any asset to
  any live token would make a share a read capability over the whole asset namespace,
  gated only by guessing eight hex characters — and unguessability is not the security
  model used anywhere else here.
- `shareImageSrc` is deliberately a *second* function rather than a parameter on
  `resolveImageSrc`. The two look alike and must never be interchanged: one points at
  the session-gated route, the other carries the token. It lives next to the share
  model and takes the token as an argument rather than reading it from anywhere
  ambient.

**Cost, stated rather than hidden:** one document read for a `document` share, up to
one per in-scope document for a `subtree` share, stopping at the first match. The index
cannot answer this — it stopped carrying bodies in phase 4. If large subtree shares
ever make that hurt, the fix is an asset-reference manifest built alongside the index,
not a weaker check.

**Verified.** `tests/share.test.ts` covers the decision (6 new checks: in-scope served,
private refused, every refusal null, revoked stops serving, locked serves nothing until
unlocked, subtree reaches its own documents and no further).
`tests/assets.test.ts` covers the *response* — because an oracle does not need a
different status code to exist, a different body or header is enough, so the five
refusals are compared byte for byte and required to collapse to one shape.

Confirmed over real HTTP in the sandbox: a shared page renders its image through
`/api/share/<token>/asset?path=…` and loads the real bytes, while the same token asking
for a private document's image, an unknown token, a document path, and a traversal all
return the identical `404 {"error":"Not found","code":"NOT_FOUND"}` with identical
`Cache-Control` and `X-Robots-Tag`.

`no-store` here, against `immutable` on `/api/assets` — the opposite choice, on purpose:
there the key is content-addressed and the reader authenticated; here the token is the
credential, and a cached copy would outlive the revocation meant to take it away.

### 6 — Toolbar and alt text (2 pts) — **done**

An image button in [editor-toolbar.tsx](../components/workspace/editor-toolbar.tsx)
opening a file picker, because drag-and-drop is unreachable by keyboard and does not
exist on a phone — it cannot be the only way in.

The button runs the **same** upload the drop handler runs. `image-drop.ts` exposes its
configuration through a CodeMirror facet and exports `insertImageFiles(view, files)`,
so the toolbar needs a view and nothing else — it knows nothing about `uploadAsset` or
about toasts. A second configured entry point would have been a second thing to keep in
step, and the first symptom of drift would have been a picker that uploads differently
from a drop.

**Alt text was not given its own editor, deliberately.** Clicking a rendered image puts
the caret on its line, which reveals `![alt](path)` as ordinary text — the same way
every other piece of syntax in this editor is edited, and the same way a wikilink's
label is. A dedicated dialog would be a second editing model for one field.

**Verified in the sandbox:** the button opens the picker; `accept` offers
`image/png,image/jpeg,image/gif,image/webp` and not SVG; `multiple` is on; the input is
cleared after use, so choosing the same file twice in a row still fires; a chosen file
uploaded and rendered as `![Picked From Dialog](assets/2026/…png)`. The button is in the
tab order (`tabIndex 0`) and the hidden input is not (`-1`) — tabbing onto an invisible
file field is a dead end. No console errors.

One lint rule earned its keep here: `react-hooks/refs` rejected reading the input ref
from inside an array built during render. The button is its own element with a real
event handler instead.

### 7 — Orphan policy (3 pts) — **done**

Deleting a document does **not** delete its images (D5), and
[scripts/gc-assets.ts](../scripts/gc-assets.ts) reports what that leaves behind
without deleting anything until a person types `--force`. The procedure is in
[docs/runbook.md](runbook.md), including the instruction not to schedule it — what
counts as an orphan depends on when it runs.

**Two rules stop it destroying data, and both are the point of the item:**

1. **The trash counts as a reference.** A document deleted yesterday still names its
   images, and a restore inside the 30-day window has to return a document whose
   pictures load. Collecting them would have been a silent loss: the document comes
   back looking whole and renders nothing.
2. **Nothing recent is deleted, `--force` or not.** The upload lands before the
   document save does, so for a moment a perfectly live image has no reference
   anywhere. `--min-age` defaults to 7 days, and an asset whose age cannot be
   determined is treated as brand new — the benefit of the doubt goes to the file.

Rule 2 needed something the `Bucket` did not have, so it gained `statObject` (size and
last-modified) across all three backends. Without it, an image uploaded thirty seconds
ago is indistinguishable from one abandoned last year, and a sweep could eat work in
progress. The alternative was a GC with a footgun in it.

References are gathered from raw document text rather than parsed links: a mention is a
mention whether it is `![alt](path)`, a pasted `<img>` tag, or a line in a code fence.
Wrong in that direction leaves a stale file; wrong in the other removes a picture from
someone's note.

**Verified:** 6 checks in `tests/assets.test.ts`, in-process against a memory bucket —
live reference kept, trashed reference kept, orphan reported with its size, a fresh
orphan refused deletion, an old one deleted and only it, unknown age read as young.

**Not verified:** the CLI wrapper itself — `parseArgs`, the printed report, `main()`.
Both exported functions where the logic lives are covered; the argument parsing and
formatting around them have been read but not run.

### 8 — Client-side downscale (3 pts) — **done**

Closes the risk the 4 MB cap opened: a photo straight off a phone is routinely larger
than the route will accept, and a limit that can only refuse is a limit that makes the
feature useless on the device most photos come from.

`shrinkToFit` in [image-drop.ts](../components/workspace/image-drop.ts) sits in the one
upload path, so drop, paste and the picker all get it. `MAX_ASSET_BYTES` moved to
[lib/asset-limits.ts](../lib/asset-limits.ts) — the client needs the same number and
cannot import `request-limits.ts`, which pulls in `next/server`. Two numbers would
drift, and a client believing in a larger budget produces uploads the server rejects.

**The rule is narrow on purpose: re-encoding happens only to make an impossible upload
possible.** Recompressing every screenshot would mean the bytes in the vault are never
quite the bytes the user chose, which is not a trade this project gets to make on
somebody's behalf. And when it does happen, it says so — altering someone's file
silently is not a thing to do quietly.

Three refusals to be clever, each of which would have been a silent loss:

- **A GIF is never re-encoded**, even when oversized. A canvas holds one frame, so it
  would turn an animation into a still and report success.
- **WebP, not JPEG.** A screenshot with a transparent corner should not come back with
  a black one.
- **A re-encode that came out larger is discarded**, and a browser that cannot decode
  the image returns the original. A bad shrink must never be worse than no shrink.

**Verified in the browser**, which is the only place this code runs: a 4000×3000 PNG of
noise, 39.4 MB, became a 2.80 MB WebP at 2560×1920 — the first shrink step, exactly as
designed — uploaded, rendered, and was announced as *"Phone Photo.png was 39.4 MB and
has been resized to 2.8 MB to fit the 4.0 MB limit."* A 67-byte PNG dropped immediately
after was stored as `.png`, byte for byte, with no notice. `scaledSize` is covered
headless, along with all three give-up paths.

---

## Decisions to make (day 1, before item 2)

| # | Decision | Recommendation |
|---|----------|----------------|
| D1 | Asset key scheme | `assets/<yyyy>/<hash8>-<name>.<ext>`, vault-root-relative. Dedupes, caches forever, never collides, still readable in a file listing. |
| D2 | Markdown syntax | Plain CommonMark `![alt](assets/…)`. No editor-specific syntax, no attributes block. Non-negotiable: the buffer is the file. |
| D3 | SVG uploads | Reject in v1. An SVG is a script host; serving one same-origin from the share route would be a stored XSS on a public page. |
| D4 | Upload transport | `multipart/form-data` straight to the route, capped at 4 MB. Presigned PUT direct to R2 is the v2 answer, not this sprint's. |
| D5 | Orphaned assets | Never auto-delete. Report only. |
| D6 | Dedupe | By content hash, silently. Two drops of the same file cost one object. |

### 9 and 10 — stopped, because each reverses something written down

Both were listed as stretch work early in the sprint, before the constraints were
worked out. With the feature built, each turns out to contradict a position this
codebase already holds — so they are decisions, not tasks, and not mine to take
quietly.

**Item 9, `![alt|400](…)`, is not CommonMark.** D2 in this very plan says plain
CommonMark, no attributes block, non-negotiable. Elsewhere that link reads as an image
whose alt text is literally `alt|400`. The argument for it is real — it is *Obsidian's*
convention, and Obsidian compatibility is a stated goal of the project — so this is a
genuine trade rather than an obvious no. The alternative, HTML `<img width>`, is worse
here: rendering raw HTML in shared documents would hand any embedded markup to an
unauthenticated reader's browser.

**Item 10 would put user data in Cache Storage.** `public/sw.js` says "Never cache API
responses or user data", and `tests/service-worker.test.ts:305` asserts it — shipping
this means deleting a passing assertion. The payoff is also smaller than it looked:
`/api/assets` is already `immutable, max-age=1yr`, so the HTTP cache serves these
offline in most cases. The cost is images persisting on disk in the browser profile,
outliving a sign-out.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Committed load is 83% of capacity | Sprint runs hot, something ships half-done | **Closed** — item 4, the designated cut, landed with 5 pts still to go |
| An image is in the document but renders nowhere yet | A user who drops one today sees a broken image in the reading view | **Closed** — items 4 and 5 cover the editor, the reading view and public shares |
| Vercel's ~4.5 MB request body cap | A photo straight off a phone (5–8 MB) 413s | Cap at 4 MB with a clear error in item 2; client-side downscale is stretch item 8 and becomes P1 next sprint |
| `Bucket` change touches three backends | R2 regressions land silently — `test:r2` needs live credentials and is **not** in the default `npm test` chain | Run `npm run test:r2` explicitly before merge; add it to the PR checklist |
| Share asset route leaks existence | The one invariant the share model rests on | **Closed** by item 5 — refusals asserted byte-identical at both the store and the response level |
| Image bytes have no quota | Object storage bills by what is in it | Per-request cap + write rate limit this sprint; item 7 gives a way to see and reclaim what accumulated. A vault-wide quota is still a v2 item |
| Assets drift into the corpus | A rebuild would index binaries as notes | **Closed** by item 1 — asserted per backend in `tests/assets.test.ts` |
| Backups and migrations skip images | A restore returns a vault of broken image links | **Closed** by item 2b, with a real backup→verify→restore drill in the suite |
| `npm run lint` is red before we start | The DoD cannot be met | **Closed** — the stale worktree was removed. A second worktree (`silly-driscoll-ef3b1c`) was kept: it holds an uncommitted search-dialog fix that exists in no commit |

---

## Definition of done

- [ ] `npm run verify` green (deps, typecheck, lint, full test chain, production build)
- [ ] `tests/assets.test.ts` written and wired into the `test` script in `package.json`
- [ ] `tests/share.test.ts` extended with the four asset cases
- [ ] Manual pass: drop, paste, picker, failed upload, offline reload, share link opened
      in a private window
- [ ] `README.md` gains an "Images" paragraph under Editing; `docs/runbook.md` gains
      the asset-GC procedure
- [ ] PR merged to `main` from `feat/image-insertion`

## Key dates

| Date | Event |
|------|-------|
| Wed 12 Aug | Sprint start · decisions D1–D6 settled |
| Thu 13 Aug | Items 1–2 merged behind no flag (no UI yet, nothing to regress) |
| Tue 18 Aug | Mid-sprint check-in · P0 3–4 demoable, cut decision on item 4 taken here |
| Sat 22 Aug | Item 5 (share) merged — the security-sensitive one, not left to the last day |
| Tue 25 Aug | Sprint end / demo |
| Wed 26 Aug | Retro → `docs/sprint-7-review.md` |
