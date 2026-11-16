/**
 * ============================================================================
 *  CBT SEKOLAH — Backend Cloudflare Workers
 * ============================================================================
 *  Database utama : GitHub repo PRIVAT (soal, kunci, akun, jadwal, arsip hasil)
 *  Gambar         : GitHub repo PUBLIK
 *  Data peserta   : Cloudflare D1 (cepat, tahan ribuan siswa bersamaan)
 *  Google Form    : soal bisa diimpor dari link Google Form, jawaban siswa
 *                   dikirim kembali ke form tersebut saat selesai.
 *
 *  Binding & variabel (Settings > Variables):
 *    DB            : D1 database
 *    GITHUB_TOKEN  : secret, fine-grained token (Contents: Read & write)
 *    SECRET        : secret, string acak panjang untuk tanda tangan sesi
 *    DATA_REPO     : contoh namaakun/cbt-data   (privat)
 *    MEDIA_REPO    : contoh namaakun/cbt-media  (publik)
 *    BRANCH        : opsional, default "main"
 *    MEDIA_CDN     : opsional, jsdelivr (default) | raw | pages
 *  Cron trigger    : "* * * * *" (sinkron arsip, kumpul otomatis, kirim ulang form)
 * ============================================================================
 */

const VERSI = '2.0.0';
const GRACE_MS = 2 * 60 * 1000;
const TOKEN_GURU_JAM = 12;
const TOKEN_SISWA_JAM = 8;
const MAX_JAWABAN_CHARS = 60000;
const MEM_TTL = 20000;            // cache berkas di memori isolate
const BERKAS_TTL = 6 * 3600000;   // cache berkas di D1

/* ----------------------------------------------------------------------------
 *  ENTRY
 * -------------------------------------------------------------------------- */
export default {
  async fetch(request, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (request.method === 'GET') return json({ ok: true, data: { app: 'CBT Sekolah', versi: VERSI, backend: 'cloudflare' }, serverTime: Date.now() });
    if (request.method !== 'POST') return json({ ok: false, error: 'Metode tidak didukung' }, 405);
    let req;
    try { req = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: 'Format permintaan tidak valid', code: 'ERR', serverTime: Date.now() }); }
    const c = new Ctx(env, ctx, req.token || '');
    try {
      await c.siapkan();
      const fn = ACTIONS[req.action];
      if (!fn) throw new AppError('Aksi tidak dikenal: ' + req.action);
      const data = await fn(req.data || {}, c);
      if (data instanceof RawJson) return new Response('{"ok":true,"data":' + data.s + ',"serverTime":' + Date.now() + '}', { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
      return json({ ok: true, data: data === undefined ? null : data, serverTime: Date.now() });
    } catch (err) {
      const msg = String((err && err.message) || err);
      const code = (err && err.code) || (/D1_|SQLITE_BUSY|network|timed out|Too many|exceeded/i.test(msg) ? 'BUSY' : 'ERR');
      if (!(err instanceof AppError)) console.error(req.action, msg, err && err.stack);
      return json({ ok: false, error: msg, code, serverTime: Date.now() });
    }
  },

  async scheduled(event, env, ctx) {
    const c = new Ctx(env, ctx, '');
    await c.siapkan();
    await prosesCron(c);
  }
};

/** Data yang sudah berupa teks JSON (dikirim apa adanya, hemat CPU). */
class RawJson { constructor(s) { this.s = s; } }

class AppError extends Error {
  constructor(message, code) { super(message); this.code = code || 'ERR'; }
}

/* ----------------------------------------------------------------------------
 *  KONTEKS PER PERMINTAAN
 * -------------------------------------------------------------------------- */
let SKEMA_OK = false;
const MEM = new Map();

class Ctx {
  constructor(env, ctx, token) {
    this.env = env; this.ctx = ctx; this.token = token;
    this.db = env.DB;
    this.memo = {};
  }
  get dataRepo() { if (!this.env.DATA_REPO) throw new AppError('DATA_REPO belum diatur'); return this.env.DATA_REPO; }
  get mediaRepo() { if (!this.env.MEDIA_REPO) throw new AppError('MEDIA_REPO belum diatur'); return this.env.MEDIA_REPO; }
  get branch() { return this.env.BRANCH || 'main'; }
  async siapkan() {
    if (SKEMA_OK) return;
    await this.db.batch(SKEMA.map(s => this.db.prepare(s)));
    SKEMA_OK = true;
  }
  waitUntil(p) { if (this.ctx && this.ctx.waitUntil) this.ctx.waitUntil(p); }
}

const SKEMA = [
  `CREATE TABLE IF NOT EXISTS peserta (
    key TEXT PRIMARY KEY, ujian_id TEXT NOT NULL, nis TEXT NOT NULL, nama TEXT, kelas TEXT,
    status TEXT NOT NULL DEFAULT 'belum', mulai INTEGER DEFAULT 0, deadline INTEGER DEFAULT 0, selesai INTEGER DEFAULT 0,
    pelanggaran INTEGER DEFAULT 0, jawaban TEXT, hasil TEXT, manual TEXT, ver INTEGER DEFAULT 0,
    last_seen INTEGER DEFAULT 0, percobaan INTEGER DEFAULT 0, catatan TEXT DEFAULT '', perangkat TEXT DEFAULT '',
    terjawab INTEGER DEFAULT 0, ragu INTEGER DEFAULT 0, form_status TEXT DEFAULT '', form_info TEXT DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS idx_peserta_ujian ON peserta(ujian_id)`,
  `CREATE TABLE IF NOT EXISTS aktif (key TEXT PRIMARY KEY, deadline INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_aktif_deadline ON aktif(deadline)`,
  `CREATE TABLE IF NOT EXISTS antrian (key TEXT PRIMARY KEY, ver INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kirim (key TEXT PRIMARY KEY, coba INTEGER DEFAULT 0, berikut INTEGER DEFAULT 0, galat TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS kunci (nama TEXT PRIMARY KEY, pemilik TEXT, sampai INTEGER)`,
  `CREATE TABLE IF NOT EXISTS berkas (path TEXT PRIMARY KEY, isi TEXT, ada INTEGER DEFAULT 1, waktu INTEGER)`,
  `CREATE TABLE IF NOT EXISTS gagal (k TEXT PRIMARY KEY, n INTEGER, sampai INTEGER)`
];

/* ----------------------------------------------------------------------------
 *  UTIL
 * -------------------------------------------------------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = p => (p || '') + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const str = (v, max) => { v = (v === null || v === undefined) ? '' : String(v); return max ? v.slice(0, max) : v; };
const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
const bool = v => v === true || v === 'true' || v === 1 || v === '1';
const parse = (s, d) => { if (!s) return d; try { return JSON.parse(s); } catch (e) { return d; } };
const round2 = n => Math.round(n * 100) / 100;
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64url(bytes) {
  let s = ''; const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
}
function b64(bytes) { return b64url(bytes).replace(/-/g, '+').replace(/_/g, '/'); }
function b64urlDecodeStr(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(a);
}
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hashPw(pw, salt) { return sha256Hex(salt + '|' + pw); }        // sama dengan versi Apps Script
async function makeCred(pw) { const salt = uid(''); return { salt, hash: await hashPw(String(pw), salt) }; }
async function cekPw(u, pw) { return !!(u && u.salt && u.hash === await hashPw(String(pw), u.salt)); }
const clone = o => JSON.parse(JSON.stringify(o));

/* ----------------------------------------------------------------------------
 *  GITHUB
 * -------------------------------------------------------------------------- */
