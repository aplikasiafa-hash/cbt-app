/**
 * ============================================================================
 *  CBT SEKOLAH — Durable Object "Engine" (satu instance untuk seluruh sekolah)
 * ============================================================================
 *  - Menyimpan sesi ujian yang sedang berjalan DI MEMORI (cepat, ribuan siswa).
 *  - Siswa terhubung lewat WebSocket: autosave dikirim sebagai pesan (20 pesan = 1 request
 *    kuota) sehingga 1300 siswa × 6 ujian/hari tetap di bawah kuota gratis.
 *  - Perubahan penting (mulai, selesai, reset) langsung ditulis ke SQLite Durable Object
 *    sebelum siswa menerima jawaban "berhasil". Jawaban sementara dicadangkan tiap 2 menit.
 *  - Hasil akhir dikirim ke D1 (tabel hasil) secara berkelompok (1 query untuk ratusan siswa).
 *  - CPU Durable Object 30 detik per permintaan → aman untuk penilaian/hasil ribuan siswa.
 * ============================================================================
 */
import { DurableObject } from 'cloudflare:workers';
import * as X from './shared.js';
import { siapkanD1, potong, SKEMA_VERSI } from './db.js';
import { unggahGambar, cekRepoData, commitFiles, unduhRepo } from './github.js';

const { AppError, now, str_, num_, bool_, parse_, uid_, GRACE_MS } = X;

const NB = 12;                 // ember cadangan jawaban per ujian
const JW_FLUSH_MS = 120000;    // cadangkan jawaban sementara tiap 2 menit
const DENYUT_MS = 4000;        // dorong perubahan status ke monitor tiap 4 detik
const PENDING_MS = 2 * 3600000; // jawaban perangkat tak kunjung datang: dinilai dari cadangan server 2 jam setelah jadwal ditutup
const ALARM_MS = 60000;        // perawatan saat tidak ada koneksi
const BACKUP_MS = 30 * 60000;  // cadangan GitHub otomatis maks. tiap 30 menit
// Salinan data guru/bank/jadwal/pengaturan di penyimpanan internal Durable Object: saat mesin ujian bangun dari tidur
// tidak perlu membaca D1 (hemat "Rows read"). Dimuat ulang dari D1 sekali setiap versi aplikasi baru.
const CACHE_VERSI = 'c1:' + X.VERSI + ':' + SKEMA_VERSI;   // versi/skema baru → siapkan D1 (migrasi) & muat ulang sekali

/** Map yang ikut menyimpan perubahan ke tabel salinan di penyimpanan internal Durable Object. */
class PetaDO extends Map {
  constructor(sql, tabel, entri) { super(entri); this.sql = sql; this.tabel = tabel; }
  set(k, v) { super.set(k, v); if (this.sql) this.sql.exec(`INSERT OR REPLACE INTO ${this.tabel} (id, d) VALUES (?, ?)`, k, JSON.stringify(v)); return this; }
  delete(k) { const r = super.delete(k); if (this.sql && r) this.sql.exec(`DELETE FROM ${this.tabel} WHERE id = ?`, k); return r; }
  clear() { super.clear(); if (this.sql) this.sql.exec(`DELETE FROM ${this.tabel}`); }
  tulisSemua() { this.sql.exec(`DELETE FROM ${this.tabel}`); for (const [k, v] of this) this.sql.exec(`INSERT INTO ${this.tabel} (id, d) VALUES (?, ?)`, k, JSON.stringify(v)); }
}
const PUBLIK = new Set(['_dev', 'ping', 'loginSiswa', 'loginGuru']);

const HDR = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const jres = o => new Response(JSON.stringify(o), { headers: HDR });
const kirim = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch (e) { /* koneksi sudah tutup */ } };
const POTONG = 400000;
/** Jawaban besar (hasil 1300 siswa, bank soal) dipecah agar aman dari batas ukuran pesan WebSocket. */
function kirimBesar(ws, o) {
  const s = JSON.stringify(o);
  try {
    if (s.length <= POTONG) return ws.send(s);
    const n = Math.ceil(s.length / POTONG);
    for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: 'pt', id: o.id, i, n, s: s.slice(i * POTONG, (i + 1) * POTONG) }));
  } catch (e) { /* koneksi sudah tutup */ }
}
const ember = nis => X.seed_(String(nis)) % NB;

function rekam(P) {
  return {
    nis: P.nis, nama: P.nama, kelas: P.kelas, status: P.status, mulai: P.mulai || 0, deadline: P.deadline || 0, selesai: P.selesai || 0,
    pelanggaran: P.pelanggaran || 0, jawaban: P.jawaban || { j: {}, r: [] }, hasil: P.hasil || null, manual: { ...(P.manual || {}) },
    catatan: P.catatan || '', percobaan: P.percobaan || 0, ver: P.ver || 0, otomatis: P.otomatis ? 1 : 0
  };
}
/** Status untuk guru: belum · mengerjakan · pending (waktu habis, jawaban perangkat belum diterima) · selesai · direset */
function statusTampil(P, t) {
  return P.status === 'mengerjakan' && (P.deadline || 0) + GRACE_MS < t ? 'pending' : P.status;
}
function dariRekam(rec) {
  const jw = rec.jawaban || { j: {}, r: [] };
  return Object.assign(rekam(rec), { nis: String(rec.nis), jawaban: jw, perangkat: '', lastSeen: rec.selesai || 0, terjawab: X.hitungTerjawab_(jw), ragu: (jw.r || []).length, syncVer: rec.ver || 0, mv: 0 });
}

