/**
 * ============================================================================
 *  CBT SEKOLAH — Backend Google Apps Script
 * ============================================================================
 *  Database   : repo GitHub PRIVAT  (soal, kunci, akun, jadwal, hasil)
 *  Gambar     : repo GitHub PUBLIK  (gambar soal)
 *  Antrian    : Google Sheet (dibuat otomatis) sebagai buffer cepat peserta.
 *               Hasil disinkronkan ke GitHub setiap 1 menit dalam 1 commit.
 *
 *  SCRIPT PROPERTIES yang wajib diisi (Project Settings > Script properties):
 *    GITHUB_TOKEN  : Fine-grained token (Contents: Read & write) utk kedua repo
 *    DATA_REPO     : contoh  namaakun/cbt-data    (HARUS privat)
 *    MEDIA_REPO    : contoh  namaakun/cbt-media   (publik, utk gambar)
 *  Opsional:
 *    BRANCH        : default "main"
 *    MEDIA_CDN     : jsdelivr (default) | raw | pages
 *
 *  Setelah mengisi properties, jalankan fungsi setup() sekali dari editor,
 *  lalu Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 * ============================================================================
 */

var VERSI = '1.0.0';
var GRACE_MS = 2 * 60 * 1000;          // toleransi keterlambatan kirim jawaban
var TOKEN_GURU_JAM = 12;
var TOKEN_SISWA_JAM = 8;
var CACHE_TTL = 21600;                  // 6 jam (maksimum CacheService)
var MAX_JAWABAN_CHARS = 45000;
var SHEET_PESERTA = 'Peserta';

// Kolom sheet Peserta (1-based)
var C = {
  KEY: 1, UJIAN: 2, NIS: 3, NAMA: 4, KELAS: 5, STATUS: 6, MULAI: 7, DEADLINE: 8,
  SELESAI: 9, PELANGGARAN: 10, JAWABAN: 11, HASIL: 12, MANUAL: 13, VER: 14,
  SYNCVER: 15, LASTSEEN: 16, PERCOBAAN: 17, CATATAN: 18, PERANGKAT: 19
};
var NCOL = 19;
var HEADER = ['key', 'ujianId', 'nis', 'nama', 'kelas', 'status', 'mulai', 'deadline',
  'selesai', 'pelanggaran', 'jawaban', 'hasil', 'manual', 'ver', 'syncVer',
  'lastSeen', 'percobaan', 'catatan', 'perangkat'];

// ---------------------------------------------------------------------------
//  ENTRY POINT
// ---------------------------------------------------------------------------
function doGet() {
  return out_({ ok: true, data: { app: 'CBT Sekolah', versi: VERSI }, serverTime: Date.now() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out_({ ok: false, error: 'Format permintaan tidak valid', code: 'ERR', serverTime: Date.now() });
  }
  try {
    var fn = ACTIONS[req.action];
    if (!fn) throw new AppError('Aksi tidak dikenal: ' + req.action);
    var result = fn(req.data || {}, { token: req.token || '' });
    return out_({ ok: true, data: result === undefined ? null : result, serverTime: Date.now() });
  } catch (err) {
    var msg = String(err && err.message || err);
    var code = (err && err.code) || (/too many|invoked|lock|timed out|timeout|rate limit|bandwidth/i.test(msg) ? 'BUSY' : 'ERR');
    if (!(err instanceof AppError)) console.error(req.action + ': ' + msg + (err && err.stack ? '\n' + err.stack : ''));
    return out_({ ok: false, error: msg, code: code, serverTime: Date.now() });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function AppError(message, code) {
  this.message = message;
  this.code = code || 'ERR';
  this.stack = (new Error(message)).stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.name = 'AppError';

// ---------------------------------------------------------------------------
//  DAFTAR AKSI API
// ---------------------------------------------------------------------------
var ACTIONS = {
  // publik
  ping: apiPing,
  loginGuru: apiLoginGuru,
  loginSiswa: apiLoginSiswa,
  // umum (login)
  gantiPassword: apiGantiPassword,
  getConfig: apiGetConfig,
  // guru & admin
  dashboard: apiDashboard,
  listBank: apiListBank,
  getBank: apiGetBank,
  saveBank: apiSaveBank,
  deleteBank: apiDeleteBank,
  uploadGambar: apiUploadGambar,
  listUjian: apiListUjian,
  monitorUjian: apiMonitorUjian,
  hasilUjian: apiHasilUjian,
  koreksi: apiKoreksi,
  hitungUlang: apiHitungUlang,
  koreksiMassal: apiKoreksiMassal,
  // admin
  saveConfig: apiSaveConfig,
  saveUjian: apiSaveUjian,
  deleteUjian: apiDeleteUjian,
  gantiTokenUjian: apiGantiTokenUjian,
  resetPeserta: apiResetPeserta,
  resetLogin: apiResetLogin,
  paksaSelesai: apiPaksaSelesai,
  listGuru: apiListGuru,
  saveGuru: apiSaveGuru,
  deleteGuru: apiDeleteGuru,
  listSiswa: apiListSiswa,
  saveSiswa: apiSaveSiswa,
  importSiswa: apiImportSiswa,
  deleteSiswa: apiDeleteSiswa,
  sinkronSekarang: apiSinkronSekarang,
  // siswa
  ujianSaya: apiUjianSaya,
  mulaiUjian: apiMulaiUjian,
  simpanJawaban: apiSimpanJawaban,
  selesaiUjian: apiSelesaiUjian
};

// ---------------------------------------------------------------------------
//  KONFIGURASI & UTIL
// ---------------------------------------------------------------------------
var PROPS_ = null;
/** Script Properties di-cache 10 menit agar tidak menghabiskan kuota baca Properties (50.000/hari akun Gmail). */
function props_() {
  if (PROPS_) return PROPS_;
  var c = CacheService.getScriptCache().get('cfg_props');
  if (c) { PROPS_ = JSON.parse(c); return PROPS_; }
  PROPS_ = PropertiesService.getScriptProperties().getProperties();
  try { CacheService.getScriptCache().put('cfg_props', JSON.stringify(PROPS_), 600); } catch (e) {}
  return PROPS_;
}
function prop_(k, def) { var v = props_()[k]; return (v === undefined || v === null || v === '') ? def : v; }
function dataRepo_() { var r = prop_('DATA_REPO'); if (!r) throw new AppError('DATA_REPO belum diatur di Script Properties'); return r; }
function mediaRepo_() { var r = prop_('MEDIA_REPO'); if (!r) throw new AppError('MEDIA_REPO belum diatur di Script Properties'); return r; }
function branch_() { return prop_('BRANCH', 'main'); }
function secret_() { var s = prop_('SECRET'); if (!s) throw new AppError('Jalankan setup() terlebih dahulu'); return s; }

function uid_(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}
function str_(v, max) { v = (v === null || v === undefined) ? '' : String(v); return max ? v.slice(0, max) : v; }
function num_(v, def) { var n = Number(v); return isFinite(n) ? n : def; }
function bool_(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function parse_(s, def) { if (!s) return def; try { return JSON.parse(s); } catch (e) { return def; } }
function bytesHex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) { var b = (bytes[i] + 256) % 256; s += (b < 16 ? '0' : '') + b.toString(16); }
  return s;
}
function hashPw_(pw, salt) {
  return bytesHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pw, Utilities.Charset.UTF_8));
}
function makeCred_(pw) { var salt = uid_(''); return { salt: salt, hash: hashPw_(String(pw), salt) }; }
function cekPw_(user, pw) { return user && user.salt && user.hash === hashPw_(String(pw), user.salt); }

function round2_(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------
//  CACHE (mendukung nilai > 100KB dengan dipecah)
// ---------------------------------------------------------------------------
var MEMO_ = {};
function cache_() { return CacheService.getScriptCache(); }
function cacheGet_(key) {
  if (MEMO_.hasOwnProperty(key)) return MEMO_[key];
  var c = cache_();
  var meta = c.get(key);
  if (meta === null) return null;
  if (meta.indexOf('§CH:') !== 0) { MEMO_[key] = meta; return meta; }
  var parts = meta.split(':'); // §CH:n:vid
  var n = Number(parts[1]), vid = parts[2], keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '#' + vid + '#' + i);
  var got = c.getAll(keys), s = '';
  for (var j = 0; j < keys.length; j++) { if (got[keys[j]] === undefined || got[keys[j]] === null) return null; s += got[keys[j]]; }
  MEMO_[key] = s;
  return s;
}
function cachePut_(key, val, ttl) {
  MEMO_[key] = val;
  var c = cache_(), SIZE = 25000;
  ttl = ttl || CACHE_TTL;
  try {
    if (val.length <= SIZE) { c.put(key, val, ttl); return; }
    var vid = uid_(''), n = Math.ceil(val.length / SIZE), obj = {};
    for (var i = 0; i < n; i++) obj[key + '#' + vid + '#' + i] = val.substr(i * SIZE, SIZE);
    c.putAll(obj, ttl);
    c.put(key, '§CH:' + n + ':' + vid, ttl);
  } catch (e) {
    console.warn('cachePut gagal ' + key + ': ' + e.message);
  }
}
function cacheDel_(key) { delete MEMO_[key]; cache_().remove(key); }

// ---------------------------------------------------------------------------
//  GITHUB
// ---------------------------------------------------------------------------
function ghFetch_(method, path, body, accept) {
  var token = prop_('GITHUB_TOKEN');
  if (!token) throw new AppError('GITHUB_TOKEN belum diatur di Script Properties');
  var opt = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  if (body !== undefined) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch('https://api.github.com' + path, opt);
  return { code: res.getResponseCode(), text: res.getContentText('UTF-8') };
}
function ghJson_(method, path, body) {
  var r = ghFetch_(method, path, body);
  if (r.code < 200 || r.code >= 300) {
    var e = new AppError('GitHub ' + r.code + ' (' + method.toUpperCase() + ' ' + path.split('?')[0] + '): ' + r.text.slice(0, 200), ghKode_(r));
    e.status = r.code;
    throw e;
  }
  return r.text ? JSON.parse(r.text) : {};
}
function ghKode_(r) {
  if (r.code === 409 || r.code === 422) return 'CONFLICT';
  if (r.code >= 500 || r.code === 429 || (r.code === 403 && /rate limit|abuse/i.test(r.text))) return 'BUSY';
  return 'ERR';
}
function encPath_(p) { return p.split('/').map(encodeURIComponent).join('/'); }

/** Baca file mentah dari repo. null bila tidak ada. */
function ghRead_(repo, path, fresh) {
  var ck = 'gh:' + repo + ':' + path;
  if (!fresh) {
    var c = cacheGet_(ck);
    if (c !== null) return c === '§NULL' ? null : c;
  }
  var r = ghFetch_('get', '/repos/' + repo + '/contents/' + encPath_(path) + '?ref=' + encodeURIComponent(branch_()), undefined, 'application/vnd.github.raw+json');
  if (r.code === 404) { cachePut_(ck, '§NULL', 300); return null; }
  if (r.code !== 200) throw new AppError('Gagal membaca ' + path + ' dari GitHub (' + r.code + '): ' + r.text.slice(0, 150), ghKode_(r));
  cachePut_(ck, r.text);
  return r.text;
}
function readJson_(path, def, fresh) {
  var t = ghRead_(dataRepo_(), path, fresh);
  if (t === null) return def;
  try { return JSON.parse(t); } catch (e) { throw new AppError('File ' + path + ' di GitHub rusak (bukan JSON valid)'); }
}

/**
 * Commit banyak file sekaligus (Git Data API). files: { path: stringIsi | null(hapus) }
 */
function ghCommit_(repo, files, message) {
  var paths = Object.keys(files);
  if (!paths.length) return null;
  var br = branch_();
  for (var attempt = 0; attempt < 5; attempt++) {
    var ref = ghJson_('get', '/repos/' + repo + '/git/ref/heads/' + br);
    var headSha = ref.object.sha;
    var head = ghJson_('get', '/repos/' + repo + '/git/commits/' + headSha);
    var tree = paths.map(function (p) {
      return files[p] === null
        ? { path: p, mode: '100644', type: 'blob', sha: null }
        : { path: p, mode: '100644', type: 'blob', content: files[p] };
    });
    var t = ghJson_('post', '/repos/' + repo + '/git/trees', { base_tree: head.tree.sha, tree: tree });
    var cm = ghJson_('post', '/repos/' + repo + '/git/commits', { message: message, tree: t.sha, parents: [headSha] });
    var u = ghFetch_('patch', '/repos/' + repo + '/git/refs/heads/' + br, { sha: cm.sha, force: false });
    if (u.code === 200) {
      paths.forEach(function (p) {
        cachePut_('gh:' + repo + ':' + p, files[p] === null ? '§NULL' : files[p], files[p] === null ? 300 : CACHE_TTL);
      });
      return cm.sha;
    }
    if (u.code === 409 || u.code === 422) { Utilities.sleep(250 + Math.floor(Math.random() * 750)); continue; }
    throw new AppError('Gagal menyimpan ke GitHub (' + u.code + '): ' + u.text.slice(0, 150), ghKode_(u));
  }
  throw new AppError('GitHub sedang sibuk, coba simpan lagi', 'BUSY');
}

function writeJson_(filesObj, message) {
  var f = {};
  Object.keys(filesObj).forEach(function (p) { f[p] = filesObj[p] === null ? null : JSON.stringify(filesObj[p], null, 1); });
  return ghCommit_(dataRepo_(), f, message);
}

/** Jalankan fn di dalam ScriptLock (untuk read-modify-write file bersama). */
function withLock_(fn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 25000)) throw new AppError('Server sedang sibuk, mencoba lagi…', 'BUSY');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
//  DATA (dengan cache)
// ---------------------------------------------------------------------------
var P = {
  config: 'config.json',
  guru: 'users/guru.json',
  siswa: 'users/siswa.json',
  bankIndex: 'bank/_index.json',
  bank: function (id) { return 'bank/' + id + '.json'; },
  ujianIndex: 'ujian/_index.json',
  hasil: function (id) { return 'hasil/' + id + '.json'; }
};
function safeId_(id) {
  id = str_(id);
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(id)) throw new AppError('ID tidak valid');
  return id;
}
function getConfig_() {
  return readJson_(P.config, { namaSekolah: 'Sekolah', tahunAjaran: '', semester: '', tingkat: ['X', 'XI', 'XII'], kelas: [], mapel: [] });
}
function getGuruList_(fresh) { return readJson_(P.guru, [], fresh); }
function getSiswaList_(fresh) { return readJson_(P.siswa, [], fresh); }
function getBankIndex_(fresh) { return readJson_(P.bankIndex, [], fresh); }
function getUjianList_(fresh) { return readJson_(P.ujianIndex, [], fresh); }
function getBank_(id, fresh) { return readJson_(P.bank(safeId_(id)), null, fresh); }
function getUjian_(id) {
  var u = getUjianList_().filter(function (x) { return x.id === id; })[0];
  if (!u) throw new AppError('Ujian tidak ditemukan');
  return u;
}

