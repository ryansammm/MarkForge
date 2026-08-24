# MarkForge — Proses Kerja (Workflow)

Referensi untuk setiap jenis pengerjaan. Prinsip dasar: **main = selalu stabil**, **dev = arena kerja**, **release = otomatis**.

---

## 1. Branch model

| Branch | Kegunaan | Aturan |
|---|---|---|
| `main` | Produksi | Selalu stabil; setiap push = deploy Vercel |
| `dev` | Pengembangan harian | Commit di sini; merge ke `main` saat lolos verifikasi |
| `android` | Cadangan masa depan | Belum aktif |
| `feat/*`, `fix/*` | Opsional untuk fitur besar | Dibuat dari `dev`, merge balik ke `dev` |

---

## 2. Alur per jenis pekerjaan

### A. Fitur baru
1. Buka issue / tulis ringkas apa & kenapa.
2. Kerjakan di `dev` (atau branch `feat/nama` untuk fitur besar).
3. Wajib sebelum merge:
   - `pnpm typecheck && pnpm lint`
   - Test relevan (`pnpm test:...`) — fitur dengan logika baru wajib punya minimal 1 test.
   - Jika mengubah UI: uji manual di desktop **dan** browser mobile-width.
4. Merge `dev` → `main` → Vercel auto-deploy.
5. Fitur yang memengaruhi perilaku user → tambah/ubah spec di `openspec/specs/`.

### B. Bug fix
1. Reproduksi dulu — catat langkah minimum.
2. Cari akar masalah, bukan gejala: satu bug boleh memunculkan lebih dari satu gejala di tempat berbeda.
3. Fix + **test yang membuktikan bug itu** (akan gagal tanpa fix).
4. `npm run check:encoding` otomatis via pre-commit.
5. Commit dengan format: `fix: <area> - <akar masalah>` (bukan gejalanya).

### C. Perubahan/refactor
1. Refactor hanya boleh dilakukan jika semua test tetap hijau sebelum DAN sesudah.
2. Tidak menambah dependency tanpa alasan di commit message.
3. Satu refactor = satu tujuan. Jangan mencampur perubahan perilaku.

### D. Rebuild portable exe
1. Pastikan `main` dalam kondisi teruji.
2. Jalankan: `pnpm dist:portable` (build standalone + rakit + electron-builder).
3. Output: `dist/MarkForge-Portable-<versi>.exe`.
4. Smoke test wajib: buka exe → login → buka dokumen → health endpoint 200.
5. Naikkan `version` di package.json, lalu release resmi lewat tag (lihat §3).

---

## 3. Release otomatis (tanpa terminal)

```bash
# dari main yang sudah siap:
npm version patch   # atau minor / major
git push origin main --follow-tags
```

- Tag `v*` memicu workflow `.github/workflows/release.yml`.
- GitHub Actions mem-build exe di cloud dan menempelkannya ke halaman **Releases**.
- Monitor: repo → tab **Actions**; hasil: tab **Releases**.
- Catatan: versi exe mengikuti tag; build ulang tag sama tidak akan gagal karena `--allow-same-version`.

---

## 4. Tugas repetitif & penanganannya

| Tugas repetitif | Penanganan otomatis |
|---|---|
| Mojibake/huruf aneh | Pre-commit + CI gate (`check:encoding`) — sudah aktif |
| Lupa typecheck/lint sebelum push | Sudah masuk `npm run verify` di CI |
| Build ulang exe manual | `pnpm dist:portable` satu perintah |
| Release manual | Tag `v*` → workflow release otomatis |
| Sinkron lockfile tim | `pnpm install --frozen-lockfile` dipaksa di CI |
| Backup notes | `scripts/backup.ts` (jalankan berkala) |

Kandidat otomatisasi berikutnya (belum dibuat): changelog otomatis dari commit, notifikasi Discord/webhook saat release, jadwal backup terjadwal.

---

## 5. Checklist "definition of done"

Sebelum menyatakan sebuah pekerjaan selesai:

- [ ] `pnpm verify` hijau (deps + encoding + typecheck + lint + test + build)
- [ ] Diuji di **dua mode**: web (`pnpm dev`) dan desktop (`pnpm desktop:start`)
- [ ] String UI bebas mojibake (gate sudah menjaga)
- [ ] Dokumentasi terkait diperbarui (file ini / README / openspec)
- [ ] Push ke branch yang benar (`dev` untuk eksperimen, `main` untuk stabil)

---

## 6. Darurat / troubleshooting cepat

| Gejala | Cek pertama |
|---|---|
| Push ditolak (non-fast-forward) | `git fetch` → bandingkan → merge/rebase, jangan force-push main |
| Exe tidak mau start | `%TEMP%\markforge-desktop.log`; pastikan `.next\BUILD_ID` ada (jalankan `pnpm build`) |
| Sync to cloud gagal di exe | `.env` R2_* ikut ter-bake? cek `scripts/prepare-electron.mjs` output |
| Huruf aneh muncul lagi | `npm run check:encoding` → perbaiki file sebagai UTF-8 no-BOM via node/.NET |
