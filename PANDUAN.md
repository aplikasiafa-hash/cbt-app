# CBT Sekolah — versi Cloudflare (gratis)

Versi ini menggantikan backend Google Apps Script dengan **Cloudflare Workers + D1 + Durable Objects**,
semuanya dalam **paket gratis**. Aplikasi guru dan siswa tampil dan bekerja sama seperti sebelumnya.

| Bagian | Lokasi | Keterangan |
|---|---|---|
| Aplikasi guru & admin | `public/guru/index.html` | Bank soal, jadwal, monitoring **langsung**, hasil & koreksi |
| Aplikasi siswa | `public/ujian-cbt/index.html` | Login, kerjakan ujian, jawaban tersimpan otomatis |
| Backend | `src/` | Worker (pintu masuk) + Durable Object "Engine" (mesin ujian) |
| Pengaturan Cloudflare | `wrangler.jsonc` | Nama aplikasi, repo GitHub gambar/cadangan |

## Apa yang berubah dibanding versi Apps Script

| | Apps Script (lama) | Cloudflare (baru) |
|---|---|---|
| Permintaan bersamaan | maks. 30, siswa harus antre/dibagi sesi ±300 | ribuan, tanpa antre |
| Kirim jawaban | HTTP tiap 30 detik (berat) | disimpan di perangkat, dikirim saat Selesai (cadangan tiap 5 menit lewat koneksi yang masih terbuka) |
| Kuota | setiap klik = 1 permintaan | **1 permintaan per siswa per ujian**; guru 1 permintaan sekali buka aplikasi (edit soal sampai simpan, jadwal, monitor) |
| Monitoring pengawas | disegarkan tiap 15 detik | status saja: **belum mulai · mengerjakan · pending · selesai**, berubah sendiri |
| Database utama | GitHub + Google Sheet buffer | Cloudflare D1 (SQL) |
| GitHub | database | **gambar soal** + **cadangan otomatis** (opsional) |
| Hosting aplikasi | GitHub Pages | ikut di Cloudflare (satu alamat), GitHub Pages tetap bisa |

```
 HP/laptop siswa / guru ──1 koneksi langsung (WebSocket)──► Worker ──► Durable Object "Engine"
                                                                    sesi ujian di memori, penilaian,
                                                                    monitoring, login, bank soal, jadwal
        (HTTP biasa hanya cadangan bila jaringan memblokir WebSocket)        │
                                                              D1 (akun, soal, jadwal, hasil)
                              │  simpan permanen: SQLite internal + D1
 Monitor guru ◄──WebSocket────┘
 Gambar soal ──► GitHub repo publik (cbt-media) via jsDelivr      Cadangan ──► GitHub repo privat (opsional)
```

## Hasil uji

Diuji di komputer pengembang dengan simulasi Cloudflare resmi (`wrangler dev`):

- **Uji fungsional** (semua fitur lama: 7 jenis soal, token, kunci perangkat, koreksi, hitung ulang, reset; plus
  status Pending, kiriman terlambat, penilaian otomatis bila perangkat tak pernah tersambung) — lulus.
- **Uji Chrome hitung permintaan** (dihitung dari log server):
  guru login → bank soal → edit 3× → Simpan → jadwal → monitor 2 ujian = **1**;
  siswa login → mulai → menjawab → Selesai → nilai → daftar = **1**;
  siswa yang koneksinya diputus di tengah ujian lalu halamannya dimuat ulang = **2** (ujian lanjut dari perangkat tanpa
  server, kirim akhir saat Selesai); siswa yang offline saat waktu habis = **2** (monitor menampilkan *Pending*, jawaban
  terkirim sendiri begitu internet menyala, lalu *Selesai*).
