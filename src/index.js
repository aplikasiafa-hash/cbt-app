/**
 * ============================================================================
 *  CBT SEKOLAH — Backend Cloudflare (Workers + D1 + Durable Objects) — GRATIS
 * ============================================================================
 *  Worker ini sangat ringan (batas gratis: 10 ms CPU per permintaan):
 *   - ping, loginGuru, getConfig                        → langsung ke D1
 *   - loginSiswa, ujianSaya → mesin ujian (perlu tahu siswa yang sedang ujian & token ujian yang berlaku)
 *   - /api/ws (WebSocket ujian & monitoring)            → Durable Object "Engine"
 *   - aksi lain (guru/admin, mulai/simpan/selesai)      → Durable Object "Engine"
 *  Aplikasi guru & siswa (folder public/) disajikan sebagai aset statis (gratis, tidak dihitung kuota).
 * ============================================================================
 */
import { Engine } from './engine.js';
import {
  VERSI, TOKEN_GURU_JAM, CONFIG_DEFAULT, AppError, errInfo, now, setOffset,
  str_, cekPw_, signToken_, verifyToken_
} from './shared.js';

export { Engine };

const LOKAL = new Set(['ping', 'loginGuru', 'getConfig']);
const HDR = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: HDR });
const okRes = data => jres({ ok: true, data: data === undefined ? null : data, serverTime: now() });
const errRes = e => { const i = errInfo(e); if (!(e && e.app)) console.error(e && e.stack || e); return jres({ ok: false, error: i.msg, code: i.code, serverTime: now() }); };

// cache per-isolate (hemat kuota baca D1)
let SECRET = null, CONFIG = null, CONFIG_T = 0, KUNCI_LINK = null, KUNCI_LINK_T = 0;

const engine = env => env.ENGINE.get(env.ENGINE.idFromName('utama'));

async function secret(env) {
  if (SECRET) return SECRET;
  try {
    const r = await env.DB.prepare(`SELECT v FROM kv WHERE k='secret'`).first();
    if (r && r.v) return (SECRET = r.v);
  } catch (e) { /* tabel belum dibuat */ }
  const r = await engine(env).fetch('https://engine/init', { method: 'POST' });
  const j = await r.json();
  if (!j.ok) throw new AppError(j.error || 'Gagal menyiapkan database');
  return (SECRET = j.data);
}
async function config(env) {
  if (CONFIG && Date.now() - CONFIG_T < 60000) return CONFIG;
  await secret(env);
  const r = await env.DB.prepare(`SELECT v FROM kv WHERE k='config'`).first();
  CONFIG = { ...CONFIG_DEFAULT, ...(r ? JSON.parse(r.v) : {}) }; CONFIG_T = Date.now();
  return CONFIG;
}
/** Sakelar "kunci link" (Pengaturan, admin). Tersimpan di kv 'kunci_link': '0' = mati; selain itu aktif.
 *  Dibaca paling sering sekali per 30 detik per isolate, dan hanya untuk permintaan halaman ujian tanpa kunci. */
async function kunciLinkAktif(env) {
  if (KUNCI_LINK !== null && Date.now() - KUNCI_LINK_T < 30000) return KUNCI_LINK;
  try { const r = await env.DB.prepare(`SELECT v FROM kv WHERE k='kunci_link'`).first(); KUNCI_LINK = !(r && r.v === '0'); }
  catch (e) { KUNCI_LINK = true; }   // belum ada tabel → aktif (aman)
  KUNCI_LINK_T = Date.now();
  return KUNCI_LINK;
}

// --------------------------------------------------------------------------
//  Pembatasan percobaan login (8 kali gagal / 10 menit)
// --------------------------------------------------------------------------
const SQL_GAGAL = `INSERT INTO gagal (k, n, t) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN gagal.t < ?2 - 600000 THEN 1 ELSE gagal.n + 1 END, t = ?2`;
function cekGagal(row) {
  if (row && row.n >= 8 && now() - row.t < 600000) throw new AppError('Terlalu banyak percobaan masuk. Tunggu 10 menit lalu coba lagi.');
}

