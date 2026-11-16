# cbt-app — kode aplikasi CBT Sekolah

Repo ini dipasang otomatis ke Cloudflare Worker **`cbt-sekolah`** (Workers Builds). Setiap commit ke `main`
memasang ulang aplikasi dalam 1–2 menit.

| Folder / file | Isi |
|---|---|
| `public/guru/` | Aplikasi guru & admin |
| `public/siswa/` | Aplikasi siswa |
| `src/` | Backend: Worker + Durable Object "Engine" |
| `wrangler.jsonc` | Pengaturan Cloudflare — **ganti `namaakun`** dengan nama akun GitHub Anda |
| `test/` | Uji otomatis (untuk pengembang) |
| `PANDUAN.md` | Panduan lengkap pemakaian & pemecahan masalah |

Rahasia (`GITHUB_TOKEN`) tidak pernah disimpan di repo ini, hanya di dashboard Cloudflare.
Jangan memperbarui repo ini saat ujian berlangsung.
