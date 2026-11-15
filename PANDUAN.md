# CBT Sekolah — Panduan Instalasi & Penggunaan

Sistem ujian berbasis komputer (CBT) dengan **soal, kunci, dan arsip jawaban tersimpan di GitHub**, server di
**Cloudflare Workers** (sanggup ribuan siswa bersamaan), dan bisa **mengimpor soal dari Google Form** sekaligus
mengirim jawaban siswa kembali ke form tersebut.

| Bagian | File | Untuk siapa |
|---|---|---|
| Aplikasi Guru & Admin | `guru/index.html` | Guru menyusun bank soal; admin mengatur jadwal, siswa, guru, memantau ujian |
| Aplikasi Siswa | `siswa/index.html` | Siswa login dan mengerjakan ujian (HP, laptop, komputer lab) |
| Server | `worker/worker.js` | Cloudflare Worker + database D1 |
| Server lama (cadangan) | `backend/Code.gs` | Versi Google Apps Script, untuk sekolah kecil (±300 siswa per sesi) |

```
 Browser Guru/Siswa ──► Cloudflare Worker ──► GitHub repo PRIVAT  (soal, kunci, akun, jadwal, arsip hasil)
   (GitHub Pages)        token GitHub       ──► GitHub repo PUBLIK (gambar soal)
                         disimpan di sini   ──► Cloudflare D1      (peserta yang sedang ujian, jawaban sementara, nilai)
                                            ──► Google Form        (opsional: jawaban dikirim ke form asal)
```

Token GitHub hanya ada di server, kunci jawaban tidak pernah dikirim ke siswa, dan penilaian dilakukan di server.
Siswa yang membuka "Inspect Element" tidak akan menemukan kunci jawaban.

---

## Fitur

**Jenis soal (7):** pilihan ganda, pilihan ganda kompleks, benar/salah (label bisa diganti), menjodohkan (dengan
pengecoh), isian singkat (banyak alternatif jawaban), mengurutkan, uraian (dikoreksi manual dengan pedoman). Semua soal
mendukung teks bacaan, gambar (diunggah ke GitHub, otomatis diperkecil, bisa tempel Ctrl+V), rumus LaTeX
(`$\frac{1}{2}$`), tebal/miring/garis bawah, dan bobot per soal.

**Guru:** bank soal per mapel & tingkat, impor cepat dari teks Word, **impor dari Google Form**, pratinjau tampilan
siswa, duplikat, unduh/impor JSON, hasil & nilai, koreksi uraian, analisis butir soal, hitung ulang nilai, unduh Excel.

**Admin:** jadwal ujian (waktu, durasi, kelas, acak soal & pilihan, token, batas keluar halaman, tampilkan nilai),
monitoring langsung, reset login pindah perangkat, hentikan & kumpulkan, ulang ujian, data siswa (impor Excel, kartu
login), data guru, pengaturan sekolah.

**Siswa:** daftar ujian sesuai kelas, token ujian, lembar jawaban bergaya LJK, ragu-ragu, sisa waktu sinkron dengan
server, ukuran huruf, jawaban tersimpan di perangkat dan server, aman saat halaman dimuat ulang atau koneksi putus,
layar penuh, deteksi keluar halaman, kunci satu perangkat, kirim otomatis saat waktu habis.

---

## Langkah 1 — GitHub

1. Buat tiga repository: `cbt-data` (**Private**, berisi kunci & kata sandi), `cbt-media` (**Public**, gambar soal),
   `cbt-app` (**Public**, aplikasi guru & siswa).
2. Buat token: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
   *Generate new token*. Repository access: **Only select repositories** → `cbt-data` dan `cbt-media`.
   Permissions → **Contents: Read and write**. Salin tokennya (`github_pat_…`).
