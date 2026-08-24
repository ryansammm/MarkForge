# Password Manager — Rencana Fitur

**Status:** MVP terimplementasi (Fase 0–3)  
**Produk:** Morrow  
**Prinsip utama:** *zero-knowledge vault* — backend, bucket R2, backup, indeks, dan log tidak boleh dapat membaca isi kredensial.

---

## Keputusan Fase 0 (diambil saat implementasi)

Fase 0 memblokir Fase 1 pada lima pertanyaan terbuka. Berikut jawaban yang dipakai,
beserta alasannya. Yang berubah dari rencana awal hanya **satu**: KDF.

| Pertanyaan | Keputusan | Alasan |
|---|---|---|
| Library Argon2id dan cipher | **PBKDF2-SHA256 600.000 iterasi + AES-256-GCM, keduanya WebCrypto.** Bukan Argon2id. | Argon2id di browser berarti bundle WASM pada aplikasi yang saat ini punya nol dependensi kripto — biaya bundle, audit, dan kompatibilitas Turbopack yang tidak sebanding untuk rilis pertama. WebCrypto adalah kode native yang sudah diaudit, tersedia di semua target, dan 0 byte bundle. 600.000 iterasi adalah angka OWASP terkini untuk PBKDF2-HMAC-SHA256. |
| Migrasi ke Argon2id nanti | **Tidak diblokir.** `kdf` pada record adalah union bertag yang sudah mendeskripsikan parameter argon2id (`memoryKiB`, `parallelism`), dan `deriveKey` menolak algoritma yang belum diimplementasikan dengan pesan eksplisit alih-alih menebak. | Vault yang ditulis hari ini bisa di-*reseal* dengan parameter baru pada unlock berikutnya, tanpa skrip migrasi. Ini yang membuat memilih opsi konservatif lebih dulu aman. |
| Recovery key di MVP | **Tidak.** Tetap P1, seperti rencana awal. | Menambahnya mengubah format record dan onboarding; layar bootstrap menyatakan secara eksplisit bahwa tidak ada jalan pemulihan. |
| Durasi auto-lock & visibility | **15 menit idle; 60 detik setelah tab masuk background; selalu terkunci saat reload.** Visibility tidak mengunci seketika. | Mengunci seketika saat tab hilang fokus membuat "salin password lalu pindah ke tab lain" — alur paling umum — mustahil. 60 detik menutup kasus "meninggalkan meja" tanpa merusaknya. Timer di-*poll* tiap 5 detik, bukan satu timeout panjang, agar laptop yang sleep tetap terkunci saat dibuka. |
| Auto-clear clipboard | **Default aktif, 30 detik, dan jujur tentang batasannya.** | Clipboard manager yang sudah merekam entri tetap menyimpannya, dan sebagian browser menolak `readText` tanpa gesture. Implementasinya menimpa dengan spasi (bukan string kosong, yang ditolak sebagian browser) dan hanya bila isi clipboard masih nilai yang disalin. |
| Multi-device sejak MVP | **Ya, sebatas conflict handling.** Revision + `If-Match`, dengan pilihan *merge* atau *keep this copy* di UI. | Merge menyatukan berdasarkan id item; edit pada item yang sama diselesaikan last-write-wins per `updatedAt`. Penghapusan tidak direkonsiliasi — item yang ada di satu sisi selalu dipertahankan, karena item berlebih terlihat dan bisa dihapus, sedangkan item hilang tidak. |

Threat model yang diminta Fase 0 tidak ditulis sebagai dokumen terpisah; mitigasi tiap
ancaman ada sebagai komentar di titik kode yang menanganinya, dan sebagai test negatif
di `tests/vault.test.ts`.

## Ringkasan

Morrow saat ini menyimpan catatan Markdown sebagai sumber kebenaran, dengan metadata dan indeks yang dapat dibangun ulang. Password Manager akan menjadi vault terpisah untuk menyimpan kredensial pribadi tanpa mencampurkan plaintext ke dokumen, `index.json`, `search.json`, atau share link.

MVP ditujukan untuk pemilik workspace tunggal: membuat dan membuka vault dengan master password, menyimpan kredensial, mencari secara lokal setelah vault dibuka, menghasilkan password, dan mengunci vault kembali. Kolaborasi, sharing, dan browser autofill bukan bagian dari rilis pertama.