- **Uji beban ujian 90 menit, 1300 siswa + 50 guru memantau**: 1300 siswa membuka aplikasi bersamaan (semua siap
  ±6 detik); cadangan jawaban tiap 5 menit; 130 siswa koneksinya putus di menit ke-30 dan tidak menyambung ulang;
  26 siswa offline saat waktu habis (tampil *Pending*, terkirim belakangan); di menit ke-89,5 semua menekan *Selesai*
  bersamaan (dinilai dalam ±1,2 detik). **1300 hasil tersimpan, semuanya memakai jawaban lengkap dari perangkat.**
  Monitor guru tidak menerima data jawaban sama sekali selama ujian. Kuota: **1.506 permintaan**
  (1300 siswa + 156 kirim akhir dari yang putus/offline + 50 guru), 0 permintaan HTTP.
- Impor data dari repo GitHub versi Apps Script: akun lama bisa login dengan kata sandi lama, bank soal & hasil lama ikut pindah.

> Uji di atas memakai simulasi di komputer, bukan akun Cloudflare Anda. Sebelum ujian besar, lakukan **uji coba 1–2 kelas** dulu.

## Kapasitas & kuota gratis

Batas harian paket gratis Cloudflare **direset pukul 08.00 WITA** (00.00 UTC). Perkiraan pemakaian pada beban
**terberat**: 1300 siswa × 6 ujian per hari × 90 menit + 50 guru memantau tiap ujian (artinya setiap siswa mengikuti 6 ujian sehari):

| Kuota gratis per hari | Batas | Perkiraan terpakai |
|---|---|---|
| Permintaan Worker ("Requests today") | 100.000 | ±8.100–9.000 (1 per siswa per ujian; +1 bagi siswa yang koneksinya sempat putus; terburuk ±15.900) |
| Permintaan Durable Object (20 pesan WebSocket = 1) | 100.000 | ±17.000 |
| Baris dibaca D1 | 5.000.000 | ±50.000 (1%) |
| Baris ditulis D1 | 100.000 | ±9.000 (9%) |
| Baris dibaca penyimpanan internal Durable Object | 5.000.000 | ±8.000 |
| Baris ditulis penyimpanan internal Durable Object | 100.000 | ±27.000 (27%) |
| Waktu aktif Durable Object | 13.000 GB-detik | paling banyak ±10.800 (satu mesin ujian 24 jam penuh) |

Angka di atas diukur dari simulasi (`GURU=50 MENIT=90 npm run beban`), termasuk 50 guru membuat & mengedit bank
soal dan 10 guru membuka halaman Hasil.

**Ukuran database D1** (batas paket gratis **500 MB** per database): hasil tiap siswa disimpan terkompresi
±1,4 KB, jadi 1300 siswa × 6 ujian ≈ 11 MB per hari ujian → cukup untuk ±45 hari ujian penuh. Ukuran saat ini
terlihat di **Pengaturan → Ukuran database**. Bila mendekati penuh: unduh Excel hasil ujian lama, lalu di
**Jadwal ujian** hapus jadwal tersebut dan pilih **Hapus hasilnya juga** (cadangan di GitHub `cbt-data` tidak ikut
terhapus).

**Biaya tetap (tidak bergantung jumlah siswa) — versi 2.4:** data guru, bank soal, jadwal, pengaturan, jumlah
siswa, dan daftar siswa per kelas disalin ke penyimpanan internal mesin ujian. Saat mesin ujian bangun dari tidur
(tidak dipakai beberapa menit) ia **tidak membaca D1 sama sekali**. Pemicu terjadwal cukup **sekali sehari**
(06.00 WITA); kumpul otomatis, sinkron hasil, dan cadangan GitHub dijalankan alarm internal hanya saat ada pekerjaan.
Bila data D1 pernah diubah di luar aplikasi (tidak disarankan), tekan **Pengaturan → Muat ulang data dari database**.

Membuka halaman aplikasi (HTML) **tidak** dihitung kuota. Pemakaian sebenarnya bisa dilihat di
dash.cloudflare.com → *Workers & Pages* → `cbt-sekolah` → *Metrics*.

