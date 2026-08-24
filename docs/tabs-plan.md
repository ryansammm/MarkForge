# Tab Dokumen & Riwayat Navigasi — Rencana Fitur

**Status:** Fase 0–4 selesai.
**Produk:** Morrow
**Prinsip utama:** *satu sesi kerja, satu jendela* — membuka dua catatan sekaligus tidak boleh butuh dua tab browser, dan mengikuti sebuah tautan tidak boleh menghilangkan tempat asal.

---

## Ringkasan

Morrow hari ini adalah aplikasi satu-dokumen. Seluruh state dokumen aktif bertumpu pada
satu `useState`: `activePath` di [workspace-app.tsx:104](../components/workspace/workspace-app.tsx). Mengklik apa pun —
item sidebar, backlink, wikilink, hasil pencarian — memanggil `navigateTo` yang
mengganti dokumen di tempat. Tidak ada tab, tidak ada riwayat, tidak ada tombol kembali.

Rencana ini menambahkan **tab dokumen di dalam aplikasi** beserta **riwayat maju/mundur
per tab**, dengan mengubah `activePath` menjadi sebuah sesi navigasi yang bisa berisi
banyak dokumen.

## Masalah yang diselesaikan

Untuk membaca dua catatan sekaligus, satu-satunya jalan saat ini adalah membuka aplikasi
Morrow di tab browser kedua. Ini menimbulkan dua kerugian nyata:

1. **Dua instance aplikasi berarti dua salinan state.** Dua `indexData` terpisah, dua
   mesin autosave, dua vault. Rename di satu tab tidak terlihat di tab lain sampai
   reload, dan dua editor yang tidak sadar satu sama lain adalah cara termurah untuk
   memicu konflik `If-Match` pada dokumen yang sama.
2. **Konteks hilang saat mengikuti tautan.** Klik backlink, baca, lalu tidak ada jalan
   kembali ke titik asal selain mencarinya lagi di sidebar.

### Catatan temuan: tidak ada yang membuka tab browser hari ini

Perlu diluruskan karena mengubah ruang lingkup pekerjaan. Semua navigasi internal sudah
in-place, bukan `<a target="_blank">`:

| Permukaan | Kode | Perilaku |
|---|---|---|
| Backlink | [backlinks-panel.tsx:57](../components/workspace/backlinks-panel.tsx) | `<button onClick={onSelectDoc}>` → `navigateTo` |
| Wikilink (mode baca) | [doc-viewer.tsx:129](../components/workspace/doc-viewer.tsx) | `<button onClick={onNavigateWikilink}>` |
| Wikilink (mode edit) | [live-preview.ts:258](../components/workspace/live-preview.ts) | `mousedown` + Ctrl/Cmd → `onNavigate` |
| Sidebar, pencarian, recent edits | — | semuanya `<button>` |

Satu-satunya `target="_blank"` ada di [doc-viewer.tsx:151](../components/workspace/doc-viewer.tsx) untuk URL eksternal
sungguhan, dan itu memang benar. Jadi yang dibangun di sini bukan perbaikan bug
navigasi, melainkan **kemampuan menahan lebih dari satu dokumen terbuka** — yang selama
ini disiasati pengguna dengan tab browser.

## Sasaran

1. Beberapa dokumen dapat terbuka bersamaan sebagai tab di dalam aplikasi, dengan satu
   `indexData` dan satu mesin autosave.
2. Klik backlink/wikilink dengan modifier membuka tab baru; tanpa modifier tetap
   mengganti di tempat.
3. Setiap tab punya riwayat maju/mundur sendiri.
4. Set tab bertahan melewati reload dan restart aplikasi.
5. Rename, pemindahan, dan penghapusan dokumen merapikan seluruh tab yang menunjuk ke
   sana — tidak ada tab yang menggantung ke path yang sudah tidak ada.
6. Tidak ada satu pun jalur di mana tab menyebabkan tulisan hilang.

