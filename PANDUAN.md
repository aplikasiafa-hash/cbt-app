# CBT Sekolah — Panduan Instalasi & Penggunaan

Sistem ujian berbasis komputer (CBT) dengan **soal, kunci, dan jawaban tersimpan di GitHub**.
Terdiri dari dua aplikasi web dan satu backend:

| Bagian | File | Untuk siapa |
|---|---|---|
| Aplikasi Guru & Admin | `guru/index.html` | Guru menyusun bank soal; admin mengatur jadwal, siswa, guru, memantau ujian |
| Aplikasi Siswa | `siswa/index.html` | Siswa login dan mengerjakan ujian (HP, laptop, komputer lab) |
| Backend | `backend/Code.gs` + `appsscript.json` | Google Apps Script — jembatan aman ke GitHub |

```
 Browser Guru/Siswa ──► Google Apps Script (Code.gs) ──► GitHub repo PRIVAT  (soal, kunci, akun, jadwal, hasil)
   (GitHub Pages)        token GitHub disimpan di sini ──► GitHub repo PUBLIK (gambar soal)
                         │
                         └─► Google Sheet "Buffer Peserta" (antrian cepat; disinkron ke GitHub tiap 1 menit)
```

**Mengapa ada Apps Script di tengah?** Agar token GitHub tidak pernah ada di browser, kunci jawaban
tidak pernah dikirim ke siswa, dan penilaian dilakukan di server. Siswa yang membuka "Inspect Element"
tidak akan menemukan kunci jawaban.

---

## Fitur

**Jenis soal (7):** pilihan ganda, pilihan ganda kompleks, benar/salah (label bisa diganti: Sesuai/Tidak sesuai,
Fakta/Opini, dll.), menjodohkan (dengan pengecoh), isian singkat (banyak alternatif jawaban), mengurutkan, uraian
(dikoreksi manual dengan pedoman penskoran). Semua soal mendukung teks bacaan/stimulus, gambar (diunggah ke GitHub,
otomatis diperkecil, bisa tempel Ctrl+V), rumus matematika LaTeX (`$\frac{1}{2}$`), tebal/miring/garis bawah,
dan bobot per soal. Penilaian sebagian atau mutlak untuk soal kompleks.

**Guru:** bank soal per mapel & tingkat, impor cepat dari teks Word, pratinjau tampilan siswa, duplikat, unduh/impor
JSON (berbagi bank soal antarsekolah), hasil & nilai, koreksi uraian per soal atau per siswa, analisis butir soal
(tingkat kesukaran, daya pembeda, sebaran jawaban), hitung ulang nilai bila kunci diperbaiki, unduh Excel.

**Admin:** jadwal ujian (waktu dibuka/ditutup, durasi, kelas peserta, acak soal & pilihan, token ujian, batas keluar
halaman, tampilkan nilai), monitoring langsung (siapa sedang mengerjakan, progres, sisa waktu, pelanggaran), reset login
pindah perangkat, hentikan & kumpulkan, ulang ujian, data siswa (impor Excel, cetak kartu login), data guru, pengaturan
sekolah/tingkat/kelas/mapel.

**Siswa:** daftar ujian sesuai kelas, token ujian, navigasi lembar jawaban bergaya LJK, tandai ragu-ragu, sisa waktu
(sinkron dengan jam server), ukuran huruf, jawaban tersimpan otomatis (di perangkat + server), tetap aman saat
halaman dimuat ulang atau koneksi putus, layar penuh, deteksi keluar halaman, kunci satu perangkat, kirim otomatis
saat waktu habis.

---

## Langkah 1 — Siapkan GitHub

1. Buat **tiga repository** di akun GitHub Anda:
   - `cbt-data` → **Private** (wajib privat: berisi kunci jawaban & kata sandi)
   - `cbt-media` → **Public** (gambar soal; nama file acak sehingga tidak bisa ditebak)
   - `cbt-app` → **Public** (tempat aplikasi guru & siswa di-hosting)

   Repo `cbt-data` dan `cbt-media` boleh dibiarkan kosong. Backend akan mengisinya sendiri.