Jika suatu hari butuh lebih (mis. 2.500 siswa), paket **Workers Paid US$5/bulan** menghapus batas harian ini tanpa
mengubah kode.

---

## Langkah 1 — Pasang Node.js & buat akun Cloudflare

1. Unduh dan pasang **Node.js LTS** dari <https://nodejs.org> (klik *Next* sampai selesai).
2. Buat akun gratis di <https://dash.cloudflare.com/sign-up> (cukup email; tidak perlu kartu kredit, tidak perlu domain).

## Langkah 2 — Pasang ke Cloudflare

**Cara mudah (Windows):** buka folder `cbt-cloudflare`, klik dua kali **`PASANG-WINDOWS.bat`**.

**Cara manual:** buka *Command Prompt* di folder `cbt-cloudflare`, lalu:
```
npm install
npx wrangler login
npx wrangler deploy
```

- `wrangler login` membuka browser → klik **Allow**.
- Pada deploy pertama, jika diminta, buat subdomain `workers.dev` (mis. `sman5pinrang`).
  Database D1 `cbt-sekolah-db` dibuat **otomatis**; tabel dibuat sendiri saat aplikasi pertama dibuka.
- Setelah selesai, muncul alamat seperti `https://cbt-sekolah.sman5pinrang.workers.dev`.

Aplikasi langsung bisa dibuka:
- Guru & admin: `https://cbt-sekolah.<subdomain>.workers.dev/guru/`
- Siswa: `https://cbt-sekolah.<subdomain>.workers.dev/ujian-cbt/` (alamat lama `/siswa/` dan alamat utama `/` dialihkan ke sini)

## Langkah 3 — GitHub untuk gambar soal (agar guru bisa unggah gambar)

1. Buat repo **publik** `cbt-media` di GitHub (boleh kosong).
2. (Opsional, disarankan) Buat repo **privat** `cbt-data` untuk cadangan otomatis soal & hasil.
3. Buat token: GitHub → *Settings* → *Developer settings* → *Personal access tokens* → **Fine-grained tokens** →
   *Generate new token* → *Only select repositories*: `cbt-media` (dan `cbt-data`) → *Repository permissions* →
   **Contents: Read and write** → *Generate*. Salin token (`github_pat_…`).
4. Buka `wrangler.jsonc`, isi:
   ```jsonc
   "MEDIA_REPO": "namaakun/cbt-media",
   "DATA_REPO": "namaakun/cbt-data",   // kosongkan "" bila tidak memakai cadangan
   ```
5. Simpan token sebagai rahasia lalu deploy ulang:
   ```
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler deploy
   ```
   (tempel token saat diminta; token tidak pernah tersimpan di file atau browser)

Cek di aplikasi guru → **Pengaturan** → bagian *Sistem & cadangan*: repo dan token harus terbaca.

## Langkah 4 — Penggunaan pertama

1. Buka aplikasi guru, masuk dengan **admin / admin123**, lalu **segera ganti kata sandi** di *Akun saya*.
2. **Pengaturan**: nama sekolah, tahun ajaran, tingkat, kelas, mata pelajaran.
3. **Data guru**: buat akun guru. Hapus akun contoh `guru`.
4. **Data siswa → Impor**: Excel dengan kolom **NIS, Nama, Kelas** (opsional **Kata sandi**; bawaan = NIS). Hapus siswa contoh 1001–1003.
5. Guru membuat **Bank soal**; admin membuat **Jadwal ujian**.
6. Hari ujian: admin menyalakan **Token ujian** (Beranda atau Jadwal ujian → **Manual** atau **Otomatis**; satu token untuk semua ujian).
   Pengawas membuka **Monitoring** (tanda **● Status diperbarui otomatis** = tersambung), tekan **↻ Muat ulang** untuk melihat token terbaru, lalu bacakan.