## Bukan sasaran rilis ini

- **Split pane / stacked panes.** Menampilkan dua dokumen berdampingan adalah fitur
  berbeda dengan model layout berbeda. Model tab di Fase 0 adalah prasyaratnya, bukan
  saingannya.
- **Sinkronisasi URL dan deep link.** Aplikasi belum punya routing per dokumen sama
  sekali. Menambahkannya bersamaan dengan tab memunculkan pertanyaan yang belum perlu
  dijawab ("URL mewakili tab yang mana?"). Dicatat sebagai lanjutan.
- **Tab preview bergaya VS Code** (tab italic yang tergantikan bila tidak di-pin).
  Perilaku implisit yang sulit ditebak; ditunda sampai ada keluhan nyata.
- **Menyeret tab antar jendela.**
- **Mengedit di lebih dari satu tab sekaligus.** Lihat Keputusan 3.

---

## Keputusan desain

| Pertanyaan | Keputusan | Alasan |
|---|---|---|
| **1. Klik backlink: ganti di tempat atau tab baru?** | **Ganti di tempat.** Tab baru lewat Ctrl/Cmd+klik atau klik tengah. | Kalau setiap backlink membuka tab, sepuluh menit membaca menghasilkan dua puluh tab yang tidak satu pun diminta. Model Chrome/Obsidian sudah jadi kebiasaan dan bisa dipelajari sekali. **Ini satu-satunya keputusan yang saya ambil berbeda dari permintaan awal** — kalau backlink memang harus selalu membuka tab, perubahannya satu baris di `handleNavigateWikilink`, dan sebaiknya diputuskan sebelum Fase 1 dimulai, bukan sesudah. |
| **2. Apa yang per-tab, apa yang global?** | Per-tab: `path`, `mode`, riwayat, posisi scroll. Global: `indexData`, dialog, rail, sidebar, vault, indikator simpan. | `mode` harus per-tab: membuka catatan referensi saat sedang mengedit tidak boleh menyeret editor ikut pindah. Sisanya milik aplikasi, bukan milik dokumen. |
| **3. Bagaimana dengan mesin autosave?** | **Tetap satu instance `useDocumentSave`, terikat pada tab aktif. Pindah tab memanggil `flushPendingSave()` lebih dulu.** Tab latar bersifat baca. | Rules of Hooks melarang membuat instance hook per tab secara dinamis; alternatifnya adalah komponen per-tab, sebuah refactor jauh lebih besar dengan risiko kehilangan data yang nyata. Dan Morrow adalah aplikasi autosave — "belum tersimpan" hanya berumur selama debounce. Memaksa flush saat pindah tab **lebih aman** daripada memelihara N buffer kotor di latar. `navigateTo` sudah melakukan persis ini hari ini ([workspace-app.tsx:346](../components/workspace/workspace-app.tsx)). |
| **4. Body dokumen di-cache atau di-fetch ulang tiap pindah tab?** | **Cache per path, dengan revalidasi.** Tampilkan cache seketika, tetap fetch di belakang, batas 20 entri (LRU). | Tanpa cache, tiap perpindahan tab menampilkan skeleton — tab yang terasa lambat seperti itu tidak menyelesaikan masalah apa pun. Body rata-rata ~1,9 KB (81% dari indeks 4,68 MB pada 2.000 dokumen, `docs/phase-4-scale.md`), jadi 20 tab ≈ 40 KB. Revalidasi wajib karena indeks memang boleh basi terhadap disk, dan etag yang basi berarti simpanan pertama menimpa perubahan dari luar aplikasi. |
| **5. Masuk mode edit memakai etag yang mana?** | Etag dari fetch terbaru. Bila revalidasi masih berjalan, tombol Edit menunggu. | Ini invarian yang sudah dijaga hari ini lewat `source?.path !== activePath`; cache tidak boleh melubanginya. |
| **6. Berapa batas jumlah tab?** | Tidak dibatasi; strip menggulir. Cache body yang dibatasi (20). | Batas keras memaksa pertanyaan "tab mana yang ditutup" ke pengguna tanpa alasan teknis. Yang mahal adalah body, dan itu sudah dibatasi. |
| **7. Tab di layar sempit?** | Strip menggulir horizontal, disembunyikan sepenuhnya bila hanya ada satu tab. | Di bawah `md` sidebar sudah berupa drawer; strip yang selalu ada mengambil tinggi yang tidak dimiliki. Menyembunyikannya saat satu tab membuat pengguna satu-dokumen tidak membayar apa pun. |
| **8. Pintasan papan tik berbasis apa?** | **Alt**, bukan Ctrl. | Ctrl+W, Ctrl+T, Ctrl+Tab, dan Ctrl+1..9 dipesan browser dan `preventDefault()` tidak mencegatnya di Chrome. Alt+← / Alt+→ *bisa* dicegat dan maknanya tepat. Catatan: di PWA terinstal pintasan Ctrl kembali tersedia — bisa ditambahkan belakangan di belakang pemeriksaan `display-mode: standalone`. |