## Masalah yang diselesaikan

Pengguna Morrow membutuhkan tempat privat untuk menyimpan kredensial yang terkait dengan pekerjaan dan catatan mereka. Menaruh password di Markdown berisiko karena file dapat terindeks, dibagikan, dicadangkan, atau dibuka di aplikasi lain.

Tanpa vault terenkripsi, Morrow tidak dapat menjadi tempat yang aman untuk menyimpan kredensial meskipun akses aplikasi telah dilindungi session password. Session aplikasi harus diperlakukan terpisah dari kemampuan membuka isi password vault.

## Sasaran

1. Pengguna dapat membuat vault dan menyimpan credential tanpa plaintext pernah dikirim ke server.
2. Pengguna dapat membuat, membaca, mengubah, menghapus, dan mencari item password setelah vault dibuka.
3. Kebocoran `password-vault.json`, backup, atau bucket R2 tidak cukup untuk membaca credential tanpa master password.
4. Vault dapat dikunci otomatis dan dibuka ulang tanpa mengubah session Morrow.
5. Semua jalur utama MVP memiliki pengujian unit, API, dan browser end-to-end.

## Bukan sasaran MVP

- **Autofill browser dan extension.** Memerlukan integrasi browser serta threat model tambahan.
- **Berbagi vault atau folder bersama.** Rekeying dan manajemen akses multi-pengguna merupakan proyek terpisah.
- **TOTP, passkey, kartu pembayaran, dan lampiran.** Skema item v1 hanya untuk login credential.
- **Pemulihan master password oleh Morrow.** Ini bertentangan dengan model zero-knowledge; recovery key akan diputuskan sebelum implementasi.
- **Pencarian server-side.** Pencarian hanya berjalan di browser setelah dekripsi.

## Model keamanan dan data

### Batas keamanan

| Komponen | Boleh mengetahui | Tidak boleh mengetahui |
|---|---|---|
| Browser saat vault terbuka | Plaintext vault dalam memori | Master password setelah derivasi kunci selesai |
| API / `WorkspaceStore` | Ciphertext, versi skema, revision/ETag | Nama situs, username, password, catatan, master password |
| R2 / filesystem / backup | File vault terenkripsi | Isi credential |
| `index.json`, `search.json`, shares, logs, analytics | Tidak ada data vault | Semua data vault termasuk metadata item |

### Bentuk penyimpanan

Tambahkan `password-vault.json` pada metadata private, terpisah dari corpus dokumen. File ini tidak diindeks ulang dan tidak pernah dapat dibaca melalui `/api/files`, shares, atau public route.

Payload minimal:

Bentuk yang diimplementasikan (`lib/vault/record.ts`) — `kdf` menjadi union bertag agar
Argon2id tetap dapat diparse dan dimigrasikan nanti:

```ts
type VaultKdf =
  | { algorithm: 'PBKDF2-SHA256'; salt: string; iterations: number }
  | { algorithm: 'argon2id'; salt: string; memoryKiB: number; iterations: number; parallelism: number }

type PasswordVaultRecord = {
  version: 1
  kdf: VaultKdf
  cipher: { algorithm: 'XChaCha20-Poly1305' | 'AES-256-GCM'; nonce: string; ciphertext: string }
  /** Acak per penulisan, ditetapkan server. Token untuk If-Match. */
  revision: string
  updatedAt: string
}
```

