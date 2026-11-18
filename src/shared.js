/**
 * CBT Sekolah — fungsi bersama (Worker & Durable Object).
 * Logika penilaian, pengacakan, dan pembersihan soal sama dengan versi Apps Script.
 */

export const VERSI = '2.8.0-CBT';
export const GRACE_MS = 2 * 60 * 1000;          // toleransi keterlambatan kirim jawaban
export const TOKEN_GURU_JAM = 12;
export const TOKEN_SISWA_JAM = 16;              // cukup untuk 1 hari ujian (beberapa sesi) tanpa login ulang
export const MAX_JAWABAN_CHARS = 45000;

// ---------------------------------------------------------------------------
//  WAKTU (offset hanya dipakai saat uji lokal DEV_MODE)
// ---------------------------------------------------------------------------
let OFFSET = 0;
export const now = () => Date.now() + OFFSET;
export const setOffset = ms => { OFFSET = Number(ms) || 0; };

// ---------------------------------------------------------------------------
//  ERROR
// ---------------------------------------------------------------------------
export class AppError extends Error {
  constructor(message, code) { super(message); this.code = code || 'ERR'; this.app = true; }
}

/** Ubah error D1/runtime menjadi pesan yang dimengerti pengguna. */
export function errInfo(err) {
  const msg = String((err && err.message) || err);
  if (err && err.app) return { msg, code: err.code };
  if (/exceeded|quota|limit.*(reached|exceed)|daily/i.test(msg) && /D1|row|database|request/i.test(msg)) {
    return { msg: 'Kuota harian serverC sudah habis. Kuota pulih pukul 08.00 WITA.', code: 'KUOTA' };
  }
  if (/overloaded|too many|timed? ?out|network|reset|unavailable|busy|internal error/i.test(msg)) return { msg: 'Server sedang sibuk, mencoba lagi…', code: 'BUSY' };
  // pesan teknis tanpa nama layanan
  return { msg: msg.replace(/\bD1(_[A-Z_]+)?:?/g, 'database:').replace(/cloudflare|workers?\.dev|durable ?objects?/ig, 'serverC').replace(/github/ig, 'serverB'), code: 'ERR' };
}

// ---------------------------------------------------------------------------
//  UTIL
// ---------------------------------------------------------------------------
export const uid_ = prefix => (prefix || '') + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
export const str_ = (v, max) => { v = (v === null || v === undefined) ? '' : String(v); return max ? v.slice(0, max) : v; };
export const num_ = (v, def) => { const n = Number(v); return isFinite(n) ? n : def; };
export const bool_ = v => v === true || v === 'true' || v === 1 || v === '1';
export const parse_ = (s, def) => { if (!s) return def; try { return JSON.parse(s); } catch (e) { return def; } };
export const round2_ = n => Math.round(n * 100) / 100;

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/** SHA-256(salt|pw) — sama dengan versi Apps Script, sehingga data lama bisa diimpor. */
export async function hashPw_(pw, salt) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(salt + '|' + pw)));
}
// ---- jadwal "hari ini" untuk siswa (zona WITA, UTC+8)
export const ZONA_MS = 8 * 3600000;
export function hariIni_(t) { const d = Math.floor((t + ZONA_MS) / 86400000); return [d * 86400000 - ZONA_MS, (d + 1) * 86400000 - ZONA_MS]; }
export function ujianHariIni_(u, t) { const [a, b] = hariIni_(t); return u.mulai < b && u.selesai >= a; }

