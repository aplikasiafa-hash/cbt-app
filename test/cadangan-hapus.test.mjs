// Uji cadangan serverB: bank soal yang dihapus sebelum sempat dicadangkan tidak boleh membuat cadangan macet (422).
// Jalankan dengan wrangler dev + test/github-tiruan.mjs (lihat /tmp/regresi.sh, variabel $GH).
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const GH = 'http://127.0.0.1:9999';
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 400))); if (!c) fails++; };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
const repo = async () => (await (await fetch(GH + '/_log', { headers: { authorization: 'Bearer x' } })).json());
const soal = [{ tipe: 'pg', teks: 'Satu?', bobot: 1, opsi: [{ teks: 'a' }, { teks: 'b' }], kunci: 'A' }];
const bank = async (judul, T) => (await call('saveBank', { bank: { judul, mapel: 'Fisika', tingkat: 'X', soal } }, T)).data.bank.id;

let r = await call('loginGuru', { username: 'admin', password: 'admin123' });
const ADM = r.data.token;

// 1) dua bank dicadangkan
const A = await bank('Tetap', ADM), B = await bank('Dihapus setelah dicadangkan', ADM);
r = await call('sinkronSekarang', {}, ADM);
ok('cadangan awal berhasil', r.ok && r.data.cadangan && !r.data.cadangan.error, r);
let g = await repo();
ok('repo berisi kedua bank', g.files['bank/' + A + '.json'] && g.files['bank/' + B + '.json'], Object.keys(g.files));

// 2) bank C dibuat lalu dihapus sebelum dicadangkan, bank B (sudah ada di repo) juga dihapus
const C = await bank('Dibuat lalu langsung dihapus', ADM);
r = await call('deleteBank', { id: C }, ADM); ok('bank C dihapus', r.ok, r);
r = await call('deleteBank', { id: B }, ADM); ok('bank B dihapus', r.ok, r);
r = await call('sinkronSekarang', {}, ADM);
ok('cadangan tidak macet oleh bank yang tidak pernah dicadangkan', r.ok && r.data.cadangan && !r.data.cadangan.error, r);
g = await repo();
ok('bank B terhapus dari repo, bank A tetap', !g.files['bank/' + B + '.json'] && g.files['bank/' + A + '.json'], Object.keys(g.files));
ok('bank C tidak ikut dikirim sebagai penghapusan', !g.log.some(x => x.tree && x.tree.includes('-bank/' + C + '.json')), g.log.filter(x => x.tree));
ok('bankidx terbaru tidak memuat B & C', (() => { const i = JSON.parse(g.files['bank/_index.json']).map(x => x.id); return i.includes(A) && !i.includes(B) && !i.includes(C); })(), g.files['bank/_index.json']);
r = await call('statusSistem', {}, ADM);
ok('status: tidak ada cadangan gagal, antrian kosong', r.ok && !r.data.cadanganGagal && r.data.antrianCadangan === 0, r.data && { g: r.data.cadanganGagal, a: r.data.antrianCadangan });

// 3) penghapusan saja (berkas tak pernah ada) → tetap tidak galat
const D = await bank('Hanya untuk dihapus', ADM);
await call('deleteBank', { id: D }, ADM);
r = await call('sinkronSekarang', {}, ADM);
ok('hapus bank yang belum pernah dicadangkan: cadangan tetap berhasil', r.ok && r.data.cadangan && !r.data.cadangan.error, r);

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
