/**
 * ============================================================================
 *  CBT SEKOLAH — Backend Cloudflare (Workers + D1 + Durable Objects) — GRATIS
 * ============================================================================
 *  Worker ini sangat ringan (batas gratis: 10 ms CPU per permintaan):
 *   - ping, loginSiswa, loginGuru, ujianSaya, getConfig  → langsung ke D1
 *   - /api/ws (WebSocket ujian & monitoring)            → Durable Object "Engine"
 *   - aksi lain (guru/admin, mulai/simpan/selesai)      → Durable Object "Engine"
 *  Aplikasi guru & siswa (folder public/) disajikan sebagai aset statis (gratis, tidak dihitung kuota).
 * ============================================================================
 */
import { Engine } from './engine.js';
import {
  VERSI, TOKEN_GURU_JAM, TOKEN_SISWA_JAM, CONFIG_DEFAULT, AppError, errInfo, now, setOffset,
  str_, cekPw_, signToken_, verifyToken_, reqSiswa_
} from './shared.js';

export { Engine };

const LOKAL = new Set(['ping', 'loginSiswa', 'loginGuru', 'ujianSaya', 'getConfig']);
const HDR = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: HDR });
const okRes = data => jres({ ok: true, data: data === undefined ? null : data, serverTime: now() });
const errRes = e => { const i = errInfo(e); if (!(e && e.app)) console.error(e && e.stack || e); return jres({ ok: false, error: i.msg, code: i.code, serverTime: now() }); };

// cache per-isolate (hemat kuota baca D1)
let SECRET = null, CONFIG = null, CONFIG_T = 0, UJIAN = null, UJIAN_T = 0;

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
  CONFIG = r ? JSON.parse(r.v) : CONFIG_DEFAULT; CONFIG_T = Date.now();
  return CONFIG;
}
async function daftarUjian(env) {
  if (UJIAN && Date.now() - UJIAN_T < 20000) return UJIAN;
  const r = await env.DB.prepare(`SELECT data FROM ujian WHERE selesai >= ?`).bind(now() - 3 * 86400000).all();
  UJIAN = r.results.map(x => JSON.parse(x.data)); UJIAN_T = Date.now();
  return UJIAN;
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

  async loginSiswa(d, env) {
    const sec = await secret(env), nis = str_(d.nis, 40).trim();
    const [g, s] = await env.DB.batch([
      env.DB.prepare(`SELECT n, t FROM gagal WHERE k = ?`).bind('s:' + nis),
      env.DB.prepare(`SELECT nis, nama, kelas, salt, hash FROM siswa WHERE nis = ?`).bind(nis)
    ]);
    cekGagal(g.results[0]);
    const sw = s.results[0];
    if (!sw || !(await cekPw_(sw, d.password))) {
      await env.DB.prepare(SQL_GAGAL).bind('s:' + nis, now()).run();
      throw new AppError('NIS atau kata sandi salah');
    }
    const token = await signToken_({ r: 'siswa', id: sw.nis, n: sw.nama, k: sw.kelas, exp: now() + TOKEN_SISWA_JAM * 3600000 }, sec);
    const c = await config(env);
    return { token, user: { nis: sw.nis, nama: sw.nama, kelas: sw.kelas }, sekolah: { namaSekolah: c.namaSekolah, logo: c.logo || '' } };
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
  },

  async ujianSaya(d, env, tok) {
    const me = reqSiswa_(await verifyToken_(tok, await secret(env)));
    const t = now();
    const list = (await daftarUjian(env))
      .filter(u => u.aktif && (u.kelas || []).indexOf(me.k) >= 0 && u.selesai >= t - 3 * 86400000 && u.mulai <= t + 7 * 86400000)
      .sort((a, b) => a.mulai - b.mulai);
    const hasil = {};
    if (list.length) {
      const r = await env.DB.prepare(`SELECT ujian_id, nilai, perlu FROM hasil WHERE nis = ?1 AND ujian_id IN (SELECT value FROM json_each(?2))`)
        .bind(me.id, JSON.stringify(list.map(u => u.id))).all();
      r.results.forEach(x => { hasil[x.ujian_id] = x; });
    }
    return list.map(u => {
      const h = hasil[u.id];
      const item = {
        id: u.id, nama: u.nama, mapel: u.mapel, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi,
        jumlahSoal: u.jumlahSoal, pakaiToken: u.pakaiToken, keterangan: u.keterangan,
        jadwal: t < u.mulai ? 'akan' : t > u.selesai ? 'selesai' : 'berlangsung', status: h ? 'selesai' : 'belum'
      };
      if (h && u.tampilNilai) { item.nilai = h.nilai; item.perluKoreksi = h.perlu; }
      return item;
    });
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
    setOffset(body.data && body.data.offset); UJIAN = null; CONFIG = null;
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
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Tidak ditemukan', { status: 404 });
  },

  // Pemicu terjadwal: rawat sesi ujian (kumpul otomatis, sinkron) + cadangan GitHub opsional
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(engine(env).fetch('https://engine/tick', { method: 'POST' }).then(r => r.text()).catch(e => console.error('tick', e)));
  }
};