Validasinya adalah **allowlist ketat**, bukan pengecekan bentuk: field apa pun yang
tidak disebut format ditolak dengan 400. Ini yang membuat "plaintext tidak pernah
sampai ke server" menjadi sifat kode, bukan konvensi — sebuah `{ ...envelope,
itemNames: [...] }` yang ditambahkan untuk debugging akan gagal di batas API, bukan
lolos diam-diam.

`revision` sengaja acak, bukan hash konten: dua penyimpanan dengan isi identik
(simpan, undo, simpan lagi) akan menghasilkan hash yang sama, dan revision yang
bertabrakan membuat penulisan basi terlihat mutakhir.

Seluruh daftar item, termasuk nama situs, URL, username, password, catatan, tag, dan timestamp detail, berada di dalam `ciphertext`. Parameter KDF dan revision adalah satu-satunya metadata plaintext yang diizinkan.

### Kriptografi

- Derivasi kunci di browser menggunakan Argon2id dengan parameter yang ditinjau oleh security review.
- Enkripsi/dekripsi terjadi di browser menggunakan primitive yang audited; nonce unik untuk setiap enkripsi.
- Master password tidak boleh masuk ke request body, URL, storage browser persisten, log, atau telemetry.
- Kunci hasil derivasi dan plaintext hanya berada di memori selama vault terbuka; hapus referensi saat lock.
- Jangan membuat kriptografi sendiri. Pilih library yang aktif dipelihara dan audit ukuran/risiko bundle sebelum dipakai.

## User stories

### Pemilik workspace

- Sebagai pemilik workspace, saya ingin membuat vault dengan master password agar credential saya tidak dapat dibaca oleh penyimpanan Morrow.
- Sebagai pemilik workspace, saya ingin menambah situs, username, password, dan catatan agar credential tersimpan rapi.
- Sebagai pemilik workspace, saya ingin mencari credential saat vault terbuka agar dapat menemukan item dengan cepat.
- Sebagai pemilik workspace, saya ingin membuat password kuat agar tidak perlu menyusunnya sendiri.
- Sebagai pemilik workspace, saya ingin mengunci vault tanpa keluar dari Morrow agar perangkat yang ditinggal tetap aman.

## Kebutuhan

### P0 — wajib sebelum rilis

1. **Bootstrap vault**
   - Pengguna yang belum memiliki vault dapat menetapkan dan mengonfirmasi master password.
   - Browser menghasilkan salt, menurunkan kunci, mengenkripsi vault kosong, lalu mengirim ciphertext.
   - Master password tidak dapat dilihat pada devtools network payload maupun log server.

2. **Unlock dan lock vault**
   - Pengguna memasukkan master password untuk mendekripsi vault secara lokal.
   - Password salah menghasilkan pesan generik tanpa mengubah data vault.
   - Tombol lock menghapus data plaintext serta kunci dari state aplikasi.
   - Auto-lock berjalan setelah periode inaktif yang disepakati dan saat halaman ditutup/refresh.

3. **Manajemen credential**
   - Item terdiri dari nama, URL opsional, username/email, password, catatan opsional, dan tag opsional.
   - Pengguna dapat membuat, mengubah, dan menghapus item, lalu menyimpan ulang ciphertext secara atomik.
   - Penghapusan item meminta konfirmasi; pemulihan dari trash tidak termasuk MVP.

4. **Pencarian dan generator lokal**
   - Pencarian hanya memproses data yang telah didekripsi di browser.
   - Generator membuat password dengan panjang dan pilihan karakter yang dapat disesuaikan.
   - Aksi copy memakai Clipboard API dan menghapus clipboard setelah interval yang dikonfigurasi, bila izin browser memungkinkan.

5. **Sinkronisasi aman**
   - Endpoint privat khusus vault menerima dan mengembalikan record terenkripsi saja.
   - Penulisan memakai revision/`If-Match`; bila terjadi konflik, perubahan lokal tidak boleh tertimpa diam-diam.
   - Backup/restore Morrow meliputi record vault tanpa mencoba mendekripsinya.

6. **Isolasi dan observabilitas**
   - Tidak ada route share yang dapat membaca vault.
   - `index.json`, search snapshot, error message, structured log, analytics, dan error webhook tidak memuat isi vault.
   - Respons error juga tidak mengungkapkan keberadaan item tertentu.

### P1 — segera setelah MVP

- Recovery key opsional yang ditampilkan sekali saat bootstrap dan dapat dipakai untuk membuka vault.
- Deteksi password lemah/duplikat secara lokal.
- Kategori/folder, favicon lokal, dan riwayat perubahan terenkripsi.
- Impor file dari Bitwarden/1Password/CSV dengan preview serta penghapusan plaintext impor setelah selesai.

### P2 — pertimbangan masa depan

- Browser extension dan autofill.
- TOTP, passkey, kartu pembayaran, secure notes, dan attachment.
- Vault bersama, manajemen anggota, rekeying, dan audit trail.
- Sinkronisasi multi-perangkat yang lebih canggih daripada last-write conflict handling.

## Perubahan arsitektur yang direncanakan

| Area | Rencana perubahan | Hasil |
|---|---|---|
| `lib/server` | Tambah `vault-store.ts` yang menangani hanya record ciphertext dan concurrency. Jangan letakkan logika dekripsi di server. | `lib/server/vault-store.ts`. Tidak ada dekripsi di server. |
| Storage contract | Tambahkan metode baca/tulis metadata vault ke backend filesystem, MemoryBucket, dan R2. | **Tidak ada perubahan kontrak.** `readMeta`/`writeMeta`/`writeMetaIfUnchanged` sudah generik terhadap nama; vault menumpang namespace metadata yang sama dengan `shares.json` dan trash. Menambah metode khusus vault justru akan menduplikasi logika di tiga backend. |
| API | Tambah private route dengan GET/PUT, session guard, size limit, rate limit, dan `If-Match`. | `app/api/vault/route.ts`. Session guard-nya ganda: middleware, plus verifikasi HMAC di route itu sendiri sebagai defense-in-depth. Tidak ada DELETE. |
| Client | Tambah `lib/vault/` untuk KDF, cipher, schema plaintext, dan state lock/unlock; tambahkan page/dialog Passwords. | `lib/vault/{record,crypto,items,generator,clipboard,api,use-vault}.ts`; `components/workspace/{passwords-dialog,password-item-form}.tsx`. Dialog, bukan route — sebuah route adalah URL, dan URL adalah sesuatu yang di-restore browser saat startup. |
| Backup | Sertakan vault record dalam `scripts/backup.ts` dan validasi integritas ciphertext pada `--verify`. | Selesai, plus `metaEtags` di manifest (opsional, agar snapshot lama tetap terverifikasi) dan penolakan restore bila hash tidak cocok. |
| Tests | Tambah suite crypto, vault store/API, data-leak regression, dan Playwright untuk alur pengguna. | `tests/vault.test.ts` — 61 check, masuk ke `npm test`. **Playwright tidak ditambahkan:** repo ini tidak punya konfigurasi Playwright (skrip `ui:verify` menunjuk ke file yang tidak ada), jadi alur pengguna diverifikasi manual di browser, bukan otomatis. Lihat "Yang belum selesai". |

## Fase implementasi

### Fase 0 — keputusan pemblokir (1–2 hari)

- Finalisasi library dan parameter Argon2id/cipher bersama engineering/security.
- Putuskan apakah recovery key masuk MVP.
- Tulis threat model: XSS, device theft, bucket/backup leak, brute force, clipboard, multi-tab, dan conflict.
- Tentukan batas auto-lock serta kebijakan lifecycle clipboard.

### Fase 1 — fondasi terenkripsi

- Implementasikan format record, validasi schema, dan crypto proof-of-concept di browser.
- Implementasikan penyimpanan vault konsisten di filesystem, MemoryBucket, dan R2.
- Tambahkan GET/PUT API dengan session guard, limit, revision, dan redaksi log.
- Perbarui backup/restore dan regression test agar vault tidak masuk index/search/share.

### Fase 2 — pengalaman MVP

- Tambahkan navigasi Passwords, onboarding master password, unlock screen, dan status lock.
- Tambahkan daftar, detail, tambah, edit, hapus, search lokal, generator, dan copy action.
- Implementasikan auto-lock dan UI penanganan save conflict.
- Gunakan mockup Password Manager sebagai referensi visual; sesuaikan dengan komponen Morrow yang sudah ada.

### Fase 3 — validasi rilis

- Jalankan unit test, API test, storage-backend parity test, dan E2E.
- Security review untuk XSS, telemetry/log leakage, penggunaan memory, clipboard, dan dependency crypto.
- Uji backup/restore dari filesystem dan R2 pada vault yang dikunci.
- Lakukan beta terbatas sebelum feature flag diaktifkan secara umum.

## Kriteria penerimaan rilis

- [x] Record vault yang tersimpan tidak memuat plaintext credential atau master password. — diuji sebagai pencarian string atas byte yang benar-benar ditulis, bukan atas bentuk yang diasumsikan benar.
- [x] Master password tidak dikirim ke server dalam kondisi apa pun. — master password bukan parameter fungsi mana pun di `lib/vault/api.ts`; ia hanya masuk ke `deriveKey`.
- [x] Vault dapat dibuat, dibuka, dikunci, serta dibuka kembali dengan password benar.
- [x] Password salah atau ciphertext yang dimodifikasi tidak membuka vault dan tidak merusak record tersimpan. — AES-GCM mengautentikasi, jadi record yang diedit di bucket mana pun gagal terbuka alih-alih terdekripsi menjadi sesuatu yang masuk akal.
- [x] CRUD, search, generator, copy, dan auto-lock berjalan saat vault terbuka.
- [x] Konflik revision terlihat oleh pengguna dan tidak menyebabkan overwrite diam-diam. — dan perubahan lokal tetap di layar saat konflik muncul; membuangnya akan menjadi kehilangan diam-diam yang justru ingin dicegah.
- [x] Tidak ada credential yang muncul pada index, search, share, log, telemetry, atau backup plaintext. — masing-masing punya test negatif sendiri: reindex, index+backlinks, `/api/files`, search corpus, share document/subtree, trash, dan purge.
- [x] Backup lalu restore menghasilkan vault yang masih dapat dibuka dengan master password yang sama.
- [x] Semua test yang ada tetap lulus, ditambah regression test keamanan vault. — `npm run verify` hijau: check-deps, typecheck, lint, 14 suite, build.

### Yang belum selesai

- **E2E otomatis.** Repo ini belum punya konfigurasi Playwright, jadi menambahkannya
  untuk vault berarti memasang harness E2E untuk seluruh proyek — pekerjaan yang lebih
  besar dari fiturnya dan di luar cakupan yang diminta. Alur pengguna sudah
  diverifikasi manual di browser (bootstrap → unlock → tambah item dengan generator →
  auto-lock → password salah), tetapi verifikasi itu tidak berulang di CI.
- **Security review pihak lain, dan beta terbatas.** Keduanya butuh manusia; Fase 3
  mencantumkannya dan keduanya belum dilakukan.
- **Feature flag.** Fitur ini langsung aktif di sidebar, tanpa flag.

## Metrik keberhasilan

| Waktu evaluasi | Metrik | Target awal |
|---|---|---|
| 30 hari | Aktivasi vault oleh workspace eligible | ≥ 25% |
| 30 hari | Pengguna yang menyelesaikan tambah credential pertama | ≥ 80% dari pembuat vault |
| 30 hari | Keberhasilan unlock | ≥ 98% dari percobaan valid |
| Beta | Temuan plaintext pada log/index/share/backup | 0 |
| Beta | Kehilangan data dari conflict atau save failure | 0 |

## Pertanyaan terbuka

Kelima pertanyaan Fase 0 sudah dijawab di bagian "Keputusan Fase 0" di atas. Yang
tersisa untuk ditinjau:

| Pertanyaan | Pemilik | Dampak |
|---|---|---|
| Apakah PBKDF2 600.000 iterasi diterima sebagai KDF rilis, atau Argon2id wajib sebelum beta? | Security | Menentukan apakah dependensi WASM masuk sebelum rilis. Format sudah siap untuk keduanya. |
| Apakah fitur ini perlu feature flag sebelum diaktifkan umum? | Product | Fase 3 menyebut beta terbatas; saat ini tidak ada flag. |
| Apakah harness E2E (Playwright) dipasang untuk seluruh proyek? | Engineering | Menentukan apakah alur vault bisa diregresikan di CI. |

## Risiko dan mitigasi

| Risiko | Mitigasi |
|---|---|
| XSS dapat membaca vault yang sedang terbuka | CSP ketat, dependency audit, minimalkan third-party script, security review sebelum beta. |
| Pengguna lupa master password | Jelaskan zero-knowledge di onboarding; putuskan recovery key sebelum rilis. |
| Ciphertext conflict antar-tab/device | Gunakan ETag/revision dan tampilkan resolve/retry, bukan last-write-wins diam-diam. |
| Plaintext bocor ke subsystem Morrow | Test negatif eksplisit untuk index, search, shares, logs, analytics, dan backup. |
| KDF terlalu mahal/ringan | Benchmark pada perangkat target dan gunakan parameter versi agar dapat dimigrasikan nanti. |
