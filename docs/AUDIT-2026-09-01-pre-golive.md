# MarkForge — Audit Pra Go-Live (Tahap 1)

> **Status**: dev-lite, setelah §19-§22 notion-block system direvert, AI block dihapus.
> **Tanggal**: 2026-09-01
> **Cakupan**: Audit end-user + maintainability, tanpa ubah kode. Tahap 2 (bersih-bersih) dan Tahap 3 (go-live) menunggu approval.

---

## 1. Tujuan & Positioning

### 1.1 Core value proposition (dari README + spec)

MarkForge adalah **browser-native workspace untuk vault Markdown terhubung** dengan tiga janji:

| Janji | Bukti di codebase |
|---|---|
| File `.md` adalah source of truth | `lib/server/{fs-bucket,r2-bucket,bucket}.ts` — dua backend (FS lokal + R2 cloud) yang simpan byte-for-byte |
| Plain-Markdown editor (tanpa document model proprietary) | `lib/markdown/{serializer,frontmatter}.ts`, editor pakai `remark/rehype` untuk render, bukan AST editor |
| Setiap dokumen bisa jadi public URL satu klik | `app/api/share/[token]/route.ts` + `app/share/[token]/page.tsx` |

### 1.2 Apakah fitur yang ada konsisten?

**Mayoritas ya.** Fitur yang ada (editing, organizing, sharing, safety) lurus dengan tiga janji di atas.

**Tiga outlier yang melenceng (sudah sebagian dibersihkan):**

1. **AI block** (sudah dihapus) — bertentangan dengan "plain markdown". Tinggal kemungkinan: `code-block.tsx` masih accept `language === 'ai'` → render sebagai code block biasa (benar, tapi legacy document dengan `ai` fences akan berubah visual). Verifikasi: user tidak akan lihat AI affordance lagi.
2. **Page lock** (sudah dihapus) — feature `frontmatter.lock` + `LockPrompt` ada di git history, saat ini disabled, tetapi frontmatter `lock` masih ditulis oleh beberapa legacy path. **Tinggal:** apakah `frontmatter.lock` masih di-indeks/dibaca? Audit di §2.
3. **Password manager vault** (sub-product besar) — `lib/vault/*` 7 file, `passwords-dialog.tsx` 480 LOC, `password-item-form.tsx`, sidebar `KeyRound` button. **Bertentangan** dengan "markdown note app": ini 1Password, bukan catatan. Tapi spec jelas (`docs/password-manager-plan.md`) — user memutuskan ini by design.

---

## 2. Inventarisasi Fitur

### 2.1 Daftar fitur (klasifikasi CORE / SUPPORT / SUSPECT)