// ---------------------------------------------------------------------------
//  AUTENTIKASI (token bertanda tangan HMAC, tanpa penyimpanan sesi)
// ---------------------------------------------------------------------------
function signToken_(payload) {
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(payload), Utilities.Charset.UTF_8);
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret_()));
  return body + '.' + sig;
}
function verifyToken_(tok) {
  var bad = new AppError('Sesi berakhir, silakan masuk lagi', 'AUTH');
  if (!tok || tok.indexOf('.') < 0) throw bad;
  var parts = tok.split('.');
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], secret_()));
  if (sig !== parts[1]) throw bad;
  var p = parse_(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'), null);
  if (!p || !p.exp || p.exp < Date.now()) throw bad;
  return p;
}
function reqGuru_(ctx) {
  var p = verifyToken_(ctx.token);
  if (p.r !== 'guru' && p.r !== 'admin') throw new AppError('Akses khusus guru', 'AUTH');
  return p;
}
function reqAdmin_(ctx) {
  var p = reqGuru_(ctx);
  if (p.r !== 'admin') throw new AppError('Akses khusus admin');
  return p;
}
function reqSiswa_(ctx) {
  var p = verifyToken_(ctx.token);
  if (p.r !== 'siswa') throw new AppError('Akses khusus siswa', 'AUTH');
  return p;
}
function cekPercobaan_(key) {
  var n = Number(cache_().get('la:' + key) || 0);
  if (n >= 8) throw new AppError('Terlalu banyak percobaan masuk. Tunggu 10 menit lalu coba lagi.');
  return n;
}
function catatGagal_(key, n) { cache_().put('la:' + key, String(n + 1), 600); }

// ---------------------------------------------------------------------------
//  API PUBLIK
// ---------------------------------------------------------------------------
function apiPing() {
  var c = getConfig_();
  return { app: 'CBT Sekolah', versi: VERSI, namaSekolah: c.namaSekolah, logo: c.logo || '', tahunAjaran: c.tahunAjaran, semester: c.semester };
}

function apiLoginGuru(d) {
  var username = str_(d.username).trim().toLowerCase();
  var n = cekPercobaan_('g:' + username);
  var u = getGuruList_().filter(function (x) { return x.username === username; })[0];
  if (!u || !cekPw_(u, d.password)) { catatGagal_('g:' + username, n); throw new AppError('Nama pengguna atau kata sandi salah'); }
  if (u.aktif === false) throw new AppError('Akun dinonaktifkan. Hubungi admin.');
  var token = signToken_({ r: u.role === 'admin' ? 'admin' : 'guru', id: u.id, n: u.nama, exp: Date.now() + TOKEN_GURU_JAM * 3600000 });
  return { token: token, user: { id: u.id, username: u.username, nama: u.nama, role: u.role === 'admin' ? 'admin' : 'guru', mapel: u.mapel || [] }, config: getConfig_() };
}

function apiLoginSiswa(d) {
  var nis = str_(d.nis).trim();
  var n = cekPercobaan_('s:' + nis);
  var s = getSiswaList_().filter(function (x) { return String(x.nis) === nis; })[0];
  if (!s || !cekPw_(s, d.password)) { catatGagal_('s:' + nis, n); throw new AppError('NIS atau kata sandi salah'); }
  var token = signToken_({ r: 'siswa', id: s.nis, n: s.nama, k: s.kelas, exp: Date.now() + TOKEN_SISWA_JAM * 3600000 });
  var c = getConfig_();
  return { token: token, user: { nis: s.nis, nama: s.nama, kelas: s.kelas }, sekolah: { namaSekolah: c.namaSekolah, logo: c.logo || '' } };
}

function apiGantiPassword(d, ctx) {
  var p = verifyToken_(ctx.token);
  var baru = str_(d.baru);
  if (baru.length < 6) throw new AppError('Kata sandi baru minimal 6 karakter');
  return withLock_(function () {
    if (p.r === 'siswa') {
      var list = getSiswaList_(true);
      var s = list.filter(function (x) { return String(x.nis) === p.id; })[0];
      if (!s || !cekPw_(s, d.lama)) throw new AppError('Kata sandi lama salah');
      var cr = makeCred_(baru); s.salt = cr.salt; s.hash = cr.hash;
      var f = {}; f[P.siswa] = list; writeJson_(f, 'Siswa ' + p.id + ' ganti kata sandi');
    } else {
      var g = getGuruList_(true);
      var u = g.filter(function (x) { return x.id === p.id; })[0];
      if (!u || !cekPw_(u, d.lama)) throw new AppError('Kata sandi lama salah');
      var cr2 = makeCred_(baru); u.salt = cr2.salt; u.hash = cr2.hash;
      var f2 = {}; f2[P.guru] = g; writeJson_(f2, 'Guru ' + u.username + ' ganti kata sandi');
    }
    return true;
  });
}

function apiGetConfig(d, ctx) { verifyToken_(ctx.token); return getConfig_(); }

function apiSaveConfig(d, ctx) {
  var me = reqAdmin_(ctx);
  var cfg = {
    namaSekolah: str_(d.namaSekolah, 120).trim() || 'Sekolah',
    tahunAjaran: str_(d.tahunAjaran, 20),
    semester: str_(d.semester, 20),
    logo: str_(d.logo, 500),
    tingkat: (d.tingkat || []).map(function (x) { return str_(x, 20).trim(); }).filter(Boolean),
    kelas: (d.kelas || []).map(function (k) { return { nama: str_(k.nama, 40).trim(), tingkat: str_(k.tingkat, 20).trim() }; }).filter(function (k) { return k.nama; }),
    mapel: (d.mapel || []).map(function (x) { return str_(x, 80).trim(); }).filter(Boolean)
  };
  withLock_(function () { var f = {}; f[P.config] = cfg; writeJson_(f, 'Pengaturan diubah oleh ' + me.n); });
  return cfg;
}