2. Buat **token GitHub** (fine-grained):
   GitHub → foto profil → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**
   - *Expiration*: pilih paling lama yang diizinkan (catat tanggalnya, perbarui sebelum habis)
   - *Repository access*: **Only select repositories** → pilih `cbt-data` dan `cbt-media`
   - *Permissions* → *Repository permissions* → **Contents: Read and write**
   - Klik **Generate token**, salin token (diawali `github_pat_…`). Token hanya tampil sekali.

## Langkah 2 — Pasang backend Google Apps Script

1. Buka <https://script.google.com> → **Proyek baru**. Beri nama, mis. `CBT Sekolah`.
2. Hapus isi `Code.gs`, tempel seluruh isi file `backend/Code.gs`.
3. Klik ⚙ **Project Settings** → centang **Show "appsscript.json" manifest file in editor**.
   Kembali ke editor, buka `appsscript.json`, ganti isinya dengan file `backend/appsscript.json`.
4. Masih di ⚙ **Project Settings** → bagian **Script Properties** → **Add script property**:

   | Property | Isi |
   |---|---|
   | `GITHUB_TOKEN` | token dari Langkah 1 |
   | `DATA_REPO` | `namaakun/cbt-data` |
   | `MEDIA_REPO` | `namaakun/cbt-media` |
   | `BRANCH` *(opsional)* | `main` (bawaan) |
   | `MEDIA_CDN` *(opsional)* | `jsdelivr` (bawaan), `raw`, atau `pages` |

5. Di editor, pilih fungsi **`setup`** di toolbar → **Run**. Izinkan akses
   (jika muncul "Google hasn't verified this app": **Advanced** → **Go to CBT Sekolah (unsafe)** → **Allow**,
   karena ini skrip milik Anda sendiri).
   `setup()` akan: memeriksa repo, membuat Google Sheet buffer, mengisi data awal di GitHub, dan memasang
   pemicu sinkronisasi tiap 1 menit. Lihat **Execution log** untuk hasilnya.
6. Klik **Deploy** → **New deployment** → ikon ⚙ → **Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   Klik **Deploy**, salin **Web app URL** (berakhiran `/exec`).
7. Uji: buka URL tersebut di browser. Harus tampil `{"ok":true,...}`.

> **Saat memperbarui `Code.gs` di kemudian hari:** Deploy → **Manage deployments** → ✏️ → *Version*: **New version**
> → **Deploy**. URL tetap sama, jadi aplikasi tidak perlu diubah.

> **Akun belajar.id / Google Workspace sekolah** memberi kuota lebih besar (lihat bagian Kapasitas). Jika opsi
> *Anyone* tidak tersedia karena kebijakan domain, gunakan akun Gmail biasa.

## Langkah 3 — Pasang aplikasi Guru & Siswa

1. Buka `guru/index.html` dan `siswa/index.html` dengan editor teks. Cari baris:
   ```js
   const API_URL = window.CBT_API_URL || 'PASTE_URL_WEB_APP_DI_SINI';
   ```
   Ganti `PASTE_URL_WEB_APP_DI_SINI` dengan Web app URL dari Langkah 2.
2. Unggah folder `guru/` dan `siswa/` ke repo `cbt-app`.
3. Repo `cbt-app` → **Settings** → **Pages** → *Source*: **Deploy from a branch** → `main` / `(root)` → **Save**.
4. Setelah 1–2 menit aplikasi bisa dibuka di:
   - Guru & admin: `https://namaakun.github.io/cbt-app/guru/`
   - Siswa: `https://namaakun.github.io/cbt-app/siswa/`

   (Bisa juga di-hosting di Cloudflare Pages atau server sekolah. Keduanya hanya file HTML statis.)

## Langkah 4 — Penggunaan pertama