// ---- kata sandi yang DIISI ADMIN disimpan terenkripsi (AES-GCM, kunci dari secret server) agar bisa diunduh di Excel.
//      Kata sandi yang diganti sendiri oleh pemilik akun tidak disimpan (hanya hash).
let kunciSandiP = null, kunciSandiS = '';
function kunciSandi(secret) {
  if (!kunciSandiP || kunciSandiS !== secret) {
    kunciSandiS = secret;
    kunciSandiP = crypto.subtle.digest('SHA-256', enc.encode('sandi|' + secret)).then(raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return kunciSandiP;
}
export async function enkripSandi_(pw, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await kunciSandi(secret), enc.encode(String(pw))));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return 'v1:' + keB64(all);
}
export async function dekripSandi_(t, secret) {
  try {
    if (!t || !String(t).startsWith('v1:')) return null;
    const all = dariB64(String(t).slice(3));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await kunciSandi(secret), all.slice(12)));
  } catch (e) { return null; }
}
/** Isi kolom password di Excel: sandi dari admin, atau sandi bawaan (NIS), atau keterangan. */
export async function bacaSandi_(u, secret, bawaan, oleh) {
  if (u.sandi === '-') return '(diganti sendiri oleh ' + oleh + ')';
  if (u.sandi) {
    const pw = await dekripSandi_(u.sandi, secret);
    if (pw !== null) return (await cekPw_(u, pw)) ? pw : '(diganti sendiri oleh ' + oleh + ')';
  }
  if (bawaan && await cekPw_(u, bawaan)) return bawaan;
  return '(tidak diketahui, isi ulang lewat Ubah)';
}
export const sandiDariExcel_ = v => { const t = String(v || '').trim(); return /^\(/.test(t) ? '' : t; };

export async function makeCred_(pw) { const salt = uid_(''); return { salt, hash: await hashPw_(String(pw), salt) }; }
export async function cekPw_(user, pw) { return !!(user && user.salt && user.hash === await hashPw_(String(pw), user.salt)); }

// ---------------------------------------------------------------------------
//  TOKEN SESI (HMAC-SHA256, tanpa penyimpanan sesi)
// ---------------------------------------------------------------------------
const b64u = bytes => { let s = ''; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
const KEYS = new Map();
async function hmacKey(secret) {
  let k = KEYS.get(secret);
  if (!k) { k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); KEYS.set(secret, k); }
  return k;
}
/** Token keluar aplikasi ujian (Android/Windows) per jadwal: diturunkan dari rahasia server, tetap, tidak perlu disimpan. */
export async function tokenKeluar_(ujianId, secret) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode('keluar:' + ujianId)));
  const huruf = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 6; i++) s += huruf.charAt(sig[i] % huruf.length);
  return s;
}
/** Sidik token keluar yang dibawa paket siswa: aplikasi bisa memeriksa token tanpa internet. */
export async function hashKeluar_(ujianId, token) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(ujianId + ':' + String(token || '').trim().toUpperCase())));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function signToken_(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return body + '.' + sig;
}
export async function verifyToken_(tok, secret) {
  const bad = new AppError('Sesi berakhir, silakan masuk lagi', 'AUTH');
  if (!tok || typeof tok !== 'string' || tok.indexOf('.') < 0) throw bad;
  const [body, sig] = tok.split('.');
  let okSig = false;
  try { okSig = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(sig), enc.encode(body)); } catch (e) { okSig = false; }
  if (!okSig) throw bad;
  const p = parse_(new TextDecoder().decode(unb64u(body)), null);
  if (!p || !p.exp || p.exp < now()) throw bad;
  return p;
}
export function reqGuru_(me) { if (me.r !== 'guru' && me.r !== 'admin') throw new AppError('Akses khusus guru', 'AUTH'); return me; }
export function reqAdmin_(me) { reqGuru_(me); if (me.r !== 'admin') throw new AppError('Akses khusus admin'); return me; }
export function reqSiswa_(me) { if (me.r !== 'siswa') throw new AppError('Akses khusus siswa', 'AUTH'); return me; }

// ---------------------------------------------------------------------------
//  BANK SOAL
// ---------------------------------------------------------------------------
export const TIPE_SOAL = ['pg', 'pgk', 'bs', 'jodoh', 'isian', 'urut', 'uraian'];
const ID_RE = /^[a-zA-Z0-9_-]{3,40}$/, ID2_RE = /^[a-zA-Z0-9_-]{2,40}$/;
export function safeId_(id) { id = str_(id); if (!ID_RE.test(id)) throw new AppError('ID tidak valid'); return id; }