// ---------------------------------------------------------------------------
//  DASHBOARD
// ---------------------------------------------------------------------------
function apiDashboard(d, ctx) {
  var me = reqGuru_(ctx);
  var now = Date.now();
  var banks = getBankIndex_();
  var ujian = getUjianList_();
  if (me.r !== 'admin') {
    banks = banks.filter(function (b) { return b.guruId === me.id; });
    ujian = ujian.filter(function (u) { return u.guruId === me.id; });
  }
  var hariIni = ujian.filter(function (u) { return u.selesai >= now && u.mulai <= now + 86400000; })
    .sort(function (a, b) { return a.mulai - b.mulai; })
    .map(ringkasUjian_);
  var res = {
    jumlahBank: banks.length,
    jumlahSoal: banks.reduce(function (a, b) { return a + (b.jumlahSoal || 0); }, 0),
    jumlahUjian: ujian.length,
    berlangsung: ujian.filter(function (u) { return u.aktif && u.mulai <= now && u.selesai >= now; }).length,
    mendatang: hariIni,
    bankTerbaru: banks.slice().sort(function (a, b) { return (b.diubah || 0) - (a.diubah || 0); }).slice(0, 5)
  };
  if (me.r === 'admin') {
    res.jumlahSiswa = getSiswaList_().length;
    res.jumlahGuru = getGuruList_().length;
  }
  return res;
}

// ---------------------------------------------------------------------------
//  BANK SOAL
// ---------------------------------------------------------------------------
var TIPE_SOAL = ['pg', 'pgk', 'bs', 'jodoh', 'isian', 'urut', 'uraian'];

function apiListBank(d, ctx) {
  var me = reqGuru_(ctx);
  var list = getBankIndex_();
  if (me.r !== 'admin') list = list.filter(function (b) { return b.guruId === me.id; });
  return list;
}

function bolehBank_(me, bank) {
  if (me.r === 'admin' || bank.guruId === me.id) return true;
  throw new AppError('Anda tidak memiliki akses ke bank soal ini');
}

function apiGetBank(d, ctx) {
  var me = reqGuru_(ctx);
  var b = getBank_(d.id);
  if (!b) throw new AppError('Bank soal tidak ditemukan');
  bolehBank_(me, b);
  return b;
}

function bersihkanSoal_(s) {
  var tipe = TIPE_SOAL.indexOf(s.tipe) >= 0 ? s.tipe : 'pg';
  var o = {
    id: /^[a-zA-Z0-9_-]{3,40}$/.test(s.id || '') ? s.id : uid_('s'),
    tipe: tipe,
    teks: str_(s.teks, 20000),
    stimulus: str_(s.stimulus, 30000),
    gambar: (s.gambar || []).map(function (g) { return str_(g, 500); }).filter(Boolean).slice(0, 6),
    bobot: Math.max(0, num_(s.bobot, 1)),
    pembahasan: str_(s.pembahasan, 10000)
  };
  function opsiList(arr) {
    return (arr || []).map(function (op) {
      return {
        id: /^[a-zA-Z0-9_-]{2,40}$/.test(op.id || '') ? op.id : uid_('o'),
        teks: str_(op.teks, 5000),
        gambar: str_(op.gambar, 500)
      };
    }).slice(0, 12);
  }
  if (tipe === 'pg' || tipe === 'pgk' || tipe === 'urut') o.opsi = opsiList(s.opsi);
  if (tipe === 'pg') o.kunci = str_(s.kunci);
  if (tipe === 'pgk') o.kunci = (s.kunci || []).map(String);
  if (tipe === 'bs') {
    o.label = (s.label && s.label.length === 2) ? [str_(s.label[0], 30), str_(s.label[1], 30)] : ['Benar', 'Salah'];
    o.pernyataan = (s.pernyataan || []).map(function (p) {
      return { id: /^[a-zA-Z0-9_-]{2,40}$/.test(p.id || '') ? p.id : uid_('p'), teks: str_(p.teks, 3000), benar: !!p.benar };
    }).slice(0, 20);
  }
  if (tipe === 'jodoh') {
    o.pasangan = (s.pasangan || []).map(function (p) {
      return {
        idKiri: /^[a-zA-Z0-9_-]{2,40}$/.test(p.idKiri || '') ? p.idKiri : uid_('l'),
        idKanan: /^[a-zA-Z0-9_-]{2,40}$/.test(p.idKanan || '') ? p.idKanan : uid_('r'),
        kiri: str_(p.kiri, 2000),
        kanan: str_(p.kanan, 2000)
      };
    }).slice(0, 20);
  }
  if (tipe === 'isian') o.jawaban = (s.jawaban || []).map(function (x) { return str_(x, 300).trim(); }).filter(Boolean).slice(0, 20);
  if (tipe === 'uraian') o.rubrik = str_(s.rubrik, 10000);
  if (['pgk', 'bs', 'jodoh', 'urut'].indexOf(tipe) >= 0) o.penilaian = s.penilaian === 'mutlak' ? 'mutlak' : 'sebagian';
  return o;
}

function apiSaveBank(d, ctx) {
  var me = reqGuru_(ctx);
  var input = d.bank || {};
  var judul = str_(input.judul, 150).trim();
  if (!judul) throw new AppError('Judul bank soal wajib diisi');
  var isBaru = !input.id;
  var id = isBaru ? uid_('b') : safeId_(input.id);
  var soal = (input.soal || []).slice(0, 300).map(bersihkanSoal_);
  var seen = {};
  soal.forEach(function (s) { if (seen[s.id]) s.id = uid_('s'); seen[s.id] = 1; });
  return withLock_(function () {
    var lama = isBaru ? null : getBank_(id, true);
    if (!isBaru && !lama) throw new AppError('Bank soal tidak ditemukan');
    if (lama) bolehBank_(me, lama);
    var now = Date.now();
    var bank = {
      id: id,
      judul: judul,
      mapel: str_(input.mapel, 80),
      tingkat: str_(input.tingkat, 20),
      deskripsi: str_(input.deskripsi, 1000),
      guruId: lama ? lama.guruId : me.id,
      guruNama: lama ? lama.guruNama : me.n,
      dibuat: lama ? lama.dibuat : now,
      diubah: now,
      soal: soal
    };
    var idx = getBankIndex_(true).filter(function (b) { return b.id !== id; });
    idx.push({ id: id, judul: bank.judul, mapel: bank.mapel, tingkat: bank.tingkat, guruId: bank.guruId, guruNama: bank.guruNama, jumlahSoal: soal.length, totalBobot: soal.reduce(function (a, s) { return a + s.bobot; }, 0), dibuat: bank.dibuat, diubah: now });
    var f = {}; f[P.bank(id)] = bank; f[P.bankIndex] = idx;
    writeJson_(f, (isBaru ? 'Bank baru: ' : 'Ubah bank: ') + judul + ' (' + me.n + ')');
    // info ujian yang memakai bank ini
    var dipakai = getUjianList_().filter(function (u) { return u.bankId === id && u.selesai >= now; }).map(function (u) { return u.nama; });
    return { bank: bank, dipakai: dipakai };
  });
}

function apiDeleteBank(d, ctx) {
  var me = reqGuru_(ctx);
  var id = safeId_(d.id);
  return withLock_(function () {
    var b = getBank_(id, true);
    if (!b) throw new AppError('Bank soal tidak ditemukan');
    bolehBank_(me, b);
    var dipakai = getUjianList_(true).filter(function (u) { return u.bankId === id; });
    if (dipakai.length) throw new AppError('Bank soal dipakai di jadwal: ' + dipakai.map(function (u) { return u.nama; }).join(', ') + '. Hapus jadwalnya dulu.');
    var idx = getBankIndex_(true).filter(function (x) { return x.id !== id; });
    var f = {}; f[P.bank(id)] = null; f[P.bankIndex] = idx;
    writeJson_(f, 'Hapus bank: ' + b.judul + ' (' + me.n + ')');
    return true;
  });
}

function apiUploadGambar(d, ctx) {
  var me = reqGuru_(ctx);
  var tipe = str_(d.tipe);
  var ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[tipe];
  if (!ext) throw new AppError('Format gambar tidak didukung (gunakan JPG, PNG, WEBP, GIF)');
  var data = str_(d.data).replace(/^data:[^,]+,/, '');
  if (data.length > 2800000) throw new AppError('Ukuran gambar maksimal 2 MB');
  var now = new Date();
  var path = 'img/' + now.getFullYear() + '/' + ('0' + (now.getMonth() + 1)).slice(-2) + '/' + uid_('') + '.' + ext;
  var repo = mediaRepo_();
  var last;
  for (var i = 0; i < 4; i++) {
    last = ghFetch_('put', '/repos/' + repo + '/contents/' + encPath_(path), { message: 'Gambar soal (' + me.n + ')', content: data, branch: branch_() });
    if (last.code === 200 || last.code === 201) {
      var sha = JSON.parse(last.text).commit.sha;
      return { url: urlMedia_(repo, sha, path), path: path };
    }
    if (last.code !== 409 && last.code !== 422) break;
    Utilities.sleep(300 + Math.floor(Math.random() * 700));
  }
  throw new AppError('Gagal mengunggah gambar ke GitHub (' + last.code + '): ' + last.text.slice(0, 150));
}

function urlMedia_(repo, sha, path) {
  var mode = prop_('MEDIA_CDN', 'jsdelivr');
  var parts = repo.split('/');
  if (mode === 'raw') return 'https://raw.githubusercontent.com/' + repo + '/' + sha + '/' + path;
  if (mode === 'pages') return 'https://' + parts[0].toLowerCase() + '.github.io/' + parts[1] + '/' + path;
  return 'https://cdn.jsdelivr.net/gh/' + repo + '@' + sha + '/' + path;
}

// ---------------------------------------------------------------------------
//  JADWAL UJIAN
// ---------------------------------------------------------------------------
function statusJadwal_(u, now) {
  if (!u.aktif) return 'nonaktif';
  if (now < u.mulai) return 'akan';
  if (now > u.selesai) return 'selesai';
  return 'berlangsung';
}
/** jumlah soal terkini dari index bank (bank bisa diedit setelah dijadwalkan) */
function jumlahSoalTerkini_(u) {
  if (!JUMLAH_MEMO_) { JUMLAH_MEMO_ = {}; getBankIndex_().forEach(function (b) { JUMLAH_MEMO_[b.id] = b.jumlahSoal; }); }
  return JUMLAH_MEMO_[u.bankId] !== undefined ? JUMLAH_MEMO_[u.bankId] : u.jumlahSoal;
}
var JUMLAH_MEMO_ = null;