### Sudah punya data di versi Apps Script?
Isi `DATA_REPO` dengan repo data lama (mis. `namaakun/cbt-data`) dan pastikan token punya akses ke repo itu,
lalu: aplikasi guru → **Pengaturan** → **Impor data dari GitHub…**. Akun guru & siswa (dengan kata sandi lama),
bank soal, jadwal, dan hasil ujian ikut pindah. Lakukan saat tidak ada ujian berlangsung.

---

## Hak akses (versi 2.9.0-CBT)

| | Admin | Guru pengawas | Guru pemilik soal | Siswa |
|---|---|---|---|---|
| Bank soal milik guru | lihat di daftar saja (tidak bisa Edit/Hapus) | — | susun, ubah, hapus | — |
| Mata pelajaran bank soal baru | semua | — | hanya mapel yang ditetapkan admin di akunnya | — |
| Jadwal ujian yang terlihat | semua (atur jadwal, kelas, **pengawas**) | **hanya hari ini**: Ujian, Kelas, Waktu, Durasi, Pengawas | sama dengan pengawas | **hanya hari ini** |
| Monitoring (daftar) | **hanya ujian yang sedang berlangsung**, semua kelas (ujian lain lewat Jadwal → Pantau) | **hanya ujian berlangsung yang ia awasi, hanya kelas yang ia awasi** | hanya bila ia juga pengawas | — |
| Token ujian (satu untuk semua ujian) | buat: Mati / Manual / Otomatis | lihat + ↻ Muat ulang (bila mengawasi ujian hari ini) | — | — |
| Hasil: nilai, skor, ringkasan & KKM, analisis soal, koreksi, hitung ulang | **tidak** (hanya daftar peserta & status) | — | ya | nilai sendiri bila "Tampilkan nilai" aktif |
| Excel & impor: data siswa, data guru, **pengaturan** | ya | — | — | — |

**Menetapkan pengawas:** Jadwal ujian → Buat/Ubah jadwal → pilih *Bank soal* (Nama ujian terisi otomatis dari judul
bank soal guru, bisa diubah) → *Nama pengawas*: ketik nama guru lalu Enter (atau pilih dari daftar). Bila kelas peserta
lebih dari satu, tandai kelas yang diawasi tiap pengawas. Daftar pilihan **tidak memuat akun admin** dan **tidak memuat
guru yang sudah mengawasi ujian bermapel sama di tingkat lain** (ujian yang belum berakhir) — misalnya pengawas
Kimia X tidak ditawarkan untuk Kimia XI.

**Impor guru:** Data guru → *Impor* → file Excel dengan kolom *Nama pengguna, Nama, Mata pelajaran, Password, Peran,
Status* (sama dengan hasil *Unduh Excel*). Guru baru tanpa password → password sama dengan nama pengguna.

**Impor pengaturan:** Pengaturan → *Unduh Excel* (lembar Identitas, Tingkat, Kelas, Mata pelajaran) → ubah di Excel →
*Impor* → pilih *Tambahkan* atau *Ganti* → *Impor & simpan*.

## Aplikasi ujian Android (.apk) & Windows (.exe)

Folder `ExamBrowser` berisi aplikasi seperti *exambrowser* untuk halaman `/ujian-cbt/`. Cara membangun (lewat
GitHub Actions, gratis) dan memasangnya ada di `ExamBrowser/README.md`. Ringkasnya:

- Android: terkunci sejak siswa menekan **Mulai mengerjakan** (sematkan layar + lapisan mengambang bila siswa keluar).
- Windows: layar penuh & tombol pintas Windows diblokir sejak dibuka; terkunci penuh sejak **Mulai mengerjakan**.
- **Tidak ada token keluar.** Selama ujian aplikasi tidak bisa ditutup; kunci terbuka sendiri setelah jawaban
  terkirim, atau setelah pengawas **mereset** ujian siswa itu di Monitoring (perangkat perlu internet saat itu).
  Darurat (perangkat macet tanpa internet): mulai ulang HP/komputer — jawaban tetap tersimpan di perangkat dan
  ujian dilanjutkan saat aplikasi dibuka lagi.