### Tabrakan yang ditemukan di kode

Di editor, **Ctrl/Cmd+klik sudah dipakai** sebagai gestur navigasi wikilink
([live-preview.ts:261](../components/workspace/live-preview.ts)) — jadi di sana ia tidak bisa sekaligus berarti "buka
tab baru". Di dalam editor, gestur tab baru adalah **Ctrl/Cmd+Shift+klik**. Perbedaan
antara mode baca dan mode edit ini disengaja dan harus disebut di tooltip.

---

## Model data

Berkas baru: `lib/tabs.ts` — reducer murni, tanpa React, supaya bisa diuji sebagai skrip
node seperti `tests/store.test.ts`.

```ts
export interface Tab {
  id: string
  /** Dokumen yang sedang ditampilkan; selalu sama dengan history[cursor]. */
  path: string
  mode: 'read' | 'edit'
  /** Tumpukan path yang pernah dikunjungi di tab ini. Dibatasi 50. */
  history: string[]
  cursor: number
}

export interface TabsState {
  tabs: Tab[]
  activeId: string | null
}

export type TabAction =
  | { type: 'open'; path: string; newTab?: boolean; background?: boolean }
  | { type: 'close'; id: string }
  | { type: 'closeOthers'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'setMode'; id: string; mode: 'read' | 'edit' }
  | { type: 'back' } | { type: 'forward' }
  | { type: 'reorder'; from: number; to: number }
  // Rekonsiliasi terhadap operasi berkas
  | { type: 'pathRenamed'; from: string; to: string }
  | { type: 'prefixMoved'; from: string; to: string }
  | { type: 'pathRemoved'; path: string }
  | { type: 'prefixRemoved'; prefix: string }
```

**Semantik yang harus dijaga reducer:**

- `open` tanpa `newTab` menavigasi tab aktif: potong `history` setelah `cursor`, dorong
  path baru, majukan `cursor`. Sama seperti riwayat browser.
- `open` dengan `newTab` ke path yang **sudah terbuka** di tab lain mengaktifkan tab itu,
  tidak membuat duplikat.
- `close` pada tab aktif memindahkan fokus ke tetangga kanan, atau kiri bila ia yang
  terakhir. Menutup tab terakhir menghasilkan `activeId: null` (layar kosong yang sudah
  ditangani `DocViewer`).
- `pathRemoved` / `prefixRemoved` menutup setiap tab yang cocok **dan** membersihkan
  entri yang cocok dari `history` setiap tab yang tersisa, lalu mengoreksi `cursor`.
  Riwayat yang menyimpan path terhapus berarti tombol Kembali menuju 404.

## Perubahan berkas

### Baru