function ringkasUjian_(u) {
  var now = Date.now();
  return {
    id: u.id, nama: u.nama, bankId: u.bankId, bankJudul: u.bankJudul, mapel: u.mapel, tingkat: u.tingkat,
    guruId: u.guruId, guruNama: u.guruNama, kelas: u.kelas, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi,
    acakSoal: u.acakSoal, acakOpsi: u.acakOpsi, tampilNilai: u.tampilNilai, pakaiToken: u.pakaiToken,
    token: u.token, maxPelanggaran: u.maxPelanggaran, aktif: u.aktif, keterangan: u.keterangan,
    jumlahSoal: jumlahSoalTerkini_(u), status: statusJadwal_(u, now), diubah: u.diubah
  };
}

function apiListUjian(d, ctx) {
  var me = reqGuru_(ctx);
  var list = getUjianList_();
  if (me.r !== 'admin') list = list.filter(function (u) { return u.guruId === me.id; });
  return list.map(ringkasUjian_).sort(function (a, b) { return b.mulai - a.mulai; });
}

function buatToken_() {
  var huruf = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 6; i++) s += huruf.charAt(Math.floor(Math.random() * huruf.length));
  return s;
}

function apiSaveUjian(d, ctx) {
  var me = reqAdmin_(ctx);
  var nama = str_(d.nama, 150).trim();
  if (!nama) throw new AppError('Nama ujian wajib diisi');
  var mulai = num_(d.mulai, 0), selesai = num_(d.selesai, 0), durasi = Math.round(num_(d.durasi, 0));
  if (!mulai || !selesai || selesai <= mulai) throw new AppError('Waktu selesai harus setelah waktu mulai');
  if (durasi < 1 || durasi > 600) throw new AppError('Durasi harus 1–600 menit');
  var kelas = (d.kelas || []).map(function (k) { return str_(k, 40); }).filter(Boolean);
  if (!kelas.length) throw new AppError('Pilih minimal satu kelas peserta');
  var bank = getBank_(d.bankId, true);
  if (!bank) throw new AppError('Bank soal tidak ditemukan');
  if (!bank.soal.length) throw new AppError('Bank soal masih kosong');

  var saved = withLock_(function () {
    var list = getUjianList_(true);
    var lama = d.id ? list.filter(function (u) { return u.id === d.id; })[0] : null;
    if (d.id && !lama) throw new AppError('Jadwal tidak ditemukan');
    var now = Date.now();
    var u = {
      id: lama ? lama.id : uid_('u'),
      nama: nama,
      bankId: bank.id, bankJudul: bank.judul, mapel: bank.mapel, tingkat: str_(d.tingkat, 20) || bank.tingkat,
      guruId: bank.guruId, guruNama: bank.guruNama, jumlahSoal: bank.soal.length,
      kelas: kelas, mulai: mulai, selesai: selesai, durasi: durasi,
      acakSoal: bool_(d.acakSoal), acakOpsi: bool_(d.acakOpsi), tampilNilai: bool_(d.tampilNilai),
      pakaiToken: bool_(d.pakaiToken),
      token: bool_(d.pakaiToken) ? ((lama && lama.token) || buatToken_()) : '',
      maxPelanggaran: Math.max(0, Math.round(num_(d.maxPelanggaran, 0))),
      aktif: d.aktif === undefined ? true : bool_(d.aktif),
      keterangan: str_(d.keterangan, 1000),
      dibuat: lama ? lama.dibuat : now, diubah: now, oleh: me.n
    };
    list = list.filter(function (x) { return x.id !== u.id; });
    list.push(u);
    var f = {}; f[P.ujianIndex] = list;
    writeJson_(f, (lama ? 'Ubah jadwal: ' : 'Jadwal baru: ') + nama + ' (' + me.n + ')');
    siapkanPeserta_(u);
    return u;
  });
  return ringkasUjian_(saved);
}

function apiDeleteUjian(d, ctx) {
  var me = reqAdmin_(ctx);
  return withLock_(function () {
    var list = getUjianList_(true);
    var u = list.filter(function (x) { return x.id === d.id; })[0];
    if (!u) throw new AppError('Jadwal tidak ditemukan');
    var rows = barisUjian_(u.id).filter(function (r) { return r.status === 'mengerjakan' || r.status === 'selesai'; });
    if (rows.length && !d.paksa) throw new AppError('Sudah ada ' + rows.length + ' peserta yang mengerjakan. Hapus tetap akan menyimpan hasil yang sudah ada di GitHub.', 'ADA_PESERTA');
    var f = {}; f[P.ujianIndex] = list.filter(function (x) { return x.id !== u.id; });
    writeJson_(f, 'Hapus jadwal: ' + u.nama + ' (' + me.n + ')');
    return true;
  });
}

function apiGantiTokenUjian(d, ctx) {
  var me = reqGuru_(ctx);
  return withLock_(function () {
    var list = getUjianList_(true);
    var u = list.filter(function (x) { return x.id === d.id; })[0];
    if (!u) throw new AppError('Jadwal tidak ditemukan');
    if (me.r !== 'admin' && u.guruId !== me.id) throw new AppError('Tidak berhak mengganti token');
    u.token = buatToken_(); u.pakaiToken = true; u.diubah = Date.now();
    var f = {}; f[P.ujianIndex] = list;
    writeJson_(f, 'Token baru: ' + u.nama);
    return u.token;
  });
}

// ---------------------------------------------------------------------------
//  SHEET PESERTA (buffer)
// ---------------------------------------------------------------------------
var SHEET_ = null;
function sheet_() {
  if (SHEET_) return SHEET_;
  var id = prop_('SHEET_ID');
  if (!id) throw new AppError('Jalankan setup() terlebih dahulu');
  SHEET_ = SpreadsheetApp.openById(id).getSheetByName(SHEET_PESERTA);
  return SHEET_;
}
function rowToObj_(v, row) {
  return {
    row: row, key: v[C.KEY - 1], ujianId: v[C.UJIAN - 1], nis: String(v[C.KEY - 1]).split('|')[1], nama: v[C.NAMA - 1], kelas: v[C.KELAS - 1],
    status: v[C.STATUS - 1] || 'belum', mulai: Number(v[C.MULAI - 1]) || 0, deadline: Number(v[C.DEADLINE - 1]) || 0,
    selesai: Number(v[C.SELESAI - 1]) || 0, pelanggaran: Number(v[C.PELANGGARAN - 1]) || 0,
    jawaban: parse_(v[C.JAWABAN - 1], { j: {}, r: [] }), hasil: parse_(v[C.HASIL - 1], null), manual: parse_(v[C.MANUAL - 1], {}),
    ver: Number(v[C.VER - 1]) || 0, syncVer: Number(v[C.SYNCVER - 1]) || 0, lastSeen: Number(v[C.LASTSEEN - 1]) || 0,
    percobaan: Number(v[C.PERCOBAAN - 1]) || 0, catatan: v[C.CATATAN - 1] || '', perangkat: v[C.PERANGKAT - 1] || ''
  };
}
function objToRow_(o) {
  var v = new Array(NCOL);
  v[C.KEY - 1] = o.key; v[C.UJIAN - 1] = o.ujianId; v[C.NIS - 1] = String(o.nis); v[C.NAMA - 1] = o.nama || ''; v[C.KELAS - 1] = o.kelas || '';
  v[C.STATUS - 1] = o.status || 'belum'; v[C.MULAI - 1] = o.mulai || ''; v[C.DEADLINE - 1] = o.deadline || ''; v[C.SELESAI - 1] = o.selesai || '';
  v[C.PELANGGARAN - 1] = o.pelanggaran || 0; v[C.JAWABAN - 1] = o.jawaban ? JSON.stringify(o.jawaban) : '';
  v[C.HASIL - 1] = o.hasil ? JSON.stringify(o.hasil) : ''; v[C.MANUAL - 1] = o.manual && Object.keys(o.manual).length ? JSON.stringify(o.manual) : '';
  v[C.VER - 1] = o.ver || 0; v[C.SYNCVER - 1] = o.syncVer || 0; v[C.LASTSEEN - 1] = o.lastSeen || ''; v[C.PERCOBAAN - 1] = o.percobaan || 0;
  v[C.CATATAN - 1] = o.catatan || ''; v[C.PERANGKAT - 1] = o.perangkat || '';
  return v;
}
function tulisBaris_(o) { sheet_().getRange(o.row, 1, 1, NCOL).setValues([objToRow_(o)]); }

/** Peta nis -> nomor baris untuk satu ujian (cache, fallback scan kolom A:B). */
function petaBaris_(ujianId, rebuild) {
  var ck = 'rm:' + ujianId;
  if (!rebuild) { var c = parse_(cacheGet_(ck), null); if (c) return c; }
  var sh = sheet_(), last = sh.getLastRow(), map = {};
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < v.length; i++) if (v[i][1] === ujianId) map[String(v[i][0]).split('|')[1]] = i + 2;
  }
  cachePut_(ck, JSON.stringify(map));
  return map;
}

/** Ambil baris peserta (ujianId,nis). null jika belum ada. */
function ambilBaris_(ujianId, nis) {
  var key = ujianId + '|' + nis, sh = sheet_();
  for (var pass = 0; pass < 2; pass++) {
    var map = petaBaris_(ujianId, pass === 1);
    var row = map[nis];
    if (row) {
      var v = sh.getRange(row, 1, 1, NCOL).getValues()[0];
      if (v[0] === key) return rowToObj_(v, row);
    }
  }
  return null;
}

/** Semua baris untuk satu ujian (dibaca dalam 1 blok). */
function barisUjian_(ujianId) {
  var map = petaBaris_(ujianId), rows = Object.keys(map).map(function (k) { return map[k]; });
  if (!rows.length) return [];
  var min = Math.min.apply(null, rows), max = Math.max.apply(null, rows);
  var sh = sheet_();
  if (max > sh.getLastRow()) { map = petaBaris_(ujianId, true); rows = Object.keys(map).map(function (k) { return map[k]; }); if (!rows.length) return []; min = Math.min.apply(null, rows); max = Math.max.apply(null, rows); }
  var v = sh.getRange(min, 1, max - min + 1, NCOL).getValues(), out = [], valid = true;
  rows.forEach(function (r) {
    var val = v[r - min];
    if (val[C.UJIAN - 1] !== ujianId) valid = false; else out.push(rowToObj_(val, r));
  });
  if (!valid) { // peta usang -> bangun ulang sekali
    map = petaBaris_(ujianId, true);
    out = [];
    Object.keys(map).forEach(function (nis) { out.push(rowToObj_(sh.getRange(map[nis], 1, 1, NCOL).getValues()[0], map[nis])); });
  }
  return out;
}