- Isi-otomatis dan tawaran **"Simpan sandi"** Google/Edge dimatikan di kedua aplikasi.
- Jadwal → **Wajib memakai aplikasi CBT Ujian** agar ujian tidak bisa dikerjakan dari browser biasa.

## Halaman ujian hanya untuk aplikasi + sumber teracak

- **`/ujian-cbt/` hanya bisa dibuka lewat aplikasi CBT Ujian** (.apk/.exe). Dibuka di browser mana pun → **404**.
  Aktif bila rahasia `APP_KUNCI` diatur di Worker **dan** disatukan ke aplikasi (lihat `ExamBrowser-kunci/APP_KUNCI-BACA.md`).
  Bila `APP_KUNCI` kosong, gerbang mati (halaman terbuka biasa — untuk uji coba). `/guru/` tidak terpengaruh.
- **Kode halaman diacak.** Berkas yang dilayani (`public/guru/index.html`, `public/ujian-cbt/`) sudah diacak
  (javascript-obfuscator) dan dibuang komentar/spasinya sehingga sulit dibaca, ditiru, atau diubah.
  Sumber yang mudah dibaca ada di folder `sumber/`; setelah mengeditnya jalankan `node bina.mjs` untuk membangun
  ulang berkas di `public/`. (Folder `sumber/` tidak dilayani ke internet, jadi aman disimpan di proyek.)

  Catatan jujur: pengacakan menyulitkan, bukan mustahil — kode teracak masih bisa dianalisis dengan usaha keras,
  dan tampilan yang sudah tampil di layar selalu bisa dilihat lewat alat pengembang (di aplikasi, alat pengembang
  dimatikan). Gerbang aplikasi + pengacakan menaikkan palang setinggi mungkin untuk hal yang dijalankan di sisi pengguna.

## Excel: NISN, NIP, dan password berawalan 0

File *Unduh Excel* dan *Unduh format Excel* (di jendela Impor) memakai format **Teks** untuk kolom NIS/NISN,
Nama pengguna (NIP), dan Password — termasuk baris kosong di bawahnya — sehingga angka 0 di depan dan NIP 18 digit
tidak berubah saat diketik. Saat impor:
- NISN di kolom berjudul **NISN** yang tersimpan sebagai angka (0 di depan hilang) dilengkapi kembali menjadi 10 digit;
- angka lebih dari 15 digit yang sudah rusak di Excel (mis. `1.98012E+17`) dilewati dan diberi tahu, karena digit
  terakhirnya sudah berubah. Ubah kolomnya menjadi Teks lalu ketik ulang.

## serverB (cadangan) dan serverC (server utama)

Di aplikasi, Cloudflare disebut **serverC** dan GitHub disebut **serverB**; nama layanan dan kata "D1" tidak tampil di
layar. (Alamat aplikasi `…workers.dev` dan alamat gambar soal tetap terlihat oleh orang yang memeriksa alamat/kode
halaman; pakai domain sendiri bila perlu menyamarkannya.)

- Data dikirim ke serverB **hanya bila ada perubahan**, ±2 menit setelah perubahan terakhir. Selama ada siswa yang
  sedang mengerjakan, pengiriman ditunda sampai ujian selesai. Tidak ada perubahan = tidak ada pengiriman.
- **Data hari-hari sebelumnya dibaca dari serverB** (0 baris D1): daftar Data siswa, Excel & kartu login siswa, daftar
  peserta monitor, hasil & nilai ujian yang sudah lewat, koreksi ujian lama.
