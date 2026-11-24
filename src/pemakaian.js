/**
 * ============================================================================
 *  Pemakaian harian akun serverC — angka yang sama dengan dasbor serverC
 * ============================================================================
 *  Dibaca dari GraphQL Analytics API dan API Workers Observability, untuk SELURUH akun (batas gratis
 *  serverC berlaku per akun). Tidak membaca/menulis D1 sama sekali.
 *
 *  Butuh rahasia  CF_API_TOKEN  (token API dengan izin "Account Analytics: Read" dan
 *  "Workers Observability: Read"). Opsional: variabel CF_ACCOUNT_ID bila token bisa membuka
 *  lebih dari satu akun.
 * ============================================================================
 */
import { AppError } from './shared.js';

/** Batas paket gratis serverC (per hari, kecuali penyimpanan). Aplikasi guru menampilkan 90%-nya sebagai batas. */
export const BATAS_GRATIS = {
  workerReq: 100000,          // Workers: requests / hari
  obs: 200000,                // Workers Observability: events / hari
  d1Baca: 5000000,            // D1: rows read / hari
  d1Tulis: 100000,            // D1: rows written / hari
  d1Simpan: 5e9,              // D1: total storage (5 GB)
  doReq: 100000,              // Durable Objects: requests / hari
  doDurasi: 13000,            // Durable Objects: duration GB-s / hari
  doBaca: 5000000,            // Durable Objects SQLite: rows read / hari
  doTulis: 100000,            // Durable Objects SQLite: rows written / hari
  doSimpan: 5e9                // Durable Objects SQLite: stored data (5 GB)
};

const Q_WORKER = `query PemakaianWorker($a: string!, $t0: Time!, $t1: Time!) { viewer { accounts(filter: {accountTag: $a}) {
  w: workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $t0, datetime_leq: $t1}) { sum { requests } }
} } }`;
const Q_D1 = `query PemakaianD1($a: string!, $d: Date!, $k: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  baris: d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $d, date_leq: $d}) { sum { rowsRead rowsWritten } }
  ukuran: d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $k}) { max { databaseSizeBytes } dimensions { date databaseId } }
} } }`;
const Q_DO = `query PemakaianDO($a: string!, $t0: Time!, $t1: Time!, $k: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  req: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $t0, datetime_leq: $t1}) { sum { requests } }
  periodik: durableObjectsPeriodicGroups(limit: 10000, filter: {datetime_geq: $t0, datetime_leq: $t1}) { sum { duration rowsRead rowsWritten } }
  sql: durableObjectsSqlStorageGroups(limit: 10000, filter: {date_geq: $k}) { max { storedBytes } dimensions { date namespaceId } }
} } }`;