| # | Fitur | File utama | Klasifikasi | Catatan |
|---|---|---|---|---|
| 1 | Edit Markdown live preview (Obsidian-style) | `markdown-editor.tsx`, `live-preview.ts`, `hide-md-syntax.ts` | **CORE** | Pembeda utama dari editor markdown biasa |
| 2 | Wikilink `[[` autocomplete + Mod-click | `wikilink-complete.ts`, `lib/resolve-link.ts` | **CORE** | Link graph = nilai utama |
| 3 | Slash commands `/` | `slash-commands.ts` | **CORE** | Onboarding power-user |
| 4 | Format toolbar (B/I/code/heading) | `editor-toolbar.tsx`, `editor-commands.ts` | **CORE** | Standar editor, expected |
| 5 | Code block syntax highlight + copy | `code-block.tsx`, `code-highlight.ts` | **CORE** | Untuk technical notes |
| 6 | Image drop/paste, lightbox, zoom | `image-drop.ts`, `image-lightbox.tsx`, `image-zoom.ts` | **CORE** | Common note need |
| 7 | Sidebar explorer (tree, drag&drop) | `sidebar.tsx`, `explorer-drop.ts` | **CORE** | Navigation utama |
| 8 | Tabs (multi-doc) | `tab-strip.tsx`, `tabs.ts` | **CORE** | Switching doc tanpa kehilangan konteks |
| 9 | Side peek (45% overlay) | `side-peek.tsx` | **SUPPORT** | Nice untuk referensi cepat, tapi overlap dengan tab |
| 10 | Recent edits panel | `recent-edits-panel.tsx` | **SUPPORT** | Redundan dengan sort-by-mtime sidebar |
| 11 | Backlinks panel | `backlinks-panel.tsx` | **CORE** | Bagian dari link graph value |
| 12 | TOC (table of contents) panel | `toc-panel.tsx` | **SUPPORT** | Berguna untuk doc panjang, tapi nav tree sudah ada |
| 13 | Details panel (created/updated/word count) | `details-panel.tsx` | **SUPPORT** | Metadata; word count low value |
| 14 | Pinned favorites | `sidebar.tsx:178` (pinnedPaths state) | **SUPPORT** | Power-user; Obsidian/kompetitor punya ini |
| 15 | Rename + link repair | `lib/server/rename.ts` | **CORE** | Janji "markdown file tetap valid" |
| 16 | Trash with restore | `trash-dialog.tsx`, `lib/trash.ts` | **CORE** | Recoverable delete = safety promise |
| 17 | Share link (public URL, revocation) | `share-dialog.tsx`, `lib/server/share-store.ts` | **CORE** | Janji "one-click public URL" |
| 18 | Password-protected share | `lib/server/share-password.ts` | **CORE** | Share butuh gate |
| 19 | PIN login + session cookie | `app/login`, `app/pin`, `lib/session.ts` | **CORE** | App-wide auth |
| 20 | Password manager vault (encrypted items) | `lib/vault/*` (7 file), `passwords-dialog.tsx`, `password-item-form.tsx` | **SUSPECT** | Sub-product dalam produk note; user harus paham trade-off (single-master-key, no sync) |
| 21 | Page-level Export (`⋯` menu) | `lib/export/page-export.ts` | **CORE** | Keluar dari MarkForge = tetap punya file |
| 22 | Page-level Import (file/folder picker) | `lib/import/page-import.ts` | **CORE** | Bulk onboarding |
| 23 | Two backends (FS / R2) | `lib/server/{fs-bucket,r2-bucket}.ts` | **CORE** | Web + desktop = target deployment |
| 24 | Sync to cloud (desktop → R2) | `electron/main.cjs` IPC + `scripts/sync-storage.ts` | **SUPPORT** | Untuk desktop user; punya friction (no automatic conflict merge) |
| 25 | PWA install | `components/pwa-install` | **SUPPORT** | Browser install; nice-to-have |
| 26 | Encoding gate (BOM/mojibake scan) | `scripts/check-encoding.mjs`, `.githooks/pre-commit` | **CORE (infra)** | Bukan fitur user, tapi jaring pengaman |
| 27 | Asset garbage collection | `scripts/gc-assets.ts` | **SUPPORT** | Background hygiene |
| 28 | Search dialog (`Cmd-K`) | `search-dialog.tsx`, `lib/search.ts` | **CORE** | Cakupan doc banyak = butuh search |
| 29 | Theme switcher (light/dark/system) | `components/theme-switcher` | **CORE** | Standar 2026 |
| 30 | Desktop tab bar (Electron) | `desktop-tab-bar.tsx`, `lib/desktop-tabs.ts` | **SUPPORT** | Multi-window native; web tidak butuh |
| 31 | Resize handles (sidebar, rail) | `resize-handle.tsx` | **CORE** | Layout control |
| 32 | Frontmatter region hider (id/created/width/view) | `hide-frontmatter-id.ts` | **CORE (cleanliness)** | Janji "tidak ada line buku besar di body" |
| 33 | Markdown syntax hider (active-line reveal) | `hide-md-syntax.ts` | **CORE** | Untuk live preview feel |
| 34 | Two-stage Ctrl+A (line → whole window) | `markdown-editor.tsx`, `doc-viewer.tsx` | **SUPPORT** | Power-user; not a common ask |
| 35 | Breadcrumb | `breadcrumb.tsx` | **CORE** | User harus tahu di mana di tree |
| 36 | **AI block** (run prompt, stream response) | ~~`ai-block.tsx`, `ai-block-edit.ts`~~ (deleted) | **REMOVED** | Out of scope |
| 37 | **Empty block placeholder** ("press space for AI") | ~~`empty-block-placeholder.ts`~~ (deleted) | **REMOVED** | Out of scope |
| 38 | **Page lock (frontmatter.lock + LockPrompt)** | `lib/lock/*` deleted; `lib/markdown/frontmatter.ts` legacy field | **LEGACY** | Field masih di-indeks, harus verifikasi |
| 39 | **Block menu (Notion-style slash menu for blocks)** | archived in `openspec/changes/archive/2026-08-30-block-menu/` | **REVERTED** | Out of scope per revert §19-§22 |
| 40 | **Notion block tree (§19-§22)** | reverted in `c15c80e` | **REVERTED** | -4495 LOC removed |