- **Data hari ini dibaca dari serverC (D1)**: bila data siswa diubah hari ini, atau hasil ujian lama dikoreksi hari ini,
  data dibaca dari D1 sampai salinannya terkirim lagi ke serverB dan hari berganti.
- Salinan dibaca pada commit yang tercatat (tidak berubah), jadi isinya pasti sama dengan D1 saat dikirim. Bila serverB
  tidak bisa dihubungi, aplikasi otomatis membaca dari D1.

## Cara kerja saat ujian

- **1 kali ujian = 1 permintaan per siswa.** Koneksi dibuka sekali (saat login/mulai) dan dipakai untuk login, daftar
  ujian, mulai, cadangan jawaban, Selesai, dan nilai.
- Setiap jawaban **langsung tersimpan di perangkat** siswa. Soal dan batas waktu juga disimpan di perangkat, sehingga
  halaman yang dimuat ulang atau aplikasi yang ditutup-buka **melanjutkan ujian tanpa menghubungi server**.
- Selama koneksi masih terbuka, cadangan jawaban ikut dikirim **tiap 5 menit** (tidak menambah permintaan).
- Bila koneksi putus (sinyal hilang, HP terkunci lama), aplikasi **tidak menyambung ulang** selama ujian. Siswa tetap
  mengerjakan; saat menekan **Selesai** (atau waktu habis) aplikasi membuka 1 koneksi baru untuk mengirim jawaban akhir.
  Jadi paling banyak 2 permintaan per siswa per ujian.
- Saat waktu habis, perangkat mengirim otomatis. Bila saat itu tidak ada internet, jawaban tetap di perangkat dan
  dikirim sendiri begitu internet menyala (dicoba tiap 2 menit). Selama menunggu, monitor menampilkan **Pending**.
- Jawaban yang datang setelah waktu habis tetap diterima dan diberi catatan *"terkirim … menit setelah waktu habis"*.
- Bila perangkat rusak/hilang: pengawas memilih **Kumpulkan sekarang** (dinilai dari cadangan terakhir di server).
  Bila tidak ada yang menekan, siswa *Pending* dinilai otomatis dari cadangan terakhir **2 jam setelah jadwal ditutup**;
  bila perangkatnya tersambung lagi setelah itu, jawaban lengkap dari perangkat menggantikan nilai otomatis.
- **Monitor** cukup menampilkan status: **Belum mulai · Mengerjakan · Pending · Selesai**. Tidak ada progres jawaban,
  tidak ada penyegaran berkala. Perubahan status dikirim server lewat koneksi aplikasi guru yang sudah terbuka. Bila
  koneksi guru putus, tekan **Perbarui** (1 permintaan).
- Aplikasi guru: membuka aplikasi lalu mengedit soal sampai **Simpan**, mengatur jadwal, dan memantau = 1 permintaan.
  Draf soal tersimpan di perangkat selama mengedit. Bila koneksi guru sempat putus (laptop tidur), Simpan membuka
  1 koneksi baru.
- Bila koneksi langsung (WebSocket) diblokir jaringan, aplikasi memakai HTTP biasa (tiap klik = 1 permintaan; jawaban
  tetap dikirim saat Selesai saja).
- Mulai, selesai, dan reset dicatat permanen **sebelum** siswa melihat tanda berhasil. Jawaban sementara dicadangkan
  tiap 2 menit, sehingga server yang restart di tengah ujian tidak menghilangkan jawaban.
- Login siswa berlaku 16 jam, jadi siswa cukup login sekali untuk semua sesi ujian hari itu.

**Tidak perlu lagi membagi sesi kecil** seperti di versi Apps Script. Pembagian sesi hanya bila ruangan/perangkat terbatas.

## Memperbarui aplikasi

Ubah file, lalu jalankan `npx wrangler deploy` (atau klik dua kali `PASANG-WINDOWS.bat`).
**Jangan deploy saat ujian berlangsung.** Bila terpaksa, siswa tetap mengerjakan dari perangkat dan jawaban terkirim saat Selesai.