/** Tambah baris baru (harus dipanggil di dalam lock). */
function tambahBaris_(objs) {
  if (!objs.length) return;
  var sh = sheet_(), start = sh.getLastRow() + 1, n = objs.length;
  var kurang = start + n - 1 - sh.getMaxRows();
  if (kurang > 0) sh.insertRowsAfter(sh.getMaxRows(), kurang + 500);
  sh.getRange(start, 1, n, 5).setNumberFormat('@');
  sh.getRange(start, 1, n, NCOL).setValues(objs.map(objToRow_));
  var byUjian = {};
  objs.forEach(function (o, i) { o.row = start + i; byUjian[o.ujianId] = 1; });
  Object.keys(byUjian).forEach(function (uj) { petaBaris_(uj, true); });
}

/** Buat baris "belum" untuk semua siswa di kelas peserta (dipanggil di dalam lock). */
function siapkanPeserta_(u) {
  var siswa = getSiswaList_().filter(function (s) { return u.kelas.indexOf(s.kelas) >= 0; });
  var map = petaBaris_(u.id, true), baru = [];
  siswa.forEach(function (s) {
    if (!map[String(s.nis)]) baru.push({ key: u.id + '|' + s.nis, ujianId: u.id, nis: String(s.nis), nama: s.nama, kelas: s.kelas, status: 'belum' });
  });
  tambahBaris_(baru);
}

