// =============================================================================
//  Pasang nama variabel di serverC secara otomatis (Settings → Variables and Secrets).
//
//  Dijalankan sendiri oleh "npx wrangler deploy" (lihat "build" di wrangler.jsonc), hanya saat
//  pemasangan dari serverB lewat serverC Builds. Di komputer sendiri / uji lokal: tidak melakukan apa-apa.
//
//  Yang ditambahkan HANYA bila namanya BELUM ADA:
//    CF_API_TOKEN, DATA_REPO, GITHUB_TOKEN, MEDIA_REPO  → nilai kosong, diisi admin di dashboard serverC
//    APP_KUNCI                                         → kunci link aplikasi CBT Ujian (.apk / .exe)
//  Nama yang sudah ada TIDAK PERNAH diubah atau ditimpa, jadi isian admin aman di setiap pemasangan ulang.
//  Bila ada yang gagal, hanya muncul pesan di log — pemasangan aplikasi tetap berjalan.
// =============================================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const API = (process.env.CBT_SERVERC_API || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const KOSONG = ['CF_API_TOKEN', 'DATA_REPO', 'GITHUB_TOKEN', 'MEDIA_REPO'];
const log = m => console.log('[variabel serverC] ' + m);

// Kunci link yang sama dengan yang disatukan ke aplikasi CBT Ujian (.apk / .exe) saat dibangun.
const KUNCI_LINK = 'cbt_QkDjyqHtqNMpl_I7vzhWxyeo4J7R5Vvs';
function namaWorker() {
  if (process.env.WRANGLER_CI_OVERRIDE_NAME) return process.env.WRANGLER_CI_OVERRIDE_NAME.trim();
  try { const m = readFileSync(join(DIR, 'wrangler.jsonc'), 'utf8').match(/"name"\s*:\s*"([^"]+)"/); return m ? m[1] : ''; }
  catch (e) { return ''; }
}

async function panggil(token, path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  const kode = j && j.errors && j.errors[0] ? j.errors[0].code : 0;
  return { ok: r.ok && (!j || j.success !== false), status: r.status, kode, hasil: j ? j.result : null,
    pesan: j && j.errors && j.errors[0] ? j.errors[0].message : 'HTTP ' + r.status };
}

async function jalan() {
  if (process.env.WORKERS_CI !== '1' && process.env.CBT_PASANG_VARIABEL !== '1') return;   // bukan serverC Builds
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) { log('token pemasangan tidak tersedia, dilewati.'); return; }
  const nama = namaWorker();
  if (!nama) { log('nama aplikasi tidak diketahui, dilewati.'); return; }

  let akun = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!akun) {
    const a = await panggil(token, '/accounts?per_page=5');
    const daftar = a.ok && Array.isArray(a.hasil) ? a.hasil : [];
    if (daftar.length !== 1) { log('ID akun tidak bisa ditentukan (' + (a.ok ? daftar.length + ' akun' : a.pesan) + '), dilewati.'); return; }
    akun = daftar[0].id;
  }
  const dasar = '/accounts/' + akun + '/workers/scripts/' + encodeURIComponent(nama);

  // semua nama yang sudah ada (teks biasa maupun rahasia) — tidak akan disentuh
  const s = await panggil(token, dasar + '/settings');
  if (!s.ok) {
    if (s.status === 404 || s.kode === 10007) log('aplikasi "' + nama + '" belum ada di serverC; nama variabel ditambahkan pada pemasangan berikutnya.');
    else log('daftar variabel tidak bisa dibaca (' + s.pesan + '), dilewati.');
    return;
  }
  const ada = new Set(((s.hasil && s.hasil.bindings) || []).map(b => b.name));
  const kunci = KUNCI_LINK;
  const perlu = [...KOSONG.map(n => [n, '']), ['APP_KUNCI', kunci]].filter(([n, v]) => !ada.has(n) && (n !== 'APP_KUNCI' || v));
  if (!perlu.length) { log('semua nama variabel sudah ada, tidak ada yang diubah.'); return; }

  const dibuat = [];
  for (const [n, v] of perlu) {
    const kirim = text => panggil(token, dasar + '/secrets', { method: 'PUT', body: JSON.stringify({ name: n, text, type: 'secret_text' }) });
    let r = await kirim(v);
    // serverC menolak nilai kosong → isi "-" (aplikasi menganggap "-" sama dengan belum diisi)
    if (!r.ok && v === '') r = await kirim('-');
    if (r.ok) dibuat.push(n); else log(n + ' gagal ditambahkan (' + r.pesan + ').');
  }
  if (dibuat.length) log('ditambahkan: ' + dibuat.join(', ') + '. Isi nilainya di Settings → Variables and Secrets.');
}

jalan().catch(e => log('dilewati (' + (e && e.message || e) + ').')).finally(() => process.exit(0));