### 2.2 Fitur yang sebaiknya DIHAPUS

| Fitur | Alasan |
|---|---|
| **#13 Details panel (word count)** | Word count tidak memberi nilai yang tidak bisa dihitung sendiri. Metadata "created/updated" sudah muncul di tab status bar. Bisa digabung jadi 1 baris ringkas. |
| **#20 Password manager (sub-product)** | **Rekomendasi kuat untuk ditinjau ulang.** Alasan: (a) two-product cognitive load, (b) single master password = single point of failure, (c) tidak ada sync = user di device lain tidak punya akses, (d) kompetitor (1Password, Bitwarden) gratis dan battle-tested. **Trade-off:** kalau user sudah pakai, hapus = breaking. Saran: deprecate, setujui timeline hapus di v2. |
| **#9 Side peek** | Overlap dengan #8 tabs. Tambah kompleksitas (45% overlay layout, Escape handler) untuk use-case yang sudah ditutupi tab. |
| **#30 Desktop tab bar (multi-window)** | Browser sudah punya multi-tab native. Multi-window di Electron menambah bug surface (cross-window state sync) untuk benefit marginal. |
| **#34 Two-stage Ctrl+A** | Bukan user request yang muncul di issue list. Power-user feature dengan maintenance cost (capture-phase listener). |

### 2.3 Fitur yang MISSING tapi seharusnya ada

| Fitur | Alasan | Effort |
|---|---|---|
| **Onboarding tour / first-run hint** | User baru lihat sidebar kosong tanpa panduan. README bilang `[[` autocomplete, tapi tidak ada UI hint. | S — modal one-time |
| **Page count badge di sidebar root** | "12 pages in /work" — feedback bahwa folder tidak kosong. | XS |
| **Conflict resolution UI** | Edit di 2 tab = last-write-wins silent. `lib/mergeVaults` ada tapi untuk vault items, bukan document. Tab sudah restore offset, tapi content conflict = silent overwrite. | M — perlu ETag check saat switch tab |
| **Export folder / batch export** | Export per-page ada, tapi tidak ada "export all". Untuk backup use case. | S |
| **Keyboard shortcut cheatsheet (`?`)** | Power-user onboarding. Format menu (`Cmd-K`) ada; cheatsheet tidak. | XS |
| **Drag image dari web ke editor** | Paste dari clipboard ada (image-drop.ts), drag dari web tidak. | S |
| **Bulk operations (move/delete many)** | Sidebar pilih banyak = tidak ada. | M |
| **Page templates** | User bikin note dari template (meeting, journal). | M |

### 2.4 Redundan / overlap

- **#8 Tabs vs #9 Side peek** — dua cara untuk "lihat dua dokumen". Pertahankan tabs, hapus peek.
- **#10 Recent edits vs #15 Sidebar sort by mtime** — sort sudah ada di sidebar tree. Recent edits panel = duplikat.
- **#12 TOC vs breadcrumb** — breadcrumb = posisi di tree, TOC = posisi dalam doc. Beda, **bukan redundan**.
- **#26 Encoding gate vs #11 Backlinks reconciliation** — orthogonal.

---

## 3. UI/UX

### 3.1 Flow utama

```
/login → PIN keypad → /
/        → Sidebar (tree, search, create) | Tab strip | Main pane (editor or viewer)
                ↳ Right rail: TOC, Backlinks, Recent edits, Details
                ↳ ⋯ menu per page: copy, duplicate, move, trash, view, width, export
/settings → App PIN card | Vault dialog (inline) | Appearance
/share/[token] → Public read-only
```