3. Isi awal repo `cbt-data` (akun admin, contoh soal) dibuat oleh fungsi `setup()` di `backend/Code.gs`.
   Sekolah yang sudah memakai versi Apps Script cukup memakai repo yang sama: semua akun, soal, dan jadwal langsung
   terbaca oleh server Cloudflare (format dan hash kata sandinya sama).

## Langkah 2 — Server Cloudflare

1. Daftar/masuk di <https://dash.cloudflare.com> (paket gratis cukup untuk mulai).
2. **Storage & Databases → D1 → Create database**, nama `cbt-sekolah`, lokasi *Asia-Pacific*.
3. **Workers & Pages → Create → Worker**, nama `cbt-sekolah` → *Deploy* → **Edit code**, hapus isinya, tempel seluruh
   `worker/worker.js` → *Deploy*. Tabel database dibuat otomatis saat pertama dipanggil.
4. Worker → **Settings → Bindings → Add → D1 database**: nama variabel `DB`, pilih `cbt-sekolah`.
5. Worker → **Settings → Variables and Secrets**:

   | Nama | Jenis | Isi |
   |---|---|---|
   | `GITHUB_TOKEN` | Secret | token dari Langkah 1 |
   | `SECRET` | Secret | teks acak panjang (mis. 64 huruf/angka) untuk tanda tangan sesi |
   | `DATA_REPO` | Text | `namaakun/cbt-data` |
   | `MEDIA_REPO` | Text | `namaakun/cbt-media` |
   | `BRANCH` | Text | `main` (opsional) |

6. Worker → **Settings → Trigger events → Add → Cron trigger** → `* * * * *` (tiap menit).
7. Alamat server: `https://cbt-sekolah.<subdomain>.workers.dev`. Buka di browser; harus tampil
   `{"ok":true,...}`. Subdomain baru bisa butuh 10–15 menit sebelum sertifikatnya aktif.

## Langkah 3 — Aplikasi Guru & Siswa

1. Di `guru/index.html` dan `siswa/index.html`, isi alamat server pada baris
   `const API_URL = window.CBT_API_URL || '…';`
2. Unggah folder `guru/` dan `siswa/` ke repo `cbt-app`, lalu aktifkan **Settings → Pages** (branch `main`, root).
3. Guru & admin: `https://namaakun.github.io/cbt-app/guru/` · Siswa: `https://namaakun.github.io/cbt-app/siswa/`

## Langkah 4 — Penggunaan pertama

1. Masuk aplikasi guru sebagai **admin / admin123**, lalu **segera ganti kata sandi** di *Akun saya*.
2. **Pengaturan**: nama sekolah, tahun ajaran, tingkat, kelas, mapel.
3. **Data guru**: buat akun tiap guru. Hapus akun contoh `guru`.
4. **Data siswa → Impor**: Excel dengan kolom **NIS, Nama, Kelas** (opsional **Kata sandi**). Kata sandi awal = NIS.
5. **Cetak kartu login**, lalu guru membuat **Bank soal**, admin membuat **Jadwal ujian**.
6. Hari ujian: pengawas membuka **Monitoring** dan membacakan **token**.
7. Setelah ujian: **Hasil & koreksi** → koreksi uraian → **Unduh Excel**.

---

## Impor dari Google Form

Bank soal → **Impor Google Form** → tempel link responden (`https://forms.gle/…` atau `…/viewform`).

**Sebelum impor, buka form di Google Forms → Setelan, lalu pastikan:**
- **Batasi ke 1 tanggapan** dan **Batasi ke pengguna di organisasi** dalam keadaan mati. Keduanya mewajibkan login
  Google sehingga server CBT tidak bisa mengirim jawaban.
- **Kumpulkan alamat email**: *Jangan kumpulkan*.
- Form **Menerima tanggapan**.

