# cbt-app — kode aplikasi CBT Sekolah

Repo ini dipasang otomatis ke Cloudflare Worker **`cbt-sekolah`** (Workers Builds). Setiap commit ke `main`
memasang ulang aplikasi dalam 1–2 menit.

| Folder / file | Isi |
|---|---|
| `public/guru/` | Aplikasi guru & admin |
| `public/ujian-cbt/` | Aplikasi siswa (alamat `…/ujian-cbt/`; `public/siswa/` hanya pengalih untuk alamat lama) |
| `src/` | Backend: Worker + Durable Object "Engine" |
| `wrangler.jsonc` | Pengaturan Cloudflare (nama repo GitHub Anda sudah terisi) |
| `test/` | Uji otomatis (untuk pengembang) |
| `PANDUAN.md` | Panduan lengkap pemakaian & pemecahan masalah |

Rahasia (`GITHUB_TOKEN`) tidak pernah disimpan di repo ini, hanya di dashboard Cloudflare.
Jangan memperbarui repo ini saat ujian berlangsung.