### 3.2 Friction untuk user baru

| # | Friction | Severity | Saran konkret |
|---|---|---|---|
| 1 | **Login = "Protected Workspace"** dengan icon gembok, no branding. User bingung: ini apa? | High | **Hilangkan A** generic Lock icon + "Protected Workspace" **lebih baik B** "MarkForge" + tagline kecil "Your markdown vault" — karena C value prop tidak terbaca di entry. |
| 2 | **App PIN = 6 digit** (sama dengan iPhone unlock). User familiar tapi tidak tahu bedanya dengan vault master password. | High | **Hilangkan A** istilah "vault master password" di settings **lebih baik B** "Vault key" — lebih pendek, lebih jelas, less overlap dengan "App PIN". |
| 3 | **Settings page password manager** =/= "settings". User expect theme/PIN di sini, malah lihat password manager UI. | High | **Hilangkan A** password manager di /settings **lebih baik B** route terpisah `/vault` — pisahkan concerns, sesuai §2.2. |
| 4 | **Empty workspace = sidebar kosong** tanpa onboarding. | High | Tambah first-run modal: "Create your first page" atau template picker. |
| 5 | **No visible "save" indicator** untuk yang pertama kali — `SaveIndicator` ada tapi subtle. | Med | Save indicator di header selalu visible (bukan hanya saat saving). |
| 6 | **Wikilink `[[` autocomplete** — user harus tahu trigger. Tidak ada UI hint. | Med | Slash command list bisa include `[[` example. |
| 7 | **Rename + repair** berjalan silent. User tidak tahu link lain di-update. | Med | Toast "Renamed. 12 of 14 links updated — 2 failed: …" — sudah ada di `lib/server/rename.ts:342` (`return` message), tapi toast mungkin tidak muncul di UI. Verifikasi. |
| 8 | **"Press space for AI"** (sebelum dihapus) = 100% friction, no value. | Resolved | Sudah dihapus. |
| 9 | **Theme switcher** icon-only di header. User tidak tahu itu theme. | Low | Tooltip "Theme" sudah ada, OK. |
| 10 | **Sidebar collapse** tidak ada button — hanya resize. Di layar kecil, sidebar = full overlay drawer. | Med | Tambah collapse-to-icons button di header. |

### 3.3 Konsistensi design system

| Aspek | Status | Catatan |
|---|---|---|
| **Color tokens** | ✅ Konsisten | `app/globals.css` pakai CSS vars (`--primary`, `--background`, dll), shadcn convention. |
| **Spacing** | ✅ Konsisten | Tailwind 4 + shadcn. Beberapa inline `gap-3` vs `gap-2` inkonsisten tapi minor. |
| **Iconography** | ✅ Konsisten | `lucide-react` dipakai seragam. |
| **Button hierarchy** | ✅ Konsisten | `components/ui/button.tsx` dari shadcn. |
| **Dialog vs page** | ⚠️ Inkonsisten | `ShareDialog` = modal, `Settings` = page, `PIN change` = page, `PasswordsDialog` = modal mounted inline di settings. **Hilangkan A** password dialog inline **lebih baik B** route `/vault` dengan layout sendiri. |
| **Loading states** | ⚠️ Inkonsisten | `Loader2` spinner + text di beberapa tempat, skeleton di tempat lain. Tidak ada konvensi. |
| **Empty states** | ⚠️ Minimal | Sidebar empty, editor empty, viewer empty — semuanya cuma spinner. Tidak ada illustration/text. |
| **Error states** | ✅ Cukup | Toast `sonner` + inline destructive banner (`app/settings/page.tsx:133`). |

### 3.4 Saran konkret tambahan

- **Hilangkan A** `recent-edits-panel.tsx` **lebih baik B** sort sidebar by mtime default — less code, less rail width used.
- **Hilangkan A** `side-peek.tsx` **lebih baik B** user pakai tabs — less overlay logic, less Escape handler.
- **Hilangkan A** `details-panel.tsx` word count **lebih baik B** cuma show created/updated di tab status — less render work per keystroke.
- **Pertahankan A** TOC panel **lebih baik B** dipertahankan — untuk dokumen panjang (10+ headings) nilainya tinggi.
- **Tambah A** onboarding one-time modal **lebih baik B** karena** empty workspace = user lost.

