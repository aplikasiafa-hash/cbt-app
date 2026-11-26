// Uji 2.19: nama variabel yang dibuat otomatis di serverC masih kosong / "-" → aplikasi menganggapnya belum diisi.
// Jalankan: wrangler dev --var DEV_MODE:1 --var DATA_REPO:- --var MEDIA_REPO:- --var GITHUB_TOKEN:- --var CF_API_TOKEN:- --var APP_KUNCI:-
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 400))); if (!c) fails++; };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
await call('_dev', { offset: 0 });
const ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
let r = await call('statusSistem', {}, ADM);
ok('serverB dianggap belum diatur', r.ok && !r.data.adaB && !r.data.adaMedia, r.data);
ok('kunci link "-" dianggap belum dipasang', r.data.kunciLink && r.data.kunciLink.terpasang === false, r.data.kunciLink);
r = await call('pemakaianHarian', {}, ADM);
ok('token API serverC "-" dianggap belum diisi', r.ok && r.data.siap === false && r.data.alasan === 'token', r);
r = await call('sinkronSekarang', {}, ADM);
ok('sinkron tetap jalan tanpa serverB', r.ok, r);
console.log(fails ? 'GAGAL ' + fails : 'SEMUA LULUS variabel kosong');
process.exit(fails ? 1 : 0);