/** Hanya untuk uji lokal (DEV_MODE): menghitung baris dibaca/ditulis di D1 dan di SQLite internal Durable Object. */
function pasangUkur(self) {
  const u = self.ukur = { d1r: 0, d1w: 0, d1q: 0, dor: 0, dow: 0, doq: 0 };
  const asliSql = self.sql, kursor = [];
  const lipat = n => { for (const c of kursor.splice(0, n)) { u.dor += c.rowsRead; u.dow += c.rowsWritten; } };
  self.sql = { exec: (...a) => { const c = asliSql.exec(...a); u.doq++; kursor.push(c); if (kursor.length > 4000) lipat(2000); return c; } };
  self.ukurBaca = () => { lipat(kursor.length); return { ...u }; };
  const kueri = self.ukurKueri = {};
  const catat = (r, sql) => {
    if (r && r.meta) {
      u.d1r += r.meta.rows_read || 0; u.d1w += r.meta.rows_written || 0; u.d1q++;
      const k = String(sql || '?').replace(/\s+/g, ' ').slice(0, 90), q = kueri[k] || (kueri[k] = { n: 0, r: 0, w: 0 });
      q.n++; q.r += r.meta.rows_read || 0; q.w += r.meta.rows_written || 0;
    }
    return r;
  };
  const asli = new WeakMap(), sqlNya = new WeakMap();
  const bungkus = (st, sql) => {
    const p = new Proxy(st, { get(t, k) {
      if (k === 'bind') return (...a) => bungkus(t.bind(...a), sql);
      if (k === 'all' || k === 'run') return async (...a) => catat(await t[k](...a), sql);
      if (k === 'first') return async col => { const r = catat(await t.all(), sql); const row = r.results[0] ?? null; return col ? (row ? row[col] : null) : row; };
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    asli.set(p, st); sqlNya.set(p, sql); return p;
  };
  const DB = self.env.DB;
  self.env.DB = new Proxy(DB, { get(t, k) {
    if (k === 'prepare') return sql => bungkus(t.prepare(sql), sql);
    if (k === 'batch') return async sts => { const r = await t.batch(sts.map(x => asli.get(x) || x)); r.forEach((x, i) => catat(x, sqlNya.get(sts[i]))); return r; };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
}

export class Engine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // nilai contoh "namaakun/…" di wrangler.jsonc dianggap belum diatur
    const repo = v => (v && !/^namaakun\//i.test(String(v).trim())) ? String(v).trim() : '';
    this.env = { ...env, MEDIA_REPO: repo(env.MEDIA_REPO), DATA_REPO: repo(env.DATA_REPO) };
    this.repoContoh = /^namaakun\//i.test(env.MEDIA_REPO || '') || /^namaakun\//i.test(env.DATA_REPO || '');
    this.sql = ctx.storage.sql;
    if (env.DEV_MODE === '1') pasangUkur(this);   // uji lokal: hitung baris dibaca/ditulis (D1 & penyimpanan internal)
    this.L = new Map();          // ujianId → sesi langsung
    this.memuat = new Map();
    this.bankFull = new Map();
    this.bankMemuat = new Map();
    this.sockets = new Set();
    this.antri = Promise.resolve();
    this.alarmAt = 0;
    this.siap = ctx.blockConcurrencyWhile(() => this.boot());
  }

  // ==========================================================================
  //  BOOT
  // ==========================================================================
  async boot() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS p (u TEXT NOT NULL, nis TEXT NOT NULL, d TEXT NOT NULL, PRIMARY KEY (u, nis)) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jw (u TEXT NOT NULL, b INTEGER NOT NULL, d TEXT NOT NULL, PRIMARY KEY (u, b)) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    for (const t of ['c_guru', 'c_bank', 'c_ujian', 'c_roster']) this.sql.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, d TEXT NOT NULL) WITHOUT ROWID`);
    if (this.metaGet('c_versi') === CACHE_VERSI && this.metaGet('c_secret')) this.muatDariDO();
    else { this.secret = await siapkanD1(this.env.DB); await this.muatCache(); }
    this.bdirty = new Set(parse_(this.metaGet('bdirty'), []));
    this.lastBackup = Number(this.metaGet('lastBackup') || 0);
    this.cadanganGagal = parse_(this.metaGet('cadanganGagal'), null);
    const ids = [...this.sql.exec(`SELECT DISTINCT u FROM p UNION SELECT DISTINCT u FROM jw`)].map(r => r.u);
    for (const id of ids) await this.getL(id);
    this.alarmAt = (await this.ctx.storage.getAlarm()) || 0;
    await this.aturAlarm();
  }
  /** Bangun dari tidur: semua data dasar dari penyimpanan internal (0 baris D1). */
  muatDariDO() {
    const baca = t => [...this.sql.exec(`SELECT id, d FROM ${t}`)].map(r => [r.id, JSON.parse(r.d)]);
    this.secret = this.metaGet('c_secret');
    this._config = parse_(this.metaGet('c_config'), null) || { ...X.CONFIG_DEFAULT };
    this.guru = new PetaDO(this.sql, 'c_guru', baca('c_guru'));
    this.bankIdx = new PetaDO(this.sql, 'c_bank', baca('c_bank'));
    this.ujian = new PetaDO(this.sql, 'c_ujian', baca('c_ujian'));
    this.bankFull.clear();
    this.jmlSiswa = null; this.roster = null;
  }
  get config() { return this._config; }
  set config(v) { this._config = v; if (this.sql) this.metaSet('c_config', JSON.stringify(v)); }
  async muatCache() {
    const DB = this.env.DB;
    const [c, g, b, u] = await DB.batch([
      DB.prepare(`SELECT v FROM kv WHERE k='config'`),
      DB.prepare(`SELECT data FROM guru`),
      DB.prepare(`SELECT meta FROM bank`),
      DB.prepare(`SELECT data FROM ujian`)
    ]);
    this.config = c.results[0] ? JSON.parse(c.results[0].v) : { ...X.CONFIG_DEFAULT };
    this.guru = new PetaDO(this.sql, 'c_guru', g.results.map(r => { const x = JSON.parse(r.data); return [x.id, x]; }));
    this.bankIdx = new PetaDO(this.sql, 'c_bank', b.results.map(r => { const x = JSON.parse(r.meta); return [x.id, x]; }));
    this.ujian = new PetaDO(this.sql, 'c_ujian', u.results.map(r => { const x = JSON.parse(r.data); return [x.id, x]; }));
    this.guru.tulisSemua(); this.bankIdx.tulisSemua(); this.ujian.tulisSemua();
    this.bankFull.clear();
    this.lupakanSiswa();
    this.metaSet('c_secret', this.secret); this.metaSet('c_versi', CACHE_VERSI);
  }
  metaGet(k) { const r = [...this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k)]; return r.length ? r[0].v : null; }
  metaSet(k, v) { this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, String(v)); }

  /** Kunci sederhana untuk operasi tulis guru/admin (read-modify-write ke D1). */
  kunci(fn) { const run = this.antri.then(() => fn()); this.antri = run.catch(() => {}); return run; }

  // ==========================================================================
  //  HTTP
  // ==========================================================================
  async fetch(req) {
    await this.siap;
    const url = new URL(req.url);
    if (url.pathname === '/api/ws') return this.bukaWs(url);
    if (url.pathname === '/init') return jres({ ok: true, data: this.secret });
    if (url.pathname === '/tick') {
      try { await this.rawat(); await this.cadangkanOtomatis(); } catch (e) { console.error('tick', e && e.stack || e); }
      await this.aturAlarm().catch(() => {});
      return jres({ ok: true });
    }
    let body;
    try { body = JSON.parse(await req.text()); } catch (e) { return jres({ ok: false, error: 'Format permintaan tidak valid', code: 'ERR', serverTime: now() }); }
    try {
      const fn = this.AKSI[body.action];
      if (!fn) throw new AppError('Aksi tidak dikenal: ' + body.action);
      const me = PUBLIK.has(body.action) ? null : await X.verifyToken_(body.token, this.secret);
      const data = await fn.call(this, body.data || {}, me);
      return jres({ ok: true, data: data === undefined ? null : data, serverTime: now() });
    } catch (e) {
      const i = X.errInfo(e);
      if (!(e && e.app)) console.error(body.action + ': ' + (e && e.stack || e));
      return jres({ ok: false, error: i.msg, code: i.code, serverTime: now() });
    }
  }

  async alarm() {
    this.alarmAt = 0;
    try { await this.rawat(); } catch (e) { console.error('alarm', e && e.stack || e); }
    try { await this.cadangkanOtomatis(); } catch (e) { console.error('cadangan', e && e.stack || e); }
    await this.aturAlarm();
  }
  /** Alarm hanya dipasang bila ada pekerjaan: ujian berjalan/belum tersinkron, atau cadangan GitHub tertunda.
   *  Menggantikan pemicu terjadwal tiap jam (yang membangunkan mesin ujian walau tidak ada pekerjaan). */
  async aturAlarm() {
    const t = Date.now();
    let at = this.adaKerja() ? t + ALARM_MS : 0;
    const b = this.waktuCadangan();
    if (b && (!at || b < at)) at = Math.max(b, t + 10000);
    if (!at) return;
    if (this.alarmAt && this.alarmAt > t && this.alarmAt <= at + 5000) return;
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }
  pasangAlarm() { return this.aturAlarm(); }
  adaPeserta() { for (const L of this.L.values()) for (const P of L.P.values()) if (P.status === 'mengerjakan') return true; return false; }
  waktuCadangan() {
    if (!this.env.DATA_REPO || !this.env.GITHUB_TOKEN || !this.bdirty || !this.bdirty.size) return 0;
    if (this.adaPeserta()) return 0;   // ditunda selama ujian berjalan (alarm perawatan ujian tetap jalan)
    let at = this.lastBackup + BACKUP_MS;
    if (this.cadanganGagal) at = Math.max(at, this.cadanganGagal.t + 6 * 3600000);
    return at;
  }
  adaKerja() {
    for (const L of this.L.values()) {
      if (L.dirty.size) return true;
      for (const P of L.P.values()) if (P.status === 'mengerjakan' || P.ver !== P.syncVer) return true;
    }
    return false;
  }

  // ==========================================================================
  //  DATA UJIAN, BANK, SISWA
  // ==========================================================================
  ujianWajib(id) { const u = this.ujian.get(str_(id)); if (!u) throw new AppError('Ujian tidak ditemukan'); return u; }
  ringkas(u) {
    const r = X.ringkasUjian_(u); const b = this.bankIdx.get(u.bankId); if (b) r.jumlahSoal = b.jumlahSoal;
    // nama pengawas diambil dari data guru terbaru (bila guru mengganti nama, jadwal ikut berubah)
    r.pengawas = (u.pengawas || []).map(p => { const g = this.guru.get(p.id); return { id: p.id, nama: g ? g.nama : (p.nama || '(akun dihapus)'), kelas: p.kelas || [] }; });
    return r;
  }
  /** Ringkasan untuk guru: tandai kelas yang ia awasi & apakah ia pemilik soal. Token hanya untuk pengawasnya. */
  ringkasUntuk(u, me) {
    const r = this.ringkas(u);
    if (me.r === 'admin') return r;
    const k = this.kelasAwas(me, u);
    r.awasi = u.kelas.filter(x => k.has(x)); r.pemilik = u.guruId === me.id;
    if (!k.size) r.token = '';
    return r;
  }
  /** Kelas yang diawasi akun ini pada ujian u: null = semua (admin), Set kosong = bukan pengawas. */
  kelasAwas(me, u) {
    if (me.r === 'admin') return null;
    const s = new Set();
    for (const p of u.pengawas || []) {
      if (p.id !== me.id) continue;
      const kl = (p.kelas || []).filter(k => u.kelas.includes(k));
      (kl.length ? kl : u.kelas).forEach(k => s.add(k));
    }
    return s;
  }
  /** Monitoring: admin (semua kelas) atau guru yang ditugaskan sebagai pengawas (hanya kelas yang ia awasi). */
  bolehPantau(me, u) { const k = this.kelasAwas(me, u); if (k === null || k.size) return k; throw new AppError('Anda bukan pengawas ujian ini. Pengawas ditetapkan admin di menu Jadwal ujian.'); }
  /** Hasil ujian: admin (daftar peserta saja) atau guru pemilik bank soal. */
  bolehHasil(me, u) { if (me.r === 'admin' || u.guruId === me.id) return true; throw new AppError('Anda tidak memiliki akses ke hasil ujian ini'); }
  /** Nilai, analisis, dan koreksi hanya untuk guru pemilik bank soal ujian ini (bukan admin/pengawas lain). */
  pemilikNilai(me, u) { if (u.guruId === me.id) return true; throw new AppError('Nilai hanya dapat dilihat dan dikoreksi oleh guru pemilik soal.'); }
  bolehBank(me, b) { if (me.r === 'admin' || b.guruId === me.id) return true; throw new AppError('Anda tidak memiliki akses ke bank soal ini'); }

  async getBank(id) {
    id = str_(id);
    if (this.bankFull.has(id)) return this.bankFull.get(id);
    let p = this.bankMemuat.get(id);
    if (!p) {
      p = (async () => {
        const r = await this.env.DB.prepare(`SELECT data FROM bank WHERE id = ?`).bind(id).first();
        const b = r ? JSON.parse(r.data) : null;
        if (b) { if (this.bankFull.size > 60) this.bankFull.delete(this.bankFull.keys().next().value); this.bankFull.set(id, b); }
        return b;
      })().finally(() => this.bankMemuat.delete(id));
      this.bankMemuat.set(id, p);
    }
    return p;
  }

  /** Sesi langsung satu ujian (dimuat dari SQLite DO + hasil D1). */
  async getL(id) {
    const ada = this.L.get(id);
    if (ada) return ada;
    let p = this.memuat.get(id);
    if (!p) { p = this.muatL(id).finally(() => this.memuat.delete(id)); this.memuat.set(id, p); }
    return p;
  }
  async muatL(id) {
    const L = { id, P: new Map(), mv: 1, dirty: new Set(), mons: new Set(), socks: new Map(), siswa: null };
    for (const r of this.sql.exec(`SELECT d FROM p WHERE u = ?`, id)) {
      const P = JSON.parse(r.d); P.mv = 1; P.syncVer = undefined; L.P.set(P.nis, P);
    }
    for (const r of this.sql.exec(`SELECT d FROM jw WHERE u = ?`, id)) {
      const m = JSON.parse(r.d);
      for (const nis in m) {
        const e = m[nis], P = L.P.get(nis);
        if (P && P.status === 'mengerjakan' && e.c === P.percobaan && e.t > (P.pt || 0)) {
          P.jawaban = e.j; P.pelanggaran = Math.max(P.pelanggaran || 0, e.l || 0); P.lastSeen = e.s || P.lastSeen;
          P.terjawab = X.hitungTerjawab_(e.j); P.ragu = (e.j.r || []).length; P.jt = e.t;
        }
      }
    }
    // cocokkan dengan hasil di D1 (yang sudah tersimpan / sudah dikoreksi guru)
    const r = await this.env.DB.prepare(`SELECT nis, ver, data FROM hasil WHERE ujian_id = ?`).bind(id).all();
    const diD1 = new Set();
    for (const row of r.results) {
      diD1.add(row.nis);
      const P = L.P.get(row.nis);
      if (!P) { L.P.set(row.nis, dariRekam(await X.bukaData(row.data))); continue; }
      if (row.ver === P.ver) P.syncVer = P.ver;
      else if (row.ver > P.ver && P.status === 'selesai') {
        const rec = await X.bukaData(row.data);
        Object.assign(P, { hasil: rec.hasil, manual: rec.manual || {}, catatan: rec.catatan, ver: row.ver, syncVer: row.ver });
      }
    }
    for (const P of L.P.values()) {
      if (P.syncVer === undefined && (P.status === 'direset' || P.status === 'belum' || P.status === 'mengerjakan') && !diD1.has(P.nis)) P.syncVer = P.ver;
      if (P.syncVer === undefined && P.status !== 'selesai' && P.status !== 'direset') P.syncVer = P.ver;
    }
    this.L.set(id, L);
    return L;
  }

  /** Daftar peserta (per kombinasi kelas) disimpan di memori: monitor & Hasil tidak membaca ulang D1 tiap dibuka. */
  async siswaUjian(u, L) {
    if (L && L.siswa) return L.siswa;
    const kelas = [...(u.kelas || [])].sort(), kunci = kelas.join('|');
    const c = this.roster || (this.roster = new Map());
    let p = c.get(kunci);
    const ada = !p && [...this.sql.exec(`SELECT d FROM c_roster WHERE id = ?`, kunci)][0];
    if (ada) { p = Promise.resolve(new Map(JSON.parse(ada.d).map(s => [String(s.nis), s]))); c.set(kunci, p); }
    if (!p) {
      const gen = this.rosterGen || 0;
      p = this.env.DB.prepare(`SELECT nis, nama, kelas FROM siswa WHERE kelas IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(kelas)).all()
        .then(r => {
          if ((this.rosterGen || 0) === gen) this.sql.exec(`INSERT OR REPLACE INTO c_roster (id, d) VALUES (?, ?)`, kunci, JSON.stringify(r.results));
          return new Map(r.results.map(s => [String(s.nis), s]));
        });
      p.catch(() => { if (c.get(kunci) === p) c.delete(kunci); });
      c.set(kunci, p);
      if (c.size > 40) c.delete(c.keys().next().value);
    }
    const m = await p;
    if (L) L.siswa = m;
    return m;
  }
  lupakanSiswa() {
    this.jmlSiswa = null; this.roster = null; this.rosterGen = (this.rosterGen || 0) + 1;
    this.metaSet('c_jml', ''); this.sql.exec(`DELETE FROM c_roster`);
    for (const L of this.L.values()) L.siswa = null;
  }

  // ==========================================================================
  //  PENYIMPANAN SESI
  // ==========================================================================
  persistP(L, P) {
    P.pt = now();
    const o = rekam(P); o.perangkat = P.perangkat || ''; o.lastSeen = P.lastSeen || 0; o.terjawab = P.terjawab || 0; o.ragu = P.ragu || 0; o.pt = P.pt;
    this.sql.exec(`INSERT OR REPLACE INTO p (u, nis, d) VALUES (?, ?, ?)`, L.id, P.nis, JSON.stringify(o));
  }
  ubah(L, P) { P.mv = ++L.mv; }

  flushJw() {
    this.jwT = now();
    for (const L of this.L.values()) {
      if (!L.dirty.size) continue;
      const per = new Map(); for (const b of L.dirty) per.set(b, {});
      for (const P of L.P.values()) {
        if (P.status !== 'mengerjakan') continue;
        const o = per.get(ember(P.nis));
        if (o) o[P.nis] = { c: P.percobaan, j: P.jawaban, l: P.pelanggaran, s: P.lastSeen, t: P.jt || now() };
      }
      for (const [b, o] of per) {
        if (Object.keys(o).length) this.sql.exec(`INSERT OR REPLACE INTO jw (u, b, d) VALUES (?, ?, ?)`, L.id, b, JSON.stringify(o));
        else this.sql.exec(`DELETE FROM jw WHERE u = ? AND b = ?`, L.id, b);
      }
      L.dirty.clear();
    }
  }

  jadwalSync(ms) {
    if (this.tSync) return;
    this.tSync = setTimeout(() => { this.tSync = null; this.syncD1().catch(e => console.error('sync', e && e.stack || e)); }, ms || 1500);
  }
  /** Kirim hasil selesai/direset ke D1 secara berkelompok (json_each: ratusan baris per query). */
  async syncD1() {
    if (this.syncJalan) { this.syncLagi = true; return this.syncJalan; }
    this.syncJalan = (async () => {
      const tulis = [], hapus = [], tanda = [], ujianBerubah = new Set();
      for (const L of this.L.values()) for (const P of L.P.values()) {
        if (P.ver === P.syncVer) continue;
        if (P.status === 'selesai') tulis.push({ u: L.id, n: P.nis, s: P.otomatis ? 'otomatis' : 'selesai', v: P.hasil ? P.hasil.nilai : null, p: P.hasil ? P.hasil.perluKoreksi : 0, r: P.ver, d: await X.kemasData(rekam(P)) });
        else if (P.status === 'direset') hapus.push({ u: L.id, n: P.nis });
        else { P.syncVer = P.ver; continue; }
        tanda.push([L, P, P.ver]); ujianBerubah.add(L.id);
      }
      if (!tanda.length) return 0;
      await this.tulisHasilD1(tulis, hapus);
      for (const [L, P, v] of tanda) if (P.ver === v) { P.syncVer = v; this.ubah(L, P); }
      ujianBerubah.forEach(id => this.tandaiCadangan('hasil:' + id));
      return tanda.length;
    })().finally(() => { this.syncJalan = null; if (this.syncLagi) { this.syncLagi = false; this.jadwalSync(300); } });
    return this.syncJalan;
  }
  async tulisHasilD1(tulis, hapus) {
    const DB = this.env.DB, st = [];
    for (const g of potong(tulis, 800000)) {
      st.push(DB.prepare(`INSERT INTO hasil (ujian_id, nis, status, nilai, perlu, ver, data)
        SELECT json_extract(value,'$.u'), json_extract(value,'$.n'), coalesce(json_extract(value,'$.s'), 'selesai'), json_extract(value,'$.v'), json_extract(value,'$.p'), json_extract(value,'$.r'), json_extract(value,'$.d') FROM json_each(?) WHERE true
        ON CONFLICT(ujian_id, nis) DO UPDATE SET status=excluded.status, nilai=excluded.nilai, perlu=excluded.perlu, ver=excluded.ver, data=excluded.data WHERE excluded.ver >= hasil.ver`).bind(JSON.stringify(g)));
    }
    for (const g of potong(hapus, 800000)) {
      st.push(DB.prepare(`DELETE FROM hasil WHERE (ujian_id, nis) IN (SELECT json_extract(value,'$.u'), json_extract(value,'$.n') FROM json_each(?))`).bind(JSON.stringify(g)));
    }
    for (let i = 0; i < st.length; i += 20) await DB.batch(st.slice(i, i + 20));
  }
  /** Tulis rekam (koreksi / hitung ulang) langsung ke D1 lalu samakan dengan sesi langsung. */
  async tulisRekam(ujianId, recs) {
    const baris = [];
    for (const rec of recs) baris.push({ u: ujianId, n: rec.nis, s: rec.otomatis ? 'otomatis' : 'selesai', v: rec.hasil ? rec.hasil.nilai : null, p: rec.hasil ? rec.hasil.perluKoreksi : 0, r: rec.ver, d: await X.kemasData(rec) });
    await this.tulisHasilD1(baris, []);
    const L = this.L.get(ujianId);
    if (L) for (const rec of recs) {
      const P = L.P.get(rec.nis);
      if (P && P.status === 'selesai') { P.hasil = rec.hasil; P.manual = rec.manual; P.ver = rec.ver; P.syncVer = rec.ver; this.ubah(L, P); }
    }
    this.tandaiCadangan('hasil:' + ujianId);
  }

  // ==========================================================================
  //  PERAWATAN: kumpul otomatis, cadangan jawaban, sinkron, bersih-bersih
  // ==========================================================================
  async rawat() {
    const t = now();
    for (const L of [...this.L.values()]) {
      const u = this.ujian.get(L.id);
      for (const P of L.P.values()) {
        if (P.status !== 'mengerjakan' || (P.deadline || 0) + GRACE_MS >= t) continue;
        // waktu habis tetapi jawaban dari perangkat belum datang → Pending (perangkat mengirim saat tersambung lagi)
        if (!P.tandaPending) { P.tandaPending = 1; this.ubah(L, P); }
        if (u && t > Math.max(P.deadline, u.selesai) + PENDING_MS) {
          const bank = await this.getBank(u.bankId);
          if (bank) this.finalisasi(L, P, u, bank, 'otomatis: jawaban perangkat belum terkirim, dinilai dari cadangan terakhir', true);
        }
      }
    }
    if (t - (this.jwT || 0) >= JW_FLUSH_MS) this.flushJw();
    await this.syncD1();
    // sesi ujian yang sudah ditutup & tersinkron dilepas dari memori
    for (const L of [...this.L.values()]) {
      const u = this.ujian.get(L.id);
      if (u && t < u.selesai + GRACE_MS + 10 * 60000) continue;
      if (L.mons.size || L.socks.size) continue;
      let sisa = false;
      for (const P of L.P.values()) if (P.status === 'mengerjakan' || P.ver !== P.syncVer) { sisa = true; break; }
      if (sisa) continue;
      this.sql.exec(`DELETE FROM p WHERE u = ?`, L.id);
      this.sql.exec(`DELETE FROM jw WHERE u = ?`, L.id);
      this.L.delete(L.id);
    }
  }

  finalisasi(L, P, u, bank, catatan, otomatis) {
    const t = now();
    P.status = 'selesai'; P.selesai = t; P.otomatis = otomatis ? 1 : 0; P.tandaPending = 0;
    P.hasil = X.hitungHasil_(bank, P.jawaban, P.manual);
    P.catatan = catatan || P.catatan || '';
    P.ver = t; P.lastSeen = t;
    this.persistP(L, P);
    this.ubah(L, P);
    L.dirty.add(ember(P.nis));
    this.jadwalSync(1500);
    const info = this.infoSelesai(P, u);
    const set = L.socks.get(P.nis);
    if (set) for (const ws of [...set]) {
      kirim(ws, { t: 'selesai', data: info });
      this.akhiriIkatan(ws, 1000, 'selesai', 3000);
    }
    return info;
  }
  infoSelesai(P, u) {
    const res = { status: 'selesai', selesai: P.selesai, catatan: P.catatan || '' };
    if (u && u.tampilNilai && P.hasil) { res.nilai = P.hasil.nilai; res.benar = P.hasil.benar; res.jumlahSoal = P.hasil.jumlahSoal; res.perluKoreksi = P.hasil.perluKoreksi; }
    return res;
  }
  cekPerangkat(P, perangkat) {
    if (P.perangkat && perangkat && P.perangkat !== perangkat) throw new AppError('Ujian ini sedang dikerjakan di perangkat lain. Minta pengawas melakukan "Reset login".', 'PERANGKAT');
  }
  tendangLain(L, nis, perangkat) {
    const set = L.socks.get(nis);
    if (set) for (const ws of [...set]) if (ws.info.s && ws.info.s.perangkat !== perangkat) {
      kirim(ws, { t: 'err', k: 'ikut', code: 'PERANGKAT', msg: 'Ujian ini dilanjutkan di perangkat lain.' });
      this.akhiriIkatan(ws, 4001, 'perangkat lain');
      set.delete(ws);
    }
  }

  // ==========================================================================
  //  INTI SISWA (dipakai WebSocket maupun HTTP)
  // ==========================================================================
  async mulaiInti(me, d) {
    const u = this.ujianWajib(d.ujianId);
    const t = now();
    if (!u.aktif || (u.kelas || []).indexOf(me.k) < 0) throw new AppError('Anda tidak terdaftar sebagai peserta ujian ini');
    if (t < u.mulai) throw new AppError('Ujian belum dibuka');
    const perangkat = str_(d.perangkat, 60);
    const L = await this.getL(u.id);
    let P = L.P.get(me.id);
    if (P && P.status === 'selesai') throw new AppError('Anda sudah menyelesaikan ujian ini', 'SELESAI');
    if (t > u.selesai && !(P && P.status === 'mengerjakan')) throw new AppError('Waktu ujian sudah ditutup');
    if (u.pakaiToken && str_(d.token).trim().toUpperCase() !== String(u.token).toUpperCase()) throw new AppError('Token ujian salah', 'TOKEN');
    const bank = await this.getBank(u.bankId);
    if (!bank) throw new AppError('Bank soal ujian tidak ditemukan. Hubungi admin.');
    P = L.P.get(me.id); // bisa berubah selama menunggu
    if (!P) { P = { nis: me.id, nama: me.n, kelas: me.k, status: 'belum', percobaan: 0, ver: 0, syncVer: 0, mv: 0 }; L.P.set(me.id, P); }
    if (P.status === 'selesai') throw new AppError('Anda sudah menyelesaikan ujian ini', 'SELESAI');
    if (P.status === 'mengerjakan') {
      this.cekPerangkat(P, perangkat);
      if (t > P.deadline + GRACE_MS) {
        this.finalisasi(L, P, u, bank, 'waktu habis');
        throw new AppError('Waktu pengerjaan Anda sudah habis. Jawaban terakhir telah dikirim.', 'SELESAI');
      }
      if (!P.perangkat && perangkat) { P.perangkat = perangkat; this.persistP(L, P); this.tendangLain(L, me.id, perangkat); }
    } else {
      Object.assign(P, {
        status: 'mengerjakan', mulai: t, deadline: Math.min(t + u.durasi * 60000, u.selesai), percobaan: (P.percobaan || 0) + 1,
        jawaban: { j: {}, r: [] }, pelanggaran: 0, hasil: null, manual: {}, selesai: 0, catatan: '', terjawab: 0, ragu: 0,
        perangkat, lastSeen: t, nama: me.n, kelas: me.k, jt: 0
      });
      this.persistP(L, P);
      this.tendangLain(L, me.id, perangkat);
      this.pasangAlarm().catch(e => console.error('alarm', e));
    }
    this.ubah(L, P);
    return {
      ujian: { id: u.id, nama: u.nama, mapel: u.mapel, durasi: u.durasi, maxPelanggaran: u.maxPelanggaran, tampilNilai: u.tampilNilai, keterangan: u.keterangan },
      soal: X.soalUntukSiswa_(u, bank, me.id, P.percobaan),
      mulai: P.mulai, deadline: P.deadline, jawaban: P.jawaban, pelanggaran: P.pelanggaran
    };
  }

  /** Autosave. viaHttp=true → langsung ditulis permanen (cadangan bila WebSocket tidak tersedia). */
  simpanInti(L, me, d, viaHttp) {
    const P = L.P.get(me.id);
    if (!P) throw new AppError('Data peserta tidak ditemukan');
    const u = this.ujian.get(L.id);
    if (P.status === 'selesai') return this.infoSelesai(P, u);
    if (P.status !== 'mengerjakan') return { status: P.status };
    if (d.mulai && Number(d.mulai) !== P.mulai) return { status: 'direset' };
    this.cekPerangkat(P, str_(d.perangkat, 60));
    const t = now();
    const jw = X.bersihJawaban_(d.jawaban);
    P.jawaban = jw; P.jt = t;
    P.pelanggaran = Math.max(P.pelanggaran || 0, Math.round(num_(d.pelanggaran, 0)));
    P.terjawab = X.hitungTerjawab_(jw); P.ragu = (jw.r || []).length; P.lastSeen = t;
    if (t > P.deadline + GRACE_MS) {
      return null; // pemanggil akan memfinalisasi (butuh bank)
    }
    if (viaHttp) this.persistP(L, P); else L.dirty.add(ember(P.nis));
    return { status: 'mengerjakan', deadline: P.deadline };
  }

  async selesaiInti(L, me, d) {
    const P = L.P.get(me.id);
    if (!P) throw new AppError('Data peserta tidak ditemukan');
    const u = this.ujianWajib(L.id);
    const mulai = Number(d.mulai) || 0;
    if (mulai && P.mulai !== mulai && P.status !== 'selesai') throw new AppError('Ujian Anda telah direset oleh pengawas. Silakan mulai lagi.', 'DIRESET');
    // dinilai otomatis karena perangkat lama tidak tersambung → jawaban perangkat yang datang belakangan tetap dipakai
    const susulan = () => P.status === 'selesai' && P.otomatis && mulai && P.mulai === mulai;
    if (P.status === 'mengerjakan' || susulan()) {
      this.cekPerangkat(P, str_(d.perangkat, 60));
      const bank = await this.getBank(u.bankId);
      if (!bank) throw new AppError('Bank soal ujian tidak ditemukan. Hubungi admin.');
      if (P.status !== 'mengerjakan' && !susulan()) return this.infoSelesai(P, u);
      const t = now();
      P.jawaban = X.bersihJawaban_(d.jawaban);
      P.pelanggaran = Math.max(P.pelanggaran || 0, Math.round(num_(d.pelanggaran, 0)));
      P.terjawab = X.hitungTerjawab_(P.jawaban); P.ragu = (P.jawaban.r || []).length;
      const cat = [];
      if (d.alasan) cat.push(str_(d.alasan, 60));
      if (t > P.deadline + GRACE_MS) cat.push('terkirim ' + Math.max(1, Math.round((t - P.deadline) / 60000)) + ' menit setelah waktu habis');
      return this.finalisasi(L, P, u, bank, cat.join(', '));
    }
    if (P.status !== 'selesai') throw new AppError('Ujian Anda telah direset oleh pengawas. Silakan mulai lagi.', 'DIRESET');
    return this.infoSelesai(P, u);
  }

  // ==========================================================================
  //  WEBSOCKET
  //  ?r=1  → soket tunggal aplikasi (dibuka sekali per halaman = 1 request kuota).
  //          Semua aksi lewat pesan {t:'rpc'}; ikut ujian {t:'ikut'}; monitor {t:'pantau'}; {t:'lepas'}.
  //  ?u=…  → soket ujian lama (siswa), ?m=… → soket monitor lama (guru) — tetap didukung.
  // ==========================================================================
  bukaWs(url) {
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    this.sockets.add(ws);
    const rpc = url.searchParams.get('r') === '1';
    ws.info = { rpc, s: null, m: null, t0: Date.now(), last: Date.now(), potong: null };
    ws.addEventListener('message', ev => { this.pesan(ws, ev.data).catch(e => console.error('ws', e && e.stack || e)); });
    const tutup = () => this.lepasWs(ws);
    ws.addEventListener('close', tutup);
    ws.addEventListener('error', tutup);
    ws.siap = rpc ? Promise.resolve() : this.sambut(ws, url);
    this.mulaiDenyut();
    return new Response(null, { status: 101, webSocket: client });
  }
  /** Soket lama: identitas dari alamat. */
  async sambut(ws, url) {
    try {
      const me = await X.verifyToken_(url.searchParams.get('t'), this.secret);
      const mId = url.searchParams.get('m');
      if (mId) await this.pantau(ws, me, mId);
      else await this.ikutUjian(ws, me, url.searchParams.get('u'), str_(url.searchParams.get('p'), 60));
    } catch (e) {
      const i = X.errInfo(e);
      kirim(ws, { t: 'err', code: i.code, msg: i.msg });
      try { ws.close(i.code === 'PERANGKAT' ? 4001 : 4000, i.code); } catch (e2) {}
    }
  }
  /** Hubungkan soket ke sesi ujian siswa (untuk autosave & pemberitahuan langsung). */
  async ikutUjian(ws, me, uId, perangkat) {
    X.reqSiswa_(me);
    const u = this.ujianWajib(uId);
    const L = await this.getL(u.id);
    if (!this.sockets.has(ws)) return;
    const P = L.P.get(me.id);
    if (!P || P.status !== 'mengerjakan') {
      kirim(ws, P && P.status === 'selesai' ? { t: 'selesai', data: this.infoSelesai(P, u) } : { t: 'status', status: P ? P.status : 'belum' });
      if (!ws.info.rpc) try { ws.close(1000, 'bukan sesi aktif'); } catch (e) {}
      return;
    }
    this.cekPerangkat(P, perangkat);
    if (!P.perangkat && perangkat) { P.perangkat = perangkat; this.persistP(L, P); }
    this.lepasIkatan(ws);
    this.tendangLain(L, me.id, perangkat);
    ws.info.s = { L, me, perangkat, u };
    let set = L.socks.get(me.id);
    if (!set) L.socks.set(me.id, set = new Set());
    set.add(ws);
    P.lastSeen = now();
    kirim(ws, { t: 'hai', now: now(), deadline: P.deadline, status: P.status });
  }
  /** Hubungkan soket guru ke monitor satu ujian. */
  async pantau(ws, me, mId) {
    X.reqGuru_(me);
    const u = this.ujianWajib(mId);
    const kelas = this.bolehPantau(me, u);
    const L = await this.getL(u.id);
    const snap = await this.monitorPayload(L, u, kelas, me);
    if (!this.sockets.has(ws)) return;
    this.lepasIkatan(ws);
    ws.info.m = { L, me, kelas }; ws.mv = L.mv;
    L.mons.add(ws);
    if (ws.info.rpc) kirimBesar(ws, { t: 'snap', id: 'snap' + (++this.nomorSnap || (this.nomorSnap = 1)), data: snap, now: now() });
    else kirim(ws, { t: 'snap', data: snap, now: now() });
  }
  lepasIkatan(ws) {
    const inf = ws.info;
    if (!inf) return;
    if (inf.m) { inf.m.L.mons.delete(ws); inf.m = null; }
    if (inf.s) {
      const { L, me } = inf.s;
      const set = L.socks.get(me.id);
      if (set) { set.delete(ws); if (!set.size) L.socks.delete(me.id); }
      inf.s = null;
    }
  }
  /** Ujian selesai / direset / pindah perangkat: soket tunggal cukup dilepas, soket lama ditutup. */
  akhiriIkatan(ws, kode, alasan, jeda) {
    if (ws.info && ws.info.rpc) return this.lepasIkatan(ws);
    const tutup = () => { try { ws.close(kode || 1000, alasan || ''); } catch (e) {} };
    if (jeda) setTimeout(tutup, jeda); else tutup();
  }
  async pesan(ws, data) {
    await ws.siap;
    const inf = ws.info;
    if (!inf || typeof data !== 'string' || data.length > 1200000) return;
    inf.last = Date.now();
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.t === 'pt') {                       // potongan pesan besar (bank soal, gambar, impor)
      if (!inf.rpc) return;
      const pot = inf.potong || (inf.potong = new Map());
      let b = pot.get(m.id);
      if (!b) {
        if (pot.size >= 8 || !(m.n > 1 && m.n <= 30)) return;
        pot.set(m.id, b = { n: m.n, a: [], k: 0 });
      }
      if (typeof m.s !== 'string' || !(m.i >= 0 && m.i < b.n) || b.a[m.i] !== undefined) return;
      b.a[m.i] = m.s; b.k++;
      if (b.k < b.n) return;
      pot.delete(m.id);
      try { m = JSON.parse(b.a.join('')); } catch (e) { return; }
      if (!m || m.t === 'pt') return;
    }
    if (m.t === 'rpc') return this.prosesRpc(ws, m);
    if (m.t === 'ikut' || m.t === 'pantau') {
      try {
        const me = await X.verifyToken_(m.tok, this.secret);
        if (m.t === 'ikut') await this.ikutUjian(ws, me, m.u, str_(m.p, 60));
        else await this.pantau(ws, me, m.m);
      } catch (e) {
        const i = X.errInfo(e);
        kirim(ws, { t: 'err', k: m.t, code: i.code, msg: i.msg });
      }
      return;
    }
    if (m.t === 'lepas') return this.lepasIkatan(ws);
    if (m.t !== 'j' && m.t !== 'selesai') return;
    const s = inf.s;
    if (!s) { kirim(ws, { t: 'perlu_ikut', id: m.id }); return; }   // mis. setelah server dimulai ulang
    try {
      if (m.t === 'j') {
        let r = this.simpanInti(s.L, s.me, { jawaban: m.j, pelanggaran: m.p, perangkat: s.perangkat, mulai: m.mulai }, false);
        if (r === null) { const bank = await this.getBank(s.u.bankId); r = this.finalisasi(s.L, s.L.P.get(s.me.id), s.u, bank, 'waktu habis'); }
        kirim(ws, { t: 'ok', v: m.v, now: now(), ...r });
      } else {
        const r = await this.selesaiInti(s.L, s.me, { jawaban: m.j, pelanggaran: m.p, alasan: m.a, perangkat: s.perangkat, mulai: m.mulai });
        kirim(ws, { t: 'hasil', id: m.id, data: r });
      }
    } catch (e) {
      const i = X.errInfo(e);
      kirim(ws, { t: 'err', k: 'ikut', id: m.id, code: i.code, msg: i.msg });
      if (i.code === 'PERANGKAT') this.akhiriIkatan(ws, 4001, 'perangkat');
    }
  }
  /** Satu aksi lewat soket — sama persis dengan HTTP, tanpa menambah request kuota. */
  async prosesRpc(ws, m) {
    let res;
    try {
      const fn = this.AKSI[m.a];
      if (!fn) throw new AppError('Aksi tidak dikenal: ' + m.a);
      const me = PUBLIK.has(m.a) ? null : await X.verifyToken_(m.tok, this.secret);
      const data = await fn.call(this, m.d || {}, me);
      res = { t: 'res', id: m.id, ok: true, data: data === undefined ? null : data, now: now() };
    } catch (e) {
      const i = X.errInfo(e);
      if (!(e && e.app)) console.error(m.a + ': ' + (e && e.stack || e));
      res = { t: 'res', id: m.id, ok: false, error: i.msg, code: i.code, now: now() };
    }
    kirimBesar(ws, res);
  }
  lepasWs(ws) {
    if (!this.sockets.delete(ws)) return;
    this.lepasIkatan(ws);
    if (!this.sockets.size) this.hentiDenyut();
  }
  mulaiDenyut() {
    if (this.tDenyut) return;
    this.ketukan = 0;
    this.tDenyut = setInterval(() => this.denyut(), DENYUT_MS);
  }
  hentiDenyut() {
    if (this.tDenyut) { clearInterval(this.tDenyut); this.tDenyut = null; }
    if (this.adaKerja()) this.pasangAlarm().catch(() => {});
  }
  denyut() {
    const t = now(); this.ketukan++;
    for (const L of this.L.values()) {
      for (const ws of L.mons) {
        if (ws.mv >= L.mv) continue;
        const rows = [], kl = ws.info && ws.info.m && ws.info.m.kelas;   // pengawas: hanya kelas yang diawasi
        for (const P of L.P.values()) if (P.mv > ws.mv && (!kl || kl.has(P.kelas))) rows.push(this.monRow(L, P));
        ws.mv = L.mv;
        if (rows.length) kirim(ws, { t: 'diff', rows, now: t });
      }
    }
    if (this.ketukan % 10 === 0) {         // ±40 detik: jaga koneksi tetap hidup + sinkron jam
      const msg = JSON.stringify({ t: 'tik', now: t }), skrg = Date.now();
      for (const ws of [...this.sockets]) {
        try { ws.send(msg); } catch (e) {}
        const inf = ws.info; if (!inf) continue;
        const diam = skrg - (inf.last || inf.t0);
        // soket yang lama tidak dipakai ditutup; aplikasi menyambung lagi saat dibutuhkan
        const tutup = inf.rpc ? ((!inf.s && !inf.m && diam > 3 * 3600000) || (inf.m && diam > 6 * 3600000)) : (inf.m && skrg - inf.t0 > 4 * 3600000);
        if (tutup) try { ws.close(1000, 'diam'); } catch (e) {}
      }
    }
    if (this.ketukan % 8 === 0) this.rawat().catch(e => console.error('rawat', e && e.stack || e));
  }

  /** Monitor cukup status (belum / mengerjakan / pending / selesai) — dikirim hanya saat status berubah. */
  monRow(L, P) {
    return {
      nis: P.nis, nama: P.nama, kelas: P.kelas, status: statusTampil(P, now()), mulai: P.mulai || 0, deadline: P.deadline || 0, selesai: P.selesai || 0,
      catatan: P.catatan || '', adaPerangkat: !!P.perangkat
    };
  }
  /** kelas: null = semua kelas (admin); Set = hanya kelas yang diawasi pengawas ini. */
  async monitorPayload(L, u, kelas, me) {
    const siswa = await this.siswaUjian(u, L);
    const ok = k => !kelas || kelas.has(k);
    const peserta = [];
    for (const [nis, s] of siswa) {
      if (!ok(s.kelas)) continue;
      const P = L.P.get(nis);
      peserta.push(P ? this.monRow(L, P) : { nis, nama: s.nama, kelas: s.kelas, status: 'belum', mulai: 0, deadline: 0, selesai: 0, catatan: '', adaPerangkat: false });
    }
    for (const P of L.P.values()) if (!siswa.has(P.nis) && ok(P.kelas)) peserta.push(this.monRow(L, P));
    const uj = this.ringkas(u);
    if (kelas) uj.kelas = u.kelas.filter(k => kelas.has(k));
    return { ujian: uj, peserta, serverTime: now(), pemilik: !!me && u.guruId === me.id, semuaKelas: !kelas };
  }

  // ==========================================================================
  //  CADANGAN GITHUB (opsional, bila DATA_REPO diisi)
  // ==========================================================================
  tandaiCadangan(k) {
    if (!this.env.DATA_REPO || this.bdirty.has(k)) return;
    this.bdirty.add(k);
    this.metaSet('bdirty', JSON.stringify([...this.bdirty]));
    this.aturAlarm().catch(() => {});
  }
  async cadangkanOtomatis() {
    if (!this.env.DATA_REPO || !this.env.GITHUB_TOKEN || !this.bdirty.size) return null;
    if (Date.now() - this.lastBackup < BACKUP_MS) return null;
    // tunda selama ada siswa yang sedang mengerjakan (dicadangkan setelah ujian selesai)
    if (this.adaPeserta()) return null;
    // gagal (mis. token salah) → jangan dicoba tiap pemicu, tunggu 6 jam atau sampai admin menekan tombol cadangkan
    if (this.cadanganGagal && Date.now() - this.cadanganGagal.t < 6 * 3600000) return null;
    try { const r = await this.cadangkan(); this.cadanganGagal = null; this.metaSet('cadanganGagal', ''); return r; }
    catch (e) {
      this.cadanganGagal = { t: Date.now(), pesan: X.errInfo(e).msg.slice(0, 300) };
      this.metaSet('cadanganGagal', JSON.stringify(this.cadanganGagal));
      throw e;
    }
  }
  async cadangkan() {
    const repo = await cekRepoData(this.env);
    const keys = [...this.bdirty].slice(0, 30), files = {}, DB = this.env.DB;
    for (const k of keys) {
      if (k === 'config') files['config.json'] = JSON.stringify(this.config, null, 1);
      else if (k === 'guru') files['users/guru.json'] = JSON.stringify([...this.guru.values()], null, 1);
      else if (k === 'siswa') files['users/siswa.json'] = JSON.stringify((await DB.prepare(`SELECT nis, nama, kelas, salt, hash FROM siswa`).all()).results, null, 1);
      else if (k === 'ujian') files['ujian/_index.json'] = JSON.stringify([...this.ujian.values()], null, 1);
      else if (k === 'bankidx') files['bank/_index.json'] = JSON.stringify([...this.bankIdx.values()], null, 1);
      else if (k.startsWith('bank:')) { const b = await this.getBank(k.slice(5)); files['bank/' + k.slice(5) + '.json'] = b ? JSON.stringify(b, null, 1) : null; }
      else if (k.startsWith('hasil:')) {
        const id = k.slice(6), u = this.ujian.get(id);
        const r = await DB.prepare(`SELECT nis, data FROM hasil WHERE ujian_id = ?`).bind(id).all();
        const arsip = { ujianId: id, nama: u ? u.nama : '', mapel: u ? u.mapel : '', bankId: u ? u.bankId : '', peserta: {}, diperbarui: now() };
        for (const x of r.results) arsip.peserta[x.nis] = await X.bukaData(x.data);
        files['hasil/' + id + '.json'] = JSON.stringify(arsip);
      }
    }
    if (keys.length) await commitFiles(this.env, repo, files, 'Cadangan CBT: ' + keys.length + ' berkas');
    keys.forEach(k => this.bdirty.delete(k));
    this.lastBackup = Date.now();
    this.metaSet('bdirty', JSON.stringify([...this.bdirty]));
    this.metaSet('lastBackup', this.lastBackup);
    return { berkas: keys.length, sisa: this.bdirty.size };
  }
}