1. Buka aplikasi guru, masuk dengan **admin / admin123**, lalu **segera ganti kata sandi** di *Akun saya*.
2. **Pengaturan**: isi nama sekolah, tahun ajaran, tingkat (X, XI, XII), kelas, mata pelajaran.
3. **Data guru**: buat akun untuk tiap guru (peran *Guru* atau *Admin*). Hapus akun contoh `guru`.
4. **Data siswa** → **Impor**: unggah Excel dengan kolom **NIS, Nama, Kelas** (opsional **Kata sandi**).
   Kata sandi awal = NIS. Kelas baru otomatis ditambahkan. Hapus siswa contoh 1001–1003.
5. **Cetak kartu login** untuk dibagikan ke siswa.
6. Guru membuat **Bank soal**. Admin membuat **Jadwal ujian** dan memilih bank soal & kelas.
7. Hari ujian: pengawas membuka **Monitoring**, membacakan **token**, lalu memantau peserta.
8. Setelah ujian: **Hasil & koreksi** → koreksi uraian → **Unduh Excel**.

Bank soal contoh "Contoh — Semua Jenis Soal" berisi ketujuh jenis soal untuk dicoba, dan boleh dihapus.

---

## Format impor

**Impor cepat soal** (di editor bank soal):
```
1. Ibu kota Sulawesi Selatan adalah ...
A. Kendari
B. Makassar*
C. Palu

2. Manakah bilangan prima?
A. 2
B. 9
C. 11
Kunci: A, C

3. Rumus kimia air adalah ...
Jawaban: H2O | h2o

4. Jelaskan proses fotosintesis!
Bobot: 5
```
Tanda `*` atau baris `Kunci:` menandai jawaban benar. Lebih dari satu kunci menjadi pilihan ganda kompleks. Baris
`Jawaban:` menjadikan soal isian, dan soal tanpa pilihan maupun jawaban menjadi uraian.

**Impor siswa:** file `.xlsx/.xls/.csv` atau salin-tempel dari Excel. Baris judul boleh ada (kolom dikenali dari
nama: NIS/NISN, Nama, Kelas/Rombel, Kata sandi). Tanpa judul, urutan kolom dianggap NIS, Nama, Kelas, Kata sandi.

---

## Cara kerja penyimpanan

Isi repo `cbt-data`:
```
config.json              identitas sekolah, tingkat, kelas, mapel
users/guru.json          akun guru (kata sandi di-hash SHA-256 + salt)
users/siswa.json         akun siswa (kata sandi di-hash)
bank/_index.json         daftar bank soal
bank/<id>.json           isi bank soal + kunci jawaban
ujian/_index.json        jadwal ujian
hasil/<idUjian>.json     jawaban & nilai seluruh peserta satu ujian
```
Repo `cbt-media`: `img/<tahun>/<bulan>/<acak>.jpg`

Riwayat perubahan tersimpan sebagai commit Git. Anda bisa melihat siapa mengubah apa dan memulihkan versi lama.

**Alur jawaban siswa:** setiap jawaban disimpan di perangkat siswa (aman jika koneksi putus atau halaman dimuat ulang)
dan dikirim ke server tiap 30 detik. Saat siswa menekan *Selesai*, nilai langsung dihitung di server dan dicatat di
Google Sheet buffer. Pemicu tiap 1 menit mengirim semua hasil baru ke GitHub **dalam satu commit**, dan mengumpulkan
otomatis siswa yang waktunya habis tetapi belum menekan *Selesai*. Dengan cara ini ratusan siswa bisa selesai
bersamaan tanpa membuat GitHub menolak penulisan.

Jangan mengedit Google Sheet buffer secara manual. Sheet itu dikelola otomatis.

---

## Kapasitas & kuota

Batas utama Google Apps Script:

| Batas | Gmail biasa | Google Workspace / belajar.id |
|---|---|---|
| Eksekusi bersamaan per pengguna | 30 | 30 |
| Panggilan URL Fetch per hari | 20.000 | 100.000 |
| Total waktu pemicu per hari | 90 menit | 6 jam |
| Baca/tulis Properties per hari | 50.000 | 500.000 |