// --------------------------------------------------------------------------
//  AKSI LOKAL (paling sering dipakai siswa)
// --------------------------------------------------------------------------
const AKSI = {
  async ping(d, env) {
    const c = await config(env);
    return { app: 'CBT Sekolah', versi: VERSI, namaSekolah: c.namaSekolah, logo: c.logo || '', tahunAjaran: c.tahunAjaran, semester: c.semester };
  },

  async loginGuru(d, env) {
    const sec = await secret(env), username = str_(d.username, 60).trim().toLowerCase();
    const [g, r] = await env.DB.batch([
      env.DB.prepare(`SELECT n, t FROM gagal WHERE k = ?`).bind('g:' + username),
      env.DB.prepare(`SELECT data FROM guru WHERE username = ?`).bind(username)
    ]);
    cekGagal(g.results[0]);
    const u = r.results[0] ? JSON.parse(r.results[0].data) : null;
    if (!u || !(await cekPw_(u, d.password))) {
      await env.DB.prepare(SQL_GAGAL).bind('g:' + username, now()).run();
      throw new AppError('Nama pengguna atau kata sandi salah');
    }
    if (u.aktif === false) throw new AppError('Akun dinonaktifkan. Hubungi admin.');
    const role = u.role === 'admin' ? 'admin' : 'guru';
    const token = await signToken_({ r: role, id: u.id, n: u.nama, exp: now() + TOKEN_GURU_JAM * 3600000 }, sec);
    return { token, user: { id: u.id, username: u.username, nama: u.nama, role, mapel: u.mapel || [] }, config: await config(env) };
  },

  async getConfig(d, env, tok) {
    await verifyToken_(tok, await secret(env));
    return config(env);
  }
};

// --------------------------------------------------------------------------
//  ROUTER
// --------------------------------------------------------------------------
async function api(req, env, url) {
  let aksi = url.searchParams.get('a') || '';
  if (aksi && !LOKAL.has(aksi) && aksi !== '_dev') {
    // diteruskan apa adanya (tanpa diurai) → hemat CPU Worker
    const r = await engine(env).fetch('https://engine/api', { method: 'POST', body: req.body, headers: { 'content-type': 'text/plain' } });
    return new Response(r.body, { status: r.status, headers: HDR });
  }
  const text = await req.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { return errRes(new AppError('Format permintaan tidak valid')); }
  aksi = body.action;
  if (aksi === '_dev' && env.DEV_MODE === '1') {
    setOffset(body.data && body.data.offset); CONFIG = null;
  }
  if (!LOKAL.has(aksi)) {
    const r = await engine(env).fetch('https://engine/api', { method: 'POST', body: text, headers: { 'content-type': 'text/plain' } });
    return new Response(r.body, { status: r.status, headers: HDR });
  }
  try {
    return okRes(await AKSI[aksi](body.data || {}, env, body.token || ''));
  } catch (e) { return errRes(e); }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/api') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { ...HDR, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (req.method === 'POST') return api(req, env, url);
      return okRes({ app: 'CBT Sekolah', versi: VERSI });
    }
    if (p === '/api/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Butuh WebSocket', { status: 426 });
      return engine(env).fetch(req);
    }
    // Halaman ujian HANYA boleh dibuka dari aplikasi CBT Ujian (.apk/.exe). Aplikasi menyisipkan
    // kunci rahasia (APP_KUNCI) ke User-Agent; browser biasa tidak punya → dijawab 404.
    // Kunci diatur sebagai rahasia Worker (wrangler secret put APP_KUNCI) DAN disatukan ke aplikasi saat dibangun.
    // Bila APP_KUNCI tidak diatur, gerbang MATI (halaman terbuka seperti biasa) agar tidak mengunci diri sendiri.
    // Admin juga bisa mematikan/menyalakan gerbang dari Pengaturan → "Kunci link" tanpa menghapus rahasianya.
    if (p === '/ujian-cbt' || url.pathname.startsWith('/ujian-cbt/')) {
      if (env.APP_KUNCI && !(req.headers.get('user-agent') || '').includes('k/' + env.APP_KUNCI) && await kunciLinkAktif(env)) {
        let body = 'Tidak ditemukan';
        try { body = await (await env.ASSETS.fetch(new URL('/404.html', url))).text(); } catch (e) {}
        return new Response(body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'vary': 'User-Agent' } });
      }
      const r = await env.ASSETS.fetch(req);
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), 'cache-control': 'no-store', 'vary': 'User-Agent' } });
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Tidak ditemukan', { status: 404 });
  },

  // Pemicu terjadwal: rawat sesi ujian (kumpul otomatis, sinkron) + cadangan GitHub opsional
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(engine(env).fetch('https://engine/tick', { method: 'POST' }).then(r => r.text()).catch(e => console.error('tick', e)));
  }
};