// ============================================================================
//  DAFTAR AKSI (HTTP)
// ============================================================================
const A = Engine.prototype.AKSI = {};

A._dev = async function (d) {
  if (this.env.DEV_MODE !== '1') throw new AppError('Tidak tersedia');
  if (d.offset !== undefined) X.setOffset(d.offset);
  if (d.rawat) await this.rawat();
  if (d.flush) { this.flushJw(); await this.syncD1(); }
  if (d.ukuranHasil) return { hasil: await this.env.DB.prepare(`SELECT COUNT(*) AS n, AVG(length(data)) AS rata, SUM(length(data)) AS total FROM hasil`).first(), db: await ukuranD1(this.env.DB) };
  const ukur = this.ukurBaca ? this.ukurBaca() : null;
  if (d.perKueri && this.ukurKueri) { const k = { ...this.ukurKueri }; if (d.ukurNol) for (const x in this.ukurKueri) delete this.ukurKueri[x]; return { ukur, kueri: k }; }
  if (d.ukurNol && this.ukur) Object.keys(this.ukur).forEach(k => { this.ukur[k] = 0; });
  return { offset: d.offset, sockets: this.sockets.size, live: this.L.size, ukur };
};

// ---------------------------------------------------------------- masuk & daftar (juga tersedia lewat soket tunggal)
function cekGagal(self, k) {
  const g = self.gagalLogin && self.gagalLogin.get(k);
  if (g && g.n >= 8 && now() - g.t < 600000) throw new AppError('Terlalu banyak percobaan masuk. Tunggu 10 menit lalu coba lagi.');
}
function catatGagal(self, k) {
  const map = self.gagalLogin || (self.gagalLogin = new Map());
  if (map.size > 20000) map.clear();
  const g = map.get(k), t = now();
  if (!g || t - g.t > 600000) map.set(k, { n: 1, t }); else { g.n++; g.t = t; }
}
A.ping = async function () {
  const c = this.config;
  return { app: 'CBT Sekolah', versi: X.VERSI, namaSekolah: c.namaSekolah, logo: c.logo || '', tahunAjaran: c.tahunAjaran, semester: c.semester };
};
A.getConfig = async function () { return this.config; };
A.loginSiswa = async function (d) {
  const nis = str_(d.nis, 40).trim(), k = 's:' + nis;
  cekGagal(this, k);
  const sw = await this.env.DB.prepare(`SELECT nis, nama, kelas, salt, hash FROM siswa WHERE nis = ?`).bind(nis).first();
  if (!sw || !(await X.cekPw_(sw, d.password))) { catatGagal(this, k); throw new AppError('NIS atau kata sandi salah'); }
  const token = await X.signToken_({ r: 'siswa', id: String(sw.nis), n: sw.nama, k: sw.kelas, exp: now() + X.TOKEN_SISWA_JAM * 3600000 }, this.secret);
  return { token, user: { nis: String(sw.nis), nama: sw.nama, kelas: sw.kelas }, sekolah: { namaSekolah: this.config.namaSekolah, logo: this.config.logo || '' } };
};
A.loginGuru = async function (d) {
  const username = str_(d.username, 60).trim().toLowerCase(), k = 'g:' + username;
  cekGagal(this, k);
  const u = [...this.guru.values()].find(g => g.username === username);
  if (!u || !(await X.cekPw_(u, d.password))) { catatGagal(this, k); throw new AppError('Nama pengguna atau kata sandi salah'); }
  if (u.aktif === false) throw new AppError('Akun dinonaktifkan. Hubungi admin.');
  const role = u.role === 'admin' ? 'admin' : 'guru';
  const token = await X.signToken_({ r: role, id: u.id, n: u.nama, exp: now() + X.TOKEN_GURU_JAM * 3600000 }, this.secret);
  return { token, user: { id: u.id, username: u.username, nama: u.nama, role, mapel: u.mapel || [] }, config: this.config };
};
A.ujianSaya = async function (d, me) {
  X.reqSiswa_(me);
  const t = now();
  const list = [...this.ujian.values()]
    .filter(u => u.aktif && (u.kelas || []).indexOf(me.k) >= 0 && X.ujianHariIni_(u, t))   // hanya jadwal hari ini
    .sort((a, b) => a.mulai - b.mulai);
  const st = {}, cariD1 = [];
  for (const u of list) {
    const L = this.L.get(u.id);
    if (!L) { cariD1.push(u.id); continue; }
    const P = L.P.get(me.id);
    if (P && (P.status === 'selesai' || P.status === 'mengerjakan')) st[u.id] = { status: P.status, nilai: P.hasil ? P.hasil.nilai : null, perlu: P.hasil ? P.hasil.perluKoreksi : 0, oto: P.otomatis };
  }
  if (cariD1.length) {
    const r = await this.env.DB.prepare(`SELECT ujian_id, nilai, perlu, (status = 'otomatis') AS oto FROM hasil WHERE nis = ?1 AND ujian_id IN (SELECT value FROM json_each(?2))`).bind(me.id, JSON.stringify(cariD1)).all();
    r.results.forEach(x => { st[x.ujian_id] = { status: 'selesai', nilai: x.nilai, perlu: x.perlu, oto: x.oto }; });
  }
  return list.map(u => {
    const h = st[u.id], b = this.bankIdx.get(u.bankId);
    const item = {
      id: u.id, nama: u.nama, mapel: u.mapel, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi,
      jumlahSoal: b ? b.jumlahSoal : u.jumlahSoal, pakaiToken: u.pakaiToken, keterangan: u.keterangan,
      jadwal: t < u.mulai ? 'akan' : t > u.selesai ? 'selesai' : 'berlangsung', status: h ? h.status : 'belum'
    };
    if (h && h.status === 'selesai' && u.tampilNilai) { item.nilai = h.nilai; item.perluKoreksi = h.perlu; }
    if (h && h.status === 'selesai' && h.oto) item.susulan = true;   // dinilai otomatis: jawaban dari perangkat masih diterima
    return item;
  });
};