## Hosting di GitHub Pages (opsional)

Aplikasi sudah ikut di Cloudflare, jadi ini tidak wajib. Jika tetap ingin memakai GitHub Pages, ubah baris ini di
`public/guru/index.html` dan `public/ujian-cbt/index.html`:
```js
const API_URL = window.CBT_API_URL || 'https://cbt-sekolah.<subdomain>.workers.dev/api';
```

## Uji di komputer sendiri (untuk pengembang)

```
npm run dev          # server lokal http://localhost:8787 (data uji, tanpa akun Cloudflare)
npm test             # uji fungsional + uji koneksi tunggal (jalankan saat "npm run dev" aktif)
GURU=50 MENIT=90 npm run beban   # simulasi ujian 90 menit: 1300 siswa + 50 guru
```

## Pemecahan masalah

| Gejala | Penyebab & solusi |
|---|---|
| "Kuota harian Cloudflare sudah habis" / Error 1027 | Batas 100.000 permintaan/hari tercapai. Pulih pukul 08.00 WITA. Jawaban siswa tetap aman di perangkat. Pertimbangkan paket US$5/bulan bila sering terjadi. |
| Monitor tertulis "Koneksi terputus" | Tekan **Perbarui** (1 permintaan). Bila tetap gagal, jaringan memblokir WebSocket: coba jaringan lain / data seluler. |
| Banyak siswa *Pending* setelah waktu habis | Perangkat siswa belum tersambung internet. Minta siswa menyalakan internet dan **jangan menghapus data browser**; jawaban terkirim sendiri. Perangkat rusak/hilang → **Kumpulkan sekarang**. |
| Siswa: "Offline — jawaban aman di perangkat" | Koneksi putus. Biarkan siswa lanjut; jawaban terkirim saat koneksi kembali. |
| "MEDIA_REPO belum diatur" saat unggah gambar | Lakukan Langkah 3. Guru tetap bisa memakai *Pakai URL gambar*. |
| "GitHub 401 / Bad credentials" | Token salah/kedaluwarsa. Buat token baru → `npx wrangler secret put GITHUB_TOKEN`. |
| "Repo … HARUS PRIVAT" | `DATA_REPO` berisi kunci jawaban & kata sandi, jadikan privat di GitHub. |
| Siswa: "sedang dikerjakan di perangkat lain" | Pengawas: Monitoring → ••• → **Reset login**. |
| Siswa salah menekan Selesai | Admin: Monitoring → ••• → **Ulang ujian dari awal**. |
| Kunci jawaban salah | Perbaiki di bank soal, lalu Hasil → **Hitung ulang nilai**. |
| Nama sekolah baru belum tampil di halaman login | Disimpan dalam cache ±1 menit. Tunggu sebentar. |
| `wrangler login` gagal di jaringan sekolah | Coba jaringan lain, atau buat API token di dashboard Cloudflare lalu `set CLOUDFLARE_API_TOKEN=...` sebelum `npx wrangler deploy`. |
| Melihat log error | `npx wrangler tail` atau dashboard → Workers → `cbt-sekolah` → *Logs*. |

## Keamanan

- Kunci jawaban, pembahasan, dan pedoman penskoran tidak pernah dikirim ke aplikasi siswa; penilaian di server.
- Kata sandi disimpan sebagai hash (format sama dengan versi lama); login dibatasi 8 kali gagal per 10 menit.
- Sesi memakai token bertanda tangan (HMAC). Token GitHub hanya ada di *secret* Cloudflare.
- Satu siswa hanya di satu perangkat; pindah perangkat lewat *Reset login*.
- Guru hanya melihat bank soal & hasil miliknya; admin melihat semuanya.

Catatan jujur: aplikasi web tidak bisa mencegah semua kecurangan (mis. memotret layar). Pengawasan ruang tetap perlu.