| Pertanyaan di Google Form | Menjadi soal CBT |
|---|---|
| Pilihan ganda, Drop-down | Pilihan ganda |
| Kotak centang | Pilihan ganda kompleks |
| Skala linear, Rating | Pilihan ganda (urutan tidak diacak) |
| Petak pilihan ganda / kotak centang | Satu soal per baris |
| Jawaban singkat, Tanggal, Waktu | Isian singkat |
| Paragraf | Uraian (bobot 0, tidak dinilai, kecuali bobotnya diubah) |
| Judul & deskripsi, Gambar | Teks bacaan / gambar untuk soal berikutnya |
| Bagian (section) | Digabung jadi satu ujian; jawaban dikirim untuk semua bagian |
| Unggah file, Video | Dilewati (dengan peringatan) |

- Pertanyaan **Nama, NIS/NISN, Kelas** dikenali otomatis dan diisi dari data siswa (tidak tampil ke siswa). Jika
  judulnya lain (mis. "No. Absen / NIS"), buka soalnya di editor → **Jadikan isian otomatis**, lalu pilih datanya
  (Nama, NIS, Kelas, Nama - Kelas, Nama - NIS) di panel *Google Form*.
- Gambar disalin ke repo `cbt-media` agar tidak hilang.
- **Kunci jawaban kuis Google Form tidak bisa dibaca dari luar.** Soal tanpa kunci tidak dinilai CBT, tetapi
  jawabannya tetap terkirim ke Google Form (penilaian kuis tetap berjalan di Google). Tambahkan kunci di editor jika
  ingin CBT juga menilai. Jenis soal dan daftar pilihan dari form dikunci agar jawaban tetap cocok dengan form;
  teksnya boleh dirapikan.
- Pertanyaan **wajib** di form juga wajib di CBT: siswa tidak bisa mengirim sebelum menjawabnya. Jika waktu habis dan
  pertanyaan wajib masih kosong, Google menolak kiriman itu (nilai tetap tersimpan di CBT). Lebih aman matikan
  *Wajib diisi* untuk pertanyaan pilihan.
- Saat siswa selesai, jawabannya langsung dikirim ke Google Form. Bila gagal (Google sibuk, form ditutup), server
  mencoba lagi otomatis hingga 5 kali. Status per siswa terlihat di **Hasil** (kolom *Google Form*: terkirim / antre /
  gagal), dan tombol **Kirim ulang ke Google Form** tersedia untuk yang belum terkirim.

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

**Impor siswa:** `.xlsx/.xls/.csv` atau salin-tempel dari Excel. Kolom dikenali dari judul (NIS/NISN, Nama,
Kelas/Rombel, Kata sandi). Data besar dikirim bertahap 250 baris per permintaan.

---

## Cara kerja penyimpanan

Repo `cbt-data`:
```
config.json                       identitas sekolah, tingkat, kelas, mapel
users/guru.json, users/siswa.json akun (kata sandi di-hash SHA-256 + salt)
bank/_index.json, bank/<id>.json  bank soal + kunci jawaban (+ tautan Google Form bila hasil impor)
ujian/_index.json                 jadwal ujian
hasil/<idUjian>/<kelas>/<nis>.json arsip jawaban & nilai tiap siswa
```
Repo `cbt-media`: `img/<tahun>/<bulan>/<acak>.png`

**Alur jawaban siswa:** jawaban selalu disimpan di perangkat siswa, lalu dikirim ke server tiap 3 menit bila ada
perubahan (dan tanda aktif tiap 5 menit). Data peserta yang sedang ujian ada di database D1, sehingga ribuan siswa
bisa menyimpan bersamaan tanpa menyentuh GitHub. Saat siswa menekan *Selesai*, nilai langsung dihitung. Setiap menit
server: (1) mengumpulkan otomatis siswa yang waktunya habis, (2) mengarsipkan hasil baru ke GitHub dalam satu commit,
(3) mengirim ulang jawaban Google Form yang tertunda. Soal, akun, dan jadwal disimpan sementara di server; jika Anda
mengubah file di GitHub secara langsung, klik **Pengaturan → Muat ulang data dari GitHub**.