// ---------------------------------------------------------------- umum
A.gantiPassword = async function (d, me) {
  const baru = str_(d.baru);
  if (baru.length < 6) throw new AppError('Kata sandi baru minimal 6 karakter');
  return this.kunci(async () => {
    const DB = this.env.DB;
    if (me.r === 'siswa') {
      const s = await DB.prepare(`SELECT salt, hash FROM siswa WHERE nis = ?`).bind(me.id).first();
      if (!s || !(await X.cekPw_(s, d.lama))) throw new AppError('Kata sandi lama salah');
      const cr = await X.makeCred_(baru);
      await DB.prepare(`UPDATE siswa SET salt = ?, hash = ?, sandi = '-' WHERE nis = ?`).bind(cr.salt, cr.hash, me.id).run();
      this.tandaiCadangan('siswa');
    } else {
      const g = this.guru.get(me.id);
      if (!g || !(await X.cekPw_(g, d.lama))) throw new AppError('Kata sandi lama salah');
      const cr = await X.makeCred_(baru);
      const baruG = { ...g, salt: cr.salt, hash: cr.hash, sandi: '-' };
      await DB.prepare(`UPDATE guru SET data = ? WHERE id = ?`).bind(JSON.stringify(baruG), g.id).run();
      this.guru.set(g.id, baruG);
      this.tandaiCadangan('guru');
    }
    return true;
  });
};

