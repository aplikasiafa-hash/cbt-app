/**
 * Skema D1 (database permanen) + data awal.
 * Tabel dibuat otomatis saat aplikasi pertama kali dipakai — tidak perlu menjalankan perintah SQL manual.
 */
import { makeCred_, bankContoh_, metaBank_, uid_ } from './shared.js';

export const SKEMA_VERSI = '3';

const SKEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS guru (id TEXT PRIMARY KEY, username TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS guru_username ON guru(username)`,
  `CREATE TABLE IF NOT EXISTS siswa (nis TEXT PRIMARY KEY, nama TEXT NOT NULL, kelas TEXT NOT NULL, salt TEXT, hash TEXT, sandi TEXT)`,
  `CREATE INDEX IF NOT EXISTS siswa_kelas ON siswa(kelas)`,
  `CREATE TABLE IF NOT EXISTS bank (id TEXT PRIMARY KEY, meta TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ujian (id TEXT PRIMARY KEY, selesai INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ujian_selesai ON ujian(selesai)`,
  // hasil akhir per peserta (selesai). Kunci (ujian_id, nis) → pencarian cepat tanpa indeks tambahan.
  `CREATE TABLE IF NOT EXISTS hasil (ujian_id TEXT NOT NULL, nis TEXT NOT NULL, status TEXT, nilai REAL, perlu INTEGER, ver INTEGER, data TEXT NOT NULL, PRIMARY KEY (ujian_id, nis)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS gagal (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)`
];

/** Pastikan tabel ada & data awal terisi. Return secret HMAC. Hanya dipanggil oleh Durable Object (satu penulis). */
export async function siapkanD1(DB) {
  const cek = await DB.prepare(`SELECT k, v FROM kv WHERE k IN ('skema','secret')`).all().catch(() => null);
  const m = {};
  if (cek && cek.results) cek.results.forEach(r => { m[r.k] = r.v; });
  if (m.skema === SKEMA_VERSI && m.secret) return m.secret;

  await DB.batch(SKEMA.map(s => DB.prepare(s)));
  // versi 3: kolom sandi (kata sandi dari admin, terenkripsi) untuk database lama
  await DB.prepare(`ALTER TABLE siswa ADD COLUMN sandi TEXT`).run().catch(() => {});
  const secret = m.secret || (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  const stmts = [DB.prepare(`INSERT OR IGNORE INTO kv (k, v) VALUES ('secret', ?)`).bind(secret)];

  const ada = await DB.prepare(`SELECT (SELECT COUNT(*) FROM guru) AS g, (SELECT v FROM kv WHERE k='config') AS c, (SELECT COUNT(*) FROM bank) AS b, (SELECT COUNT(*) FROM siswa) AS s`).first();
  if (!ada.c) {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO kv (k, v) VALUES ('config', ?)`).bind(JSON.stringify({
      namaSekolah: 'SMA Negeri Contoh', tahunAjaran: '2026/2027', semester: 'Ganjil', logo: '',
      tingkat: ['X', 'XI', 'XII'],
      kelas: [{ nama: 'X-1', tingkat: 'X' }, { nama: 'X-2', tingkat: 'X' }, { nama: 'XI-1', tingkat: 'XI' }, { nama: 'XII-1', tingkat: 'XII' }],
      mapel: ['Matematika', 'Bahasa Indonesia', 'Bahasa Inggris', 'Fisika', 'Kimia', 'Biologi', 'Sejarah', 'Geografi', 'Ekonomi', 'Sosiologi', 'PPKn', 'Pendidikan Agama', 'Informatika']
    })));
  }
  if (!ada.g) {
    const a = await makeCred_('admin123'), g = await makeCred_('guru123');
    for (const u of [
      { id: 'gadmin', username: 'admin', nama: 'Administrator', role: 'admin', aktif: true, mapel: [], salt: a.salt, hash: a.hash },
      { id: 'gcontoh', username: 'guru', nama: 'Guru Contoh', role: 'guru', aktif: true, mapel: ['Matematika'], salt: g.salt, hash: g.hash }
    ]) stmts.push(DB.prepare(`INSERT OR IGNORE INTO guru (id, username, data) VALUES (?, ?, ?)`).bind(u.id, u.username, JSON.stringify(u)));
  }
  if (!ada.s) {
    for (const r of [['1001', 'Andi Pratama', 'X-1'], ['1002', 'Budi Santoso', 'X-1'], ['1003', 'Citra Lestari', 'X-2']]) {
      const c = await makeCred_(r[0]);
      stmts.push(DB.prepare(`INSERT OR IGNORE INTO siswa (nis, nama, kelas, salt, hash) VALUES (?, ?, ?, ?, ?)`).bind(r[0], r[1], r[2], c.salt, c.hash));
    }
  }
  if (!ada.b) {
    const b = bankContoh_();
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO bank (id, meta, data) VALUES (?, ?, ?)`).bind(b.id, JSON.stringify(metaBank_(b)), JSON.stringify(b)));
  }
  stmts.push(DB.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES ('skema', ?)`).bind(SKEMA_VERSI));
  await DB.batch(stmts);
  const s = await DB.prepare(`SELECT v FROM kv WHERE k='secret'`).first();
  return s.v;
}

/** Baris JSON → dipakai dengan json_each() agar banyak baris ditulis dalam SATU query. */
export function potong(arr, maksChars) {
  const out = []; let cur = [], n = 2;
  for (const x of arr) {
    const len = JSON.stringify(x).length + 1;
    if (cur.length && n + len > maksChars) { out.push(cur); cur = []; n = 2; }
    cur.push(x); n += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

export { uid_ };
