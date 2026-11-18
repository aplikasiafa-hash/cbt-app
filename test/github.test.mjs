// Uji jalur GitHub: unggah gambar, cadangan otomatis, impor data versi Apps Script.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 400))); if (!c) fails++; };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
const lama = JSON.parse((await import('node:fs')).readFileSync('/tmp/olddata/ujian.json'));
let r = await call('loginGuru', { username: 'admin', password: 'admin123' });
const ADM = r.data.token;
r = await call('uploadGambar', { data: 'data:image/png;base64,iVBORw0KGgo=', tipe: 'image/png' }, ADM);
ok('unggah gambar → URL jsDelivr', r.ok && /^https:\/\/cdn\.jsdelivr\.net\/gh\/sekolah\/cbt-media@[0-9a-f]{40}\/img\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/.test(r.data.url), r);
r = await call('statusSistem', {}, ADM);
ok('status: serverB terbaca (tanpa nama repo)', r.ok && r.data.adaB === true && r.data.dataRepo === undefined, r);
r = await call('imporCadangan', {}, ADM);
ok('impor dari repo versi Apps Script', r.ok && r.data.siswa === 5 && r.data.guru === 3 && r.data.bank === 2 && r.data.ujian === 1 && r.data.hasil === 1, r);
r = await call('loginSiswa', { nis: '5001', password: 'sandiLama1' });
ok('siswa lama login dengan kata sandi LAMA', r.ok, r);
r = await call('loginGuru', { username: 'bu.rina', password: 'rina123' });
ok('guru lama login dengan kata sandi LAMA', r.ok, r);
await call('_dev', { offset: 0 }); // kosongkan cache 60 detik di Worker
r = await call('ping');
ok('pengaturan sekolah ikut terimpor', r.data.namaSekolah === 'SMAN 5 Pinrang', r);
r = await call('hasilUjian', { ujianId: lama.U.id }, ADM);
const p = r.ok && r.data.peserta.find(x => x.nis === '5001');
ok('hasil ujian lama tampil di Hasil & koreksi', p && p.status === 'selesai' && p.hasil && r.data.bank.judul === 'Fisika Lama', r);
r = await call('getBank', { id: lama.bankId }, ADM);
ok('bank soal lama lengkap dengan kunci', r.ok && r.data.soal.length === 3 && r.data.soal[0].kunci, r);
// cadangan: ubah sesuatu lalu cadangkan
await call('saveConfig', { namaSekolah: 'SMAN 5 Pinrang', tahunAjaran: '2026/2027', semester: 'Genap', tingkat: ['X', 'XI', 'XII'], kelas: [{ nama: 'X-1', tingkat: 'X' }], mapel: ['Fisika'] }, ADM);
r = await call('sinkronSekarang', {}, ADM);
ok('cadangan ke GitHub', r.ok && r.data.cadangan && r.data.cadangan.berkas >= 1 && !r.data.cadangan.error, r);
const g = await (await fetch('http://127.0.0.1:9999/_log', { headers: { authorization: 'Bearer x' } })).json();
ok('repo cadangan berisi config.json terbaru', g.files['config.json'] && JSON.parse(g.files['config.json']).semester === 'Genap', Object.keys(g.files));
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