A.saveConfig = async function (d, me) {
  X.reqAdmin_(me);
  const cfg = {
    namaSekolah: str_(d.namaSekolah, 120).trim() || 'Sekolah',
    tahunAjaran: str_(d.tahunAjaran, 20), semester: str_(d.semester, 20), logo: str_(d.logo, 500),
    tingkat: (d.tingkat || []).map(x => str_(x, 20).trim()).filter(Boolean),
    kelas: (d.kelas || []).map(k => ({ nama: str_(k.nama, 40).trim(), tingkat: str_(k.tingkat, 20).trim() })).filter(k => k.nama),
    mapel: (d.mapel || []).map(x => str_(x, 80).trim()).filter(Boolean)
  };
  await this.kunci(async () => {
    await this.env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES ('config', ?)`).bind(JSON.stringify(cfg)).run();
    this.config = cfg; this.tandaiCadangan('config');
  });
  return cfg;
};

A.dashboard = async function (d, me) {
  X.reqGuru_(me);
  const t = now(), admin = me.r === 'admin';
  let banks = [...this.bankIdx.values()];
  const semua = [...this.ujian.values()];
  if (!admin) banks = banks.filter(b => b.guruId === me.id);
  // guru: "milik" = ujian dari bank soalnya (untuk hasil); "awas" = ujian yang ia awasi (untuk monitoring)
  const milik = admin ? semua : semua.filter(u => u.guruId === me.id);
  const awas = admin ? semua : semua.filter(u => this.kelasAwas(me, u).size);
  const terkait = admin ? semua : [...new Set([...milik, ...awas])];
  const res = {
    jumlahBank: banks.length,
    jumlahSoal: banks.reduce((a, b) => a + (b.jumlahSoal || 0), 0),
    jumlahUjian: milik.length,
    jumlahAwas: admin ? 0 : awas.length,
    berlangsung: terkait.filter(u => u.aktif && u.mulai <= t && u.selesai >= t).length,
    mendatang: awas.filter(u => u.selesai >= t && u.mulai <= t + 86400000 && (admin || u.aktif)).sort((a, b) => a.mulai - b.mulai).map(u => this.ringkasUntuk(u, me)),
    bankTerbaru: banks.slice().sort((a, b) => (b.diubah || 0) - (a.diubah || 0)).slice(0, 5)
  };
  if (me.r === 'admin') {
    if (this.jmlSiswa === null) {
      // COUNT(*) membaca SEMUA baris siswa → dihitung sekali setelah data siswa berubah, lalu disimpan
      const m = this.metaGet('c_jml');
      this.jmlSiswa = m ? Number(m) : (await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM siswa`).first()).n;
      if (!m) this.metaSet('c_jml', String(this.jmlSiswa));
    }
    res.jumlahSiswa = this.jmlSiswa;
    res.jumlahGuru = this.guru.size;
  }
  return res;
};