---

## Kapasitas & biaya

Uji simulasi lokal: 1.300 siswa login, mulai, menyimpan 3 kali, dan selesai secara bersamaan tanpa satu pun kegagalan
dan tanpa panggilan ke GitHub; seluruh hasil terarsip dalam 10 putaran (±10 menit).

Batas paket **gratis** Cloudflare (direset tiap hari pukul 08.00 WITA):

| Batas harian | Paket gratis | Pemakaian 1 sesi ujian 1.300 siswa (90 menit) |
|---|---|---|
| Permintaan ke Worker | 100.000 | ±35.000–45.000 |
| Baris D1 ditulis | 100.000 | ±35.000–50.000 |
| Baris D1 dibaca | 5.000.000 | ±1.000.000 (termasuk monitoring guru) |

Artinya paket gratis cukup untuk **sekitar dua sesi ujian penuh (1.300 siswa) per hari**. Untuk minggu ujian dengan
3 sesi atau lebih per hari, aktifkan **Workers Paid (US$5/bulan)**: 10 juta permintaan dan 50 juta penulisan per
bulan, jauh melebihi kebutuhan sekolah. Pemakaian bisa dipantau di dashboard Cloudflare → Workers → `cbt-sekolah` →
*Metrics*, dan D1 → `cbt-sekolah` → *Metrics*.

---

## Keamanan

- Token GitHub hanya tersimpan sebagai *secret* di Cloudflare, tidak pernah dikirim ke browser.
- Kunci jawaban, pembahasan, pedoman penskoran, dan nilai asli pilihan Google Form tidak pernah dikirim ke siswa.
- Kata sandi disimpan sebagai hash; login dibatasi 8 percobaan per 10 menit.
- Sesi memakai token bertanda tangan (HMAC) yang kedaluwarsa otomatis (guru 12 jam, siswa 8 jam).
- Satu siswa hanya bisa mengerjakan di satu perangkat; pindah perangkat lewat *Reset login* oleh pengawas.
- Guru hanya melihat bank soal dan hasil ujian miliknya; admin melihat semuanya.

Aplikasi web tidak bisa sepenuhnya mencegah kecurangan (mis. memotret layar dengan HP lain); pengawasan tetap perlu.

---

## Pemecahan masalah

| Gejala | Penyebab & solusi |
|---|---|
| "Tidak dapat terhubung ke server" | Periksa internet. Buka alamat server di browser; harus tampil `{"ok":true,...}`. |
| "GITHUB_TOKEN/SECRET/DATA_REPO belum diatur" | Lengkapi variabel di Worker → Settings → Variables and Secrets. |
| "GitHub 401 / Bad credentials" | Token kedaluwarsa. Buat token baru, ganti secret `GITHUB_TOKEN`. |
| "Server sedang mencapai batas pemakaian" | Batas harian paket gratis habis. Tunggu reset (08.00 WITA) atau aktifkan Workers Paid. |
| Impor Google Form: "mewajibkan login Google" | Matikan *Batasi ke 1 tanggapan* dan *Batasi ke pengguna di organisasi* di setelan form. |
| Kolom Google Form "gagal" | Arahkan kursor ke status untuk melihat alasan (mis. pertanyaan wajib kosong, form ditutup), perbaiki, lalu *Kirim ulang*. |
| Gambar soal tidak tampil | Repo media harus publik. Gambar baru via jsDelivr bisa butuh beberapa detik saat pertama dimuat. |
| Siswa: "sedang dikerjakan di perangkat lain" | Monitoring → ••• → **Reset login**. |
| Kunci jawaban ternyata salah | Perbaiki di bank soal, lalu Hasil → **Hitung ulang nilai**. |
| Perubahan langsung di repo GitHub belum terbaca | Pengaturan → **Muat ulang data dari GitHub**. |