| Berkas | Isi |
|---|---|
| `lib/tabs.ts` | Reducer murni. `serializeTabs` / `deserializeTabs` menyusul di Fase 3, tempat keduanya benar-benar dipakai. |
| `components/workspace/tab-strip.tsx` | Strip tab: judul, tombol ×, klik tengah untuk menutup, menu konteks (Tutup, Tutup lainnya, Tutup ke kanan). |
| `lib/use-tab-session.ts` | Pembungkus React: `useReducer` + persistensi + cache body per path. Diletakkan di `lib/` bukan `components/workspace/` seperti rencana awal, mengikuti `use-document-save.ts` dan `use-persisted-flag.ts`. |
| `tests/tabs.test.ts` | Uji reducer. |

### Diubah

| Berkas | Perubahan |
|---|---|
| [workspace-app.tsx](../components/workspace/workspace-app.tsx) | `activePath`/`setActivePath` → sesi tab. Menyentuh ~9 titik: boot (baris 130–144), efek pembacaan sumber (239–269), `editingPath` (304), `navigateTo` (346), rename (485–503), hapus (579–605), `createGhostPage` (616), render header dan panel. |
| [doc-viewer.tsx](../components/workspace/doc-viewer.tsx) | `onNavigateWikilink(target)` → `onNavigateWikilink(target, { newTab })`; baca modifier dari event klik. |
| [live-preview.ts](../components/workspace/live-preview.ts) | Teruskan `shiftKey` ke `onNavigate`. |
| [backlinks-panel.tsx](../components/workspace/backlinks-panel.tsx), [recent-edits-panel.tsx](../components/workspace/recent-edits-panel.tsx), [sidebar.tsx](../components/workspace/sidebar.tsx), [search-dialog.tsx](../components/workspace/search-dialog.tsx) | `onSelectDoc(path)` → `onSelectDoc(path, { newTab })`; tambahkan `onAuxClick` untuk klik tengah (`<button>` tidak memicu `onClick` pada tombol tengah). |
| `package.json` | Tambah `test:tabs`, masukkan ke rantai `npm test`. |

---

## Fase

### Fase 0 — Refactor ke model tab, tanpa perubahan tampilan — **selesai**

Ganti `activePath` dengan sesi tab yang **dibatasi satu tab**. Strip tidak dirender.
Perilaku aplikasi harus identik dengan hari ini.

- [x] [lib/tabs.ts](../lib/tabs.ts) — reducer murni, 26 check di [tests/tabs.test.ts](../tests/tabs.test.ts), terdaftar di `npm test`.
- [x] [lib/use-tab-session.ts](../lib/use-tab-session.ts) membungkus reducer; `activePath` dan `mode` menjadi turunan dari tab aktif.
- [x] Semua callback rename/pindah/hapus dialihkan ke aksi reducer.
- [x] `typecheck`, `lint`, `npm test` (386 check), dan `next build` hijau.

Batas satu tab tidak ditegakkan lewat konstanta: tidak ada satu pun pemanggil yang
mengirim `newTab`, jadi sesi secara alami hanya berisi satu tab. Tidak ada yang perlu
dihapus di Fase 1.

Tiga hal yang menjadi lebih benar dari sebelumnya, dan tidak bisa jadi regresi karena
ketiganya menyentuh state yang dulu belum ada:

- Rename dokumen kini juga menulis ulang entri riwayat, bukan hanya path yang tampil.
- Pemindahan folder menulis ulang prefiks di seluruh sesi.
- Penghapusan membersihkan path terhapus dari riwayat tab yang bertahan, dan mengoreksi
  cursor supaya dokumen di layar tidak ikut bergeser.

Fase ini yang memikul risikonya. Memisahkannya berarti setiap regresi yang muncul di
sini pasti berasal dari refactor, bukan dari fitur.

### Fase 1 — Multi-tab — **selesai**

- [x] [TabStrip](../components/workspace/tab-strip.tsx) dirender bila `tabs.length > 1`, di atas header.
- [x] Ctrl/Cmd+klik dan klik tengah membuka tab latar dari sidebar, backlink, wikilink,
      pencarian, dan recent edits — lewat satu helper, [tab-gestures.ts](../components/workspace/tab-gestures.ts).