async function ghFetch(c, method, path, body, accept) {
  if (!c.env.GITHUB_TOKEN) throw new AppError('GITHUB_TOKEN belum diatur');
  const base = c.env.GITHUB_API || 'https://api.github.com';
  const opt = { method: method.toUpperCase(), headers: { Authorization: 'Bearer ' + c.env.GITHUB_TOKEN, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cbt-sekolah-worker' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(base + path, opt);
  return { code: res.status, text: await res.text() };
}
function ghKode(r) {
  if (r.code === 409 || r.code === 422) return 'CONFLICT';
  if (r.code >= 500 || r.code === 429 || (r.code === 403 && /rate limit|abuse/i.test(r.text))) return 'BUSY';
  return 'ERR';
}
async function ghJson(c, method, path, body) {
  const r = await ghFetch(c, method, path, body);
  if (r.code < 200 || r.code >= 300) throw new AppError('GitHub ' + r.code + ' (' + method.toUpperCase() + ' ' + path.split('?')[0] + '): ' + r.text.slice(0, 200), ghKode(r));
  return r.text ? JSON.parse(r.text) : {};
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

/** Baca file mentah repo data. null bila tidak ada. Cache: memori isolate -> D1 -> GitHub */
async function bacaBerkas(c, path, fresh) {
  const now = Date.now();
  if (!fresh) {
    const m = MEM.get(path);
    if (m && now - m.at < MEM_TTL) return m.t;
    const row = await c.db.prepare('SELECT isi, ada, waktu FROM berkas WHERE path=?1').bind(path).first();
    if (row && now - row.waktu < (row.ada ? BERKAS_TTL : 300000)) {
      const t = row.ada ? row.isi : null;
      setMem(path, t);
      return t;
    }
  }
  const r = await ghFetch(c, 'get', '/repos/' + c.dataRepo + '/contents/' + encPath(path) + '?ref=' + encodeURIComponent(c.branch), undefined, 'application/vnd.github.raw+json');
  let t;
  if (r.code === 404) t = null;
  else if (r.code !== 200) throw new AppError('Gagal membaca ' + path + ' dari GitHub (' + r.code + ')', ghKode(r));
  else t = r.text;
  await simpanCache(c, path, t);
  return t;
}
function setMem(path, t) {
  const old = MEM.get(path);
  if (old && old.t === t) { old.at = Date.now(); return; }
  MEM.set(path, { t, at: Date.now(), o: undefined, map: undefined });
}
async function simpanCache(c, path, t) {
  setMem(path, t);
  try {
    await c.db.prepare('INSERT INTO berkas(path,isi,ada,waktu) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET isi=excluded.isi, ada=excluded.ada, waktu=excluded.waktu')
      .bind(path, t === null ? null : t, t === null ? 0 : 1, Date.now()).run();
  } catch (e) { console.warn('cache berkas gagal', path, e.message); }
}
/** Baca JSON (objek hasil parse dibagi bersama — jangan dimutasi, pakai clone()). */
async function bacaJson(c, path, def, fresh) {
  const t = await bacaBerkas(c, path, fresh);
  if (t === null) return def;
  const m = MEM.get(path);
  if (m && m.t === t && m.o !== undefined) return m.o;
  let o;
  try { o = JSON.parse(t); } catch (e) { throw new AppError('File ' + path + ' di GitHub rusak (bukan JSON valid)'); }
  if (m && m.t === t) m.o = o;
  return o;
}

/** Commit banyak file sekaligus (Git Data API). files: {path: string|null} */
async function ghCommit(c, repo, files, message) {
  const paths = Object.keys(files);
  if (!paths.length) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await ghJson(c, 'get', '/repos/' + repo + '/git/ref/heads/' + c.branch);
    const head = await ghJson(c, 'get', '/repos/' + repo + '/git/commits/' + ref.object.sha);
    const tree = paths.map(p => files[p] === null ? { path: p, mode: '100644', type: 'blob', sha: null } : { path: p, mode: '100644', type: 'blob', content: files[p] });
    const t = await ghJson(c, 'post', '/repos/' + repo + '/git/trees', { base_tree: head.tree.sha, tree });
    const cm = await ghJson(c, 'post', '/repos/' + repo + '/git/commits', { message, tree: t.sha, parents: [ref.object.sha] });
    const u = await ghFetch(c, 'patch', '/repos/' + repo + '/git/refs/heads/' + c.branch, { sha: cm.sha, force: false });
    if (u.code === 200) {
      if (repo === c.dataRepo) for (const p of paths) if (!p.startsWith('hasil/')) await simpanCache(c, p, files[p]);
      return cm.sha;
    }
    if (u.code === 409 || u.code === 422) { await sleep(250 + Math.random() * 750); continue; }
    throw new AppError('Gagal menyimpan ke GitHub (' + u.code + ')', ghKode(u));
  }
  throw new AppError('GitHub sedang sibuk, coba simpan lagi', 'BUSY');
}
async function tulisJson(c, obj, message) {
  const f = {};
  for (const p of Object.keys(obj)) f[p] = obj[p] === null ? null : JSON.stringify(obj[p], null, 1);
  return ghCommit(c, c.dataRepo, f, message);
}

/** Mutex lintas isolate memakai D1 (untuk read-modify-write file bersama di GitHub). */
async function denganKunci(c, nama, fn, tunggu) {
  const id = uid('k'), batas = Date.now() + (tunggu || 20000);
  for (;;) {
    const now = Date.now();
    const r = await c.db.prepare('INSERT INTO kunci(nama,pemilik,sampai) VALUES(?1,?2,?3) ON CONFLICT(nama) DO UPDATE SET pemilik=excluded.pemilik, sampai=excluded.sampai WHERE kunci.sampai < ?4 RETURNING pemilik')
      .bind(nama, id, now + 30000, now).first();
    if (r && r.pemilik === id) break;
    if (Date.now() > batas) throw new AppError('Server sedang sibuk, mencoba lagi…', 'BUSY');
    await sleep(150 + Math.random() * 350);
  }
  try { return await fn(); }
  finally { await c.db.prepare('DELETE FROM kunci WHERE nama=?1 AND pemilik=?2').bind(nama, id).run(); }
}

/* ----------------------------------------------------------------------------
 *  DATA
 * -------------------------------------------------------------------------- */
const P = {
  config: 'config.json', guru: 'users/guru.json', siswa: 'users/siswa.json',
  bankIndex: 'bank/_index.json', bank: id => 'bank/' + id + '.json',
  ujianIndex: 'ujian/_index.json',
  hasil: (uj, kelas, nis) => 'hasil/' + uj + '/' + (String(kelas || 'tanpa-kelas').replace(/[^\w.-]+/g, '_') || 'tanpa-kelas') + '/' + String(nis).replace(/[^\w.-]+/g, '_') + '.json'
};
function safeId(id) { id = str(id); if (!/^[a-zA-Z0-9_-]{3,40}$/.test(id)) throw new AppError('ID tidak valid'); return id; }
const getConfig = async (c, fresh) => (await bacaJson(c, P.config, null, fresh)) || { namaSekolah: 'Sekolah', tahunAjaran: '', semester: '', tingkat: ['X', 'XI', 'XII'], kelas: [], mapel: [] };
const getGuruList = (c, fresh) => bacaJson(c, P.guru, [], fresh);
const getSiswaList = (c, fresh) => bacaJson(c, P.siswa, [], fresh);
const getBankIndex = (c, fresh) => bacaJson(c, P.bankIndex, [], fresh);
const getUjianList = (c, fresh) => bacaJson(c, P.ujianIndex, [], fresh);
const getBank = (c, id, fresh) => bacaJson(c, P.bank(safeId(id)), null, fresh);
async function getUjian(c, id) {
  const u = (await getUjianList(c)).find(x => x.id === id);
  if (!u) throw new AppError('Ujian tidak ditemukan');
  return u;
}
async function siswaMap(c) {
  const list = await getSiswaList(c);
  const m = MEM.get(P.siswa);
  if (m && m.o === list && m.map) return m.map;
  const map = new Map(list.map(s => [String(s.nis), s]));
  if (m && m.o === list) m.map = map;
  return map;
}

/* ----------------------------------------------------------------------------
 *  AUTENTIKASI
 * -------------------------------------------------------------------------- */
let HMAC_KEY = null, HMAC_SECRET = null;
async function hmacKey(c) {
  if (!c.env.SECRET) throw new AppError('SECRET belum diatur');
  if (!HMAC_KEY || HMAC_SECRET !== c.env.SECRET) {
    HMAC_KEY = await crypto.subtle.importKey('raw', enc.encode(c.env.SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    HMAC_SECRET = c.env.SECRET;
  }
  return HMAC_KEY;
}
async function signToken(c, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(c), enc.encode(body)));
  return body + '.' + sig;
}
async function verifyToken(c) {
  const bad = new AppError('Sesi berakhir, silakan masuk lagi', 'AUTH');
  const tok = c.token;
  if (!tok || tok.indexOf('.') < 0) throw bad;
  const [body, sig] = tok.split('.');
  const expect = b64url(await crypto.subtle.sign('HMAC', await hmacKey(c), enc.encode(body)));
  if (sig !== expect) throw bad;
  const p = parse(b64urlDecodeStr(body), null);
  if (!p || !p.exp || p.exp < Date.now()) throw bad;
  return p;
}
async function reqGuru(c) { const p = await verifyToken(c); if (p.r !== 'guru' && p.r !== 'admin') throw new AppError('Akses khusus guru', 'AUTH'); return p; }
async function reqAdmin(c) { const p = await reqGuru(c); if (p.r !== 'admin') throw new AppError('Akses khusus admin'); return p; }
async function reqSiswa(c) { const p = await verifyToken(c); if (p.r !== 'siswa') throw new AppError('Akses khusus siswa', 'AUTH'); return p; }
async function cekPercobaan(c, k) {
  const r = await c.db.prepare('SELECT n, sampai FROM gagal WHERE k=?1').bind(k).first();
  if (r && r.sampai > Date.now() && r.n >= 8) throw new AppError('Terlalu banyak percobaan masuk. Tunggu 10 menit lalu coba lagi.');
}
async function catatGagal(c, k) {
  const now = Date.now();
  await c.db.prepare('INSERT INTO gagal(k,n,sampai) VALUES(?1,1,?2) ON CONFLICT(k) DO UPDATE SET n=CASE WHEN gagal.sampai < ?3 THEN 1 ELSE gagal.n+1 END, sampai=?2').bind(k, now + 600000, now).run();
}

/* ----------------------------------------------------------------------------
 *  API: UMUM
 * -------------------------------------------------------------------------- */
async function apiPing(d, c) {
  const k = await getConfig(c);
  return { app: 'CBT Sekolah', versi: VERSI, backend: 'cloudflare', namaSekolah: k.namaSekolah, logo: k.logo || '', tahunAjaran: k.tahunAjaran, semester: k.semester };
}
async function apiLoginGuru(d, c) {
  const username = str(d.username).trim().toLowerCase();
  await cekPercobaan(c, 'g:' + username);
  const u = (await getGuruList(c)).find(x => x.username === username);
  if (!u || !(await cekPw(u, d.password))) { await catatGagal(c, 'g:' + username); throw new AppError('Nama pengguna atau kata sandi salah'); }
  if (u.aktif === false) throw new AppError('Akun dinonaktifkan. Hubungi admin.');
  const role = u.role === 'admin' ? 'admin' : 'guru';
  const token = await signToken(c, { r: role, id: u.id, n: u.nama, exp: Date.now() + TOKEN_GURU_JAM * 3600000 });
  return { token, user: { id: u.id, username: u.username, nama: u.nama, role, mapel: u.mapel || [] }, config: await getConfig(c) };
}
async function apiLoginSiswa(d, c) {
  const nis = str(d.nis).trim();
  await cekPercobaan(c, 's:' + nis);
  const s = (await siswaMap(c)).get(nis);
  if (!s || !(await cekPw(s, d.password))) { await catatGagal(c, 's:' + nis); throw new AppError('NIS atau kata sandi salah'); }
  const token = await signToken(c, { r: 'siswa', id: String(s.nis), n: s.nama, k: s.kelas, exp: Date.now() + TOKEN_SISWA_JAM * 3600000 });
  const k = await getConfig(c);
  return { token, user: { nis: String(s.nis), nama: s.nama, kelas: s.kelas }, sekolah: { namaSekolah: k.namaSekolah, logo: k.logo || '' } };
}
async function apiGantiPassword(d, c) {
  const p = await verifyToken(c);
  const baru = str(d.baru);
  if (baru.length < 6) throw new AppError('Kata sandi baru minimal 6 karakter');
  return denganKunci(c, 'github', async () => {
    if (p.r === 'siswa') {
      const list = clone(await getSiswaList(c, true));
      const s = list.find(x => String(x.nis) === p.id);
      if (!s || !(await cekPw(s, d.lama))) throw new AppError('Kata sandi lama salah');
      Object.assign(s, await makeCred(baru));
      await tulisJson(c, { [P.siswa]: list }, 'Siswa ' + p.id + ' ganti kata sandi');
    } else {
      const g = clone(await getGuruList(c, true));
      const u = g.find(x => x.id === p.id);
      if (!u || !(await cekPw(u, d.lama))) throw new AppError('Kata sandi lama salah');
      Object.assign(u, await makeCred(baru));
      await tulisJson(c, { [P.guru]: g }, 'Guru ' + u.username + ' ganti kata sandi');
    }
    return true;
  });
}
async function apiGetConfig(d, c) { await verifyToken(c); return getConfig(c); }
async function apiSaveConfig(d, c) {
  const me = await reqAdmin(c);
  const cfg = {
    namaSekolah: str(d.namaSekolah, 120).trim() || 'Sekolah', tahunAjaran: str(d.tahunAjaran, 20), semester: str(d.semester, 20), logo: str(d.logo, 500),
    tingkat: (d.tingkat || []).map(x => str(x, 20).trim()).filter(Boolean),
    kelas: (d.kelas || []).map(k => ({ nama: str(k.nama, 40).trim(), tingkat: str(k.tingkat, 20).trim() })).filter(k => k.nama),
    mapel: (d.mapel || []).map(x => str(x, 80).trim()).filter(Boolean)
  };
  await denganKunci(c, 'github', () => tulisJson(c, { [P.config]: cfg }, 'Pengaturan diubah oleh ' + me.n));
  return cfg;
}

/* ----------------------------------------------------------------------------
 *  DASHBOARD, BANK SOAL
 * -------------------------------------------------------------------------- */
async function apiDashboard(d, c) {
  const me = await reqGuru(c);
  const now = Date.now();
  let banks = await getBankIndex(c), ujian = await getUjianList(c);
  if (me.r !== 'admin') { banks = banks.filter(b => b.guruId === me.id); ujian = ujian.filter(u => u.guruId === me.id); }
  const res = {
    jumlahBank: banks.length,
    jumlahSoal: banks.reduce((a, b) => a + (b.jumlahSoal || 0), 0),
    jumlahUjian: ujian.length,
    berlangsung: ujian.filter(u => u.aktif && u.mulai <= now && u.selesai >= now).length,
    mendatang: await Promise.all(ujian.filter(u => u.selesai >= now && u.mulai <= now + 86400000).sort((a, b) => a.mulai - b.mulai).map(u => ringkasUjian(c, u))),
    bankTerbaru: banks.slice().sort((a, b) => (b.diubah || 0) - (a.diubah || 0)).slice(0, 5)
  };
  if (me.r === 'admin') { res.jumlahSiswa = (await getSiswaList(c)).length; res.jumlahGuru = (await getGuruList(c)).length; }
  return res;
}

const TIPE_SOAL = ['pg', 'pgk', 'bs', 'jodoh', 'isian', 'urut', 'uraian'];
async function apiListBank(d, c) {
  const me = await reqGuru(c);
  const list = await getBankIndex(c);
  return me.r === 'admin' ? list : list.filter(b => b.guruId === me.id);
}
function bolehBank(me, bank) { if (me.r === 'admin' || bank.guruId === me.id) return true; throw new AppError('Anda tidak memiliki akses ke bank soal ini'); }
async function apiGetBank(d, c) {
  const me = await reqGuru(c);
  const b = await getBank(c, d.id);
  if (!b) throw new AppError('Bank soal tidak ditemukan');
  bolehBank(me, b);
  const m = MEM.get(P.bank(safeId(d.id)));
  return m && m.o === b ? new RawJson(m.t) : b;
}
const okId = (v, re) => (re || /^[a-zA-Z0-9_-]{2,40}$/).test(v || '');
function bersihkanSoal(s) {
  const tipe = TIPE_SOAL.includes(s.tipe) ? s.tipe : 'pg';
  const o = {
    id: okId(s.id, /^[a-zA-Z0-9_-]{3,40}$/) ? s.id : uid('s'), tipe,
    teks: str(s.teks, 20000), stimulus: str(s.stimulus, 30000),
    gambar: (s.gambar || []).map(g => str(g, 500)).filter(Boolean).slice(0, 6),
    bobot: Math.max(0, num(s.bobot, 1)), pembahasan: str(s.pembahasan, 10000)
  };
  const opsiList = arr => (arr || []).map(op => {
    const x = { id: okId(op.id) ? op.id : uid('o'), teks: str(op.teks, 5000), gambar: str(op.gambar, 500) };
    if (op.gv !== undefined) x.gv = str(op.gv, 2000);
    return x;
  }).slice(0, 40);
  if (['pg', 'pgk', 'urut'].includes(tipe)) o.opsi = opsiList(s.opsi);
  if (tipe === 'pg') o.kunci = str(s.kunci);
  if (tipe === 'pgk') o.kunci = (s.kunci || []).map(String);
  if (tipe === 'bs') {
    o.label = (s.label && s.label.length === 2) ? [str(s.label[0], 30), str(s.label[1], 30)] : ['Benar', 'Salah'];
    o.pernyataan = (s.pernyataan || []).map(p => ({ id: okId(p.id) ? p.id : uid('p'), teks: str(p.teks, 3000), benar: !!p.benar })).slice(0, 20);
  }
  if (tipe === 'jodoh') o.pasangan = (s.pasangan || []).map(p => ({ idKiri: okId(p.idKiri) ? p.idKiri : uid('l'), idKanan: okId(p.idKanan) ? p.idKanan : uid('r'), kiri: str(p.kiri, 2000), kanan: str(p.kanan, 2000) })).slice(0, 20);
  if (tipe === 'isian') o.jawaban = (s.jawaban || []).map(x => str(x, 300).trim()).filter(Boolean).slice(0, 20);
  if (tipe === 'uraian') o.rubrik = str(s.rubrik, 10000);
  if (['pgk', 'bs', 'jodoh', 'urut'].includes(tipe)) o.penilaian = s.penilaian === 'mutlak' ? 'mutlak' : 'sebagian';
  if (s.gform && typeof s.gform === 'object') o.gform = { entry: str(s.gform.entry, 30), jenis: str(s.gform.jenis, 20), wajib: !!s.gform.wajib };
  return o;
}
async function simpanBankKeGitHub(c, me, input, isBaru) {
  const judul = str(input.judul, 150).trim();
  if (!judul) throw new AppError('Judul bank soal wajib diisi');
  const id = isBaru ? uid('b') : safeId(input.id);
  const soal = (input.soal || []).slice(0, 300).map(bersihkanSoal);
  const seen = {};
  soal.forEach(s => { if (seen[s.id]) s.id = uid('s'); seen[s.id] = 1; });
  return denganKunci(c, 'github', async () => {
    const lama = isBaru ? null : await getBank(c, id, true);
    if (!isBaru && !lama) throw new AppError('Bank soal tidak ditemukan');
    if (lama) {
      bolehBank(me, lama);
      const gm = new Map((lama.soal || []).filter(x => x.gform).map(x => [x.id, x.gform]));
      if (gm.size) soal.forEach(x => { if (gm.has(x.id)) x.gform = gm.get(x.id); });
    }
    const now = Date.now();
    const bank = {
      id, judul, mapel: str(input.mapel, 80), tingkat: str(input.tingkat, 20), deskripsi: str(input.deskripsi, 1000),
      guruId: lama ? lama.guruId : me.id, guruNama: lama ? lama.guruNama : me.n,
      dibuat: lama ? lama.dibuat : now, diubah: now, soal
    };
    let gf = isBaru ? (input.gform || null) : (lama.gform || null);
    if (!isBaru && input.gform === false) gf = null;           // putuskan tautan Google Form
    else if (gf && !isBaru && input.gform && Array.isArray(input.gform.identitas)) {
      // hanya kolom identitas yang boleh diubah dari aplikasi guru
      const sahEntry = new Set([...(lama.gform.identitas || []).map(x => String(x.entry)), ...(lama.soal || []).filter(x => x.gform).map(x => String(x.gform.entry))]);
      gf = { ...gf, identitas: input.gform.identitas.filter(x => sahEntry.has(String(x.entry)) && /^(nama|nis|kelas|namakelas|namanis|)$/.test(x.isi)).map(x => ({ entry: String(x.entry), isi: x.isi, judul: str(x.judul, 300) })).slice(0, 10) };
    }
    if (gf) bank.gform = gf; else soal.forEach(x => { delete x.gform; });
    const idx = (await getBankIndex(c, true)).filter(b => b.id !== id);
    idx.push({ id, judul, mapel: bank.mapel, tingkat: bank.tingkat, guruId: bank.guruId, guruNama: bank.guruNama, jumlahSoal: soal.length, totalBobot: soal.reduce((a, s) => a + s.bobot, 0), dibuat: bank.dibuat, diubah: now, gform: !!bank.gform });
    await tulisJson(c, { [P.bank(id)]: bank, [P.bankIndex]: idx }, (isBaru ? 'Bank baru: ' : 'Ubah bank: ') + judul + ' (' + me.n + ')');
    const dipakai = (await getUjianList(c)).filter(u => u.bankId === id && u.selesai >= now).map(u => u.nama);
    return { bank, dipakai };
  });
}
async function apiSaveBank(d, c) {
  const me = await reqGuru(c);
  const input = d.bank || {};
  if (!input.id) delete input.gform; // bank baru dari klien tidak boleh menyetel tautan form sendiri
  for (const s of input.soal || []) if (s && s.gform) delete s.gform; // tautan per soal hanya dari impor; dipulihkan dari versi tersimpan
  return simpanBankKeGitHub(c, me, input, !input.id);
}
async function apiDeleteBank(d, c) {
  const me = await reqGuru(c);
  const id = safeId(d.id);
  return denganKunci(c, 'github', async () => {
    const b = await getBank(c, id, true);
    if (!b) throw new AppError('Bank soal tidak ditemukan');
    bolehBank(me, b);
    const dipakai = (await getUjianList(c, true)).filter(u => u.bankId === id);
    if (dipakai.length) throw new AppError('Bank soal dipakai di jadwal: ' + dipakai.map(u => u.nama).join(', ') + '. Hapus jadwalnya dulu.');
    const idx = (await getBankIndex(c, true)).filter(x => x.id !== id);
    await tulisJson(c, { [P.bank(id)]: null, [P.bankIndex]: idx }, 'Hapus bank: ' + b.judul + ' (' + me.n + ')');
    return true;
  });
}

function urlMedia(c, repo, sha, path) {
  const mode = c.env.MEDIA_CDN || 'jsdelivr', parts = repo.split('/');
  if (mode === 'raw') return 'https://raw.githubusercontent.com/' + repo + '/' + sha + '/' + path;
  if (mode === 'pages') return 'https://' + parts[0].toLowerCase() + '.github.io/' + parts[1] + '/' + path;
  return 'https://cdn.jsdelivr.net/gh/' + repo + '@' + sha + '/' + path;
}
async function unggahMedia(c, base64, ext, oleh) {
  const now = new Date();
  const path = 'img/' + now.getUTCFullYear() + '/' + String(now.getUTCMonth() + 1).padStart(2, '0') + '/' + uid('') + '.' + ext;
  let last;
  for (let i = 0; i < 4; i++) {
    last = await ghFetch(c, 'put', '/repos/' + c.mediaRepo + '/contents/' + encPath(path), { message: 'Gambar soal (' + oleh + ')', content: base64, branch: c.branch });
    if (last.code === 200 || last.code === 201) return { url: urlMedia(c, c.mediaRepo, JSON.parse(last.text).commit.sha, path), path };
    if (last.code !== 409 && last.code !== 422) break;
    await sleep(300 + Math.random() * 700);
  }
  throw new AppError('Gagal mengunggah gambar ke GitHub (' + last.code + ')', ghKode(last));
}
async function apiUploadGambar(d, c) {
  const me = await reqGuru(c);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[str(d.tipe)];
  if (!ext) throw new AppError('Format gambar tidak didukung (gunakan JPG, PNG, WEBP, GIF)');
  const data = str(d.data).replace(/^data:[^,]+,/, '');
  if (data.length > 2800000) throw new AppError('Ukuran gambar maksimal 2 MB');
  return unggahMedia(c, data, ext, me.n);
}

/* ----------------------------------------------------------------------------
 *  JADWAL UJIAN
 * -------------------------------------------------------------------------- */
function statusJadwal(u, now) { if (!u.aktif) return 'nonaktif'; if (now < u.mulai) return 'akan'; if (now > u.selesai) return 'selesai'; return 'berlangsung'; }
async function ringkasUjian(c, u) {
  const idx = await getBankIndex(c), b = idx.find(x => x.id === u.bankId);
  return {
    id: u.id, nama: u.nama, bankId: u.bankId, bankJudul: u.bankJudul, mapel: u.mapel, tingkat: u.tingkat, guruId: u.guruId, guruNama: u.guruNama,
    kelas: u.kelas, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi, acakSoal: u.acakSoal, acakOpsi: u.acakOpsi, tampilNilai: u.tampilNilai,
    pakaiToken: u.pakaiToken, token: u.token, maxPelanggaran: u.maxPelanggaran, aktif: u.aktif, keterangan: u.keterangan,
    jumlahSoal: b ? b.jumlahSoal : u.jumlahSoal, gform: !!(b && b.gform), status: statusJadwal(u, Date.now()), diubah: u.diubah
  };
}
async function apiListUjian(d, c) {
  const me = await reqGuru(c);
  let list = await getUjianList(c);
  if (me.r !== 'admin') list = list.filter(u => u.guruId === me.id);
  return (await Promise.all(list.map(u => ringkasUjian(c, u)))).sort((a, b) => b.mulai - a.mulai);
}
function buatToken() { const h = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(6)); for (let i = 0; i < 6; i++) s += h[r[i] % h.length]; return s; }
async function apiSaveUjian(d, c) {
  const me = await reqAdmin(c);
  const nama = str(d.nama, 150).trim();
  if (!nama) throw new AppError('Nama ujian wajib diisi');
  const mulai = num(d.mulai, 0), selesai = num(d.selesai, 0), durasi = Math.round(num(d.durasi, 0));
  if (!mulai || !selesai || selesai <= mulai) throw new AppError('Waktu selesai harus setelah waktu mulai');
  if (durasi < 1 || durasi > 600) throw new AppError('Durasi harus 1–600 menit');
  const kelas = (d.kelas || []).map(k => str(k, 40)).filter(Boolean);
  if (!kelas.length) throw new AppError('Pilih minimal satu kelas peserta');
  const bank = await getBank(c, d.bankId, true);
  if (!bank) throw new AppError('Bank soal tidak ditemukan');
  if (!bank.soal.length) throw new AppError('Bank soal masih kosong');
  const saved = await denganKunci(c, 'github', async () => {
    let list = clone(await getUjianList(c, true));
    const lama = d.id ? list.find(u => u.id === d.id) : null;
    if (d.id && !lama) throw new AppError('Jadwal tidak ditemukan');
    const now = Date.now();
    const u = {
      id: lama ? lama.id : uid('u'), nama, bankId: bank.id, bankJudul: bank.judul, mapel: bank.mapel, tingkat: str(d.tingkat, 20) || bank.tingkat,
      guruId: bank.guruId, guruNama: bank.guruNama, jumlahSoal: bank.soal.length, kelas, mulai, selesai, durasi,
      acakSoal: bool(d.acakSoal), acakOpsi: bool(d.acakOpsi), tampilNilai: bool(d.tampilNilai), pakaiToken: bool(d.pakaiToken),
      token: bool(d.pakaiToken) ? ((lama && lama.token) || buatToken()) : '',
      maxPelanggaran: Math.max(0, Math.round(num(d.maxPelanggaran, 0))), aktif: d.aktif === undefined ? true : bool(d.aktif),
      keterangan: str(d.keterangan, 1000), dibuat: lama ? lama.dibuat : now, diubah: now, oleh: me.n
    };
    list = list.filter(x => x.id !== u.id); list.push(u);
    await tulisJson(c, { [P.ujianIndex]: list }, (lama ? 'Ubah jadwal: ' : 'Jadwal baru: ') + nama + ' (' + me.n + ')');
    return u;
  });
  return ringkasUjian(c, saved);
}
async function apiDeleteUjian(d, c) {
  const me = await reqAdmin(c);
  return denganKunci(c, 'github', async () => {
    const list = await getUjianList(c, true);
    const u = list.find(x => x.id === d.id);
    if (!u) throw new AppError('Jadwal tidak ditemukan');
    const n = await c.db.prepare("SELECT COUNT(*) AS n FROM peserta WHERE ujian_id=?1 AND status IN ('mengerjakan','selesai')").bind(u.id).first('n');
    if (n && !d.paksa) throw new AppError('Sudah ada ' + n + ' peserta yang mengerjakan. Hasil yang sudah tersimpan tidak ikut terhapus.', 'ADA_PESERTA');
    await tulisJson(c, { [P.ujianIndex]: list.filter(x => x.id !== u.id) }, 'Hapus jadwal: ' + u.nama + ' (' + me.n + ')');
    return true;
  });
}
async function apiGantiTokenUjian(d, c) {
  const me = await reqGuru(c);
  return denganKunci(c, 'github', async () => {
    const list = clone(await getUjianList(c, true));
    const u = list.find(x => x.id === d.id);
    if (!u) throw new AppError('Jadwal tidak ditemukan');
    if (me.r !== 'admin' && u.guruId !== me.id) throw new AppError('Tidak berhak mengganti token');
    u.token = buatToken(); u.pakaiToken = true; u.diubah = Date.now();
    await tulisJson(c, { [P.ujianIndex]: list }, 'Token baru: ' + u.nama);
    return u.token;
  });
}

/* ----------------------------------------------------------------------------
 *  PESERTA (D1)
 * -------------------------------------------------------------------------- */
function rowObj(r) {
  if (!r) return null;
  return {
    key: r.key, ujianId: r.ujian_id, nis: r.nis, nama: r.nama, kelas: r.kelas, status: r.status || 'belum',
    mulai: r.mulai || 0, deadline: r.deadline || 0, selesai: r.selesai || 0, pelanggaran: r.pelanggaran || 0,
    jawaban: parse(r.jawaban, { j: {}, r: [] }), hasil: parse(r.hasil, null), manual: parse(r.manual, {}), ver: r.ver || 0,
    lastSeen: r.last_seen || 0, percobaan: r.percobaan || 0, catatan: r.catatan || '', perangkat: r.perangkat || '',
    terjawab: r.terjawab || 0, ragu: r.ragu || 0, formStatus: r.form_status || '', formInfo: r.form_info || ''
  };
}
const ambilBaris = async (c, uj, nis) => rowObj(await c.db.prepare('SELECT * FROM peserta WHERE key=?1').bind(uj + '|' + nis).first());
function hitungTerisi(jw) {
  let n = 0; const j = (jw && jw.j) || {};
  for (const k in j) { const v = j[k]; if (v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) n++; }
  return n;
}

/* ---------- acak deterministik ---------- */
function seedOf(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function rng(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function acak(arr, seed) { const r = rng(seedOf(seed)), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function soalUntukSiswa(u, bank, nis, percobaan) {
  const base = u.id + '|' + nis + '|' + percobaan;
  const list = u.acakSoal ? acak(bank.soal, base) : bank.soal.slice();
  return list.map(s => {
    const o = { id: s.id, tipe: s.tipe, teks: s.teks, stimulus: s.stimulus || '', gambar: s.gambar || [], bobot: s.bobot };
    if (s.gform && s.gform.wajib) o.wajib = true;
    const bersih = op => ({ id: op.id, teks: op.teks, gambar: op.gambar || '' });
    if (s.tipe === 'pg' || s.tipe === 'pgk') o.opsi = (u.acakOpsi && !(s.gform && /skala|grid/.test(s.gform.jenis)) ? acak(s.opsi || [], base + '|' + s.id) : (s.opsi || []).slice()).map(bersih);
    if (s.tipe === 'urut') o.opsi = acak(s.opsi || [], base + '|u|' + s.id).map(bersih);
    if (s.tipe === 'bs') { o.label = s.label || ['Benar', 'Salah']; o.pernyataan = (s.pernyataan || []).map(p => ({ id: p.id, teks: p.teks })); }
    if (s.tipe === 'jodoh') {
      o.kiri = (s.pasangan || []).filter(p => p.kiri).map(p => ({ id: p.idKiri, teks: p.kiri }));
      o.kanan = acak((s.pasangan || []).filter(p => p.kanan), base + '|j|' + s.id).map(p => ({ id: p.idKanan, teks: p.kanan }));
    }
    return o;
  });
}

/* ---------- penilaian ---------- */
function normIsian(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').replace(/,/g, '.').trim(); }
function tanpaKunci(s) {
  if (s.tipe === 'pg') return !s.kunci;
  if (s.tipe === 'pgk') return !(s.kunci || []).length;
  if (s.tipe === 'isian') return !(s.jawaban || []).some(Boolean);
  return false;
}
function nilaiSoal(s, j, bankGform) {
  const b = num(s.bobot, 1), mutlak = s.penilaian === 'mutlak';
  const kosong = j === undefined || j === null || j === '' || (Array.isArray(j) && !j.length) || (typeof j === 'object' && !Array.isArray(j) && !Object.keys(j).length);
  if ((bankGform && tanpaKunci(s)) || (s.tipe === 'uraian' && b === 0)) return { skor: null, maks: 0, manual: false, tidakDinilai: true };
  let rasio = 0;
  switch (s.tipe) {
    case 'pg': rasio = (!kosong && j === s.kunci) ? 1 : 0; break;
    case 'pgk': { const k = s.kunci || [], jj = Array.isArray(j) ? j : []; if (!k.length) break; const benar = jj.filter(x => k.includes(x)).length, salah = jj.length - benar; rasio = mutlak ? (benar === k.length && !salah ? 1 : 0) : Math.max(0, benar - salah) / k.length; break; }
    case 'bs': { const ps = s.pernyataan || [], jb = (j && typeof j === 'object') ? j : {}; const ok = ps.filter(p => jb[p.id] === p.benar).length; rasio = !ps.length ? 0 : (mutlak ? (ok === ps.length ? 1 : 0) : ok / ps.length); break; }
    case 'jodoh': { const pr = (s.pasangan || []).filter(p => p.kiri && p.kanan), jm = (j && typeof j === 'object') ? j : {}; const ok = pr.filter(p => jm[p.idKiri] === p.idKanan).length; rasio = !pr.length ? 0 : (mutlak ? (ok === pr.length ? 1 : 0) : ok / pr.length); break; }
    case 'isian': rasio = (!kosong && (s.jawaban || []).map(normIsian).includes(normIsian(j))) ? 1 : 0; break;
    case 'urut': { const ids = (s.opsi || []).map(o => o.id), ju = Array.isArray(j) ? j : []; if (!ju.length) break; const ok = ids.filter((id, i) => ju[i] === id).length; rasio = !ids.length ? 0 : (mutlak ? (ok === ids.length ? 1 : 0) : ok / ids.length); break; }
    case 'uraian': if (kosong) return { skor: 0, maks: b, manual: true, kosong: true }; return { skor: null, maks: b, manual: true };
  }
  return { skor: round2(rasio * b), maks: b, manual: false };
}
function hitungHasil(bank, jw, manual) {
  const j = (jw && jw.j) || {}, perSoal = {}; let skor = 0, maks = 0, perlu = 0, benar = 0, dinilai = 0;
  manual = manual || {};
  for (const s of bank.soal) {
    const r = nilaiSoal(s, j[s.id], !!bank.gform);
    if (r.tidakDinilai) { perSoal[s.id] = null; continue; }
    if (r.manual && !r.kosong && manual[s.id] !== undefined && manual[s.id] !== null && manual[s.id] !== '') r.skor = Math.max(0, Math.min(r.maks, num(manual[s.id], 0)));
    if (r.skor === null) perlu++; else skor += r.skor;
    if (r.skor !== null && r.skor >= r.maks && r.maks > 0) benar++;
    maks += r.maks; dinilai++;
    perSoal[s.id] = r.skor;
  }
  return { skor: round2(skor), maks: round2(maks), nilai: maks ? round2(skor / maks * 100) : null, benar, jumlahSoal: bank.soal.length, dinilai, perluKoreksi: perlu, perSoal };
}

/* ---------- finalisasi & antrean ---------- */
async function enqueueArsip(c, key, ver) {
  await c.db.prepare('INSERT INTO antrian(key,ver) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET ver=excluded.ver').bind(key, ver).run();
}
/** Selesaikan peserta. Mengembalikan baris terbaru, atau null bila status sudah berubah (balapan). */
async function finalisasi(c, row, u, bank, catatan, jawabanBaru, pelanggaranBaru, tundaKirim) {
  const now = Date.now();
  const jw = jawabanBaru || row.jawaban;
  const pel = Math.max(row.pelanggaran || 0, pelanggaranBaru || 0);
  const hasil = hitungHasil(bank, jw, row.manual);
  const formStatus = bank.gform ? 'antre' : '';
  const r = await c.db.prepare(`UPDATE peserta SET status='selesai', selesai=?1, jawaban=?2, hasil=?3, catatan=?4, ver=?1, last_seen=?1, pelanggaran=?5,
      terjawab=?6, ragu=?7, form_status=?8 WHERE key=?9 AND status='mengerjakan' RETURNING *`)
    .bind(now, JSON.stringify(jw), JSON.stringify(hasil), catatan || '', pel, hitungTerisi(jw), (jw.r || []).length, formStatus, row.key).first();
  if (!r) return null;
  const stmts = [
    c.db.prepare('DELETE FROM aktif WHERE key=?1').bind(row.key),
    c.db.prepare('INSERT INTO antrian(key,ver) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET ver=excluded.ver').bind(row.key, now)
  ];
  if (bank.gform) stmts.push(c.db.prepare('INSERT INTO kirim(key,coba,berikut,galat) VALUES(?1,0,?2,\'\') ON CONFLICT(key) DO UPDATE SET coba=0, berikut=?2, galat=\'\'').bind(row.key, tundaKirim ? now : now + 90000));
  await c.db.batch(stmts);
  const o = rowObj(r);
  if (bank.gform && !tundaKirim) c.waitUntil(kirimKeForm(c, o, bank).catch(e => console.warn('kirim form', e.message)));
  return o;
}
function infoSelesai(row, u) {
  const res = { status: 'selesai', selesai: row.selesai, catatan: row.catatan || '' };
  if (u.tampilNilai && row.hasil) { res.nilai = row.hasil.nilai; res.benar = row.hasil.benar; res.jumlahSoal = row.hasil.jumlahSoal; res.dinilai = row.hasil.dinilai; res.perluKoreksi = row.hasil.perluKoreksi; }
  return res;
}

/* ----------------------------------------------------------------------------
 *  API: SISWA
 * -------------------------------------------------------------------------- */
async function apiUjianSaya(d, c) {
  const me = await reqSiswa(c);
  const now = Date.now();
  const list = (await getUjianList(c)).filter(u => u.aktif && u.kelas.includes(me.k) && u.selesai >= now - 3 * 86400000 && u.mulai <= now + 7 * 86400000).sort((a, b) => a.mulai - b.mulai);
  if (!list.length) return [];
  const keys = list.map(u => u.id + '|' + me.id);
  const rows = (await c.db.prepare('SELECT key,status,hasil FROM peserta WHERE key IN (' + keys.map((_, i) => '?' + (i + 1)).join(',') + ')').bind(...keys).all()).results || [];
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  const idx = await getBankIndex(c);
  return list.map(u => {
    const r = byKey[u.id + '|' + me.id], b = idx.find(x => x.id === u.bankId);
    const item = { id: u.id, nama: u.nama, mapel: u.mapel, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi, jumlahSoal: b ? b.jumlahSoal : u.jumlahSoal, pakaiToken: u.pakaiToken, keterangan: u.keterangan, jadwal: statusJadwal(u, now), status: r ? r.status : 'belum' };
    if (r && r.status === 'selesai' && u.tampilNilai) { const h = parse(r.hasil, null); if (h) { item.nilai = h.nilai; item.perluKoreksi = h.perluKoreksi; } }
    return item;
  });
}
function cekPerangkat(row, perangkat) {
  if (row.perangkat && perangkat && row.perangkat !== perangkat) throw new AppError('Ujian ini sedang dikerjakan di perangkat lain. Minta pengawas melakukan "Reset login".', 'PERANGKAT');
}
async function apiMulaiUjian(d, c) {
  const me = await reqSiswa(c);
  const u = await getUjian(c, str(d.ujianId));
  const now = Date.now();
  if (!u.aktif || !u.kelas.includes(me.k)) throw new AppError('Anda tidak terdaftar sebagai peserta ujian ini');
  if (now < u.mulai) throw new AppError('Ujian belum dibuka');
  const perangkat = str(d.perangkat, 60);
  let row = await ambilBaris(c, u.id, me.id);
  if (row && row.status === 'selesai') throw new AppError('Anda sudah menyelesaikan ujian ini', 'SELESAI');
  if (now > u.selesai && !(row && row.status === 'mengerjakan')) throw new AppError('Waktu ujian sudah ditutup');
  if (u.pakaiToken && str(d.token).trim().toUpperCase() !== String(u.token).toUpperCase()) throw new AppError('Token ujian salah', 'TOKEN');
  const bank = await getBank(c, u.bankId);
  if (!bank) throw new AppError('Bank soal ujian tidak ditemukan. Hubungi admin.');
  if (!row || row.status === 'belum' || row.status === 'direset') {
    const deadline = Math.min(now + u.durasi * 60000, u.selesai);
    const r = await c.db.prepare(`INSERT INTO peserta(key,ujian_id,nis,nama,kelas,status,mulai,deadline,percobaan,jawaban,pelanggaran,hasil,manual,selesai,catatan,perangkat,last_seen,terjawab,ragu,form_status,form_info,ver)
        VALUES(?1,?2,?3,?4,?5,'mengerjakan',?6,?7,1,'{"j":{},"r":[]}',0,NULL,NULL,0,'',?8,?6,0,0,'','',?6)
        ON CONFLICT(key) DO UPDATE SET status='mengerjakan', mulai=?6, deadline=?7, percobaan=peserta.percobaan+1, jawaban='{"j":{},"r":[]}', pelanggaran=0,
          hasil=NULL, manual=NULL, selesai=0, catatan='', perangkat=?8, last_seen=?6, nama=?4, kelas=?5, terjawab=0, ragu=0, form_status='', form_info='', ver=?6
        WHERE peserta.status IN ('belum','direset') RETURNING *`)
      .bind(u.id + '|' + me.id, u.id, me.id, me.n, me.k, now, deadline, perangkat).first();
    if (r) {
      await c.db.prepare('INSERT INTO aktif(key,deadline) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET deadline=excluded.deadline').bind(r.key, deadline).run();
      row = rowObj(r);
    } else {
      row = await ambilBaris(c, u.id, me.id); // balapan: sudah dimulai oleh permintaan lain
      if (row.status === 'selesai') throw new AppError('Anda sudah menyelesaikan ujian ini', 'SELESAI');
    }
  } else if (row.status === 'mengerjakan') {
    cekPerangkat(row, perangkat);
    if (now > row.deadline + GRACE_MS) {
      await finalisasi(c, row, u, bank, 'waktu habis');
      throw new AppError('Waktu pengerjaan Anda sudah habis. Jawaban terakhir telah dikirim.', 'SELESAI');
    }
    if (!row.perangkat && perangkat) await c.db.prepare('UPDATE peserta SET perangkat=?1 WHERE key=?2').bind(perangkat, row.key).run();
  }
  return {
    ujian: { id: u.id, nama: u.nama, mapel: u.mapel, durasi: u.durasi, maxPelanggaran: u.maxPelanggaran, tampilNilai: u.tampilNilai, keterangan: u.keterangan, gform: !!bank.gform },
    soal: soalUntukSiswa(u, bank, me.id, row.percobaan), mulai: row.mulai, deadline: row.deadline, jawaban: row.jawaban, pelanggaran: row.pelanggaran
  };
}
function bersihJawaban(jw) {
  const o = { j: (jw && typeof jw.j === 'object' && jw.j) ? jw.j : {}, r: (jw && Array.isArray(jw.r)) ? jw.r.slice(0, 300) : [] };
  const s = JSON.stringify(o);
  if (s.length > MAX_JAWABAN_CHARS) throw new AppError('Jawaban terlalu panjang. Persingkat jawaban uraian Anda.');
  return { o, s };
}
async function apiSimpanJawaban(d, c) {
  const me = await reqSiswa(c);
  const key = str(d.ujianId) + '|' + me.id, now = Date.now();
  const { o: jw, s } = bersihJawaban(d.jawaban);
  const perangkat = str(d.perangkat, 60);
  const r = await c.db.prepare(`UPDATE peserta SET jawaban=?1, pelanggaran=MAX(pelanggaran, ?2), last_seen=?3, terjawab=?4, ragu=?5
      WHERE key=?6 AND status='mengerjakan' AND (perangkat='' OR perangkat=?7 OR ?7='') RETURNING deadline, ujian_id`)
    .bind(s, Math.round(num(d.pelanggaran, 0)), now, hitungTerisi(jw), jw.r.length, key, perangkat).first();
  if (!r) {
    const row = await ambilBaris(c, str(d.ujianId), me.id);
    if (!row) throw new AppError('Data peserta tidak ditemukan');
    if (row.status === 'selesai') return infoSelesai(row, await getUjian(c, row.ujianId));
    if (row.status !== 'mengerjakan') return { status: row.status };
    cekPerangkat(row, perangkat);
    throw new AppError('Gagal menyimpan jawaban', 'BUSY');
  }
  if (now > r.deadline + GRACE_MS) {
    const u = await getUjian(c, r.ujian_id), bank = await getBank(c, u.bankId);
    const row = await ambilBaris(c, u.id, me.id);
    const fin = await finalisasi(c, row, u, bank, 'waktu habis');
    return infoSelesai(fin || row, u);
  }
  return { status: 'mengerjakan', deadline: r.deadline };
}
async function apiSelesaiUjian(d, c) {
  const me = await reqSiswa(c);
  const row = await ambilBaris(c, str(d.ujianId), me.id);
  if (!row) throw new AppError('Data peserta tidak ditemukan');
  const u = await getUjian(c, row.ujianId);
  if (row.status === 'mengerjakan') {
    cekPerangkat(row, str(d.perangkat, 60));
    const bank = await getBank(c, u.bankId);
    const { o: jw } = bersihJawaban(d.jawaban);
    const cat = [];
    if (d.alasan) cat.push(str(d.alasan, 60));
    if (Date.now() > row.deadline + GRACE_MS) cat.push('terlambat');
    const fin = await finalisasi(c, row, u, bank, cat.join(', '), jw, Math.round(num(d.pelanggaran, 0)));
    return infoSelesai(fin || await ambilBaris(c, row.ujianId, me.id), u);
  }
  if (row.status !== 'selesai') throw new AppError('Ujian belum dimulai atau telah direset');
  return infoSelesai(row, u);
}

/* ----------------------------------------------------------------------------
 *  API: MONITORING, HASIL, KOREKSI
 * -------------------------------------------------------------------------- */
function bolehUjian(me, u) { if (me.r === 'admin' || u.guruId === me.id) return true; throw new AppError('Anda tidak memiliki akses ke ujian ini'); }
async function apiMonitorUjian(d, c) {
  const me = await reqGuru(c);
  const u = await getUjian(c, str(d.ujianId));
  bolehUjian(me, u);
  const rows = (await c.db.prepare(`SELECT nis,nama,kelas,status,mulai,deadline,selesai,pelanggaran,terjawab,ragu,last_seen,catatan,perangkat,
      json_extract(hasil,'$.nilai') AS nilai, form_status FROM peserta WHERE ujian_id=?1`).bind(u.id).all()).results || [];
  const ada = new Set(rows.map(r => r.nis));
  const peserta = rows.map(r => ({ nis: r.nis, nama: r.nama, kelas: r.kelas, status: r.status, mulai: r.mulai, deadline: r.deadline, selesai: r.selesai, pelanggaran: r.pelanggaran, terjawab: r.terjawab, ragu: r.ragu, lastSeen: r.last_seen, nilai: r.nilai === undefined ? null : r.nilai, catatan: r.catatan, adaPerangkat: !!r.perangkat, formStatus: r.form_status }));
  for (const s of await getSiswaList(c)) if (u.kelas.includes(s.kelas) && !ada.has(String(s.nis))) peserta.push({ nis: String(s.nis), nama: s.nama, kelas: s.kelas, status: 'belum', terjawab: 0, ragu: 0, pelanggaran: 0, nilai: null });
  return { ujian: await ringkasUjian(c, u), peserta, serverTime: Date.now() };
}
async function cariBaris(c, me, ujianId, nis) {
  const u = await getUjian(c, str(ujianId));
  bolehUjian(me, u);
  const row = await ambilBaris(c, u.id, str(nis));
  if (!row) throw new AppError('Peserta belum memulai ujian ini');
  return { u, row };
}
async function apiResetLogin(d, c) {
  const me = await reqGuru(c);
  const { row } = await cariBaris(c, me, d.ujianId, d.nis);
  await c.db.prepare("UPDATE peserta SET perangkat='' WHERE key=?1").bind(row.key).run();
  return true;
}
async function apiResetPeserta(d, c) {
  const me = await reqAdmin(c);
  const { row } = await cariBaris(c, me, d.ujianId, d.nis);
  const now = Date.now();
  await c.db.batch([
    c.db.prepare(`UPDATE peserta SET status='direset', jawaban='{"j":{},"r":[]}', hasil=NULL, manual=NULL, mulai=0, deadline=0, selesai=0, pelanggaran=0,
      perangkat='', catatan=?1, ver=?2, terjawab=0, ragu=0, form_status='', form_info='' WHERE key=?3`).bind('direset ' + me.n, now, row.key),
    c.db.prepare('DELETE FROM aktif WHERE key=?1').bind(row.key),
    c.db.prepare('DELETE FROM kirim WHERE key=?1').bind(row.key),
    c.db.prepare('INSERT INTO antrian(key,ver) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET ver=excluded.ver').bind(row.key, now)
  ]);
  return true;
}
async function apiPaksaSelesai(d, c) {
  const me = await reqGuru(c);
  const { u, row } = await cariBaris(c, me, d.ujianId, d.nis);
  if (row.status !== 'mengerjakan') throw new AppError('Peserta tidak sedang mengerjakan');
  await finalisasi(c, row, u, await getBank(c, u.bankId), 'dihentikan ' + me.n);
  return true;
}
/** Satu rekaman peserta sebagai teks JSON — kolom jawaban/hasil/manual sudah JSON, disisipkan tanpa parse ulang. */
function rekamJson(r, ekstra) {
  const q = JSON.stringify;
  return '{"nis":' + q(r.nis) + ',"nama":' + q(r.nama || '') + ',"kelas":' + q(r.kelas || '') + ',"status":' + q(r.status) +
    ',"mulai":' + (r.mulai || 0) + ',"deadline":' + (r.deadline || 0) + ',"selesai":' + (r.selesai || 0) + ',"pelanggaran":' + (r.pelanggaran || 0) +
    ',"percobaan":' + (r.percobaan || 0) + ',"ver":' + (r.ver || 0) + ',"catatan":' + q(r.catatan || '') +
    ',"formStatus":' + q(r.form_status || '') + ',"formInfo":' + q(r.form_info || '') +
    ',"jawaban":' + (r.jawaban || '{"j":{},"r":[]}') + ',"hasil":' + (r.hasil || 'null') + ',"manual":' + (r.manual || '{}') + (ekstra || '') + '}';
}
async function apiHasilUjian(d, c) {
  const me = await reqGuru(c);
  const u = await getUjian(c, str(d.ujianId));
  bolehUjian(me, u);
  const bank = await getBank(c, u.bankId);
  const mb = MEM.get(P.bank(u.bankId));
  const rows = (await c.db.prepare('SELECT * FROM peserta WHERE ujian_id=?1').bind(u.id).all()).results || [];
  const bagian = rows.map(r => rekamJson(r));
  const ada = new Set(rows.map(r => r.nis));
  for (const s of await getSiswaList(c)) if (u.kelas.includes(s.kelas) && !ada.has(String(s.nis))) bagian.push(JSON.stringify({ nis: String(s.nis), nama: s.nama, kelas: s.kelas, status: 'belum' }));
  return new RawJson('{"ujian":' + JSON.stringify(await ringkasUjian(c, u)) + ',"bank":' + (mb && mb.o === bank ? mb.t : JSON.stringify(bank)) + ',"peserta":[' + bagian.join(',') + ']}');
}
async function koreksiSatu(c, u, bank, nis, input) {
  const row = await ambilBaris(c, u.id, str(nis));
  if (!row) throw new AppError('Hasil peserta tidak ditemukan');
  if (row.status !== 'selesai') throw new AppError('Peserta belum menyelesaikan ujian');
  const manual = row.manual || {};
  for (const sid of Object.keys(input || {})) {
    const v = input[sid];
    if (v === '' || v === null || v === undefined) delete manual[sid]; else manual[sid] = num(v, 0);
  }
  const hasil = hitungHasil(bank, row.jawaban, manual), now = Date.now();
  await c.db.batch([
    c.db.prepare('UPDATE peserta SET manual=?1, hasil=?2, ver=?3 WHERE key=?4').bind(JSON.stringify(manual), JSON.stringify(hasil), now, row.key),
    c.db.prepare('INSERT INTO antrian(key,ver) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET ver=excluded.ver').bind(row.key, now)
  ]);
  return { nis: row.nis, nama: row.nama, kelas: row.kelas, status: row.status, mulai: row.mulai, deadline: row.deadline, selesai: row.selesai, pelanggaran: row.pelanggaran,
    percobaan: row.percobaan, ver: now, catatan: row.catatan, formStatus: row.formStatus, formInfo: row.formInfo, jawaban: row.jawaban, hasil, manual };
}
async function apiKoreksi(d, c) {
  const me = await reqGuru(c);
  const u = await getUjian(c, str(d.ujianId));
  bolehUjian(me, u);
  return koreksiSatu(c, u, await getBank(c, u.bankId), d.nis, d.manual);
}
async function apiKoreksiMassal(d, c) {
  const me = await reqGuru(c);
  const u = await getUjian(c, str(d.ujianId));
  bolehUjian(me, u);
  const bank = await getBank(c, u.bankId), out = [];
  for (const it of (d.items || []).slice(0, 500)) out.push(await koreksiSatu(c, u, bank, it.nis, it.manual));
  return out;
}
async function apiHitungUlang(d, c) {
  const me = await reqGuru(c);
  const u = await getUjian(c, str(d.ujianId));
  bolehUjian(me, u);
  const bank = await getBank(c, u.bankId, true);
  if (!bank) throw new AppError('Bank soal tidak ditemukan');
  const rows = (await c.db.prepare("SELECT key,jawaban,manual FROM peserta WHERE ujian_id=?1 AND status='selesai'").bind(u.id).all()).results || [];
  const now = Date.now(), stmts = [];
  for (const r of rows) {
    const h = hitungHasil(bank, parse(r.jawaban, {}), parse(r.manual, {}));
    stmts.push(c.db.prepare('UPDATE peserta SET hasil=?1, ver=?2 WHERE key=?3').bind(JSON.stringify(h), now, r.key));
    stmts.push(c.db.prepare('INSERT INTO antrian(key,ver) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET ver=excluded.ver').bind(r.key, now));
  }
  for (let i = 0; i < stmts.length; i += 100) await c.db.batch(stmts.slice(i, i + 100));
  return { dihitung: rows.length };
}

/* ----------------------------------------------------------------------------
 *  API: DATA GURU & SISWA
 * -------------------------------------------------------------------------- */
const publikGuru = g => ({ id: g.id, username: g.username, nama: g.nama, role: g.role, aktif: g.aktif !== false, mapel: g.mapel || [] });
async function apiListGuru(d, c) { await reqAdmin(c); return (await getGuruList(c)).map(publikGuru); }
async function apiSaveGuru(d, c) {
  const me = await reqAdmin(c);
  const username = str(d.username, 40).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new AppError('Nama pengguna 3–40 karakter: huruf kecil, angka, titik, garis bawah');
  const nama = str(d.nama, 120).trim();
  if (!nama) throw new AppError('Nama guru wajib diisi');
  return denganKunci(c, 'github', async () => {
    const list = clone(await getGuruList(c, true));
    let g = d.id ? list.find(x => x.id === d.id) : null;
    if (d.id && !g) throw new AppError('Guru tidak ditemukan');
    if (list.some(x => x.username === username && (!g || x.id !== g.id))) throw new AppError('Nama pengguna sudah dipakai');
    if (!g) { if (!d.password || String(d.password).length < 6) throw new AppError('Kata sandi minimal 6 karakter'); g = { id: uid('g') }; list.push(g); }
    if (g.id === me.id && d.role !== 'admin') throw new AppError('Anda tidak bisa menurunkan peran akun sendiri');
    Object.assign(g, { username, nama, role: d.role === 'admin' ? 'admin' : 'guru', aktif: d.aktif === undefined ? true : bool(d.aktif), mapel: (d.mapel || []).map(x => str(x, 80)) });
    if (d.password) { if (String(d.password).length < 6) throw new AppError('Kata sandi minimal 6 karakter'); Object.assign(g, await makeCred(d.password)); }
    await tulisJson(c, { [P.guru]: list }, 'Data guru: ' + nama + ' (' + me.n + ')');
    return publikGuru(g);
  });
}
async function apiDeleteGuru(d, c) {
  const me = await reqAdmin(c);
  if (d.id === me.id) throw new AppError('Tidak bisa menghapus akun sendiri');
  return denganKunci(c, 'github', async () => {
    const list = await getGuruList(c, true);
    const g = list.find(x => x.id === d.id);
    if (!g) throw new AppError('Guru tidak ditemukan');
    await tulisJson(c, { [P.guru]: list.filter(x => x.id !== d.id) }, 'Hapus guru: ' + g.nama + ' (' + me.n + ')');
    return true;
  });
}
const publikSiswa = s => ({ nis: String(s.nis), nama: s.nama, kelas: s.kelas });
async function apiListSiswa(d, c) { await reqAdmin(c); return (await getSiswaList(c)).map(publikSiswa); }
function tebakTingkat(namaKelas, tingkatList) {
  let best = '';
  for (const t of tingkatList || []) { const re = new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i'); if (re.test(namaKelas) && t.length > best.length) best = t; }
  return best;
}
async function tambahKelasKeConfig(c, kelasBaru) {
  const cfg = clone(await getConfig(c, true));
  cfg.kelas = cfg.kelas || [];
  const ada = new Set(cfg.kelas.map(k => k.nama));
  const tambah = [...new Set(kelasBaru.filter(k => k && !ada.has(k)))];
  if (!tambah.length) return null;
  tambah.forEach(k => cfg.kelas.push({ nama: k, tingkat: tebakTingkat(k, cfg.tingkat) }));
  cfg.kelas.sort((a, b) => a.nama.localeCompare(b.nama, 'id', { numeric: true }));
  return cfg;
}
async function apiSaveSiswa(d, c) {
  const me = await reqAdmin(c);
  const nis = str(d.nis, 30).trim(), nama = str(d.nama, 120).trim(), kelas = str(d.kelas, 40).trim();
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(nis)) throw new AppError('NIS hanya boleh huruf/angka');
  if (!nama || !kelas) throw new AppError('Nama dan kelas wajib diisi');
  return denganKunci(c, 'github', async () => {
    const list = clone(await getSiswaList(c, true));
    const lamaNis = str(d.nisLama || '').trim();
    let s = lamaNis ? list.find(x => String(x.nis) === lamaNis) : null;
    if (lamaNis && !s) throw new AppError('Siswa tidak ditemukan');
    if (list.some(x => String(x.nis) === nis && x !== s)) throw new AppError('NIS ' + nis + ' sudah terdaftar');
    if (!s) { s = {}; list.push(s); if (!d.password) d.password = nis; }
    Object.assign(s, { nis, nama, kelas });
    if (d.password) Object.assign(s, await makeCred(d.password));
    const f = { [P.siswa]: list };
    const cfg = await tambahKelasKeConfig(c, [kelas]); if (cfg) f[P.config] = cfg;
    await tulisJson(c, f, 'Data siswa: ' + nama + ' (' + me.n + ')');
    return publikSiswa(s);
  });
}
async function apiImportSiswa(d, c) {
  const me = await reqAdmin(c);
  const rows = (d.rows || []).slice(0, 5000);
  if (!rows.length) throw new AppError('Tidak ada data untuk diimpor');
  return denganKunci(c, 'github', async () => {
    const list = d.mode === 'ganti' ? [] : clone(await getSiswaList(c, true));
    const byNis = new Map(list.map(s => [String(s.nis), s]));
    let baru = 0, ubah = 0; const lewati = [], perluHash = [];
    rows.forEach((r, i) => {
      const nis = str(r.nis, 30).trim(), nama = str(r.nama, 120).trim(), kelas = str(r.kelas, 40).trim();
      if (!/^[A-Za-z0-9._-]{1,30}$/.test(nis) || !nama || !kelas) { lewati.push(i + 1); return; }
      let s = byNis.get(nis);
      if (!s) { s = { nis }; list.push(s); byNis.set(nis, s); baru++; } else ubah++;
      s.nama = nama; s.kelas = kelas;
      if (r.password || !s.hash) perluHash.push([s, r.password ? String(r.password) : nis]);
    });
    await Promise.all(perluHash.map(async ([s, pw]) => Object.assign(s, await makeCred(pw))));
    const f = { [P.siswa]: list };
    const cfg = await tambahKelasKeConfig(c, list.map(s => s.kelas)); if (cfg) f[P.config] = cfg;
    await tulisJson(c, f, 'Impor siswa: ' + baru + ' baru, ' + ubah + ' diperbarui (' + me.n + ')');
    return { baru, ubah, lewati, total: list.length, config: cfg };
  }, 30000);
}
async function apiDeleteSiswa(d, c) {
  const me = await reqAdmin(c);
  const hapus = new Set((d.nis || []).map(String));
  return denganKunci(c, 'github', async () => {
    const list = await getSiswaList(c, true);
    const sisa = list.filter(s => !hapus.has(String(s.nis)));
    await tulisJson(c, { [P.siswa]: sisa }, 'Hapus ' + (list.length - sisa.length) + ' siswa (' + me.n + ')');
    return list.length - sisa.length;
  });
}

/* ----------------------------------------------------------------------------
 *  GOOGLE FORM: IMPOR & KIRIM
 * -------------------------------------------------------------------------- */
const GF_JENIS = { 0: 'singkat', 1: 'paragraf', 2: 'pg', 3: 'dropdown', 4: 'centang', 5: 'skala', 6: 'teks', 7: 'grid', 8: 'bagian', 9: 'tanggal', 10: 'waktu', 11: 'gambar', 12: 'video', 13: 'file', 18: 'rating' };
function gfBase(c) { return c.env.GFORM_BASE || 'https://docs.google.com'; }
function decodeHtml(s) { return String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'); }
function ekstrakFbData(html) {
  const i = html.indexOf('FB_PUBLIC_LOAD_DATA_');
  if (i < 0) return null;
  const start = html.indexOf('[', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, end = -1;
  for (let k = start; k < html.length; k++) {
    const ch = html.charCodeAt(k);
    if (inStr) { if (ch === 92) k++; else if (ch === 34) inStr = false; continue; }
    if (ch === 34) inStr = true;
    else if (ch === 91) depth++;
    else if (ch === 93 && --depth === 0) { end = k + 1; break; }
  }
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end)); } catch (e) { return null; }
}
/** Ambil gambar per item dari HTML: { itemId: [src...] } */
function ekstrakGambar(html) {
  const out = {};
  const bagian = html.split('role="listitem"');
  for (const b of bagian.slice(1)) {
    const m = b.match(/data-item-id="(\d+)"/) || b.match(/data-params="%\.@\.\[(\d+),/);
    if (!m) continue;
    const imgs = [...b.matchAll(/<img[^>]+src="(https:\/\/[^"]*(?:forms-images|googleusercontent)[^"]*)"/g)].map(x => decodeHtml(x[1]));
    if (imgs.length) out[m[1]] = imgs;
  }
  return out;
}
function deteksiIdentitas(judul) {
  const t = String(judul || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(nama( lengkap)?( siswa| peserta( didik)?)?|name|full name|nama siswa)$/.test(t)) return 'nama';
  if (/^(nis|nisn|no induk( siswa)?|nomor induk( siswa)?|nis nisn|nisn nis)$/.test(t)) return 'nis';
  if (/^(kelas|class|rombel|kelas rombel)$/.test(t)) return 'kelas';
  if (/^(nama (dan|&) kelas|nama kelas)$/.test(t)) return 'namakelas';
  if (/^(nama (dan|&) nis|nama nis|nis (dan|&) nama)$/.test(t)) return 'namanis';
  return '';
}
function idDariUrl(url) {
  const m = String(url).match(/\/forms\/d\/e\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
async function ambilHalamanForm(c, url) {
  url = str(url, 500).trim();
  if (!/^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/.test(url) && !c.env.GFORM_BASE) throw new AppError('Masukkan link Google Form (docs.google.com/forms/... atau forms.gle/...)');
  if (/\/forms\/d\/(?!e\/)[A-Za-z0-9_-]+\/edit/.test(url)) throw new AppError('Itu link edit. Gunakan link untuk responden: buka form → Kirim → ikon link, lalu salin.');
  let target = url;
  const id0 = idDariUrl(url);
  if (id0) target = gfBase(c) + '/forms/d/e/' + id0 + '/viewform?hl=id';
  const res = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (CBT Sekolah)', 'Accept-Language': 'id,en' } });
  const finalUrl = res.url || target;
  if (/accounts\.google\.com|ServiceLogin/.test(finalUrl)) throw new AppError('Form ini mewajibkan login Google, sehingga jawaban tidak bisa dikirim dari CBT. Di setelan form, matikan "Batasi ke pengguna ..." dan "Batasi ke 1 tanggapan", lalu coba lagi.', 'GFORM_LOGIN');
  if (!res.ok) throw new AppError('Google Form tidak bisa dibuka (' + res.status + '). Pastikan link benar dan form menerima tanggapan.');
  const html = await res.text();
  const data = ekstrakFbData(html);
  if (!data) {
    if (/closedform|tidak lagi menerima|no longer accepting/i.test(html + finalUrl)) throw new AppError('Form ini sudah tidak menerima tanggapan. Aktifkan "Menerima tanggapan" dulu.');
    throw new AppError('Isi Google Form tidak terbaca. Pastikan link adalah link responden (…/viewform).');
  }
  const formId = (String(data[14] || '').replace(/^e\//, '')) || idDariUrl(finalUrl);
  const fbzx = (html.match(/name="fbzx" value="([^"]+)"/) || [])[1] || '';
  return { data, html, formId, fbzx, emailWajib: /name="emailAddress"/.test(html) };
}
/** Salin satu gambar Google Form ke repo media (dipanggil aplikasi guru satu per satu agar ringan). */
async function apiSalinGambarGForm(d, c) {
  const me = await reqGuru(c);
  const src = str(d.url, 2000);
  let host = '';
  try { host = new URL(src).host; } catch (e) {}
  const izin = /^(docs\.google\.com|lh\d+\.googleusercontent\.com|[a-z0-9-]+\.googleusercontent\.com)$/.test(host) || (c.env.GFORM_BASE && src.startsWith(c.env.GFORM_BASE));
  if (!izin) throw new AppError('Alamat gambar bukan dari Google Form');
  const r = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0 (CBT Sekolah)' } });
  if (!r.ok) throw new AppError('Gambar tidak bisa diambil dari Google (' + r.status + ')');
  const ct = r.headers.get('content-type') || '';
  if (!/^image\//.test(ct)) throw new AppError('Berkas dari Google bukan gambar');
  const ext = /jpe?g/.test(ct) ? 'jpg' : /gif/.test(ct) ? 'gif' : /webp/.test(ct) ? 'webp' : 'png';
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 2000000) throw new AppError('Gambar lebih dari 2 MB, unggah ulang secara manual');
  return unggahMedia(c, b64(buf), ext, me.n);
}
/** Ubah struktur Google Form menjadi bank soal CBT. */
function konversiForm(data, gambarMap) {
  const items = (data[1] && data[1][1]) || [];
  const soal = [], identitas = [], peringatan = [], gambarDiperlukan = [];
  let halaman = 1, stimulusTertunda = '', gambarTertunda = [];
  const teksItem = it => [it[1], it[2]].filter(Boolean).join('\n');
  const opsiDari = (opts, idSoal) => (opts || []).filter(o => !o[4]).map((o, i) => ({ id: idSoal + 'o' + i, teks: String(o[0]), gambar: '', gv: String(o[0]) }));
  for (const it of items) {
    const [itemId, judul, desk, tipe, ans] = it;
    const jenis = GF_JENIS[tipe] || 'lain';
    if (jenis === 'bagian') { halaman++; if (judul || desk) stimulusTertunda += (stimulusTertunda ? '\n\n' : '') + teksItem(it); continue; }
    if (jenis === 'teks') { stimulusTertunda += (stimulusTertunda ? '\n\n' : '') + teksItem(it); continue; }
    if (jenis === 'gambar') { (gambarMap[itemId] || []).forEach(g => gambarTertunda.push(g)); if (judul) stimulusTertunda += (stimulusTertunda ? '\n\n' : '') + judul; continue; }
    if (jenis === 'video') { peringatan.push('Video “' + (judul || 'tanpa judul') + '” tidak bisa ditampilkan; tambahkan tautannya secara manual bila perlu.'); continue; }
    if (!ans || !ans[0]) continue;
    const q = ans[0], entry = String(q[0]), wajib = !!q[2];
    if (jenis === 'file') { peringatan.push('Pertanyaan unggah file “' + judul + '” dilewati (tidak didukung).' + (wajib ? ' Pertanyaan ini WAJIB di form, sehingga jawaban akan ditolak Google — jadikan tidak wajib.' : '')); continue; }
    const idSoal = 'g' + itemId;
    const idt = (jenis === 'singkat' || jenis === 'paragraf') ? deteksiIdentitas(judul) : '';
    if (idt) { identitas.push({ entry, isi: idt, judul }); continue; }
    const imgs = gambarMap[itemId] || [];
    const nOpsiGambar = (q[1] || []).filter(o => o && o[5]).length;
    const gambarSoal = imgs.slice(0, Math.max(0, imgs.length - nOpsiGambar));
    const gambarOpsi = imgs.slice(imgs.length - nOpsiGambar);
    const dasar = { id: idSoal, teks: teksItem(it), stimulus: stimulusTertunda, gambar: [...gambarTertunda, ...gambarSoal].slice(0, 6), bobot: 1, pembahasan: '' };
    stimulusTertunda = ''; gambarTertunda = [];
    const pasangGambarOpsi = s => { let k = 0; (q[1] || []).filter(o => !o[4]).forEach((o, i) => { if (o[5] && gambarOpsi[k]) { s.opsi[i].gambar = gambarOpsi[k]; k++; } }); };
    if (jenis === 'pg' || jenis === 'dropdown') {
      const s = { ...dasar, tipe: 'pg', opsi: opsiDari(q[1], idSoal), kunci: '', gform: { entry, jenis, wajib } };
      if ((q[1] || []).some(o => o[4])) peringatan.push('Pilihan “Lainnya” pada “' + judul + '” tidak ditampilkan.');
      pasangGambarOpsi(s); soal.push(s);
    } else if (jenis === 'centang') {
      const s = { ...dasar, tipe: 'pgk', opsi: opsiDari(q[1], idSoal), kunci: [], penilaian: 'sebagian', gform: { entry, jenis, wajib } };
      pasangGambarOpsi(s); soal.push(s);
    } else if (jenis === 'skala' || jenis === 'rating') {
      const lbl = q[3] || [];
      const opsi = (q[1] || []).map((o, i, arr) => ({ id: idSoal + 'o' + i, teks: String(o[0]) + (i === 0 && lbl[0] ? ' (' + lbl[0] + ')' : '') + (i === arr.length - 1 && lbl[1] ? ' (' + lbl[1] + ')' : ''), gambar: '', gv: String(o[0]) }));
      soal.push({ ...dasar, tipe: 'pg', opsi, kunci: '', gform: { entry, jenis: 'skala', wajib } });
    } else if (jenis === 'grid') {
      ans.forEach((row, ri) => {
        const kolom = (row[1] || []).map((o, i) => ({ id: idSoal + 'r' + ri + 'o' + i, teks: String(o[0]), gambar: '', gv: String(o[0]) }));
        const label = (row[3] && row[3][0]) || ('Baris ' + (ri + 1));
        const centang = !!(row[11] && row[11][0]);
        soal.push({ ...dasar, id: idSoal + 'r' + ri, teks: (ri === 0 ? dasar.teks + '\n\n' : (judul ? judul + '\n\n' : '')) + '**' + label + '**', stimulus: ri === 0 ? dasar.stimulus : '', gambar: ri === 0 ? dasar.gambar : [], tipe: centang ? 'pgk' : 'pg', opsi: kolom, kunci: centang ? [] : '', ...(centang ? { penilaian: 'sebagian' } : {}), gform: { entry: String(row[0]), jenis: centang ? 'gridcentang' : 'grid', wajib: !!row[2] } });
      });
    } else if (jenis === 'singkat' || jenis === 'tanggal' || jenis === 'waktu') {
      const hint = jenis === 'tanggal' ? '\n\n*Tulis tanggal dengan format TTTT-BB-HH, contoh 2026-11-16*' : jenis === 'waktu' ? '\n\n*Tulis jam dengan format JJ:MM, contoh 07:30*' : '';
      soal.push({ ...dasar, teks: dasar.teks + hint, tipe: 'isian', jawaban: [], gform: { entry, jenis, wajib } });
    } else if (jenis === 'paragraf') {
      soal.push({ ...dasar, tipe: 'uraian', rubrik: '', bobot: 0, gform: { entry, jenis, wajib } });
    } else {
      peringatan.push('Jenis pertanyaan “' + judul + '” (kode ' + tipe + ') belum didukung dan dilewati.');
    }
  }
  return { soal, identitas, peringatan, halaman };
}
async function apiImporGForm(d, c) {
  const me = await reqGuru(c);
  const { data, html, formId, emailWajib } = await ambilHalamanForm(c, d.url);
  const gmap = ekstrakGambar(html);
  const hasil = konversiForm(data, gmap);
  const wajibPilihan = hasil.soal.filter(s => s.gform && s.gform.wajib && (s.tipe === 'pg' || s.tipe === 'pgk')).length;
  if (wajibPilihan) hasil.peringatan.push(wajibPilihan + ' pertanyaan pilihan bersifat wajib di form. Jika siswa tidak menjawabnya sampai waktu habis, Google akan menolak kirimannya (hasil tetap tersimpan di CBT). Sebaiknya matikan "Wajib diisi" di form.');
  if (emailWajib) hasil.peringatan.push('Form ini meminta alamat email responden. Matikan "Kumpulkan alamat email" di setelan form agar jawaban tidak ditolak.');
  if (!hasil.soal.length) throw new AppError('Tidak ada pertanyaan yang bisa diimpor dari form ini.');
  const judulForm = str(data[1] && data[1][8], 150) || str(data[3], 150) || 'Google Form';
  const input = {
    judul: str(d.judul, 150).trim() || judulForm, mapel: str(d.mapel, 80), tingkat: str(d.tingkat, 20), deskripsi: str(data[1] && data[1][0], 1000), soal: hasil.soal,
    gform: { formId, url: str(d.url, 500), judul: judulForm, halaman: hasil.halaman, identitas: hasil.identitas, emailWajib, peringatan: hasil.peringatan, diimpor: Date.now() }
  };
  const r = await simpanBankKeGitHub(c, me, input, true);
  // gambar masih di server Google; aplikasi guru menyalinnya satu per satu lewat salinGambarGForm
  const gambar = [...new Set(r.bank.soal.flatMap(s => [...(s.gambar || []), ...(s.opsi || []).map(o => o.gambar)]).filter(g => g && !/cdn\.jsdelivr\.net|githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}/.test(g)))];
  return { bank: r.bank, peringatan: hasil.peringatan, identitas: hasil.identitas, gambar };
}
function nilaiIdentitas(isi, row) {
  if (isi === 'nama') return row.nama || '';
  if (isi === 'nis') return row.nis || '';
  if (isi === 'kelas') return row.kelas || '';
  if (isi === 'namakelas') return (row.nama || '') + ' - ' + (row.kelas || '');
  if (isi === 'namanis') return (row.nama || '') + ' - ' + (row.nis || '');
  return '';
}
function bodyForm(bank, row) {
  const gf = bank.gform, p = new URLSearchParams(), j = (row.jawaban && row.jawaban.j) || {};
  for (const idt of gf.identitas || []) p.append('entry.' + idt.entry, nilaiIdentitas(idt.isi, row));
  for (const s of bank.soal) {
    if (!s.gform || !s.gform.entry) continue;
    const e = 'entry.' + s.gform.entry, v = j[s.id];
    const gv = id => { const o = (s.opsi || []).find(x => x.id === id); return o ? (o.gv !== undefined ? o.gv : o.teks) : null; };
    if (s.tipe === 'pg') { const x = gv(v); if (x !== null) p.append(e, x); }
    else if (s.tipe === 'pgk') { (Array.isArray(v) ? v : []).forEach(id => { const x = gv(id); if (x !== null) p.append(e, x); }); }
    else if (s.gform.jenis === 'tanggal') {
      const m = String(v || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) || String(v || '').trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (m) { const [y, mo, da] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]]; p.append(e + '_year', y); p.append(e + '_month', String(+mo)); p.append(e + '_day', String(+da)); }
    } else if (s.gform.jenis === 'waktu') {
      const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
      if (m) { p.append(e + '_hour', m[1].padStart(2, '0')); p.append(e + '_minute', m[2]); }
    } else if (typeof v === 'string' && v.trim()) p.append(e, v);
    else if (s.gform.wajib) p.append(e, '-');
  }
  const n = Math.max(1, gf.halaman || 1);
  p.append('pageHistory', Array.from({ length: n }, (_, i) => i).join(','));
  p.append('fvv', '1');
  const fbzx = Array.from(crypto.getRandomValues(new Uint8Array(19)), (b, i) => i === 0 ? 1 + b % 9 : b % 10).join('');
  p.append('fbzx', fbzx);
  p.append('partialResponse', JSON.stringify([null, null, fbzx]));
  return p;
}
async function kirimKeForm(c, row, bank) {
  const gf = bank.gform;
  let status = 'gagal', info = '';
  try {
    const res = await fetch(gfBase(c) + '/forms/d/e/' + gf.formId + '/formResponse', {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (CBT Sekolah)' },
      body: bodyForm(bank, row).toString()
    });
    const html = await res.text();
    if (/accounts\.google\.com|ServiceLogin/.test(res.url || '')) info = 'Form mewajibkan login Google';
    else if (!res.ok) info = 'Google Form menjawab ' + res.status;
    else if (/name="entry\.\d+/.test(html) && /FB_PUBLIC_LOAD_DATA_/.test(html)) info = 'Ditolak Google Form (ada pertanyaan wajib yang kosong atau jawaban tidak sesuai pilihan)';
    else status = 'terkirim';
  } catch (e) { info = 'Koneksi ke Google gagal: ' + e.message; }
  if (status === 'terkirim') {
    await c.db.batch([
      c.db.prepare("UPDATE peserta SET form_status='terkirim', form_info=?1 WHERE key=?2").bind(new Date().toISOString(), row.key),
      c.db.prepare('DELETE FROM kirim WHERE key=?1').bind(row.key)
    ]);
  } else {
    const k = await c.db.prepare('UPDATE kirim SET coba=coba+1, berikut=?1, galat=?2 WHERE key=?3 RETURNING coba').bind(Date.now() + 120000, info, row.key).first();
    await c.db.prepare('UPDATE peserta SET form_status=?1, form_info=?2 WHERE key=?3').bind(k && k.coba >= 5 ? 'gagal' : 'antre', info, row.key).run();
  }
  return { status, info };
}
async function apiKirimUlangForm(d, c) {
  const me = await reqGuru(c);
  const u = await getUjian(c, str(d.ujianId));
  bolehUjian(me, u);
  const bank = await getBank(c, u.bankId);
  if (!bank || !bank.gform) throw new AppError('Ujian ini tidak terhubung ke Google Form');
  let rows;
  if (d.nis) rows = [await c.db.prepare("SELECT * FROM peserta WHERE key=?1 AND status='selesai'").bind(u.id + '|' + str(d.nis)).first()].filter(Boolean);
  else rows = (await c.db.prepare("SELECT * FROM peserta WHERE ujian_id=?1 AND status='selesai' AND form_status!='terkirim' LIMIT 40").bind(u.id).all()).results || [];
  let terkirim = 0; const galat = [];
  for (const r of rows) {
    await c.db.prepare('INSERT INTO kirim(key,coba,berikut,galat) VALUES(?1,0,0,\'\') ON CONFLICT(key) DO UPDATE SET coba=0').bind(r.key).run();
    const x = await kirimKeForm(c, rowObj(r), bank);
    if (x.status === 'terkirim') terkirim++; else galat.push(r.nama + ': ' + x.info);
  }
  return { diproses: rows.length, terkirim, galat: galat.slice(0, 10) };
}

/* ----------------------------------------------------------------------------
 *  CRON: kumpul otomatis, arsip ke GitHub, kirim ulang form
 * -------------------------------------------------------------------------- */
async function apiSinkronSekarang(d, c) {
  const me = await reqGuru(c);
  if (d.segarkan && me.r === 'admin') { await c.db.prepare('DELETE FROM berkas').run(); MEM.clear(); }
  return prosesCron(c);
}
async function prosesCron(c) {
  const now = Date.now(), laporan = { dikumpulkan: 0, disinkron: 0, formTerkirim: 0 };
  // 1) kumpulkan otomatis peserta yang waktunya habis
  const habis = (await c.db.prepare('SELECT key FROM aktif WHERE deadline < ?1 LIMIT 60').bind(now - GRACE_MS).all()).results || [];
  if (habis.length) {
    const ujianMap = Object.fromEntries((await getUjianList(c)).map(u => [u.id, u]));
    for (const h of habis) {
      const row = rowObj(await c.db.prepare('SELECT * FROM peserta WHERE key=?1').bind(h.key).first());
      if (!row || row.status !== 'mengerjakan') { await c.db.prepare('DELETE FROM aktif WHERE key=?1').bind(h.key).run(); continue; }
      const u = ujianMap[row.ujianId], bank = u && await getBank(c, u.bankId);
      if (!u || !bank) { await c.db.prepare('DELETE FROM aktif WHERE key=?1').bind(h.key).run(); continue; }
      if (await finalisasi(c, row, u, bank, 'otomatis (waktu habis)', null, 0, true)) laporan.dikumpulkan++;
    }
  }
  // 2) arsipkan hasil ke GitHub: satu file per peserta, satu commit per putaran
  const antre = (await c.db.prepare('SELECT key, ver FROM antrian ORDER BY ver LIMIT 150').all()).results || [];
  if (antre.length) {
    const keys = antre.map(a => a.key), rows = [];
    for (let i = 0; i < keys.length; i += 90) {
      const part = keys.slice(i, i + 90);
      rows.push(...((await c.db.prepare('SELECT * FROM peserta WHERE key IN (' + part.map((_, k) => '?' + (k + 1)).join(',') + ')').bind(...part).all()).results || []));
    }
    const files = {};
    for (const r of rows) files[P.hasil(r.ujian_id, r.kelas, r.nis)] = rekamJson(r, ',"ujianId":' + JSON.stringify(r.ujian_id) + ',"diarsip":' + now);
    if (rows.length) await denganKunci(c, 'github', () => ghCommit(c, c.dataRepo, files, 'Arsip hasil: ' + rows.length + ' peserta'), 25000);
    const del = antre.map(a => c.db.prepare('DELETE FROM antrian WHERE key=?1 AND ver=?2').bind(a.key, a.ver));
    for (let i = 0; i < del.length; i += 100) await c.db.batch(del.slice(i, i + 100));
    laporan.disinkron = rows.length;
  }
  // 3) kirim ulang jawaban ke Google Form yang tertunda/gagal
  const kirim = (await c.db.prepare('SELECT key FROM kirim WHERE coba < 5 AND berikut <= ?1 LIMIT 15').bind(now).all()).results || [];
  if (kirim.length) {
    const ujianMap = Object.fromEntries((await getUjianList(c)).map(u => [u.id, u]));
    for (const k of kirim) {
      const row = rowObj(await c.db.prepare('SELECT * FROM peserta WHERE key=?1').bind(k.key).first());
      const u = row && ujianMap[row.ujianId], bank = u && await getBank(c, u.bankId);
      if (!row || row.status !== 'selesai' || !bank || !bank.gform) { await c.db.prepare('DELETE FROM kirim WHERE key=?1').bind(k.key).run(); continue; }
      const x = await kirimKeForm(c, row, bank);
      if (x.status === 'terkirim') laporan.formTerkirim++;
    }
  }
  return laporan;
}

/* ----------------------------------------------------------------------------
 *  DAFTAR AKSI
 * -------------------------------------------------------------------------- */
const ACTIONS = {
  ping: apiPing, loginGuru: apiLoginGuru, loginSiswa: apiLoginSiswa, gantiPassword: apiGantiPassword, getConfig: apiGetConfig,
  dashboard: apiDashboard, listBank: apiListBank, getBank: apiGetBank, saveBank: apiSaveBank, deleteBank: apiDeleteBank, uploadGambar: apiUploadGambar,
  imporGForm: apiImporGForm, salinGambarGForm: apiSalinGambarGForm, kirimUlangForm: apiKirimUlangForm,
  listUjian: apiListUjian, monitorUjian: apiMonitorUjian, hasilUjian: apiHasilUjian, koreksi: apiKoreksi, koreksiMassal: apiKoreksiMassal, hitungUlang: apiHitungUlang,
  saveConfig: apiSaveConfig, saveUjian: apiSaveUjian, deleteUjian: apiDeleteUjian, gantiTokenUjian: apiGantiTokenUjian,
  resetPeserta: apiResetPeserta, resetLogin: apiResetLogin, paksaSelesai: apiPaksaSelesai,
  listGuru: apiListGuru, saveGuru: apiSaveGuru, deleteGuru: apiDeleteGuru,
  listSiswa: apiListSiswa, saveSiswa: apiSaveSiswa, importSiswa: apiImportSiswa, deleteSiswa: apiDeleteSiswa,
  sinkronSekarang: apiSinkronSekarang,
  ujianSaya: apiUjianSaya, mulaiUjian: apiMulaiUjian, simpanJawaban: apiSimpanJawaban, selesaiUjian: apiSelesaiUjian
};

// untuk pengujian lokal
export const _internal = { konversiForm, ekstrakFbData, ekstrakGambar, bodyForm, hitungHasil, deteksiIdentitas, MEM, reset: () => { SKEMA_OK = false; MEM.clear(); } };