// ---------------------------------------------------------------------------
//  ACAK DETERMINISTIK
// ---------------------------------------------------------------------------
function seed_(str) {
  var h = 1779033703 ^ str.length;
  for (var i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return h >>> 0;
}
function rng_(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function acak_(arr, seedStr) {
  var r = rng_(seed_(seedStr)), a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/** Soal untuk siswa: urutan sesuai pengaturan, TANPA kunci jawaban. */
function soalUntukSiswa_(u, bank, nis, percobaan) {
  var base = u.id + '|' + nis + '|' + percobaan;
  var list = u.acakSoal ? acak_(bank.soal, base) : bank.soal.slice();
  return list.map(function (s) {
    var o = { id: s.id, tipe: s.tipe, teks: s.teks, stimulus: s.stimulus || '', gambar: s.gambar || [], bobot: s.bobot };
    var opsiAcak = function (arr) { return u.acakOpsi ? acak_(arr, base + '|' + s.id) : arr.slice(); };
    var bersih = function (op) { return { id: op.id, teks: op.teks, gambar: op.gambar || '' }; };
    if (s.tipe === 'pg' || s.tipe === 'pgk') o.opsi = opsiAcak(s.opsi || []).map(bersih);
    if (s.tipe === 'urut') o.opsi = acak_(s.opsi || [], base + '|u|' + s.id).map(bersih);
    if (s.tipe === 'bs') { o.label = s.label || ['Benar', 'Salah']; o.pernyataan = (s.pernyataan || []).map(function (p) { return { id: p.id, teks: p.teks }; }); }
    if (s.tipe === 'jodoh') {
      o.kiri = (s.pasangan || []).filter(function (p) { return p.kiri; }).map(function (p) { return { id: p.idKiri, teks: p.kiri }; });
      o.kanan = acak_((s.pasangan || []).filter(function (p) { return p.kanan; }), base + '|j|' + s.id).map(function (p) { return { id: p.idKanan, teks: p.kanan }; });
    }
    return o;
  });
}

// ---------------------------------------------------------------------------
//  PENILAIAN
// ---------------------------------------------------------------------------
function normIsian_(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').replace(/,/g, '.').trim();
}

/** Nilai satu soal. return {skor, maks, manual(bool)} ; skor null = menunggu koreksi */
function nilaiSoal_(s, j) {
  var b = num_(s.bobot, 1), mutlak = s.penilaian === 'mutlak', rasio = 0;
  var kosong = j === undefined || j === null || j === '' || (Array.isArray(j) && !j.length) || (typeof j === 'object' && !Array.isArray(j) && !Object.keys(j).length);
  switch (s.tipe) {
    case 'pg':
      rasio = (!kosong && j === s.kunci) ? 1 : 0; break;
    case 'pgk': {
      var k = s.kunci || [], jj = Array.isArray(j) ? j : [];
      if (!k.length) { rasio = 0; break; }
      var benar = jj.filter(function (x) { return k.indexOf(x) >= 0; }).length;
      var salah = jj.filter(function (x) { return k.indexOf(x) < 0; }).length;
      rasio = mutlak ? (benar === k.length && salah === 0 ? 1 : 0) : Math.max(0, benar - salah) / k.length;
      break;
    }
    case 'bs': {
      var ps = s.pernyataan || [], jb = (j && typeof j === 'object') ? j : {}, ok = 0;
      ps.forEach(function (p) { if (jb[p.id] === p.benar) ok++; });
      rasio = !ps.length ? 0 : (mutlak ? (ok === ps.length ? 1 : 0) : ok / ps.length);
      break;
    }
    case 'jodoh': {
      var pr = (s.pasangan || []).filter(function (p) { return p.kiri && p.kanan; }), jm = (j && typeof j === 'object') ? j : {}, okj = 0;
      pr.forEach(function (p) { if (jm[p.idKiri] === p.idKanan) okj++; });
      rasio = !pr.length ? 0 : (mutlak ? (okj === pr.length ? 1 : 0) : okj / pr.length);
      break;
    }
    case 'isian': {
      var acc = (s.jawaban || []).map(normIsian_);
      rasio = (!kosong && acc.indexOf(normIsian_(j)) >= 0) ? 1 : 0;
      break;
    }
    case 'urut': {
      var benarUrut = (s.opsi || []).map(function (o) { return o.id; }), ju = Array.isArray(j) ? j : [], oku = 0;
      if (!ju.length) { rasio = 0; break; }
      benarUrut.forEach(function (id, i) { if (ju[i] === id) oku++; });
      rasio = !benarUrut.length ? 0 : (mutlak ? (oku === benarUrut.length ? 1 : 0) : oku / benarUrut.length);
      break;
    }
    case 'uraian':
      if (kosong) return { skor: 0, maks: b, manual: true, kosong: true };
      return { skor: null, maks: b, manual: true };
  }
  return { skor: round2_(rasio * b), maks: b, manual: false };
}

/** Hitung total. manual: {soalId: skor} dari koreksi guru. */
function hitungHasil_(bank, jawabanObj, manual) {
  var j = (jawabanObj && jawabanObj.j) || {}, perSoal = {}, skor = 0, maks = 0, perlu = 0, benar = 0;
  manual = manual || {};
  bank.soal.forEach(function (s) {
    var r = nilaiSoal_(s, j[s.id]);
    if (r.manual && !r.kosong && manual[s.id] !== undefined && manual[s.id] !== null && manual[s.id] !== '') {
      r.skor = Math.max(0, Math.min(r.maks, num_(manual[s.id], 0)));
    }
    if (r.skor === null) perlu++; else skor += r.skor;
    if (r.skor !== null && r.skor >= r.maks && r.maks > 0) benar++;
    maks += r.maks;
    perSoal[s.id] = r.skor;
  });
  return { skor: round2_(skor), maks: round2_(maks), nilai: maks ? round2_(skor / maks * 100) : 0, benar: benar, jumlahSoal: bank.soal.length, perluKoreksi: perlu, perSoal: perSoal };
}

// ---------------------------------------------------------------------------
//  API SISWA
// ---------------------------------------------------------------------------
function apiUjianSaya(d, ctx) {
  var me = reqSiswa_(ctx);
  var now = Date.now();
  var list = getUjianList_().filter(function (u) {
    return u.aktif && u.kelas.indexOf(me.k) >= 0 && u.selesai >= now - 3 * 86400000 && u.mulai <= now + 7 * 86400000;
  }).sort(function (a, b) { return a.mulai - b.mulai; });
  return list.map(function (u) {
    var b = ambilBaris_(u.id, me.id);
    var item = {
      id: u.id, nama: u.nama, mapel: u.mapel, mulai: u.mulai, selesai: u.selesai, durasi: u.durasi,
      jumlahSoal: jumlahSoalTerkini_(u), pakaiToken: u.pakaiToken, keterangan: u.keterangan,
      jadwal: statusJadwal_(u, now), status: b ? b.status : 'belum'
    };
    if (b && b.status === 'selesai' && u.tampilNilai && b.hasil) { item.nilai = b.hasil.nilai; item.perluKoreksi = b.hasil.perluKoreksi; }
    return item;
  });
}

function cekPerangkat_(row, perangkat) {
  if (row.perangkat && perangkat && row.perangkat !== perangkat) {
    throw new AppError('Ujian ini sedang dikerjakan di perangkat lain. Minta pengawas melakukan "Reset login".', 'PERANGKAT');
  }
}

function apiMulaiUjian(d, ctx) {
  var me = reqSiswa_(ctx);
  var u = getUjian_(str_(d.ujianId));
  var now = Date.now();
  if (!u.aktif || u.kelas.indexOf(me.k) < 0) throw new AppError('Anda tidak terdaftar sebagai peserta ujian ini');
  if (now < u.mulai) throw new AppError('Ujian belum dibuka');
  var perangkat = str_(d.perangkat, 60);
  var row = ambilBaris_(u.id, me.id);
  if (row && row.status === 'selesai') throw new AppError('Anda sudah menyelesaikan ujian ini', 'SELESAI');
  if (now > u.selesai && !(row && row.status === 'mengerjakan')) throw new AppError('Waktu ujian sudah ditutup');
  if (u.pakaiToken && str_(d.token).trim().toUpperCase() !== String(u.token).toUpperCase()) throw new AppError('Token ujian salah', 'TOKEN');
  var bank = getBank_(u.bankId);
  if (!bank) throw new AppError('Bank soal ujian tidak ditemukan. Hubungi admin.');

  if (!row) {
    row = withLock_(function () {
      var r = ambilBaris_(u.id, me.id);
      if (r) return r;
      var obj = { key: u.id + '|' + me.id, ujianId: u.id, nis: me.id, nama: me.n, kelas: me.k, status: 'belum' };
      tambahBaris_([obj]);
      return ambilBaris_(u.id, me.id);
    }, 20000);
  }
  if (row.status === 'mengerjakan') {
    cekPerangkat_(row, perangkat);
    if (now > row.deadline + GRACE_MS) {
      finalisasi_(row, u, bank, 'waktu habis');
      throw new AppError('Waktu pengerjaan Anda sudah habis. Jawaban terakhir telah dikirim.', 'SELESAI');
    }
    if (!row.perangkat && perangkat) { row.perangkat = perangkat; sheet_().getRange(row.row, C.PERANGKAT).setValue(perangkat); }
  } else { // belum / direset
    row.status = 'mengerjakan';
    row.mulai = now;
    row.deadline = Math.min(now + u.durasi * 60000, u.selesai);
    row.percobaan = (row.percobaan || 0) + 1;
    row.jawaban = { j: {}, r: [] };
    row.pelanggaran = 0; row.hasil = null; row.manual = {}; row.selesai = 0; row.catatan = '';
    row.perangkat = perangkat; row.lastSeen = now; row.nama = me.n; row.kelas = me.k;
    tulisBaris_(row);
    tandaiAntrian_(row.deadline);
  }
  return {
    ujian: { id: u.id, nama: u.nama, mapel: u.mapel, durasi: u.durasi, maxPelanggaran: u.maxPelanggaran, tampilNilai: u.tampilNilai, keterangan: u.keterangan },
    soal: soalUntukSiswa_(u, bank, me.id, row.percobaan),
    mulai: row.mulai, deadline: row.deadline, jawaban: row.jawaban, pelanggaran: row.pelanggaran
  };
}

function bersihJawaban_(jw) {
  var o = { j: (jw && typeof jw.j === 'object' && jw.j) ? jw.j : {}, r: (jw && Array.isArray(jw.r)) ? jw.r.slice(0, 300) : [] };
  var s = JSON.stringify(o);
  if (s.length > MAX_JAWABAN_CHARS) throw new AppError('Jawaban terlalu panjang. Persingkat jawaban uraian Anda.');
  return o;
}

function apiSimpanJawaban(d, ctx) {
  var me = reqSiswa_(ctx);
  var row = ambilBaris_(str_(d.ujianId), me.id);
  if (!row) throw new AppError('Data peserta tidak ditemukan');
  if (row.status === 'selesai') return infoSelesai_(row, getUjian_(row.ujianId));
  if (row.status !== 'mengerjakan') return { status: row.status };
  cekPerangkat_(row, str_(d.perangkat, 60));
  var now = Date.now();
  var jw = bersihJawaban_(d.jawaban);
  var pel = Math.max(row.pelanggaran, Math.round(num_(d.pelanggaran, 0)));
  sheet_().getRange(row.row, C.PELANGGARAN, 1, 2).setValues([[pel, JSON.stringify(jw)]]);
  sheet_().getRange(row.row, C.LASTSEEN).setValue(now);
  if (now > row.deadline + GRACE_MS) {
    var u = getUjian_(row.ujianId), bank = getBank_(u.bankId);
    row.jawaban = jw; row.pelanggaran = pel;
    finalisasi_(row, u, bank, 'waktu habis');
    return infoSelesai_(row, u);
  }
  return { status: 'mengerjakan', deadline: row.deadline };
}

/** Tandai bahwa ada data yang perlu disinkron (dibaca prosesAntrian). */
function tandaiAntrian_(aktifSampai) {
  try {
    var sp = PropertiesService.getScriptProperties();
    if (aktifSampai) {
      var cur = Number(sp.getProperty('Q_AKTIF') || 0);
      if (aktifSampai > cur) sp.setProperty('Q_AKTIF', String(aktifSampai));
    } else if (sp.getProperty('Q_DIRTY') !== '1') sp.setProperty('Q_DIRTY', '1');
  } catch (e) { console.warn('tandaiAntrian: ' + e.message); }
}

function finalisasi_(row, u, bank, catatan) {
  var now = Date.now();
  row.status = 'selesai';
  row.selesai = now;
  row.hasil = hitungHasil_(bank, row.jawaban, row.manual);
  row.catatan = catatan || row.catatan || '';
  row.ver = now;
  row.lastSeen = now;
  tulisBaris_(row);
  tandaiAntrian_();
  return row;
}

function apiSelesaiUjian(d, ctx) {
  var me = reqSiswa_(ctx);
  var row = ambilBaris_(str_(d.ujianId), me.id);
  if (!row) throw new AppError('Data peserta tidak ditemukan');
  var u = getUjian_(row.ujianId);
  if (row.status === 'mengerjakan') {
    cekPerangkat_(row, str_(d.perangkat, 60));
    var bank = getBank_(u.bankId);
    var now = Date.now();
    row.jawaban = bersihJawaban_(d.jawaban);
    row.pelanggaran = Math.max(row.pelanggaran, Math.round(num_(d.pelanggaran, 0)));
    var cat = [];
    if (d.alasan) cat.push(str_(d.alasan, 60));
    if (now > row.deadline + GRACE_MS) cat.push('terlambat');
    finalisasi_(row, u, bank, cat.join(', '));
  } else if (row.status !== 'selesai') {
    throw new AppError('Ujian belum dimulai atau telah direset');
  }
  return infoSelesai_(row, u);
}

function infoSelesai_(row, u) {
  var res = { status: 'selesai', selesai: row.selesai, catatan: row.catatan || '' };
  if (u.tampilNilai && row.hasil) { res.nilai = row.hasil.nilai; res.benar = row.hasil.benar; res.jumlahSoal = row.hasil.jumlahSoal; res.perluKoreksi = row.hasil.perluKoreksi; }
  return res;
}

// ---------------------------------------------------------------------------
//  MONITORING, HASIL, KOREKSI (guru/admin)
// ---------------------------------------------------------------------------
function bolehUjian_(me, u) {
  if (me.r === 'admin' || u.guruId === me.id) return true;
  throw new AppError('Anda tidak memiliki akses ke ujian ini');
}

function apiMonitorUjian(d, ctx) {
  var me = reqGuru_(ctx);
  var u = getUjian_(str_(d.ujianId));
  bolehUjian_(me, u);
  var now = Date.now();
  var rows = barisUjian_(u.id).map(function (r) {
    var terjawab = 0, j = r.jawaban.j || {};
    Object.keys(j).forEach(function (k) { var v = j[k]; if (v !== '' && v !== null && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) terjawab++; });
    return {
      nis: r.nis, nama: r.nama, kelas: r.kelas, status: r.status, mulai: r.mulai, deadline: r.deadline, selesai: r.selesai,
      pelanggaran: r.pelanggaran, terjawab: terjawab, ragu: (r.jawaban.r || []).length, lastSeen: r.lastSeen,
      nilai: r.hasil ? r.hasil.nilai : null, catatan: r.catatan, adaPerangkat: !!r.perangkat, sinkron: r.ver === r.syncVer
    };
  });
  return { ujian: ringkasUjian_(u), peserta: rows, serverTime: now };
}

function cariBarisAdmin_(me, ujianId, nis) {
  var u = getUjian_(str_(ujianId));
  bolehUjian_(me, u);
  var row = ambilBaris_(u.id, str_(nis));
  if (!row) throw new AppError('Peserta tidak ditemukan di ujian ini');
  return { u: u, row: row };
}

function apiResetLogin(d, ctx) {
  var me = reqGuru_(ctx);
  var x = cariBarisAdmin_(me, d.ujianId, d.nis);
  sheet_().getRange(x.row.row, C.PERANGKAT).setValue('');
  return true;
}

function apiResetPeserta(d, ctx) {
  var me = reqAdmin_(ctx);
  var x = cariBarisAdmin_(me, d.ujianId, d.nis), r = x.row;
  var punyaHasil = r.status === 'selesai' || r.syncVer > 0;
  r.status = punyaHasil ? 'direset' : 'belum';
  r.jawaban = { j: {}, r: [] }; r.hasil = null; r.manual = {}; r.mulai = 0; r.deadline = 0; r.selesai = 0;
  r.pelanggaran = 0; r.perangkat = ''; r.catatan = 'direset ' + me.n; r.ver = Date.now();
  tulisBaris_(r);
  tandaiAntrian_();
  return true;
}

function apiPaksaSelesai(d, ctx) {
  var me = reqGuru_(ctx);
  var x = cariBarisAdmin_(me, d.ujianId, d.nis);
  if (x.row.status !== 'mengerjakan') throw new AppError('Peserta tidak sedang mengerjakan');
  finalisasi_(x.row, x.u, getBank_(x.u.bankId), 'dihentikan ' + me.n);
  return true;
}

function apiHasilUjian(d, ctx) {
  var me = reqGuru_(ctx);
  var u = getUjian_(str_(d.ujianId));
  bolehUjian_(me, u);
  var bank = getBank_(u.bankId);
  var arsip = readJson_(P.hasil(u.id), { peserta: {} });
  var map = {};
  Object.keys(arsip.peserta || {}).forEach(function (nis) { map[nis] = arsip.peserta[nis]; });
  barisUjian_(u.id).forEach(function (r) {
    var g = map[r.nis];
    if (r.status === 'direset' || r.status === 'belum') {
      if (!g || r.ver >= (g.ver || 0)) map[r.nis] = { nis: r.nis, nama: r.nama, kelas: r.kelas, status: r.status };
      return;
    }
    if (!g || r.ver >= (g.ver || 0) || r.status === 'mengerjakan') map[r.nis] = barisKeRekam_(r);
  });
  var peserta = Object.keys(map).map(function (k) { return map[k]; });
  // hitung ulang bila bank berubah (agar konsisten dengan kunci terbaru)
  if (bank && d.hitungUlang) peserta.forEach(function (p) { if (p.status === 'selesai') p.hasil = hitungHasil_(bank, p.jawaban, p.manual); });
  return { ujian: ringkasUjian_(u), bank: bank, peserta: peserta };
}

function barisKeRekam_(r) {
  return {
    nis: r.nis, nama: r.nama, kelas: r.kelas, status: r.status, mulai: r.mulai, deadline: r.deadline, selesai: r.selesai,
    pelanggaran: r.pelanggaran, jawaban: r.jawaban, hasil: r.hasil, manual: r.manual, catatan: r.catatan,
    percobaan: r.percobaan, ver: r.ver
  };
}

function apiKoreksi(d, ctx) {
  var me = reqGuru_(ctx);
  var u = getUjian_(str_(d.ujianId));
  bolehUjian_(me, u);
  var bank = getBank_(u.bankId);
  var nis = str_(d.nis);
  var row = ambilBaris_(u.id, nis);
  if (!row) {
    // data sudah tidak ada di buffer: pulihkan dari arsip GitHub
    var arsip = readJson_(P.hasil(u.id), { peserta: {} }, true);
    var rec = arsip.peserta && arsip.peserta[nis];
    if (!rec) throw new AppError('Hasil peserta tidak ditemukan');
    withLock_(function () {
      tambahBaris_([{ key: u.id + '|' + nis, ujianId: u.id, nis: nis, nama: rec.nama, kelas: rec.kelas, status: rec.status, mulai: rec.mulai, deadline: rec.deadline, selesai: rec.selesai, pelanggaran: rec.pelanggaran, jawaban: rec.jawaban, hasil: rec.hasil, manual: rec.manual, ver: rec.ver, syncVer: rec.ver, percobaan: rec.percobaan, catatan: rec.catatan }]);
    });
    row = ambilBaris_(u.id, nis);
  }
  if (row.status !== 'selesai') throw new AppError('Peserta belum menyelesaikan ujian');
  var manual = row.manual || {};
  Object.keys(d.manual || {}).forEach(function (sid) {
    var v = d.manual[sid];
    if (v === '' || v === null || v === undefined) delete manual[sid]; else manual[sid] = num_(v, 0);
  });
  row.manual = manual;
  row.hasil = hitungHasil_(bank, row.jawaban, manual);
  row.ver = Date.now();
  tulisBaris_(row);
  tandaiAntrian_();
  return barisKeRekam_(row);
}

/** Koreksi banyak peserta sekaligus: items [{nis, manual:{soalId: skor}}] */
function apiKoreksiMassal(d, ctx) {
  var hasil = [];
  (d.items || []).slice(0, 2000).forEach(function (it) {
    MEMO_ = {}; // baca baris terbaru
    hasil.push(apiKoreksi({ ujianId: d.ujianId, nis: it.nis, manual: it.manual }, ctx));
  });
  return hasil;
}

/** Hitung ulang semua nilai memakai kunci terbaru di bank soal (mis. setelah kunci diperbaiki). */
function apiHitungUlang(d, ctx) {
  var me = reqGuru_(ctx);
  var u = getUjian_(str_(d.ujianId));
  bolehUjian_(me, u);
  var bank = getBank_(u.bankId, true);
  if (!bank) throw new AppError('Bank soal tidak ditemukan');
  var rows = barisUjian_(u.id), adaDiSheet = {}, n = 0;
  rows.forEach(function (r) {
    adaDiSheet[r.nis] = 1;
    if (r.status !== 'selesai') return;
    r.hasil = hitungHasil_(bank, r.jawaban, r.manual); r.ver = Date.now();
    tulisBaris_(r); n++;
  });
  var arsip = readJson_(P.hasil(u.id), { peserta: {} }, true), pulih = [];
  Object.keys(arsip.peserta || {}).forEach(function (nis) {
    var rec = arsip.peserta[nis];
    if (adaDiSheet[nis] || rec.status !== 'selesai') return;
    pulih.push({ key: u.id + '|' + nis, ujianId: u.id, nis: nis, nama: rec.nama, kelas: rec.kelas, status: 'selesai', mulai: rec.mulai, deadline: rec.deadline, selesai: rec.selesai, pelanggaran: rec.pelanggaran, jawaban: rec.jawaban, hasil: hitungHasil_(bank, rec.jawaban, rec.manual), manual: rec.manual, ver: Date.now(), syncVer: rec.ver, percobaan: rec.percobaan, catatan: rec.catatan });
  });
  if (pulih.length) withLock_(function () { tambahBaris_(pulih); });
  tandaiAntrian_();
  return { dihitung: n + pulih.length };
}

// ---------------------------------------------------------------------------
//  DATA GURU (admin)
// ---------------------------------------------------------------------------
function publikGuru_(g) { return { id: g.id, username: g.username, nama: g.nama, role: g.role, aktif: g.aktif !== false, mapel: g.mapel || [] }; }

function apiListGuru(d, ctx) { reqAdmin_(ctx); return getGuruList_().map(publikGuru_); }

function apiSaveGuru(d, ctx) {
  var me = reqAdmin_(ctx);
  var username = str_(d.username, 40).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new AppError('Nama pengguna 3–40 karakter: huruf kecil, angka, titik, garis bawah');
  var nama = str_(d.nama, 120).trim();
  if (!nama) throw new AppError('Nama guru wajib diisi');
  return withLock_(function () {
    var list = getGuruList_(true);
    var g = d.id ? list.filter(function (x) { return x.id === d.id; })[0] : null;
    if (d.id && !g) throw new AppError('Guru tidak ditemukan');
    if (list.some(function (x) { return x.username === username && (!g || x.id !== g.id); })) throw new AppError('Nama pengguna sudah dipakai');
    if (!g) {
      if (!d.password || String(d.password).length < 6) throw new AppError('Kata sandi minimal 6 karakter');
      g = { id: uid_('g') }; list.push(g);
    }
    if (g.id === me.id && d.role !== 'admin') throw new AppError('Anda tidak bisa menurunkan peran akun sendiri');
    g.username = username; g.nama = nama; g.role = d.role === 'admin' ? 'admin' : 'guru';
    g.aktif = d.aktif === undefined ? true : bool_(d.aktif);
    g.mapel = (d.mapel || []).map(function (x) { return str_(x, 80); });
    if (d.password) { if (String(d.password).length < 6) throw new AppError('Kata sandi minimal 6 karakter'); var cr = makeCred_(d.password); g.salt = cr.salt; g.hash = cr.hash; }
    var f = {}; f[P.guru] = list; writeJson_(f, 'Data guru: ' + nama + ' (' + me.n + ')');
    return publikGuru_(g);
  });
}

function apiDeleteGuru(d, ctx) {
  var me = reqAdmin_(ctx);
  if (d.id === me.id) throw new AppError('Tidak bisa menghapus akun sendiri');
  return withLock_(function () {
    var list = getGuruList_(true);
    var g = list.filter(function (x) { return x.id === d.id; })[0];
    if (!g) throw new AppError('Guru tidak ditemukan');
    var f = {}; f[P.guru] = list.filter(function (x) { return x.id !== d.id; });
    writeJson_(f, 'Hapus guru: ' + g.nama + ' (' + me.n + ')');
    return true;
  });
}

// ---------------------------------------------------------------------------
//  DATA SISWA (admin)
// ---------------------------------------------------------------------------
function publikSiswa_(s) { return { nis: String(s.nis), nama: s.nama, kelas: s.kelas }; }

function apiListSiswa(d, ctx) { reqAdmin_(ctx); return getSiswaList_().map(publikSiswa_); }

function tebakTingkat_(namaKelas, tingkatList) {
  var best = '';
  (tingkatList || []).forEach(function (t) {
    var re = new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'i');
    if (re.test(namaKelas) && t.length > best.length) best = t;
  });
  return best;
}

/** Tambahkan kelas baru ke config bila belum ada (dipanggil di dalam lock). return config baru atau null */
function tambahKelasKeConfig_(kelasBaru) {
  var cfg = readJson_(P.config, null, true) || getConfig_();
  var ada = {}; (cfg.kelas || []).forEach(function (k) { ada[k.nama] = 1; });
  var tambah = kelasBaru.filter(function (k) { return k && !ada[k]; });
  if (!tambah.length) return null;
  tambah = tambah.filter(function (k, i) { return tambah.indexOf(k) === i; });
  tambah.forEach(function (k) { cfg.kelas.push({ nama: k, tingkat: tebakTingkat_(k, cfg.tingkat) }); });
  cfg.kelas.sort(function (a, b) { return a.nama.localeCompare(b.nama, 'id', { numeric: true }); });
  return cfg;
}

function apiSaveSiswa(d, ctx) {
  var me = reqAdmin_(ctx);
  var nis = str_(d.nis, 30).trim(), nama = str_(d.nama, 120).trim(), kelas = str_(d.kelas, 40).trim();
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(nis)) throw new AppError('NIS hanya boleh huruf/angka');
  if (!nama || !kelas) throw new AppError('Nama dan kelas wajib diisi');
  return withLock_(function () {
    var list = getSiswaList_(true);
    var lamaNis = str_(d.nisLama || '').trim();
    var s = lamaNis ? list.filter(function (x) { return String(x.nis) === lamaNis; })[0] : null;
    if (lamaNis && !s) throw new AppError('Siswa tidak ditemukan');
    if (list.some(function (x) { return String(x.nis) === nis && x !== s; })) throw new AppError('NIS ' + nis + ' sudah terdaftar');
    if (!s) { s = {}; list.push(s); if (!d.password) d.password = nis; }
    s.nis = nis; s.nama = nama; s.kelas = kelas;
    if (d.password) { var cr = makeCred_(d.password); s.salt = cr.salt; s.hash = cr.hash; }
    var f = {}; f[P.siswa] = list;
    var cfg = tambahKelasKeConfig_([kelas]); if (cfg) f[P.config] = cfg;
    writeJson_(f, 'Data siswa: ' + nama + ' (' + me.n + ')');
    return publikSiswa_(s);
  });
}

function apiImportSiswa(d, ctx) {
  var me = reqAdmin_(ctx);
  var rows = (d.rows || []).slice(0, 5000);
  if (!rows.length) throw new AppError('Tidak ada data untuk diimpor');
  return withLock_(function () {
    var list = d.mode === 'ganti' ? [] : getSiswaList_(true);
    var byNis = {}; list.forEach(function (s) { byNis[String(s.nis)] = s; });
    var baru = 0, ubah = 0, lewati = [];
    rows.forEach(function (r, i) {
      var nis = str_(r.nis, 30).trim(), nama = str_(r.nama, 120).trim(), kelas = str_(r.kelas, 40).trim();
      if (!/^[A-Za-z0-9._-]{1,30}$/.test(nis) || !nama || !kelas) { lewati.push(i + 1); return; }
      var s = byNis[nis];
      if (!s) { s = { nis: nis }; list.push(s); byNis[nis] = s; baru++; } else ubah++;
      s.nama = nama; s.kelas = kelas;
      if (r.password || !s.hash) { var cr = makeCred_(r.password ? String(r.password) : nis); s.salt = cr.salt; s.hash = cr.hash; }
    });
    var f = {}; f[P.siswa] = list;
    var cfg = tambahKelasKeConfig_(list.map(function (s) { return s.kelas; })); if (cfg) f[P.config] = cfg;
    writeJson_(f, 'Impor siswa: ' + baru + ' baru, ' + ubah + ' diperbarui (' + me.n + ')');
    return { baru: baru, ubah: ubah, lewati: lewati, total: list.length, config: cfg };
  }, 30000);
}

function apiDeleteSiswa(d, ctx) {
  var me = reqAdmin_(ctx);
  var hapus = (d.nis || []).map(String);
  return withLock_(function () {
    var list = getSiswaList_(true);
    var sisa = list.filter(function (s) { return hapus.indexOf(String(s.nis)) < 0; });
    var f = {}; f[P.siswa] = sisa;
    writeJson_(f, 'Hapus ' + (list.length - sisa.length) + ' siswa (' + me.n + ')');
    return list.length - sisa.length;
  });
}

// ---------------------------------------------------------------------------
//  SINKRONISASI KE GITHUB (trigger tiap 1 menit)
// ---------------------------------------------------------------------------
function apiSinkronSekarang(d, ctx) { reqGuru_(ctx); return prosesAntrian(true); }

/** Dipanggil trigger tiap 1 menit. paksa=true untuk sinkron manual. */
function prosesAntrian(paksa) {
  paksa = paksa === true;
  var sp = PropertiesService.getScriptProperties();
  var now0 = Date.now(), q = sp.getProperties(); // 1x baca
  var dirty = q.Q_DIRTY === '1';
  var aktif = Number(q.Q_AKTIF || 0);
  var lastFull = Number(q.Q_FULL || 0);
  // hemat kuota: lewati bila tidak ada perubahan & tidak ada ujian yang sedang berjalan
  if (!paksa && !dirty && now0 > aktif + GRACE_MS + 60000 && now0 - lastFull < 15 * 60000) return { disinkron: 0, info: 'tidak ada perubahan' };
  var sh = sheet_(), last = sh.getLastRow();
  if (last < 2) return { disinkron: 0 };
  var ck = cache_();
  if (ck.get('flush_jalan')) return { disinkron: 0, info: 'sedang berjalan' };
  ck.put('flush_jalan', '1', 240);
  sp.setProperties({ Q_DIRTY: '0', Q_FULL: String(now0) });
  var sukses = false;
  try {
    var vals = sh.getRange(2, 1, last - 1, NCOL).getValues();
    var now = Date.now();
    var ujianMap = {}; getUjianList_().forEach(function (u) { ujianMap[u.id] = u; });
    var bankMemo = {};
    var bankOf = function (u) { if (!bankMemo[u.bankId]) bankMemo[u.bankId] = getBank_(u.bankId); return bankMemo[u.bankId]; };
    var perlu = {};
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      var status = v[C.STATUS - 1];
      // 1) kumpulkan otomatis peserta yang waktunya habis
      if (status === 'mengerjakan' && Number(v[C.DEADLINE - 1]) + GRACE_MS < now) {
        var u0 = ujianMap[v[C.UJIAN - 1]];
        if (u0 && bankOf(u0)) {
          var o = finalisasi_(rowToObj_(v, i + 2), u0, bankOf(u0), 'otomatis (waktu habis)');
          vals[i] = objToRow_(o);
          v = vals[i]; status = 'selesai';
        }
      }
      // 2) baris yang perlu dikirim ke GitHub
      if ((status === 'selesai' || status === 'direset') && Number(v[C.VER - 1]) !== Number(v[C.SYNCVER - 1])) {
        (perlu[v[C.UJIAN - 1]] = perlu[v[C.UJIAN - 1]] || []).push(i);
      }
    }
    var ujianIds = Object.keys(perlu);
    if (!ujianIds.length) { sukses = true; return { disinkron: 0 }; }
    var jumlah = 0;
    withLock_(function () {
      var files = {};
      ujianIds.forEach(function (uid) {
        var path = P.hasil(uid);
        var arsip = readJson_(path, null, true) || { ujianId: uid, peserta: {} };
        var u = ujianMap[uid];
        if (u) { arsip.nama = u.nama; arsip.mapel = u.mapel; arsip.bankId = u.bankId; }
        perlu[uid].forEach(function (idx) {
          var r = rowToObj_(vals[idx], idx + 2);
          if (r.status === 'direset') delete arsip.peserta[r.nis];
          else arsip.peserta[r.nis] = barisKeRekam_(r);
          jumlah++;
        });
        arsip.diperbarui = now;
        files[path] = JSON.stringify(arsip);
      });
      ghCommit_(dataRepo_(), files, 'Sinkron hasil: ' + jumlah + ' peserta');
    }, 30000);
    // 3) tandai sudah sinkron (hanya kolom syncVer)
    var syncCol = sh.getRange(2, C.SYNCVER, vals.length, 1).getValues();
    ujianIds.forEach(function (uid) { perlu[uid].forEach(function (idx) { syncCol[idx][0] = vals[idx][C.VER - 1]; }); });
    sh.getRange(2, C.SYNCVER, vals.length, 1).setValues(syncCol);
    sukses = true;
    return { disinkron: jumlah };
  } finally {
    ck.remove('flush_jalan');
    if (!sukses) sp.setProperty('Q_DIRTY', '1');
  }
}