---

## 4. Jangka Panjang / Maintainability

### 4.1 Tech stack saat ini

| Layer | Stack | Trade-off |
|---|---|---|
| Frontend | Next.js 16 App Router + Turbopack + React 19 | ✅ Modern, fast dev. ⚠️ Next 16 baru, beberapa library belum update. |
| Styling | Tailwind 4 + shadcn + CSS vars | ✅ Konsisten. ⚠️ Tailwind 4 = breaking dari v3, learning curve. |
| Editor | CodeMirror 6 + custom extensions | ✅ Modular, lightweight. ⚠️ Banyak extension file (`markdown-editor.tsx` 562 LOC, 13+ extension). |
| Markdown | remark + rehype + react-markdown | ✅ Standard pipeline. ⚠️ Bundle size untuk share page (tidak lazy-loaded, harusnya). |
| Backend | Next.js Route Handlers + lib/server/* | ✅ Sepanjang ada di Next. ⚠️ R2 SDK 3.1MB — besar untuk edge. |
| Storage | FsBucket (lokal) + R2Bucket (cloud) | ✅ Backend abstraksi bersih. |
| Crypto | WebCrypto AES-GCM + PBKDF2 | ✅ Built-in, no dep. |
| Desktop | Electron + embedded Next standalone | ✅ Satu codebase. ⚠️ Bundle ~150MB, build ~5min. |
| State | React useState/useReducer + localStorage persist | ✅ Sederhana. ⚠️ 2197 LOC `workspace-app.tsx` = god component. |

### 4.2 Apakah scalable?

**Untuk growth fitur 1-2 sprint lagi: ya.** Codebase sudah mature, test coverage 24 suites, encoding gate aktif.

**Untuk growth 6-12 bulan:** ada beberapa scaling limit:

1. **`workspace-app.tsx` 2197 LOC** — god component. Tambah fitur baru = tambah di sini. Pecah jadi:
   - `WorkspaceShell` (layout, sidebar, rail)
   - `DocumentView` (editor + viewer + tab strip)
   - `WorkspaceHeader` (top bar + page menu)
   - `useWorkspaceState` (extracted reducer)

2. **Doc-viewer 440 LOC** juga approaching god. Tambah block baru (callout, math, dll) akan cepat.

3. **Test pyramid terbalik**: 26 test file tapi kebanyakan unit test untuk lib, sedikit integration test untuk UI flow. End-to-end test 1 file (`scripts/ui-verify.test.ts`).

4. **No state management library** (Redux/Zustand). Untuk 5+ user-context (tabs, sidebar, vault, recent edits, theme), prop drilling menjadi masalah. `workspace-app.tsx:1-100` sudah 30+ prop.

5. **Turbopack prod build** masih slower dari Webpack di beberapa kasus. Perlu verify.

### 4.3 Rekomendasi

| Keputusan | Trade-off |
|---|---|
| **Pertahankan A** monolith workspace-app untuk sprint ini **lebih baik B** refactor ke sub-components **karena** go-live butuh stabilitas, refactor = risk. (Setelah launch, di v1.1.) |
| **Pertahankan A** React useState **lebih baik B** Zustand untuk cross-component state **karena** current pain masih manageable; Zustand = new dep, learning. |
| **Pertahankan A** dual backend (FS + R2) **lebih baik B** single backend R2 + sync helper **karena** user desktop expect local-first. |
| **Pertahankan A** Next 16 + Turbopack **lebih baik B** downgrade ke Next 15 stable **karena** Turbopack fast dev sudah ROI terlihat; downgrade = lost velocity. |
| **Pertahankan A** CodeMirror 6 **lebih baik B** Lexical atau TipTap **karena** CodeMirror terbukti untuk markdown plain-text; Lexical = AST editor = scope creep. |

### 4.4 Technical debt yang harus diprioritaskan

| # | Item | Severity | Effort |
|---|---|---|---|
| 1 | **`workspace-app.tsx` god component** (2197 LOC) | High (long-term) | XL (refactor) |
| 2 | **`frontmatter.lock` legacy field** — masih di-index, harus verify tidak bocor | Med | S |
| 3 | **No conflict resolution untuk document** — concurrent edit = silent overwrite | Med (data loss risk) | M |
| 4 | **Tests are mostly unit, no e2e for new fixes** (Ctrl+A, width override) | Med | M |
| 5 | **3 deleted files leave `.bak`/`~` candidates** — perlu audit filesystem | Low | XS (Tahap 2) |
| 6 | **4 dead imports** in various files (sisa `writeDocument`, `ai-config`, dll) | Low | S |
| 7 | **10 lint warnings** pre-existing — bukan error, tapi indicator | Low | S |
| 8 | **`a18eec4 fix(login)`** + **c15c80e revert(workspace)** = banyak churn di git log | Cosmetic | — |

---

## 5. Prioritas & Roadmap

### 5.1 Ranking

#### Critical (sebelum go-live, blocker)

| Item | Alasan |
|---|---|
| **C1** Audit filesystem — hapus file mati (Tahap 2) | Repo publik, asset tak terpakai = bloat + signal "tidak maintain" |
| **C2** Verifikasi `frontmatter.lock` benar-benar mati di semua path | Legacy field bocor = surprise untuk user |
| **C3** Verifikasi AI block removal lengkap (no `ai` UI hint tertinggal) | Sudah dihapus, tapi legacy `ai` code block di old doc — perlu cek rendering |
| **C4** `pnpm verify` green | tsc + lint + 24 test + encoding + build — all green (sudah hijau hari ini) |

#### Important (segera setelah launch)

| Item | Alasan |
|---|---|
| **I1** Onboarding first-run modal | Empty workspace = user churn |
| **I2** Conflict resolution untuk document edits | Data safety = core promise |
| **I3** Hapus password manager sub-product atau pisahkan ke route `/vault` | Two-product = confusion |
| **I4** Verifikasi rename toast muncul | Fungsi ada, UI confirmation perlu dicek |
| **I5** Tambah 1-2 e2e test untuk fix terbaru (Ctrl+A, width override) | Anti-regression |

#### Nice-to-have (backlog)

| Item | Alasan |
|---|---|
| **N1** Page templates | Power-user value |
| **N2** Keyboard shortcut cheatsheet | Onboarding accelerator |
| **N3** Drag image dari web | Convenience |
| **N4** Bulk operations | Power-user |
| **N5** Refactor `workspace-app.tsx` jadi sub-components | Long-term health |

### 5.2 Roadmap singkat

| Sprint | Fokus | Items |
|---|---|---|
| **Pre-go-live** (sekarang) | Stabilitas | C1-C4 |
| **v1.0.0 (launch)** | Public release | — |
| **v1.1 (1-2 minggu)** | Onboarding + cleanup | I1, I3, I5 |
| **v1.2 (3-4 minggu)** | Data safety + UX polish | I2, I4, N3 |
| **v1.3 (6-8 minggu)** | Power-user + debt | N1, N4, I4 |
| **v2.0 (3+ bulan)** | Refactor + scaling | N5, N2 |

---

## 6. Ringkasan Eksekutif

**MarkForge sudah solid untuk launch sebagai v1.0.0** dengan catatan:

✅ **Yang sudah bagus**:
- 24 test suites green
- Encoding gate aktif
- Plain markdown — source of truth
- Two backends mature
- Trash/restore safety net

⚠️ **Yang perlu di-address sebelum launch**:
- Cleanup filesystem (Tahap 2)
- Verifikasi legacy `frontmatter.lock` benar-benar inert
- Konfirmasi render `ai` code block jadi fallback (bukan error)

🎯 **Setelah launch (v1.1)**:
- Onboarding
- Conflict resolution
- Pertimbangkan pisahkan password manager

**Rekomendasi**: Lanjut ke Tahap 2 (cleanup) setelah user approve audit ini. Tahap 3 (go-live) setelah Tahap 2 selesai.

---

**Next step**: Review laporan ini. Jika ada disagree dengan rekomendasi (terutama I3 pisahkan password manager, atau hapus side peek), sebutkan sebelum lanjut Tahap 2.
