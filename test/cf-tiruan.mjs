// Tiruan API Cloudflare untuk menguji panel "Penggunaan harian serverC" (port 9998).
// Token yang diterima: "uji". Angka diambil dari dasbor sungguhan (20 Nov 2026).
// Lingkungan: AKUN=2 → /accounts mengembalikan dua akun; TANPA_OBS=1 → izin observability ditolak.
import http from 'node:http';

const log = [];
let angka = { req: 6017, d1Baca: 112937, d1Tulis: 848, d1Ukuran: 1335296, doReq: 2394, doDurasi: 2520.957086592, doBaca: 228846, doTulis: 2496, doSql: 3514368, obs: 425 };

function jawab(res, kode, isi) { res.writeHead(kode, { 'content-type': 'application/json' }); res.end(JSON.stringify(isi)); }

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/_log') return jawab(res, 200, log);
    if (url.pathname === '/_angka') { angka = { ...angka, ...JSON.parse(body || '{}') }; return jawab(res, 200, angka); }
    log.push({ path: url.pathname, q: (body.match(/query (\w+)/) || [])[1] || '' });
    if (req.headers.authorization !== 'Bearer uji') return jawab(res, 403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    if (url.pathname === '/accounts') {
      const r = [{ id: 'f06acd95d53a589a63c03b309197c14f', name: 'Sekolah' }];
      if (process.env.AKUN === '2') r.push({ id: 'aaaa', name: 'Lain' });
      return jawab(res, 200, { success: true, result: r });
    }
    if (url.pathname.endsWith('/workers/observability/usage')) {
      if (process.env.TANPA_OBS === '1') return jawab(res, 403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      return jawab(res, 200, { success: true, errors: [], result: { events: angka.obs, breakdown: [] } });
    }
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(body);
      if (!variables || variables.a !== 'f06acd95d53a589a63c03b309197c14f') return jawab(res, 200, { data: null, errors: [{ message: 'akun salah' }] });
      let a = {};
      if (/PemakaianWorker/.test(query)) a = { w: [{ sum: { requests: angka.req } }] };
      else if (/PemakaianD1/.test(query)) a = { baris: [{ sum: { rowsRead: angka.d1Baca, rowsWritten: angka.d1Tulis } }],
        ukuran: [{ dimensions: { databaseId: 'db1', date: variables.d }, max: { databaseSizeBytes: angka.d1Ukuran } }, { dimensions: { databaseId: 'db1', date: variables.k }, max: { databaseSizeBytes: 372736 } }] };
      else if (/PemakaianDO/.test(query)) a = { req: [{ sum: { requests: angka.doReq } }], periodik: [{ sum: { duration: angka.doDurasi, rowsRead: angka.doBaca, rowsWritten: angka.doTulis } }],
        sql: [{ dimensions: { date: variables.k, namespaceId: 'n1' }, max: { storedBytes: 81920 } }, { dimensions: { date: variables.t0.slice(0, 10), namespaceId: 'n1' }, max: { storedBytes: angka.doSql } }] };
      return jawab(res, 200, { data: { viewer: { accounts: [a] } }, errors: null });
    }
    jawab(res, 404, { success: false });
  });
}).listen(9998, '127.0.0.1', () => console.log('tiruan Cloudflare di :9998'));