const alamat = env => String(env.CF_API || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
let AKUN = null;   // { token, id } — disimpan selama mesin hidup

async function panggil(env, path, init = {}) {
  let r;
  try {
    r = await fetch(alamat(env) + path, { ...init, headers: { Authorization: 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' } });
  } catch (e) { console.log('pemakaianHarian fetch:', e.message); throw new AppError('Tidak bisa menghubungi serverC.'); }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 || r.status === 403) throw new AppError('Token API serverC ditolak atau izinnya kurang.', 'TOKEN');
  if (!r.ok || !j) throw new AppError('serverC menjawab ' + r.status + '.');
  return j;
}

async function cariAkun(env) {
  if (env.CF_ACCOUNT_ID) return String(env.CF_ACCOUNT_ID).trim();
  if (AKUN && AKUN.token === env.CF_API_TOKEN) return AKUN.id;
  const j = await panggil(env, '/accounts?per_page=5');
  const daftar = (j.result || []).map(a => a.id).filter(Boolean);
  if (!daftar.length) throw new AppError('Token API serverC tidak bisa membuka akun mana pun.', 'AKUN');
  if (daftar.length > 1) throw new AppError('Token API serverC bisa membuka ' + daftar.length + ' akun. Tambahkan variabel CF_ACCOUNT_ID berisi ID akun sekolah.', 'AKUN');
  AKUN = { token: env.CF_API_TOKEN, id: daftar[0] };
  return daftar[0];
}

async function graphql(env, query, variables) {
  const j = await panggil(env, '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (j.errors && j.errors.length) {
    const m = String(j.errors[0].message || 'galat GraphQL');
    if (/not authori[sz]ed|permission|access/i.test(m)) throw new AppError('Token API serverC belum punya izin membaca statistik.', 'TOKEN');
    console.log('pemakaianHarian graphql:', m);
    throw new AppError('Data serverC tidak terbaca.');
  }
  const a = j.data && j.data.viewer && j.data.viewer.accounts;
  if (!a || !a.length) throw new AppError('Akun serverC tidak ditemukan untuk token ini.', 'AKUN');
  return a[0];
}

const jumlah = (arr, f) => (arr || []).reduce((s, x) => s + (Number(x && x.sum && x.sum[f]) || 0), 0);
/** ukuran terbaru tiap database/namespace, dijumlahkan */
function terbaru(arr, kunciId, f) {
  const per = new Map();
  for (const x of arr || []) {
    const id = x.dimensions && x.dimensions[kunciId], tgl = (x.dimensions && x.dimensions.date) || '';
    const lama = per.get(id);
    if (!lama || tgl > lama.tgl) per.set(id, { tgl, v: Number(x.max && x.max[f]) || 0 });
  }
  let s = 0; for (const x of per.values()) s += x.v; return s;
}

/** Pemakaian hari ini (UTC; kuota serverC pulih pukul 00.00 UTC = 08.00 WITA). */
export async function pemakaianHarian(env) {
  if (!env.CF_API_TOKEN) return { siap: false, alasan: 'token', batas: BATAS_GRATIS };
  let akun;
  try { akun = await cariAkun(env); }
  catch (e) { return { siap: false, alasan: e.code === 'TOKEN' ? 'ditolak' : 'akun', pesan: e.message, batas: BATAS_GRATIS }; }
  const kini = new Date(), hari = kini.toISOString().slice(0, 10), kemarin = new Date(kini.getTime() - 864e5).toISOString().slice(0, 10);
  const t0 = hari + 'T00:00:00Z', t1 = kini.toISOString().replace(/\.\d+Z$/, 'Z'), dari = Date.parse(t0), sampai = dari + 864e5 - 1;
  const [w, d1, dO, obs] = await Promise.allSettled([
    graphql(env, Q_WORKER, { a: akun, t0, t1 }),
    graphql(env, Q_D1, { a: akun, d: hari, k: kemarin }),
    graphql(env, Q_DO, { a: akun, t0, t1, k: kemarin }),
    panggil(env, '/accounts/' + akun + '/workers/observability/usage?from=' + dari + '&to=' + sampai)
  ]);
  const data = {}, galat = {};
  if (w.status === 'fulfilled') data.workerReq = jumlah(w.value.w, 'requests'); else galat.worker = w.reason.message;
  if (d1.status === 'fulfilled') {
    data.d1Baca = jumlah(d1.value.baris, 'rowsRead'); data.d1Tulis = jumlah(d1.value.baris, 'rowsWritten');
    data.d1Simpan = terbaru(d1.value.ukuran, 'databaseId', 'databaseSizeBytes');
  } else galat.d1 = d1.reason.message;
  if (dO.status === 'fulfilled') {
    data.doReq = jumlah(dO.value.req, 'requests'); data.doDurasi = jumlah(dO.value.periodik, 'duration');
    data.doBaca = jumlah(dO.value.periodik, 'rowsRead'); data.doTulis = jumlah(dO.value.periodik, 'rowsWritten');
    data.doSimpan = terbaru(dO.value.sql, 'namespaceId', 'storedBytes');
  } else galat.do = dO.reason.message;
  if (obs.status === 'fulfilled' && obs.value && obs.value.result && obs.value.result.events != null) data.obs = Number(obs.value.result.events) || 0;
  else galat.obs = obs.status === 'rejected' && obs.reason.code === 'TOKEN' ? 'Token API serverC belum punya izin membaca log.' : (obs.reason ? obs.reason.message : 'Data serverC tidak terbaca.');
  const semuaDitolak = [w, d1, dO].every(x => x.status === 'rejected' && x.reason.code === 'TOKEN');
  if (semuaDitolak) return { siap: false, alasan: 'ditolak', pesan: w.reason.message, batas: BATAS_GRATIS };
  return { siap: true, tanggal: hari, waktu: kini.getTime(), akun: akun.slice(0, 6) + '…', data, galat, batas: BATAS_GRATIS };
}