- [x] Ctrl/Cmd+Shift+klik membuka tab depan. Di editor, ini adalah gestur tab baru.
- [x] Tombol `+` membuka dialog pencarian; memilih hasil membuat tab baru.
- [x] Aksi **"Open in new tab"** pada baris sidebar — lihat catatan keterdiskoveran.
- [x] Cache body per path, dengan pembacaan ulang setiap kali tab difokuskan.
- [x] `mode` per tab (sudah sejak Fase 0).
- [x] Rekonsiliasi berkas (sudah sejak Fase 0).
- [x] Alt+W menutup, Alt+1..9 melompat (Alt+9 = tab terakhir), Alt+PageUp/PageDown berpindah.

**Keterdiskoveran.** Strip hanya muncul pada dua tab atau lebih, jadi tombol `+` tidak
ada saat sesi masih satu tab — dan Mod-klik tidak mengumumkan dirinya sendiri. Karena
itu baris berkas di sidebar mendapat aksi "Open in new tab" di samping Rename dan
Delete. Itulah satu-satunya jalan yang terlihat menuju tab kedua.

**Yang berubah dari rencana.**

- **Tidak ada batas 20 entri pada cache.** Cache dipangkas ke himpunan tab yang terbuka,
  yang membatasinya dengan sesuatu yang bisa dilihat dan dikendalikan pengguna alih-alih
  dengan angka yang tidak bisa. Pemangkasan menumpang pada penulisan cache, bukan pada
  effect yang mengawasi sesi tab — `setState` sinkron di dalam badan effect adalah
  cascading render, dan `react-hooks/set-state-in-effect` menolaknya. Konsekuensinya:
  menutup tab latar menahan byte-nya sampai pembacaan berikutnya.
- **Kesegaran adalah satu path, bukan flag per entri.** `freshPath` mencatat satu-satunya
  dokumen yang byte-nya diketahui cocok dengan berkas. Memfokuskan tab mengubah
  `activePath` sehingga tidak lagi sama dengan `freshPath`, dan itulah seluruh pemicu
  pembacaan ulang — tanpa perlu ada yang menandai apa pun dari dalam effect.
- **Penjaga balapan baca/tulis.** `writeCountRef` menghitung penulisan per dokumen.
  Pembacaan yang dimulai sebelum sebuah penyimpanan dan selesai sesudahnya dibuang,
  karena kalau tidak, byte pra-simpan dan etag matinya akan kembali masuk cache — dan
  penyimpanan berikutnya dikirim dengan etag yang sudah diganti server. Balapan ini
  sudah ada sebelum ada tab; tab membuatnya jauh lebih mudah dipicu.

### Fase 2 — Riwayat maju/mundur per tab — **selesai**

- [x] Tombol ←/→ di header, sebelum breadcrumb, nonaktif saat tumpukan habis.
- [x] Alt+← / Alt+→, dengan `preventDefault`.
- [x] Tombol mouse 4/5 (`mousedown`, `event.button === 3 | 4`).

**Tujuannya disebutkan, bukan disiratkan.** Tooltip berbunyi "Back to Welcome to
Markdown Workspace", bukan sekadar "Back". Riwayat ini bukan milik browser, jadi tidak
ada yang datang sudah tahu apa yang ada di belakangnya.

**Gestur browser dibatalkan, bukan diteruskan.** Alt+← dan tombol mouse 3/4 adalah
gestur riwayat milik browser; membiarkannya lewat akan keluar dari aplikasi sepenuhnya,
karena tidak ada URL per dokumen dan yang ada di belakang halaman ini adalah layar login
atau situs sebelumnya. Pembatalan hanya dilakukan selagi ada tab terbuka, supaya
workspace kosong tidak menjadi jebakan.