// ---------------------------------------------------------------- bank soal
A.listBank = async function (d, me) {
  X.reqGuru_(me);
  let list = [...this.bankIdx.values()];
  if (me.r !== 'admin') list = list.filter(b => b.guruId === me.id);
  return list;
};
A.getBank = async function (d, me) {
  X.reqGuru_(me);
  const b = await this.getBank(X.safeId_(d.id));
  if (!b) throw new AppError('Bank soal tidak ditemukan');
  this.bolehBank(me, b);
  return b;
};
A.saveBank = async function (d, me) {
  X.reqGuru_(me);
  const input = d.bank || {};
  const judul = str_(input.judul, 150).trim();
  if (!judul) throw new AppError('Judul bank soal wajib diisi');
  const isBaru = !input.id;
  const id = isBaru ? uid_('b') : X.safeId_(input.id);
  const soal = (input.soal || []).slice(0, 300).map(X.bersihkanSoal_);
  const seen = {};
  soal.forEach(s => { if (seen[s.id]) s.id = uid_('s'); seen[s.id] = 1; });
  return this.kunci(async () => {
    const lama = isBaru ? null : await this.getBank(id);
    if (!isBaru && !lama) throw new AppError('Bank soal tidak ditemukan');
    if (lama) this.bolehBank(me, lama);
    if (lama && lama.guruId !== me.id) throw new AppError('Bank soal milik ' + (lama.guruNama || 'guru') + ' tidak bisa diubah oleh admin.');
    let mapel = str_(input.mapel, 80);
    if (me.r !== 'admin') {
      // guru hanya boleh memakai mata pelajaran yang ditetapkan admin di akunnya
      const g = this.guru.get(me.id), boleh = (g && g.mapel) || [];
      if (boleh.length && !boleh.includes(mapel) && (!lama || lama.mapel !== mapel)) {
        if (lama) throw new AppError('Mata pelajaran harus salah satu dari: ' + boleh.join(', '));
        mapel = boleh[0];
      }
    }
    const t = now();
    const bank = {
      id, judul, mapel, tingkat: str_(input.tingkat, 20), deskripsi: str_(input.deskripsi, 1000),
      guruId: lama ? lama.guruId : me.id, guruNama: lama ? lama.guruNama : me.n,
      dibuat: lama ? lama.dibuat : t, diubah: t, soal
    };
    const meta = X.metaBank_(bank);
    const DB = this.env.DB, st = [DB.prepare(`INSERT OR REPLACE INTO bank (id, meta, data) VALUES (?, ?, ?)`).bind(id, JSON.stringify(meta), JSON.stringify(bank))];
    // perbarui jumlah soal di jadwal yang memakai bank ini (dibaca aplikasi siswa)
    const dipakai = [];
    for (const u of this.ujian.values()) {
      if (u.bankId !== id) continue;
      if (u.selesai >= t) dipakai.push(u.nama);
      if (u.jumlahSoal !== soal.length || u.bankJudul !== judul) {
        const u2 = { ...u, jumlahSoal: soal.length, bankJudul: judul };
        st.push(DB.prepare(`UPDATE ujian SET data = ? WHERE id = ?`).bind(JSON.stringify(u2), u.id));
        this.ujian.set(u.id, u2);
      }
    }
    await DB.batch(st);
    this.bankFull.set(id, bank);
    this.bankIdx.set(id, meta);
    this.tandaiCadangan('bank:' + id); this.tandaiCadangan('bankidx');
    return { bank, dipakai };
  });
};
A.deleteBank = async function (d, me) {
  X.reqGuru_(me);
  const id = X.safeId_(d.id);
  return this.kunci(async () => {
    const b = await this.getBank(id);
    if (!b) throw new AppError('Bank soal tidak ditemukan');
    this.bolehBank(me, b);
    if (b.guruId !== me.id) throw new AppError('Bank soal milik ' + (b.guruNama || 'guru') + ' tidak bisa dihapus oleh admin.');
    const dipakai = [...this.ujian.values()].filter(u => u.bankId === id);
    if (dipakai.length) throw new AppError('Bank soal dipakai di jadwal: ' + dipakai.map(u => u.nama).join(', ') + '. Hapus jadwalnya dulu.');
    await this.env.DB.prepare(`DELETE FROM bank WHERE id = ?`).bind(id).run();
    this.bankFull.delete(id); this.bankIdx.delete(id);
    this.tandaiCadangan('bank:' + id); this.tandaiCadangan('bankidx');
    return true;
  });
};
A.uploadGambar = async function (d, me) {
  X.reqGuru_(me);
  return unggahGambar(this.env, d, me.n);
};

// ---------------------------------------------------------------- jadwal
/**
 * Admin: semua jadwal. Guru, menurut halaman (d.untuk):
 *  - 'jadwal'  : semua ujian aktif HARI INI (tanpa token, kecuali yang ia awasi)
 *  - 'monitor' : ujian yang ia awasi sebagai pengawas
 *  - 'hasil'   : ujian dari bank soal miliknya
 */
