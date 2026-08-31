# Dokumentasi Fitur Block Notion

## Icon `+` dan `⠿` (6-dot)

Kedua icon ini muncul di sisi kiri tiap block saat di-hover mouse.

- **`+` (plus)** — Klik untuk **menyisipkan block baru** tepat di bawah block yang sedang di-hover. Begitu diklik, otomatis muncul slash command menu (list block type) untuk memilih block apa yang ingin ditambahkan.
- **`⠿` (6-dot / drag handle)** — Dua fungsi:
  1. **Klik** → membuka context menu block (Turn into, Color, Copy link to block, Duplicate, Move to, Delete, Suggest edits, Ask AI, dll)
  2. **Klik-tahan-drag** → untuk reorder posisi block (pindah ke atas/bawah, atau nested ke dalam block lain)

---

## Basic Blocks (isi slash menu / "Turn into")

Ini daftar semua tipe block yang bisa dipilih saat membuat block baru, ATAU dipakai untuk convert block yang sudah ada lewat fungsi **"Turn into"**.

**Cara kerja Turn into:** pilih block yang ingin diubah tipenya → klik `⠿` → pilih "Turn into" → pilih tipe baru → isi teks tetap sama, hanya formatnya yang berubah.

### Teks & Heading

| Block | Fungsi | Shortcut |
|---|---|---|
| **Text** | Paragraf polos, default block, tanpa styling khusus | Ketik teks biasa |
| **Heading 1** | Judul terbesar, level tertinggi struktur dokumen | `#` + spasi |
| **Heading 2** | Judul level kedua | `##` + spasi |
| **Heading 3** | Judul level ketiga | `###` + spasi |
| **Heading 4** | Judul level keempat, terkecil | `####` + spasi |

Heading otomatis bisa dijadikan Table of Contents.

### List

| Block | Fungsi | Shortcut |
|---|---|---|
| **Bulleted list** | List dengan bullet (•), bisa di-indent (Tab) untuk sub-list | `-` + spasi |
| **Numbered list** | List dengan angka otomatis, auto re-order saat item ditambah/dihapus | `1.` + spasi |
| **To-do list** | List dengan checkbox, teks tercentang jadi strikethrough | `[]` + spasi |
| **Toggle list** | Block collapsible dengan arrow ▶/▼ untuk sembunyikan/tampilkan child content | `>` + spasi |

### Page & Navigasi

| Block | Fungsi |
|---|---|
| **Page** | Membuat sub-halaman baru (nested page) di dalam halaman saat ini |
| **Page in** | Sama seperti Page, tapi ada submenu untuk memilih lokasi penempatan halaman baru |
| **Link to page** | Membuat link/reference ke halaman yang **sudah ada** (bukan bikin baru) |
| **Breadcrumb** | Menampilkan jalur hierarki halaman (misal: Workspace > Project > Halaman Ini) sebagai navigasi horizontal |

### Konten Khusus

| Block | Fungsi | Shortcut |
|---|---|---|
| **Callout** | Kotak dengan background warna + icon di kiri, untuk highlight info penting. Icon bisa diganti emoji/custom | — |
| **Quote** | Blockquote dengan garis vertikal di kiri, untuk kutipan/teks yang ditonjolkan | `"` + spasi |
| **Table** | Tabel dengan baris & kolom yang bisa diedit, tambah/hapus kolom-baris | — |
| **Divider** | Garis horizontal pemisah section, murni visual | `---` |
| **Code** | Block khusus kode program dengan syntax highlighting dan tombol copy | ` ``` ` + spasi |
| **Block equation** | Render rumus matematika/LaTeX (notasi KaTeX) | — |
| **Synced block** | Block yang isinya tersambung di banyak tempat sekaligus — edit di satu tempat, ter-update di semua instance lain | — |

### Toggle Heading (kombinasi Heading + Toggle)

| Block | Fungsi | Shortcut |
|---|---|---|
| **Toggle heading 1** | Heading level 1 dengan arrow collapsible di depannya | `#` + spasi (lalu convert) |
| **Toggle heading 2** | Heading level 2 dengan arrow collapsible | `##` + spasi (lalu convert) |
| **Toggle heading 3** | Heading level 3 dengan arrow collapsible | `###` + spasi (lalu convert) |
| **Toggle heading 4** | Heading level 4 dengan arrow collapsible | `####` + spasi (lalu convert) |

Fungsinya menggabungkan struktur heading dengan kemampuan collapse/expand isi section, cocok untuk dokumen panjang dengan banyak section yang bisa disembunyikan.

### Layout

| Block | Fungsi |
|---|---|
| **2 columns** | Halaman terbagi jadi 2 kolom sejajar, tiap kolom bisa diisi block berbeda |
| **3 columns** | Halaman terbagi jadi 3 kolom sejajar |
| **4 columns** | Halaman terbagi jadi 4 kolom sejajar |
| **5 columns** | Halaman terbagi jadi 5 kolom sejajar |

Lebar tiap kolom bisa di-drag/resize secara independen.

---

## Media

| Block | Fungsi |
|---|---|
| **Code** | (lihat kategori Konten Khusus di atas) |