// ---------------------------------------------------------------------------
//  SETUP (jalankan sekali dari editor Apps Script)
// ---------------------------------------------------------------------------
function setup() {
  var sp = PropertiesService.getScriptProperties();
  ['GITHUB_TOKEN', 'DATA_REPO', 'MEDIA_REPO'].forEach(function (k) {
    if (!sp.getProperty(k)) throw new Error('Script Property "' + k + '" belum diisi. Buka Project Settings > Script properties.');
  });
  if (!sp.getProperty('SECRET')) sp.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  CacheService.getScriptCache().remove('cfg_props');
  PROPS_ = null;

  // 1. Cek repo
  var data = ghJson_('get', '/repos/' + dataRepo_());
  if (!data.private) throw new Error('Repo DATA_REPO (' + dataRepo_() + ') HARUS PRIVAT karena berisi kunci jawaban & kata sandi. Ubah di GitHub: Settings > Danger Zone > Change visibility.');
  var media = ghJson_('get', '/repos/' + mediaRepo_());
  if (media.private) console.warn('PERINGATAN: MEDIA_REPO privat — gambar soal tidak akan tampil di browser siswa. Jadikan publik.');
  [dataRepo_(), mediaRepo_()].forEach(function (repo) {
    var r = ghFetch_('get', '/repos/' + repo + '/git/ref/heads/' + branch_());
    if (r.code !== 200) {
      var put = ghFetch_('put', '/repos/' + repo + '/contents/README.md', { message: 'Inisialisasi CBT Sekolah', content: Utilities.base64Encode('# CBT Sekolah\n\nDikelola otomatis oleh aplikasi CBT. Jangan ubah manual kecuali Anda paham strukturnya.\n', Utilities.Charset.UTF_8), branch: branch_() });
      if (put.code !== 201 && put.code !== 200) throw new Error('Gagal inisialisasi repo ' + repo + ': ' + put.text);
    }
  });

  // 2. Spreadsheet buffer
  var ssId = sp.getProperty('SHEET_ID'), ss = null;
  if (ssId) { try { ss = SpreadsheetApp.openById(ssId); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create('CBT Sekolah — Buffer Peserta (jangan diedit)'); sp.setProperty('SHEET_ID', ss.getId()); }
  var sh = ss.getSheetByName(SHEET_PESERTA);
  if (!sh) { sh = ss.getSheets()[0]; sh.setName(SHEET_PESERTA); }
  sh.getRange(1, 1, 1, NCOL).setValues([HEADER]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, sh.getMaxRows(), 5).setNumberFormat('@');
  sh.getRange(1, C.JAWABAN, sh.getMaxRows(), 3).setNumberFormat('@');
  sh.getRange(1, C.CATATAN, sh.getMaxRows(), 2).setNumberFormat('@');
  CacheService.getScriptCache().remove('cfg_props');
  PROPS_ = null;

  // 3. Data awal
  var files = {};
  if (ghRead_(dataRepo_(), P.config, true) === null) {
    files[P.config] = {
      namaSekolah: 'SMA Negeri Contoh', tahunAjaran: '2026/2027', semester: 'Ganjil', logo: '',
      tingkat: ['X', 'XI', 'XII'],
      kelas: [{ nama: 'X-1', tingkat: 'X' }, { nama: 'X-2', tingkat: 'X' }, { nama: 'XI-1', tingkat: 'XI' }, { nama: 'XII-1', tingkat: 'XII' }],
      mapel: ['Matematika', 'Bahasa Indonesia', 'Bahasa Inggris', 'Fisika', 'Kimia', 'Biologi', 'Sejarah', 'Geografi', 'Ekonomi', 'Sosiologi', 'PPKn', 'Pendidikan Agama', 'Informatika']
    };
  }
  if (ghRead_(dataRepo_(), P.guru, true) === null) {
    var a = makeCred_('admin123');
    var g = makeCred_('guru123');
    files[P.guru] = [
      { id: 'gadmin', username: 'admin', nama: 'Administrator', role: 'admin', aktif: true, mapel: [], salt: a.salt, hash: a.hash },
      { id: 'gcontoh', username: 'guru', nama: 'Guru Contoh', role: 'guru', aktif: true, mapel: ['Matematika'], salt: g.salt, hash: g.hash }
    ];
  }
  if (ghRead_(dataRepo_(), P.siswa, true) === null) {
    files[P.siswa] = [['1001', 'Andi Pratama', 'X-1'], ['1002', 'Budi Santoso', 'X-1'], ['1003', 'Citra Lestari', 'X-2']].map(function (r) {
      var c = makeCred_(r[0]); return { nis: r[0], nama: r[1], kelas: r[2], salt: c.salt, hash: c.hash };
    });
  }
  if (ghRead_(dataRepo_(), P.bankIndex, true) === null) {
    var contoh = bankContoh_();
    files[P.bank(contoh.id)] = contoh;
    files[P.bankIndex] = [{ id: contoh.id, judul: contoh.judul, mapel: contoh.mapel, tingkat: contoh.tingkat, guruId: contoh.guruId, guruNama: contoh.guruNama, jumlahSoal: contoh.soal.length, totalBobot: contoh.soal.reduce(function (x, s) { return x + s.bobot; }, 0), dibuat: contoh.dibuat, diubah: contoh.diubah }];
  }
  if (ghRead_(dataRepo_(), P.ujianIndex, true) === null) files[P.ujianIndex] = [];
  if (Object.keys(files).length) writeJson_(files, 'Data awal CBT Sekolah');

  // 4. Trigger sinkronisasi tiap 1 menit
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'prosesAntrian') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('prosesAntrian').timeBased().everyMinutes(1).create();

  var info = 'SETUP SELESAI.\n- Spreadsheet buffer: ' + ss.getUrl() + '\n- Login admin: admin / admin123 (SEGERA GANTI)\n- Login guru contoh: guru / guru123\n- Siswa contoh: NIS 1001, 1002, 1003 (kata sandi = NIS)\nLangkah berikut: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).';
  console.log(info);
  return info;
}

function bankContoh_() {
  var now = Date.now();
  return {
    id: 'bcontoh01', judul: 'Contoh — Semua Jenis Soal', mapel: 'Matematika', tingkat: 'X',
    deskripsi: 'Bank soal contoh berisi 7 jenis soal. Boleh dihapus.',
    guruId: 'gcontoh', guruNama: 'Guru Contoh', dibuat: now, diubah: now,
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