export function bersihkanSoal_(s) {
  s = s || {};
  const tipe = TIPE_SOAL.indexOf(s.tipe) >= 0 ? s.tipe : 'pg';
  const o = {
    id: ID_RE.test(s.id || '') ? s.id : uid_('s'),
    tipe,
    teks: str_(s.teks, 20000),
    stimulus: str_(s.stimulus, 30000),
    gambar: (s.gambar || []).map(g => str_(g, 500)).filter(Boolean).slice(0, 6),
    bobot: Math.max(0, num_(s.bobot, 1)),
    pembahasan: str_(s.pembahasan, 10000)
  };
  const opsiList = arr => (arr || []).map(op => ({ id: ID2_RE.test(op.id || '') ? op.id : uid_('o'), teks: str_(op.teks, 5000), gambar: str_(op.gambar, 500) })).slice(0, 12);
  if (tipe === 'pg' || tipe === 'pgk' || tipe === 'urut') o.opsi = opsiList(s.opsi);
  if (tipe === 'pg') o.kunci = str_(s.kunci);
  if (tipe === 'pgk') o.kunci = (s.kunci || []).map(String);
  if (tipe === 'bs') {
    o.label = (s.label && s.label.length === 2) ? [str_(s.label[0], 30), str_(s.label[1], 30)] : ['Benar', 'Salah'];
    o.pernyataan = (s.pernyataan || []).map(p => ({ id: ID2_RE.test(p.id || '') ? p.id : uid_('p'), teks: str_(p.teks, 3000), benar: !!p.benar })).slice(0, 20);
  }
  if (tipe === 'jodoh') {
    o.pasangan = (s.pasangan || []).map(p => ({
      idKiri: ID2_RE.test(p.idKiri || '') ? p.idKiri : uid_('l'),
      idKanan: ID2_RE.test(p.idKanan || '') ? p.idKanan : uid_('r'),
      kiri: str_(p.kiri, 2000), kanan: str_(p.kanan, 2000)
    })).slice(0, 20);
  }
  if (tipe === 'isian') o.jawaban = (s.jawaban || []).map(x => str_(x, 300).trim()).filter(Boolean).slice(0, 20);
  if (tipe === 'uraian') o.rubrik = str_(s.rubrik, 10000);
  if (['pgk', 'bs', 'jodoh', 'urut'].indexOf(tipe) >= 0) o.penilaian = s.penilaian === 'mutlak' ? 'mutlak' : 'sebagian';
  return o;
}

export function metaBank_(b) {
  return { id: b.id, judul: b.judul, mapel: b.mapel, tingkat: b.tingkat, guruId: b.guruId, guruNama: b.guruNama, jumlahSoal: b.soal.length, totalBobot: b.soal.reduce((a, s) => a + (Number(s.bobot) || 0), 0), dibuat: b.dibuat, diubah: b.diubah };
}

// ---------------------------------------------------------------------------
//  JADWAL
// ---------------------------------------------------------------------------
export function statusJadwal_(u, t) {
  if (!u.aktif) return 'nonaktif';
  if (t < u.mulai) return 'akan';
  if (t > u.selesai) return 'selesai';
  return 'berlangsung';
}
export function ringkasUjian_(u) {
  return {
    id: u.id, nama: u.nama, bankId: u.bankId, bankJudul: u.bankJudul, mapel: u.mapel, tingkat: u.tingkat,
    guruId: u.guruId, guruNama: u.guruNama, kelas: u.kelas, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi,
    acakSoal: u.acakSoal, acakOpsi: u.acakOpsi, tampilNilai: u.tampilNilai, pakaiToken: u.pakaiToken, wajibApp: !!u.wajibApp,
    token: u.token, maxPelanggaran: u.maxPelanggaran, aktif: u.aktif, keterangan: u.keterangan,
    jumlahSoal: u.jumlahSoal, status: statusJadwal_(u, now()), diubah: u.diubah
  };
}
export function buatToken_() {
  const huruf = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', a = crypto.getRandomValues(new Uint8Array(6));
  let s = ''; for (let i = 0; i < 6; i++) s += huruf.charAt(a[i] % huruf.length);
  return s;
}