Sistem ini dirancang hemat kuota: soal & data di-cache 6 jam (saat ujian berlangsung hampir tidak ada panggilan
ke GitHub), sinkron hasil dikirim dalam satu commit, dan pemicu tidak bekerja bila tidak ada perubahan.
Dalam uji simulasi, 400 siswa yang login, mulai, dan menyelesaikan ujian tidak memerlukan satu pun panggilan GitHub,
dan seluruh hasilnya terkirim dalam 7 panggilan.

Karena semua permintaan berjalan sebagai satu akun (maks. 30 bersamaan), aplikasi siswa otomatis mencoba ulang dengan
jeda acak saat server sibuk. **Saran praktis:** bila lebih dari ±300 siswa memulai ujian pada menit yang sama, bagi
menjadi beberapa sesi (mis. sesi 1 kelas X, sesi 2 kelas XI) seperti pelaksanaan ANBK.

---

## Keamanan

- Token GitHub hanya ada di Script Properties, tidak pernah dikirim ke browser.
- `setup()` menolak berjalan bila repo data tidak privat.
- Kunci jawaban, pembahasan, dan pedoman penskoran tidak pernah dikirim ke aplikasi siswa. Penilaian dilakukan di server.
- Kata sandi disimpan sebagai hash; login dibatasi 8 percobaan per 10 menit.
- Sesi memakai token bertanda tangan (HMAC) yang kedaluwarsa otomatis (guru 12 jam, siswa 8 jam).
- Satu siswa hanya bisa mengerjakan di satu perangkat. Pindah perangkat harus lewat *Reset login* oleh pengawas.
- Keluar halaman ujian dicatat dan dapat memicu pengiriman otomatis sesuai batas yang diatur.
- Guru hanya melihat bank soal dan hasil ujian miliknya; admin melihat semuanya.

Catatan jujur: aplikasi berbasis web tidak bisa sepenuhnya mencegah kecurangan (mis. memotret layar dengan HP lain).
Pengawasan di ruang ujian tetap diperlukan.

---

## Mode uji lokal (opsional, untuk pengembang)

Folder `dev/` berisi tiruan Google Apps Script & GitHub sehingga seluruh sistem bisa dicoba di komputer sendiri
tanpa akun Google/GitHub (butuh [Node.js](https://nodejs.org) 18+):
```
node dev/server.js          # lalu buka http://localhost:8787/guru/ dan /siswa/
node dev/backend.test.js    # menjalankan 60+ uji otomatis backend
```
Data uji hilang saat server dimatikan.

---

## Pemecahan masalah

| Gejala | Penyebab & solusi |
|---|---|
| "Alamat backend (API_URL) belum diatur" | Isi `API_URL` di kedua file HTML (Langkah 3). |
| "Tidak dapat terhubung ke server" | Periksa internet; pastikan deployment *Who has access: Anyone*; buka URL `/exec` di browser. |
| "Jalankan setup() terlebih dahulu" | Jalankan `setup` dari editor Apps Script. |
| "GitHub 401 / Bad credentials" | Token salah atau kedaluwarsa. Buat token baru, ganti `GITHUB_TOKEN`, lalu tunggu 10 menit atau jalankan `setup` lagi. |
| "GitHub 404" | Nama `DATA_REPO`/`MEDIA_REPO` salah, atau token tidak diberi akses ke repo tersebut. |
| Gambar soal tidak tampil | Repo media harus **publik**. Gambar baru via jsDelivr bisa butuh beberapa detik saat pertama dimuat. |
| Siswa: "sedang dikerjakan di perangkat lain" | Pengawas: Monitoring → ••• → **Reset login**. |
| Siswa salah menekan Selesai / perlu mengulang | Admin: Monitoring → ••• → **Ulang ujian dari awal**. |
| Kunci jawaban ternyata salah | Perbaiki di bank soal, lalu Hasil → **Hitung ulang nilai**. |
| Perubahan Script Properties belum terbaca | Properti di-cache 10 menit. Tunggu, atau jalankan `setup` untuk menyegarkan. |
