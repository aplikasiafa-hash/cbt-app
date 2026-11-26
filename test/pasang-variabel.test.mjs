// Uji pasang-variabel.mjs terhadap tiruan API serverC (tanpa jaringan).
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const AKUN = 'a'.repeat(32);
const kunci = readFileSync('pasang-variabel.mjs', 'utf8').match(/KUNCI_LINK\s*=\s*'([^']+)'/)[1];
let ada = {}, tolakKosong = false, adaWorker = true, catatan = [];
const srv = http.createServer((q, s) => {
  let b = ''; q.on('data', c => b += c); q.on('end', () => {
    const kirim = (st, j) => { s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(j)); };
    if (q.headers.authorization !== 'Bearer tok-uji') return kirim(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    catatan.push(q.method + ' ' + q.url);
    if (q.url.startsWith('/accounts?')) return kirim(200, { success: true, result: [{ id: AKUN, name: 'Sekolah' }] });
    const m = q.url.match(/^\/accounts\/(\w+)\/workers\/scripts\/([^/]+)\/(settings|secrets)$/);
    if (!m || m[1] !== AKUN) return kirim(404, { success: false, errors: [{ code: 7003, message: 'no route' }] });
    if (!adaWorker || m[2] !== 'cbt-app') return kirim(404, { success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }] });
    if (m[3] === 'settings' && q.method === 'GET') return kirim(200, { success: true, result: { bindings: Object.entries(ada).map(([name, x]) => ({ name, type: x.type })) } });
    if (m[3] === 'secrets' && q.method === 'PUT') {
      const j = JSON.parse(b);
      if (tolakKosong && j.text === '') return kirim(400, { success: false, errors: [{ code: 10021, message: 'secret text must not be empty' }] });
      if (ada[j.name] && ada[j.name].type !== 'secret_text') return kirim(400, { success: false, errors: [{ code: 10053, message: 'binding name already in use' }] });
      ada[j.name] = { type: 'secret_text', text: j.text }; return kirim(200, { success: true, result: { name: j.name, type: 'secret_text' } });
    }
    kirim(405, { success: false, errors: [{ code: 1, message: 'method' }] });
  });
});
await new Promise(r => srv.listen(9997, r));
import { spawn } from 'node:child_process';
const jalan = (env = {}) => new Promise(r => {
  const p = spawn('node', ['pasang-variabel.mjs'], { env: { PATH: process.env.PATH, CBT_SERVERC_API: 'http://127.0.0.1:9997', ...env } });
  let o = ''; p.stdout.on('data', c => o += c); p.stderr.on('data', c => o += c); p.on('close', code => r({ code, o }));
});
const CI = { WORKERS_CI: '1', CLOUDFLARE_API_TOKEN: 'tok-uji', WRANGLER_CI_OVERRIDE_NAME: 'cbt-app' };

// 1. bukan serverC Builds → tidak memanggil apa pun
let r = await jalan({ CLOUDFLARE_API_TOKEN: 'tok-uji' });
assert.equal(r.code, 0); assert.equal(catatan.length, 0); assert.equal(r.o, '');
console.log('ok lokal: tidak melakukan apa-apa');

// 2. aplikasi baru: semua nama dibuat, ID akun dicari sendiri, nilai kosong + kunci link
r = await jalan(CI);
assert.equal(r.code, 0, r.o);
assert.deepEqual(Object.keys(ada).sort(), ['APP_KUNCI', 'CF_API_TOKEN', 'DATA_REPO', 'GITHUB_TOKEN', 'MEDIA_REPO']);
for (const n of ['CF_API_TOKEN', 'DATA_REPO', 'GITHUB_TOKEN', 'MEDIA_REPO']) assert.equal(ada[n].text, '');
assert.equal(ada.APP_KUNCI.text, kunci);
assert.ok(!r.o.includes(kunci), 'kunci tidak boleh tampil di log');
assert.match(r.o, /ditambahkan: CF_API_TOKEN, DATA_REPO, GITHUB_TOKEN, MEDIA_REPO, APP_KUNCI/);
console.log('ok baru: 5 nama dibuat');

// 3. pemasangan ulang: isian admin TIDAK ditimpa, tidak ada PUT
ada.DATA_REPO.text = 'sekolah/cbt-data'; ada.GITHUB_TOKEN.text = 'ghp_isian_admin'; ada.APP_KUNCI.text = 'kunci-lain';
catatan = [];
r = await jalan({ ...CI, CLOUDFLARE_ACCOUNT_ID: AKUN });
assert.equal(r.code, 0); assert.ok(!catatan.some(x => x.startsWith('PUT')), catatan.join());
assert.equal(ada.DATA_REPO.text, 'sekolah/cbt-data'); assert.equal(ada.GITHUB_TOKEN.text, 'ghp_isian_admin'); assert.equal(ada.APP_KUNCI.text, 'kunci-lain');
assert.match(r.o, /sudah ada, tidak ada yang diubah/);
console.log('ok ulang: isian tetap');

// 4. sekolah lama: DATA_REPO/MEDIA_REPO berupa teks biasa → tidak disentuh, sisanya ditambahkan
ada = { DATA_REPO: { type: 'plain_text', text: 'sek/data' }, MEDIA_REPO: { type: 'plain_text', text: 'sek/media' }, GITHUB_TOKEN: { type: 'secret_text', text: 'x' } };
catatan = [];
r = await jalan(CI);
assert.equal(ada.DATA_REPO.type, 'plain_text'); assert.equal(ada.DATA_REPO.text, 'sek/data'); assert.equal(ada.GITHUB_TOKEN.text, 'x');
assert.deepEqual(catatan.filter(x => x.startsWith('PUT')).length, 2);
assert.deepEqual(Object.keys(ada).sort(), ['APP_KUNCI', 'CF_API_TOKEN', 'DATA_REPO', 'GITHUB_TOKEN', 'MEDIA_REPO']);
console.log('ok lama: hanya CF_API_TOKEN & APP_KUNCI ditambahkan');

// 5. serverC menolak nilai kosong → "-"
ada = {}; tolakKosong = true;
r = await jalan(CI);
assert.equal(ada.DATA_REPO.text, '-'); assert.equal(ada.APP_KUNCI.text, kunci);
tolakKosong = false;
console.log('ok tolak kosong: diisi "-"');

// 6. aplikasi belum ada / token salah → pesan saja, keluar 0
adaWorker = false; ada = {};
r = await jalan(CI); assert.equal(r.code, 0); assert.match(r.o, /belum ada di serverC/); assert.equal(Object.keys(ada).length, 0);
adaWorker = true;
r = await jalan({ ...CI, CLOUDFLARE_API_TOKEN: 'salah' }); assert.equal(r.code, 0); assert.match(r.o, /dilewati/);
r = await jalan({ ...CI, CBT_SERVERC_API: 'http://127.0.0.1:1' }); assert.equal(r.code, 0); assert.match(r.o, /dilewati/);
console.log('ok gagal: pemasangan tetap lanjut');
srv.close();
console.log('SEMUA LULUS pasang-variabel');