A.listUjian = async function (d, me) {
  X.reqGuru_(me);
  let list = [...this.ujian.values()];
  if (me.r !== 'admin') {
    const untuk = str_(d && d.untuk, 20), t = now();
    const awas = u => this.kelasAwas(me, u).size > 0;
    if (untuk === 'jadwal') list = list.filter(u => u.aktif && X.ujianHariIni_(u, t));
    else if (untuk === 'monitor') list = list.filter(awas);
    else if (untuk === 'hasil') list = list.filter(u => u.guruId === me.id);
    else list = list.filter(u => u.guruId === me.id || awas(u));
  }
  return list.map(u => this.ringkasUntuk(u, me)).sort((a, b) => b.mulai - a.mulai);
};
/** Pengawas dari formulir jadwal: [{id, kelas:[]}] — kelas kosong = mengawasi semua kelas peserta. */
function bacaPengawas(self, d, kelas) {
  const out = [], ada = new Set();
  for (const p of (Array.isArray(d.pengawas) ? d.pengawas : []).slice(0, 100)) {
    const id = str_(p && p.id, 60), g = self.guru.get(id);
    if (!g || ada.has(id)) continue;
    ada.add(id);
    let kl = [...new Set((Array.isArray(p.kelas) ? p.kelas : []).map(k => str_(k, 40)))].filter(k => kelas.includes(k));
    if (kl.length === kelas.length) kl = [];
    out.push({ id, nama: g.nama, kelas: kl });
  }
  return out;
}
A.saveUjian = async function (d, me) {
  X.reqAdmin_(me);
  const nama = str_(d.nama, 150).trim();
  if (!nama) throw new AppError('Nama ujian wajib diisi');
  const mulai = num_(d.mulai, 0), selesai = num_(d.selesai, 0), durasi = Math.round(num_(d.durasi, 0));
  if (!mulai || !selesai || selesai <= mulai) throw new AppError('Waktu selesai harus setelah waktu mulai');
  if (durasi < 1 || durasi > 600) throw new AppError('Durasi harus 1–600 menit');
  const kelas = (d.kelas || []).map(k => str_(k, 40)).filter(Boolean);
  if (!kelas.length) throw new AppError('Pilih minimal satu kelas peserta');
  const bank = await this.getBank(str_(d.bankId));
  if (!bank) throw new AppError('Bank soal tidak ditemukan');
  if (!bank.soal.length) throw new AppError('Bank soal masih kosong');
  const pengawas = bacaPengawas(this, d, kelas);
  const u = await this.kunci(async () => {
    const lama = d.id ? this.ujian.get(str_(d.id)) : null;
    if (d.id && !lama) throw new AppError('Jadwal tidak ditemukan');
    const t = now();
    const u = {
      id: lama ? lama.id : uid_('u'), nama,
      bankId: bank.id, bankJudul: bank.judul, mapel: bank.mapel, tingkat: str_(d.tingkat, 20) || bank.tingkat,
      guruId: bank.guruId, guruNama: bank.guruNama, jumlahSoal: bank.soal.length,
      kelas, mulai, selesai, durasi, pengawas,
      acakSoal: bool_(d.acakSoal), acakOpsi: bool_(d.acakOpsi), tampilNilai: bool_(d.tampilNilai), pakaiToken: bool_(d.pakaiToken),
      token: bool_(d.pakaiToken) ? ((lama && lama.token) || X.buatToken_()) : '',
      maxPelanggaran: Math.max(0, Math.round(num_(d.maxPelanggaran, 0))),
      aktif: d.aktif === undefined ? true : bool_(d.aktif),
      keterangan: str_(d.keterangan, 1000),
      dibuat: lama ? lama.dibuat : t, diubah: t, oleh: me.n
    };
    await this.env.DB.prepare(`INSERT OR REPLACE INTO ujian (id, selesai, data) VALUES (?, ?, ?)`).bind(u.id, u.selesai, JSON.stringify(u)).run();
    this.ujian.set(u.id, u);
    const L = this.L.get(u.id);
    if (L) {
      L.siswa = null;
      // monitor yang sedang terbuka mengikuti pengawas & kelas terbaru
      for (const ws of [...L.mons]) {
        const m = ws.info && ws.info.m; if (!m) continue;
        const k = this.kelasAwas(m.me, u);
        if (k && !k.size) { kirim(ws, { t: 'err', k: 'pantau', code: 'ERR', msg: 'Anda tidak lagi menjadi pengawas ujian ini' }); this.akhiriIkatan(ws, 1000, 'bukan pengawas'); }
        else this.pantau(ws, m.me, u.id).catch(() => {});
      }
    }
    this.tandaiCadangan('ujian');
    return u;
  });
  return this.ringkas(u);
};
A.deleteUjian = async function (d, me) {
  X.reqAdmin_(me);
  return this.kunci(async () => {
    const u = this.ujianWajib(d.id);
    let n = 0;
    const L = this.L.get(u.id);
    if (L) { for (const P of L.P.values()) if (P.status === 'mengerjakan' || P.status === 'selesai') n++; }
    else n = (await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM hasil WHERE ujian_id = ?`).bind(u.id).first()).n;
    if (n && !d.paksa) throw new AppError('Sudah ada ' + n + ' peserta yang mengerjakan. ' + (d.hapusHasil ? 'Hasil mereka ikut dihapus dari database.' : 'Hasil yang sudah ada tetap tersimpan di database.'), 'ADA_PESERTA');
    if (L) {
      await this.syncD1();
      for (const ws of [...L.mons]) { kirim(ws, { t: 'err', k: 'pantau', code: 'ERR', msg: 'Ujian ini sudah dihapus' }); this.akhiriIkatan(ws, 1000, 'dihapus'); }
      for (const set of [...L.socks.values()]) for (const ws of [...set]) { kirim(ws, { t: 'reset' }); this.akhiriIkatan(ws, 1000, 'dihapus'); }
      this.sql.exec(`DELETE FROM p WHERE u = ?`, u.id); this.sql.exec(`DELETE FROM jw WHERE u = ?`, u.id);
      this.L.delete(u.id);
    }
    await this.env.DB.prepare(`DELETE FROM ujian WHERE id = ?`).bind(u.id).run();
    this.ujian.delete(u.id);
    this.tandaiCadangan('ujian');
    if (d.hapusHasil) {
      // mengosongkan ruang D1. Cadangan hasil yang belum terkirim ke GitHub dikirim dulu (bila diatur).
      const k = 'hasil:' + u.id;
      if (this.bdirty.has(k) && this.env.DATA_REPO && this.env.GITHUB_TOKEN) await this.cadangkan().catch(() => {});
      await this.env.DB.prepare(`DELETE FROM hasil WHERE ujian_id = ?`).bind(u.id).run();
      this.bdirty.delete(k); this.metaSet('bdirty', JSON.stringify([...this.bdirty]));
    }
    return true;
  });
};
A.gantiTokenUjian = async function (d, me) {
  X.reqGuru_(me);
  return this.kunci(async () => {
    const u = this.ujianWajib(d.id);
    if (me.r !== 'admin' && !this.kelasAwas(me, u).size) throw new AppError('Token hanya bisa diganti admin atau pengawas ujian ini');
    const u2 = { ...u, token: X.buatToken_(), pakaiToken: true, diubah: now() };
    await this.env.DB.prepare(`UPDATE ujian SET data = ? WHERE id = ?`).bind(JSON.stringify(u2), u.id).run();
    this.ujian.set(u.id, u2);
    this.tandaiCadangan('ujian');
    return u2.token;
  });
};

// ---------------------------------------------------------------- siswa (ujian)
A.mulaiUjian = async function (d, me) { X.reqSiswa_(me); return this.mulaiInti(me, d); };
A.simpanJawaban = async function (d, me) {
  X.reqSiswa_(me);
  const u = this.ujianWajib(d.ujianId), L = await this.getL(u.id);
  const r = this.simpanInti(L, me, d, true);
  if (r !== null) return r;
  const bank = await this.getBank(u.bankId);
  return this.finalisasi(L, L.P.get(me.id), u, bank, 'waktu habis');
};
A.selesaiUjian = async function (d, me) {
  X.reqSiswa_(me);
  const u = this.ujianWajib(d.ujianId), L = await this.getL(u.id);
  return this.selesaiInti(L, me, d);
};

// ---------------------------------------------------------------- monitoring, hasil, koreksi
A.monitorUjian = async function (d, me) {
  X.reqGuru_(me);
  const u = this.ujianWajib(d.ujianId); const kelas = this.bolehPantau(me, u);
  return this.monitorPayload(await this.getL(u.id), u, kelas, me);
};

async function cariP(self, me, d) {
  const u = self.ujianWajib(d.ujianId); const kelas = self.bolehPantau(me, u);
  const L = await self.getL(u.id);
  const P = L.P.get(str_(d.nis));
  if (!P) throw new AppError('Peserta tidak ditemukan di ujian ini');
  if (kelas && !kelas.has(P.kelas)) throw new AppError('Siswa ini tidak berada di kelas yang Anda awasi');
  return { u, L, P };
}
A.resetLogin = async function (d, me) {
  X.reqGuru_(me);
  const { L, P } = await cariP(this, me, d);
  P.perangkat = ''; this.persistP(L, P); this.ubah(L, P);
  return true;
};
A.resetPeserta = async function (d, me) {
  X.reqAdmin_(me);
  const { L, P } = await cariP(this, me, d);
  const punyaHasil = P.status === 'selesai' || P.status === 'direset';
  Object.assign(P, {
    status: punyaHasil ? 'direset' : 'belum', jawaban: { j: {}, r: [] }, hasil: null, manual: {}, mulai: 0, deadline: 0, selesai: 0,
    pelanggaran: 0, perangkat: '', catatan: 'direset ' + me.n, ver: now(), terjawab: 0, ragu: 0
  });
  this.persistP(L, P); this.ubah(L, P);
  L.dirty.add(ember(P.nis));
  const set = L.socks.get(P.nis);
  if (set) for (const ws of [...set]) { kirim(ws, { t: 'reset' }); this.akhiriIkatan(ws, 1000, 'direset'); }
  await this.syncD1();
  return true;
};
A.paksaSelesai = async function (d, me) {
  X.reqGuru_(me);
  const { u, L, P } = await cariP(this, me, d);
  if (P.status !== 'mengerjakan') throw new AppError('Peserta tidak sedang mengerjakan');
  const bank = await this.getBank(u.bankId);
  this.finalisasi(L, P, u, bank, 'dihentikan ' + me.n);
  return true;
};

A.hasilUjian = async function (d, me) {
  X.reqGuru_(me);
  const u = this.ujianWajib(d.ujianId); this.bolehHasil(me, u);
  const bank = await this.getBank(u.bankId);
  await this.syncD1();
  const map = new Map(), L = this.L.get(u.id);
  if (L) {
    const t = now();
    for (const P of L.P.values()) map.set(P.nis, (P.status === 'selesai' || P.status === 'mengerjakan') ? { ...rekam(P), status: statusTampil(P, t) } : { nis: P.nis, nama: P.nama, kelas: P.kelas, status: P.status });
  } else {
    const r = await this.env.DB.prepare(`SELECT nis, data FROM hasil WHERE ujian_id = ?`).bind(u.id).all();
    for (const x of r.results) map.set(x.nis, await X.bukaData(x.data));
  }
  for (const [nis, s] of await this.siswaUjian(u, L)) if (!map.has(nis)) map.set(nis, { nis, nama: s.nama, kelas: s.kelas, status: 'belum' });
  const peserta = [...map.values()];
  if (u.guruId !== me.id) {
    // admin & pengawas: hanya daftar peserta dan statusnya — tanpa nilai, jawaban, kunci, dan analisis
    return { ujian: this.ringkas(u), bank: bank ? { judul: bank.judul, mapel: bank.mapel, soal: [] } : null, lihatNilai: false,
      peserta: peserta.map(p => ({ nis: p.nis, nama: p.nama, kelas: p.kelas, status: p.status, mulai: p.mulai || 0, selesai: p.status === 'selesai' ? p.selesai || 0 : 0, pelanggaran: p.pelanggaran || 0, catatan: p.catatan || '' })) };
  }
  if (bank && d.hitungUlang) peserta.forEach(p => { if (p.status === 'selesai') p.hasil = X.hitungHasil_(bank, p.jawaban, p.manual); });
  return { ujian: this.ringkas(u), bank, peserta, lihatNilai: true };
};

/** Ambil rekam selesai (dari sesi langsung atau D1) untuk beberapa NIS. */
async function ambilRekam(self, u, nisList) {
  await self.syncD1();
  const out = new Map(), L = self.L.get(u.id);
  if (L) { for (const nis of nisList) { const P = L.P.get(nis); if (P) out.set(nis, rekam(P)); } return out; }
  const r = await self.env.DB.prepare(`SELECT nis, data FROM hasil WHERE ujian_id = ?1 AND nis IN (SELECT value FROM json_each(?2))`).bind(u.id, JSON.stringify(nisList)).all();
  for (const x of r.results) out.set(x.nis, await X.bukaData(x.data));
  return out;
}
function terapkanManual(rec, manualBaru, bank) {
  const manual = rec.manual || {};
  Object.keys(manualBaru || {}).forEach(sid => {
    const v = manualBaru[sid];
    if (v === '' || v === null || v === undefined) delete manual[sid]; else manual[sid] = num_(v, 0);
  });
  rec.manual = manual;
  rec.hasil = X.hitungHasil_(bank, rec.jawaban, manual);
  rec.ver = now();
}
A.koreksi = async function (d, me) {
  X.reqGuru_(me);
  const u = this.ujianWajib(d.ujianId); this.bolehHasil(me, u); this.pemilikNilai(me, u);
  const bank = await this.getBank(u.bankId);
  const nis = str_(d.nis);
  return this.kunci(async () => {
    const rec = (await ambilRekam(this, u, [nis])).get(nis);
    if (!rec) throw new AppError('Hasil peserta tidak ditemukan');
    if (rec.status !== 'selesai') throw new AppError('Peserta belum menyelesaikan ujian');
    terapkanManual(rec, d.manual, bank);
    await this.tulisRekam(u.id, [rec]);
    return rec;
  });
};
A.koreksiMassal = async function (d, me) {
  X.reqGuru_(me);
  const u = this.ujianWajib(d.ujianId); this.bolehHasil(me, u); this.pemilikNilai(me, u);
  const bank = await this.getBank(u.bankId);
  const items = (d.items || []).slice(0, 3000);
  return this.kunci(async () => {
    const recs = await ambilRekam(this, u, items.map(it => str_(it.nis)));
    const out = [];
    for (const it of items) {
      const rec = recs.get(str_(it.nis));
      if (!rec || rec.status !== 'selesai') continue;
      terapkanManual(rec, it.manual, bank);
      out.push(rec);
    }
    if (out.length) await this.tulisRekam(u.id, out);
    return out;
  });
};
A.hitungUlang = async function (d, me) {
  X.reqGuru_(me);
  const u = this.ujianWajib(d.ujianId); this.bolehHasil(me, u); this.pemilikNilai(me, u);
  const bank = await this.getBank(u.bankId);
  if (!bank) throw new AppError('Bank soal tidak ditemukan');
  return this.kunci(async () => {
    await this.syncD1();
    const L = this.L.get(u.id);
    let recs;
    if (L) recs = [...L.P.values()].filter(P => P.status === 'selesai').map(rekam);
    else recs = (await X.bukaSemua((await this.env.DB.prepare(`SELECT data FROM hasil WHERE ujian_id = ?`).bind(u.id).all()).results.map(x => x.data))).filter(r => r.status === 'selesai');
    const t = now();
    recs.forEach(rec => { rec.hasil = X.hitungHasil_(bank, rec.jawaban, rec.manual); rec.ver = t; });
    if (recs.length) await this.tulisRekam(u.id, recs);
    return { dihitung: recs.length };
  });
};

// ---------------------------------------------------------------- guru (admin)
A.listGuru = async function (d, me) { X.reqAdmin_(me); return [...this.guru.values()].map(X.publikGuru_); };
A.saveGuru = async function (d, me) {
  X.reqAdmin_(me);
  const username = str_(d.username, 40).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new AppError('Nama pengguna 3–40 karakter: huruf kecil, angka, titik, garis bawah');
  const nama = str_(d.nama, 120).trim();
  if (!nama) throw new AppError('Nama guru wajib diisi');
  return this.kunci(async () => {
    let g = d.id ? this.guru.get(str_(d.id)) : null;
    if (d.id && !g) throw new AppError('Guru tidak ditemukan');
    if ([...this.guru.values()].some(x => x.username === username && (!g || x.id !== g.id))) throw new AppError('Nama pengguna sudah dipakai');
    g = g ? { ...g } : null;
    if (!g) {
      if (!d.password || String(d.password).length < 6) throw new AppError('Kata sandi minimal 6 karakter');
      g = { id: uid_('g') };
    }
    if (g.id === me.id && d.role !== 'admin') throw new AppError('Anda tidak bisa menurunkan peran akun sendiri');
    g.username = username; g.nama = nama; g.role = d.role === 'admin' ? 'admin' : 'guru';
    g.aktif = d.aktif === undefined ? true : bool_(d.aktif);
    g.mapel = (d.mapel || []).map(x => str_(x, 80));
    if (d.password) {
      if (String(d.password).length < 6) throw new AppError('Kata sandi minimal 6 karakter');
      const cr = await X.makeCred_(d.password); g.salt = cr.salt; g.hash = cr.hash;
      g.sandi = await X.enkripSandi_(String(d.password), this.secret);
    }
    await this.env.DB.prepare(`INSERT OR REPLACE INTO guru (id, username, data) VALUES (?, ?, ?)`).bind(g.id, g.username, JSON.stringify(g)).run();
    this.guru.set(g.id, g);
    this.tandaiCadangan('guru');
    return X.publikGuru_(g);
  });
};
A.deleteGuru = async function (d, me) {
  X.reqAdmin_(me);
  if (d.id === me.id) throw new AppError('Tidak bisa menghapus akun sendiri');
  return this.kunci(async () => {
    const g = this.guru.get(str_(d.id));
    if (!g) throw new AppError('Guru tidak ditemukan');
    await this.env.DB.prepare(`DELETE FROM guru WHERE id = ?`).bind(g.id).run();
    this.guru.delete(g.id);
    this.tandaiCadangan('guru');
    return true;
  });
};

/**
 * Impor guru dari Excel (format sama dengan "Unduh Excel"): Nama pengguna, Nama, Mata pelajaran, Password, Peran, Status.
 * Dicocokkan lewat nama pengguna. Guru baru dengan password kosong → password = nama pengguna.
 * Guru lama: sel kosong (mapel/peran/status/password) = tidak diubah. Akun admin yang sedang dipakai tetap admin & aktif.
 */
A.importGuru = async function (d, me) {
  X.reqAdmin_(me);
  const rows = (d.rows || []).slice(0, 1000);
  if (!rows.length) throw new AppError('Tidak ada data untuk diimpor');
  const kosong = v => v === undefined || v === null || String(v).trim() === '';
  const mapelCfg = new Map((this.config.mapel || []).map(m => [m.toLowerCase(), m]));
  const valid = new Map(), lewati = [];
  rows.forEach((r, i) => {
    const username = str_(r.username, 40).trim().toLowerCase(), nama = str_(r.nama, 120).trim();
    if (!/^[a-z0-9._-]{3,40}$/.test(username) || !nama) { lewati.push(i + 1); return; }
    const mapel = kosong(r.mapel) ? null : [...new Set(String(r.mapel).split(/[,;\n]/).map(m => m.trim()).filter(Boolean).map(m => mapelCfg.get(m.toLowerCase()) || str_(m, 80)))];
    const peran = kosong(r.peran) ? null : (/admin/i.test(String(r.peran)) ? 'admin' : 'guru');
    const aktif = kosong(r.status) ? null : !/^(non|tidak|0|false|off|mati)/i.test(String(r.status).trim());
    valid.set(username, { username, nama, mapel, peran, aktif, pw: X.sandiDariExcel_(r.password) });
  });
  if (!valid.size) throw new AppError('Tidak ada baris yang valid. Nama pengguna 3–40 karakter (huruf kecil, angka, titik, garis bawah) dan Nama wajib diisi.');
  return this.kunci(async () => {
    const byUser = new Map([...this.guru.values()].map(g => [g.username, g]));
    const simpan = [];
    let baru = 0, ubah = 0;
    for (const v of valid.values()) {
      const lama = byUser.get(v.username), saya = lama && lama.id === me.id;
      const g = lama ? { ...lama } : { id: uid_('g'), mapel: [], role: 'guru', aktif: true };
      g.username = v.username; g.nama = v.nama;
      if (v.mapel) g.mapel = v.mapel;
      if (v.peran) g.role = v.peran;
      if (v.aktif !== null) g.aktif = v.aktif;
      if (saya) { g.role = 'admin'; g.aktif = true; }          // tidak bisa menurunkan / menonaktifkan akun sendiri
      const pw = v.pw || (lama ? '' : v.username);
      if (pw) { const cr = await X.makeCred_(pw); g.salt = cr.salt; g.hash = cr.hash; g.sandi = await X.enkripSandi_(pw, this.secret); }
      if (lama) ubah++; else baru++;
      simpan.push(g);
    }
    const DB = this.env.DB, st = simpan.map(g => DB.prepare(`INSERT OR REPLACE INTO guru (id, username, data) VALUES (?, ?, ?)`).bind(g.id, g.username, JSON.stringify(g)));
    for (let i = 0; i < st.length; i += 50) await DB.batch(st.slice(i, i + 50));
    simpan.forEach(g => this.guru.set(g.id, g));
    this.tandaiCadangan('guru');
    return { baru, ubah, lewati };
  });
};

// ---------------------------------------------------------------- siswa (admin)
const publikSiswa = s => ({ nis: String(s.nis), nama: s.nama, kelas: s.kelas });
A.listSiswa = async function (d, me) {
  X.reqAdmin_(me);
  return (await this.env.DB.prepare(`SELECT nis, nama, kelas FROM siswa`).all()).results.map(publikSiswa);
};
function kelasBaruKeConfig(self, kelasBaru) {
  const cfg = JSON.parse(JSON.stringify(self.config));
  cfg.kelas = cfg.kelas || [];
  const ada = new Set(cfg.kelas.map(k => k.nama));
  const tambah = [...new Set(kelasBaru.filter(k => k && !ada.has(k)))];
  if (!tambah.length) return null;
  tambah.forEach(k => cfg.kelas.push({ nama: k, tingkat: X.tebakTingkat_(k, cfg.tingkat) }));
  cfg.kelas.sort((a, b) => a.nama.localeCompare(b.nama, 'id', { numeric: true }));
  return cfg;
}
A.saveSiswa = async function (d, me) {
  X.reqAdmin_(me);
  const nis = str_(d.nis, 30).trim(), nama = str_(d.nama, 120).trim(), kelas = str_(d.kelas, 40).trim();
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(nis)) throw new AppError('NIS hanya boleh huruf/angka');
  if (!nama || !kelas) throw new AppError('Nama dan kelas wajib diisi');
  return this.kunci(async () => {
    const DB = this.env.DB;
    const lamaNis = str_(d.nisLama || '').trim();
    const rows = (await DB.prepare(`SELECT nis, salt, hash, sandi FROM siswa WHERE nis IN (?, ?)`).bind(nis, lamaNis || nis).all()).results;
    const lama = lamaNis ? rows.find(r => String(r.nis) === lamaNis) : null;
    if (lamaNis && !lama) throw new AppError('Siswa tidak ditemukan');
    if (rows.some(r => String(r.nis) === nis && (!lama || String(lama.nis) !== nis))) throw new AppError('NIS ' + nis + ' sudah terdaftar');
    let salt = lama ? lama.salt : null, hash = lama ? lama.hash : null, sandi = lama ? lama.sandi || null : null;
    const isian = X.sandiDariExcel_(d.password);
    const pw = isian || (!lama ? nis : '');   // kosong saat menambah → kata sandi = NIS
    if (pw) { const cr = await X.makeCred_(pw); salt = cr.salt; hash = cr.hash; sandi = isian ? await X.enkripSandi_(isian, this.secret) : null; }
    const st = [];
    if (lama && lamaNis !== nis) st.push(DB.prepare(`DELETE FROM siswa WHERE nis = ?`).bind(lamaNis));
    st.push(DB.prepare(`INSERT OR REPLACE INTO siswa (nis, nama, kelas, salt, hash, sandi) VALUES (?, ?, ?, ?, ?, ?)`).bind(nis, nama, kelas, salt, hash, sandi));
    const cfg = kelasBaruKeConfig(this, [kelas]);
    if (cfg) st.push(DB.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES ('config', ?)`).bind(JSON.stringify(cfg)));
    await DB.batch(st);
    if (cfg) { this.config = cfg; this.tandaiCadangan('config'); }
    this.lupakanSiswa(); this.tandaiCadangan('siswa');
    return { nis, nama, kelas };
  });
};
A.importSiswa = async function (d, me) {
  X.reqAdmin_(me);
  const rows = (d.rows || []).slice(0, 5000);
  if (!rows.length) throw new AppError('Tidak ada data untuk diimpor');
  return this.kunci(async () => {
    const DB = this.env.DB, ganti = d.mode === 'ganti';
    const valid = [], lewati = [], seen = new Set();
    rows.forEach((r, i) => {
      const nis = str_(r.nis, 30).trim(), nama = str_(r.nama, 120).trim(), kelas = str_(r.kelas, 40).trim();
      if (!/^[A-Za-z0-9._-]{1,30}$/.test(nis) || !nama || !kelas) { lewati.push(i + 1); return; }
      const pwx = X.sandiDariExcel_(r.password);   // keterangan "(…)" dari Excel unduhan diabaikan
      if (seen.has(nis)) { const v = valid.find(x => x.nis === nis); Object.assign(v, { nama, kelas, pw: pwx || v.pw }); return; }
      seen.add(nis); valid.push({ nis, nama, kelas, pw: pwx });
    });
    const ada = new Set();
    if (!ganti && valid.length) {
      for (const g of potong(valid.map(v => v.nis), 90000)) {
        (await DB.prepare(`SELECT nis FROM siswa WHERE nis IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(g)).all()).results.forEach(x => ada.add(String(x.nis)));
      }
    }
    const data = [];
    let baru = 0, ubah = 0;
    for (const v of valid) {
      const lama = ada.has(v.nis);
      if (lama) ubah++; else baru++;
      const o = { n: v.nis, a: v.nama, k: v.kelas, s: null, h: null, p: null };
      if (v.pw || !lama) { const cr = await X.makeCred_(v.pw || v.nis); o.s = cr.salt; o.h = cr.hash; if (v.pw) o.p = await X.enkripSandi_(v.pw, this.secret); }
      data.push(o);
    }
    const st = [];
    if (ganti) st.push(DB.prepare(`DELETE FROM siswa`));
    for (const g of potong(data, 800000)) {
      st.push(DB.prepare(`INSERT INTO siswa (nis, nama, kelas, salt, hash, sandi)
        SELECT json_extract(value,'$.n'), json_extract(value,'$.a'), json_extract(value,'$.k'), json_extract(value,'$.s'), json_extract(value,'$.h'), json_extract(value,'$.p') FROM json_each(?) WHERE true
        ON CONFLICT(nis) DO UPDATE SET nama = excluded.nama, kelas = excluded.kelas, salt = COALESCE(excluded.salt, siswa.salt), hash = COALESCE(excluded.hash, siswa.hash),
          sandi = CASE WHEN excluded.hash IS NOT NULL THEN excluded.sandi ELSE siswa.sandi END`).bind(JSON.stringify(g)));
    }
    let semuaKelas = valid.map(v => v.kelas);
    if (!ganti) semuaKelas = semuaKelas.concat((await DB.prepare(`SELECT DISTINCT kelas FROM siswa`).all()).results.map(x => x.kelas));
    const cfg = kelasBaruKeConfig(this, semuaKelas);
    if (cfg) st.push(DB.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES ('config', ?)`).bind(JSON.stringify(cfg)));
    for (let i = 0; i < st.length; i += 20) await DB.batch(st.slice(i, i + 20));
    if (cfg) { this.config = cfg; this.tandaiCadangan('config'); }
    this.lupakanSiswa(); this.tandaiCadangan('siswa');
    const total = (await DB.prepare(`SELECT COUNT(*) AS n FROM siswa`).first()).n;
    this.jmlSiswa = total;
    return { baru, ubah, lewati, total, config: cfg };
  });
};
A.deleteSiswa = async function (d, me) {
  X.reqAdmin_(me);
  const hapus = (d.nis || []).map(String);
  return this.kunci(async () => {
    const r = await this.env.DB.prepare(`DELETE FROM siswa WHERE nis IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(hapus)).run();
    this.lupakanSiswa(); this.tandaiCadangan('siswa');
    return r.meta ? r.meta.changes : hapus.length;
  });
};

// ---------------------------------------------------------------- sistem
A.sinkronSekarang = async function (d, me) {
  X.reqGuru_(me);
  this.flushJw();
  const n = await this.syncD1();
  let cadangan = null;
  if (me.r === 'admin' && this.env.DATA_REPO && this.env.GITHUB_TOKEN) {
    try { cadangan = await this.cadangkan(); this.cadanganGagal = null; this.metaSet('cadanganGagal', ''); }
    catch (e) { cadangan = { error: X.errInfo(e).msg }; this.cadanganGagal = { t: Date.now(), pesan: cadangan.error.slice(0, 300) }; this.metaSet('cadanganGagal', JSON.stringify(this.cadanganGagal)); }
  }
  return { disinkron: n || 0, cadangan, adaRepo: !!this.env.DATA_REPO };
};
/** Kolom password untuk Excel data siswa: sandi dari admin, NIS bila kosong, atau keterangan. Hanya admin. */
A.sandiSiswa = async function (d, me) {
  X.reqAdmin_(me);
  const r = await this.env.DB.prepare(`SELECT nis, salt, hash, sandi FROM siswa`).all();
  const out = {};
  for (const s of r.results) out[s.nis] = await X.bacaSandi_(s, this.secret, String(s.nis), 'siswa');
  return out;
};
A.sandiGuru = async function (d, me) {
  X.reqAdmin_(me);
  const out = {};
  for (const g of this.guru.values()) out[g.id] = await X.bacaSandi_(g, this.secret, null, 'guru');
  return out;
};
/** Data akun sendiri (mata pelajaran terbaru yang ditetapkan admin). */
A.profilSaya = async function (d, me) { X.reqGuru_(me); const g = this.guru.get(me.id); if (!g) throw new AppError('Akun tidak ditemukan', 'AUTH'); return X.publikGuru_(g); };

/** Muat ulang salinan data (guru, bank, jadwal, pengaturan) dari D1 — bila data D1 diubah di luar aplikasi. */
A.muatUlangData = async function (d, me) {
  X.reqAdmin_(me);
  return this.kunci(async () => { this.secret = await siapkanD1(this.env.DB); await this.muatCache(); return { guru: this.guru.size, bank: this.bankIdx.size, ujian: this.ujian.size }; });
};
A.statusSistem = async function (d, me) {
  X.reqAdmin_(me);
  let mengerjakan = 0, siswaOnline = 0, monitor = 0;
  for (const L of this.L.values()) { for (const P of L.P.values()) if (P.status === 'mengerjakan') mengerjakan++; siswaOnline += L.socks.size; monitor += L.mons.size; }
  return {
    versi: X.VERSI, sesiAktif: this.L.size, mengerjakan, siswaOnline, monitor,
    mediaRepo: this.env.MEDIA_REPO || (this.repoContoh ? 'masih "namaakun/…" — ganti di wrangler.jsonc' : ''), dataRepo: this.env.DATA_REPO || '', adaToken: !!this.env.GITHUB_TOKEN,
    antrianCadangan: this.bdirty.size, cadanganTerakhir: this.lastBackup || 0, cadanganGagal: this.cadanganGagal || null,
    ukuranDb: await ukuranD1(this.env.DB), batasDb: 500 * 1024 * 1024
  };
};
/** Ukuran database D1 (byte) dari keterangan kueri; 0 bila tidak tersedia. */
async function ukuranD1(DB) {
  try { const r = await DB.prepare(`SELECT 1`).all(); return (r.meta && (r.meta.size_after || r.meta.sizeAfter)) || 0; } catch (e) { return 0; }
}
A.imporGithub = async function (d, me) {
  X.reqAdmin_(me);
  return this.kunci(async () => {
    for (const L of this.L.values()) for (const P of L.P.values()) if (P.status === 'mengerjakan') throw new AppError('Ada siswa yang sedang ujian. Impor hanya boleh saat tidak ada ujian berjalan.');
    const repo = await cekRepoData(this.env);
    const f = await unduhRepo(this.env, repo);
    const DB = this.env.DB, st = [], n = { guru: 0, siswa: 0, bank: 0, ujian: 0, hasil: 0 };
    const js = p => { try { return f[p] ? JSON.parse(f[p]) : null; } catch (e) { return null; } };
    const cfg = js('config.json');
    if (cfg) st.push(DB.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES ('config', ?)`).bind(JSON.stringify(cfg)));
    const guru = js('users/guru.json') || [];
    for (const g of potong(guru.filter(g => g && g.id && g.username), 800000)) {
      n.guru += g.length;
      st.push(DB.prepare(`INSERT OR REPLACE INTO guru (id, username, data) SELECT json_extract(value,'$.id'), json_extract(value,'$.username'), value FROM json_each(?)`).bind(JSON.stringify(g)));
    }
    const siswa = (js('users/siswa.json') || []).filter(s => s && s.nis).map(s => ({ n: String(s.nis), a: s.nama, k: s.kelas, s: s.salt || null, h: s.hash || null }));
    for (const g of potong(siswa, 800000)) {
      n.siswa += g.length;
      st.push(DB.prepare(`INSERT OR REPLACE INTO siswa (nis, nama, kelas, salt, hash) SELECT json_extract(value,'$.n'), json_extract(value,'$.a'), json_extract(value,'$.k'), json_extract(value,'$.s'), json_extract(value,'$.h') FROM json_each(?)`).bind(JSON.stringify(g)));
    }
    for (const p of Object.keys(f)) {
      const m = p.match(/^bank\/([a-zA-Z0-9_-]{3,40})\.json$/);
      if (!m || m[1] === '_index') continue;
      const b = js(p); if (!b || !b.id || !Array.isArray(b.soal)) continue;
      n.bank++;
      st.push(DB.prepare(`INSERT OR REPLACE INTO bank (id, meta, data) VALUES (?, ?, ?)`).bind(b.id, JSON.stringify(X.metaBank_(b)), JSON.stringify(b)));
    }
    for (const u of (js('ujian/_index.json') || [])) {
      if (!u || !u.id) continue;
      n.ujian++;
      st.push(DB.prepare(`INSERT OR REPLACE INTO ujian (id, selesai, data) VALUES (?, ?, ?)`).bind(u.id, Number(u.selesai) || 0, JSON.stringify(u)));
    }
    const hasilRows = [];
    for (const p of Object.keys(f)) {
      const m = p.match(/^hasil\/([a-zA-Z0-9_-]{3,40})\.json$/);
      if (!m) continue;
      const a = js(p); if (!a || !a.peserta) continue;
      for (const nis in a.peserta) {
        const rec = a.peserta[nis]; if (!rec || rec.status !== 'selesai') continue;
        hasilRows.push({ u: m[1], n: String(nis), s: rec.otomatis ? 'otomatis' : 'selesai', v: rec.hasil ? rec.hasil.nilai : null, p: rec.hasil ? rec.hasil.perluKoreksi : 0, r: rec.ver || 1, d: await X.kemasData(rec) });
      }
    }
    n.hasil = hasilRows.length;
    for (let i = 0; i < st.length; i += 20) await DB.batch(st.slice(i, i + 20));
    if (hasilRows.length) await this.tulisHasilD1(hasilRows, []);
    await this.muatCache();
    this.L.clear(); this.sql.exec(`DELETE FROM p`); this.sql.exec(`DELETE FROM jw`);
    return n;
  });
};