**Maju/mundur ikut melakukan flush.** `goBack` dan `goForward` memanggil
`flushPendingSave()` persis seperti `navigateTo`. Menekan Kembali adalah meninggalkan
sebuah dokumen sama seperti mengklik menjauh darinya, dan buffer tidak boleh menjadi
pembedanya.

### Fase 3 — Bertahan melewati reload — **selesai**

- [x] Sesi ditulis ke `localStorage['morrow:tabs']` pada setiap perubahan.
- [x] Saat boot, path yang tidak ada lagi di `indexData.documents` dibuang; bila tidak
      ada yang tersisa, kembali ke perilaku lama (`paths[0]`).
- [x] Posisi scroll per tab — **dalam sesi saja**, lihat di bawah.

**Id tidak disimpan.** Id tidak berarti apa pun di luar sesi yang membuatnya, dan
menerbitkannya ulang saat restore adalah yang membuat tab hasil restore mustahil
bertabrakan dengan tab yang dibuka sesudahnya. Karena itu tab aktif disimpan sebagai
indeks, bukan id.

**Tidak ada yang dipercaya saat masuk.** Payload-nya bisa diedit tangan dan bisa
ditulis oleh build lama, jadi `deserializeTabs` menolak versi yang tidak cocok,
bentuk yang salah, dan tipe yang salah; membuang path yang sudah tidak ada dari
riwayat sekaligus dari tab; menjepit cursor ke rentang yang sah; memangkas riwayat ke
`MAX_HISTORY`; dan mengembalikan **null**, bukan sesi kosong, bila tidak ada yang
tersisa — supaya pemanggil jatuh ke perilaku lama alih-alih memulai dengan layar
kosong.

**Penulisan menunggu dispatch pertama.** Tanpa itu, penulisan akan sekali jalan saat
mount dengan sesi kosong dan menghapus isi storage sebelum boot sempat membacanya —
indeks adalah sebuah fetch, jadi restore selalu tertinggal beberapa ratus milidetik di
belakang render pertama.

**Yang berubah dari rencana: scroll tidak ikut disimpan.** Posisi scroll hidup di
sebuah ref di `WorkspaceApp`, bukan di dalam reducer. Memasukkannya ke sesi berarti
satu dispatch dan satu penulisan localStorage per frame scroll. Harganya: satu posisi
hilang per reload, ditukar dengan penulisan pada setiap putaran roda mouse. Berpindah
tab tetap mengembalikan Anda ke paragraf yang sama, yang memang keuntungan utamanya.

### Fase 4 — Layar sempit dan penyempurnaan — **selesai**

- [x] Strip menggulir horizontal; tab `w-32` di bawah `md`, `w-40` di atasnya.
- [x] Tab aktif otomatis terlihat.
- [x] Menu konteks: Close, Close others, Close to the right.
- [x] Menyeret untuk mengurutkan ulang, tanpa dependensi baru.
- [x] Titik penanda konflik simpan (Risiko 2).

**Strip yang digulir, bukan `scrollIntoView`.** Effect-nya menghitung `scrollLeft`
sendiri. `scrollIntoView` bebas menggulir halaman juga, dan dokumen di bawahnya adalah
yang sedang dibaca orang.

**Sumber drag disimpan di ref, bukan state.** `dragstart` dan `drop` adalah dua event
terpisah dan tidak ada yang menjamin React sempat me-render ulang di antaranya; dengan
state, drop akan membaca `null` dan diam-diam tidak melakukan apa-apa. Versi pertama
memang begitu, dan ketahuan saat diuji. State hanya dipakai untuk meredupkan tab.

**Fokus mengikuti tab, bukan posisi.** Menyeret tab yang sedang dibaca tidak boleh
mendaratkan Anda di dokumen lain.