// ---------------------------------------------------------------------------
//  ACAK DETERMINISTIK (sama dengan versi lama → urutan soal stabil saat dimuat ulang)
// ---------------------------------------------------------------------------
export function seed_(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return h >>> 0;
}
function rng_(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function acak_(arr, seedStr) {
  const r = rng_(seed_(seedStr)), a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/** Soal untuk siswa: urutan sesuai pengaturan, TANPA kunci jawaban. */
export function soalUntukSiswa_(u, bank, nis, percobaan) {
  const base = u.id + '|' + nis + '|' + percobaan;
  const list = u.acakSoal ? acak_(bank.soal, base) : bank.soal.slice();
  return list.map(s => {
    const o = { id: s.id, tipe: s.tipe, teks: s.teks, stimulus: s.stimulus || '', gambar: s.gambar || [], bobot: s.bobot };
    const opsiAcak = arr => u.acakOpsi ? acak_(arr, base + '|' + s.id) : arr.slice();
    const bersih = op => ({ id: op.id, teks: op.teks, gambar: op.gambar || '' });
    if (s.tipe === 'pg' || s.tipe === 'pgk') o.opsi = opsiAcak(s.opsi || []).map(bersih);
    if (s.tipe === 'urut') o.opsi = acak_(s.opsi || [], base + '|u|' + s.id).map(bersih);
    if (s.tipe === 'bs') { o.label = s.label || ['Benar', 'Salah']; o.pernyataan = (s.pernyataan || []).map(p => ({ id: p.id, teks: p.teks })); }
    if (s.tipe === 'jodoh') {
      o.kiri = (s.pasangan || []).filter(p => p.kiri).map(p => ({ id: p.idKiri, teks: p.kiri }));
      o.kanan = acak_((s.pasangan || []).filter(p => p.kanan), base + '|j|' + s.id).map(p => ({ id: p.idKanan, teks: p.kanan }));
    }
    return o;
  });
}

// ---------------------------------------------------------------------------
//  PENILAIAN
// ---------------------------------------------------------------------------
export const normIsian_ = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').replace(/,/g, '.').trim();

const kosong_ = j => j === undefined || j === null || j === '' || (Array.isArray(j) && !j.length) || (typeof j === 'object' && !Array.isArray(j) && !Object.keys(j).length);

/** Nilai satu soal. return {skor, maks, manual(bool)} ; skor null = menunggu koreksi */
export function nilaiSoal_(s, j) {
  const b = num_(s.bobot, 1), mutlak = s.penilaian === 'mutlak';
  let rasio = 0;
  const kosong = kosong_(j);
  switch (s.tipe) {
    case 'pg': rasio = (!kosong && j === s.kunci) ? 1 : 0; break;
    case 'pgk': {
      const k = s.kunci || [], jj = Array.isArray(j) ? j : [];
      if (!k.length) { rasio = 0; break; }
      const benar = jj.filter(x => k.indexOf(x) >= 0).length, salah = jj.filter(x => k.indexOf(x) < 0).length;
      rasio = mutlak ? (benar === k.length && salah === 0 ? 1 : 0) : Math.max(0, benar - salah) / k.length;
      break;
    }
    case 'bs': {
      const ps = s.pernyataan || [], jb = (j && typeof j === 'object') ? j : {}; let ok = 0;
      ps.forEach(p => { if (jb[p.id] === p.benar) ok++; });
      rasio = !ps.length ? 0 : (mutlak ? (ok === ps.length ? 1 : 0) : ok / ps.length);
      break;
    }
    case 'jodoh': {
      const pr = (s.pasangan || []).filter(p => p.kiri && p.kanan), jm = (j && typeof j === 'object') ? j : {}; let ok = 0;
      pr.forEach(p => { if (jm[p.idKiri] === p.idKanan) ok++; });
      rasio = !pr.length ? 0 : (mutlak ? (ok === pr.length ? 1 : 0) : ok / pr.length);
      break;
    }
    case 'isian': { const acc = (s.jawaban || []).map(normIsian_); rasio = (!kosong && acc.indexOf(normIsian_(j)) >= 0) ? 1 : 0; break; }
    case 'urut': {
      const benarUrut = (s.opsi || []).map(o => o.id), ju = Array.isArray(j) ? j : []; let ok = 0;
      if (!ju.length) { rasio = 0; break; }
      benarUrut.forEach((id, i) => { if (ju[i] === id) ok++; });
      rasio = !benarUrut.length ? 0 : (mutlak ? (ok === benarUrut.length ? 1 : 0) : ok / benarUrut.length);
      break;
    }
    case 'uraian':
      if (kosong) return { skor: 0, maks: b, manual: true, kosong: true };
      return { skor: null, maks: b, manual: true };
  }
  return { skor: round2_(rasio * b), maks: b, manual: false };
}

/** Hitung total. manual: {soalId: skor} dari koreksi guru. */
export function hitungHasil_(bank, jawabanObj, manual) {
  const j = (jawabanObj && jawabanObj.j) || {}, perSoal = {};
  let skor = 0, maks = 0, perlu = 0, benar = 0;
  manual = manual || {};
  bank.soal.forEach(s => {
    const r = nilaiSoal_(s, j[s.id]);
    if (r.manual && !r.kosong && manual[s.id] !== undefined && manual[s.id] !== null && manual[s.id] !== '') {
      r.skor = Math.max(0, Math.min(r.maks, num_(manual[s.id], 0)));
    }
    if (r.skor === null) perlu++; else skor += r.skor;
    if (r.skor !== null && r.skor >= r.maks && r.maks > 0) benar++;
    maks += r.maks;
    perSoal[s.id] = r.skor;
  });
  return { skor: round2_(skor), maks: round2_(maks), nilai: maks ? round2_(skor / maks * 100) : 0, benar, jumlahSoal: bank.soal.length, perluKoreksi: perlu, perSoal };
}

export function bersihJawaban_(jw) {
  const o = { j: (jw && typeof jw.j === 'object' && jw.j && !Array.isArray(jw.j)) ? jw.j : {}, r: (jw && Array.isArray(jw.r)) ? jw.r.slice(0, 300) : [] };
  if (JSON.stringify(o).length > MAX_JAWABAN_CHARS) throw new AppError('Jawaban terlalu panjang. Persingkat jawaban uraian Anda.');
  return o;
}

export function hitungTerjawab_(jw) {
  let n = 0; const j = (jw && jw.j) || {};
  for (const k in j) { if (!kosong_(j[k])) n++; }
  return n;
}

// ---------------------------------------------------------------------------
//  KOMPRES DATA HASIL (hemat ukuran D1: batas paket gratis 500 MB per database)
//  Rekam hasil per siswa ±2,7 KB JSON → ±1,5 KB. Data lama (JSON biasa) tetap terbaca.
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function keB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function dariB64(t) { const s = atob(t), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }
export async function kemasData(obj) {
  const s = JSON.stringify(obj);
  if (s.length < 400) return s;
  const z = new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  return 'z:' + keB64(z);
}
export async function bukaData(t) {
  if (typeof t !== 'string') return t;
  if (!t.startsWith('z:')) return JSON.parse(t);
  return JSON.parse(await new Response(new Blob([dariB64(t.slice(2))]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text());
}
export const bukaSemua = rows => Promise.all(rows.map(bukaData));

// ---------------------------------------------------------------------------
//  LAIN-LAIN
// ---------------------------------------------------------------------------
export function tebakTingkat_(namaKelas, tingkatList) {
  let best = '';
  (tingkatList || []).forEach(t => {
    const re = new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i');
    if (re.test(namaKelas) && t.length > best.length) best = t;
  });
  return best;
}
export const publikGuru_ = g => ({ id: g.id, username: g.username, nama: g.nama, role: g.role, aktif: g.aktif !== false, mapel: g.mapel || [] });

export const CONFIG_DEFAULT = { namaSekolah: 'Sekolah', tahunAjaran: '', semester: '', logo: '', tingkat: ['X', 'XI', 'XII'], kelas: [], mapel: [] };

export function bankContoh_() {
  const t = Date.now();
  return {
    id: 'bcontoh01', judul: 'Contoh — Semua Jenis Soal', mapel: 'Matematika', tingkat: 'X',
    deskripsi: 'Bank soal contoh berisi 7 jenis soal. Boleh dihapus.',
    guruId: 'gcontoh', guruNama: 'Guru Contoh', dibuat: t, diubah: t,
    soal: [
      { id: 'scontoh1', tipe: 'pg', teks: 'Hasil dari $2^3 + 4 \\times 2$ adalah ...', stimulus: '', gambar: [], bobot: 1, pembahasan: '$2^3 = 8$, lalu $8 + 8 = 16$.',
        opsi: [{ id: 'oa1', teks: '12', gambar: '' }, { id: 'ob1', teks: '16', gambar: '' }, { id: 'oc1', teks: '20', gambar: '' }, { id: 'od1', teks: '24', gambar: '' }], kunci: 'ob1' },
      { id: 'scontoh2', tipe: 'pgk', teks: 'Manakah yang merupakan **bilangan prima**? (pilih lebih dari satu)', stimulus: '', gambar: [], bobot: 2, pembahasan: '', penilaian: 'sebagian',
        opsi: [{ id: 'oa2', teks: '2', gambar: '' }, { id: 'ob2', teks: '9', gambar: '' }, { id: 'oc2', teks: '11', gambar: '' }, { id: 'od2', teks: '15', gambar: '' }], kunci: ['oa2', 'oc2'] },
      { id: 'scontoh3', tipe: 'bs', teks: 'Tentukan benar atau salah setiap pernyataan berikut.', stimulus: '', gambar: [], bobot: 2, pembahasan: '', penilaian: 'sebagian', label: ['Benar', 'Salah'],
        pernyataan: [{ id: 'p31', teks: 'Jumlah sudut dalam segitiga adalah 180°.', benar: true }, { id: 'p32', teks: 'Persegi memiliki 3 sisi.', benar: false }, { id: 'p33', teks: '$\\sqrt{49} = 7$', benar: true }] },
      { id: 'scontoh4', tipe: 'jodoh', teks: 'Jodohkan bangun datar dengan rumus luasnya.', stimulus: '', gambar: [], bobot: 3, pembahasan: '', penilaian: 'sebagian',
        pasangan: [{ idKiri: 'l41', idKanan: 'r41', kiri: 'Persegi', kanan: '$s \\times s$' }, { idKiri: 'l42', idKanan: 'r42', kiri: 'Segitiga', kanan: '$\\frac{1}{2} \\times a \\times t$' }, { idKiri: 'l43', idKanan: 'r43', kiri: 'Lingkaran', kanan: '$\\pi r^2$' }, { idKiri: 'l44', idKanan: 'r44', kiri: '', kanan: '$2 \\pi r$' }] },
      { id: 'scontoh5', tipe: 'isian', teks: 'Ibu kota Provinsi Sulawesi Selatan adalah ...', stimulus: '', gambar: [], bobot: 1, pembahasan: '', jawaban: ['Makassar', 'Kota Makassar'] },
      { id: 'scontoh6', tipe: 'urut', teks: 'Urutkan bilangan berikut dari yang **terkecil** hingga terbesar.', stimulus: '', gambar: [], bobot: 2, pembahasan: '', penilaian: 'mutlak',
        opsi: [{ id: 'o61', teks: '$-3$', gambar: '' }, { id: 'o62', teks: '$0{,}5$', gambar: '' }, { id: 'o63', teks: '$\\frac{3}{4}$', gambar: '' }, { id: 'o64', teks: '$2$', gambar: '' }] },
      { id: 'scontoh7', tipe: 'uraian', teks: 'Jelaskan langkah-langkah menyelesaikan persamaan $2x + 6 = 14$.', stimulus: '', gambar: [], bobot: 4, pembahasan: '', rubrik: 'Skor 4: memindahkan 6 ke ruas kanan (2x = 8) lalu membagi 2 (x = 4) dengan penjelasan runtut.\nSkor 2: jawaban benar tanpa langkah.\nSkor 0: salah.' }
    ]
  };
}