**Risiko 2 ternyata lebih buruk dari yang ditulis.** Rencana ini menduga notifikasi
konflik bisa lenyap bersama indikatornya. Yang sebenarnya terjadi: `use-document-save`
membuang **seluruh** respons bila dokumen sudah berganti selagi permintaan di udara
([lib/use-document-save.ts](../lib/use-document-save.ts)), jadi 409 untuk tab yang sudah ditinggalkan tidak pernah
dilaporkan sama sekali. Server tetap menyimpan apa yang diketik di `conflictPath`,
tetapi tidak ada apa pun di layar yang mengatakannya. Karena itu hook mendapat callback
`onConflict` yang menyala **sebelum** pemeriksaan itu, dan titik pada tab adalah
satu-satunya tempat konflik tersebut dilaporkan. Titiknya hilang hanya ketika sebuah
penyimpanan untuk dokumen itu berhasil — bukan ketika dilihat.

---

## Risiko

**1. Refactor menyentuh setiap jalur mutasi dokumen.** Rename, pemindahan folder,
penghapusan, restore dari trash, dan pembuatan halaman hantu semuanya menulis
`activePath` hari ini. Melewatkan satu berarti tab menggantung ke path mati.
*Mitigasi:* Fase 0 tidak menambah fitur apa pun, dan `tests/tabs.test.ts` menguji setiap
aksi rekonsiliasi sebagai fungsi murni sebelum satu pun tab tampil di layar.

**2. Konflik simpan bisa muncul pada tab yang sudah ditinggalkan.** `SaveIndicator`
hanya dirender saat `mode === 'edit'` ([workspace-app.tsx:746](../components/workspace/workspace-app.tsx)). Bila konflik
`If-Match` muncul tepat setelah pindah tab, pemberitahuannya bisa lenyap bersama
indikatornya.
*Mitigasi:* konflik memunculkan toast (`sonner` sudah menjadi dependensi) **dan** menandai
tab asal dengan titik yang bertahan sampai konflik ditangani.

**3. Menghapus penyebab bukan gejalanya.** Kalau kebutuhan sebenarnya adalah "jangan
kehilangan tempat saat mengikuti tautan", Fase 2 sendirian menyelesaikannya dengan
sepersekian usaha Fase 1.
*Mitigasi:* Fase 0 adalah prasyarat keduanya. Bila setelah Fase 2 ternyata tab jarang
dipakai, Fase 3 dan 4 boleh dibatalkan tanpa membuang apa pun.

**4. Dua instance aplikasi tetap mungkin.** Pengguna masih bisa membuka dua tab browser,
dan sekarang keduanya menulis ke `localStorage['morrow:tabs']` yang sama.
*Mitigasi:* tulis saat berubah, jangan baca ulang kecuali saat boot. Sesi tab bersifat
per-jendela; yang terakhir menutup menang. Ini sengaja tidak disinkronkan — menyamakan
set tab antar jendela adalah perilaku yang justru mengejutkan.

## Pengujian

| Lapis | Cakupan |
|---|---|
| `tests/tabs.test.ts` (baru) | Reducer: open/close/activate, fokus setelah menutup tab aktif, dedup saat `newTab` ke path yang sudah terbuka, potong-riwayat saat navigasi, back/forward di ujung tumpukan, `pathRemoved` membersihkan riwayat dan mengoreksi cursor, `prefixMoved` pada folder bersarang, serialisasi menolak path yang hilang, batas riwayat 50. |
| `tests/rename.test.ts`, `tests/data-safety.test.ts` | Sudah ada; harus tetap hijau setelah Fase 0. |
| `scripts/ui-verify.test.ts` (Playwright) | Satu alur: buka dua tab, edit di satu, pindah, kembali — pastikan tulisan tersimpan dan editor memuat teks terbaru. |

## Yang perlu diputuskan sebelum Fase 1

1. **Keputusan 1** — apakah klik backlink harus selalu membuka tab baru? Rencana ini
   memilih tidak; ini keputusan produk, bukan teknis.
2. Apakah tab menampilkan judul dokumen atau nama berkas? (Rencana: judul, konsisten
   dengan breadcrumb dan panel backlink.)
