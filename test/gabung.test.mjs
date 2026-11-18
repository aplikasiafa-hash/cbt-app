// Uji v2.5.0-CBT: data serverB + D1 dipadukan, dan kiriman ke serverB hanya saat ada perubahan.
// Butuh GitHub tiruan (node test/github-tiruan.mjs /tmp/cbt-data.tar.gz) dan wrangler dev dengan:
//   --var GITHUB_API:http://127.0.0.1:9999 --var GITHUB_TOKEN:x --var DATA_REPO:sekolah/cbt-data --var JEDA_CADANGAN_DETIK:3
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const call = async (a, d = {}, t = '') => (await fetch(BASE + '/api?a=' + a, { method: 'POST', body: JSON.stringify({ action: a, data: d, token: t }) })).json();
let fails = 0; const ok = (n, c, i) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + String(JSON.stringify(i)).slice(0, 500))); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let OFS = 0;   // _dev tanpa offset mengembalikan jam ke 0 → selalu kirim offset yang berlaku
const dev = d => { if (d.offset !== undefined) OFS = d.offset; return call('_dev', { offset: OFS, ...d }); };
const log = async () => (await (await fetch('http://127.0.0.1:9999/_log', { headers: { authorization: 'Bearer x' } })).json());
const commits = async () => (await log()).log.filter(x => x.commit);
const baca = async () => (await log()).log.filter(x => x.baca);
const d1 = async fn => { await dev({ ukurNol: true }); const r = await fn(); const u = (await dev({})).data.ukur; return [r, u.d1r]; };
const tungguKirim = async (n0, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await commits()).length > n0) return true; await sleep(1000); } return false; };

await dev({ offset: 0 });
let ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
let GURU = (await call('loginGuru', { username: 'guru', password: 'guru123' })).data.token;

console.log('Kiriman ke serverB hanya saat ada perubahan');
await tungguKirim(0, 30000);          // kiriman awal otomatis (salinan siswa pertama kali)
ok('salinan siswa pertama dikirim otomatis', (await commits()).length >= 1);
await sleep(2000);
let n0 = (await commits()).length;
await sleep(14000);
ok('tidak ada perubahan → tidak ada kiriman', (await commits()).length === n0);
await call('saveSiswa', { nis: '8001', nama: 'Siswa Gabung', kelas: 'X-1', password: 'rahasia8' }, ADM);
await call('saveSiswa', { nis: '8002', nama: 'Siswa Dua', kelas: 'X-1', password: '' }, ADM);
let st = (await call('statusSistem', {}, ADM)).data;
ok('perubahan tercatat menunggu dikirim (tidak langsung)', st.antrianCadangan >= 1 && (await commits()).length === n0, st);
ok('dikirim otomatis sesudah jeda', await tungguKirim(n0));
const cm = (await commits()).at(-1), files = (await log()).files;
ok('salinan siswa memuat kata sandi admin (terenkripsi)', cm.files.includes('users/siswa.json') && JSON.parse(files['users/siswa.json']).find(s => s.nis === '8001').sandi.startsWith('v1:'), cm);
st = (await call('statusSistem', {}, ADM)).data;
ok('status: semua perubahan terkirim', st.antrianCadangan === 0 && st.cadanganTerakhir > 0, st);

console.log('Selama ujian berlangsung kiriman ditunda');
const t0 = Date.now();
const U = (await call('saveUjian', { nama: 'Ujian Gabung', bankId: 'bcontoh01', kelas: ['X-1'], mulai: t0 - 60000, selesai: t0 + 2 * 3600000, durasi: 60, pakaiToken: false, acakSoal: false, acakOpsi: false }, ADM)).data;
const S = (await call('loginSiswa', { nis: '8001', password: 'rahasia8' })).data.token;
const m = (await call('mulaiUjian', { ujianId: U.id, perangkat: 'g1' }, S)).data;
n0 = (await commits()).length;
await sleep(15000);
ok('ada siswa mengerjakan → perubahan jadwal belum dikirim', (await commits()).length === n0);
const jw = { j: { [m.soal[0].id]: m.soal[0].opsi ? m.soal[0].opsi[0].id : 'x' }, r: [] };
let r = await call('selesaiUjian', { ujianId: U.id, jawaban: jw, perangkat: 'g1', mulai: m.mulai }, S);
ok('siswa selesai', r.ok, r);
ok('ujian selesai → jadwal & hasil dikirim', await tungguKirim(n0) && (await log()).files['hasil/' + U.id + '.json'] !== undefined);
const arsip = JSON.parse((await log()).files['hasil/' + U.id + '.json']);
ok('salinan hasil berisi jawaban siswa', arsip.peserta['8001'] && arsip.peserta['8001'].status === 'selesai', arsip);

console.log('Hari berikutnya: data kemarin dibaca dari serverB (0 baris D1)');
await dev({ offset: 2 * 86400000, lepas: true });
ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;   // token kemarin sudah kedaluwarsa
GURU = (await call('loginGuru', { username: 'guru', password: 'guru123' })).data.token;
let [ls, b] = await d1(() => call('listSiswa', {}, ADM));
ok('Data siswa: 0 baris D1, dari serverB', b === 0 && ls.data.some(s => s.nis === '8001') && ls.data.some(s => s.nis === '8002'), [b, ls.data && ls.data.length]);
let [sd, b2] = await d1(() => call('sandiSiswa', {}, ADM));
ok('Excel/kartu siswa: kata sandi dari serverB, 0 baris D1', b2 === 0 && sd.data['8001'] === 'rahasia8' && sd.data['8002'] === '8002', [b2, sd.data['8001'], sd.data['8002']]);
let [h, b3] = await d1(() => call('hasilUjian', { ujianId: U.id }, ADM));
ok('Hasil ujian kemarin dari serverB (1 baris D1 = bank soal, dibaca sekali)', b3 <= 1 && h.data.peserta.find(p => p.nis === '8001').status === 'selesai', [b3, h.data && h.data.peserta]);
let [hg, b4] = await d1(() => call('hasilUjian', { ujianId: U.id }, GURU));
ok('Guru pemilik melihat nilai dari salinan, 0 baris D1', b4 === 0 && hg.data.lihatNilai && hg.data.peserta.find(p => p.nis === '8001').hasil, [b4, hg.data && hg.data.peserta]);
let [mo, b5] = await d1(() => call('monitorUjian', { ujianId: U.id }, ADM));
ok('Monitor ujian kemarin: daftar peserta & status dari serverB, 0 baris D1', b5 === 0 && mo.data.peserta.find(p => p.nis === '8001').status === 'selesai' && mo.data.peserta.some(p => p.nis === '8002'), [b5, mo.data && mo.data.peserta]);
ok('salinan dibaca pada commit tetap (bukan cabang yang bisa berubah)', (await baca()).every(x => /^[0-9a-f]{40}$/.test(x.ref)), await baca());

console.log('Data hari ini tetap dari D1');
await call('saveSiswa', { nis: '8003', nama: 'Siswa Hari Ini', kelas: 'X-1', password: '' }, ADM);
[ls, b] = await d1(() => call('listSiswa', {}, ADM));
ok('ada perubahan siswa hari ini → dibaca dari D1 (data terbaru)', b > 0 && ls.data.some(s => s.nis === '8003'), [b]);
const nK = (await commits()).length;
r = await call('koreksi', { ujianId: U.id, nis: '8001', manual: {} }, GURU);
await dev({ lepas: true });
[h, b3] = await d1(() => call('hasilUjian', { ujianId: U.id }, GURU));
ok('hasil kemarin yang dikoreksi hari ini → dari D1 sampai terkirim lagi', b3 > 0 && h.ok, [b3, r]);
ok('koreksi ikut dikirim ke serverB', await tungguKirim(nK, 25000));
await dev({ lepas: true });
[h, b3] = await d1(() => call('hasilUjian', { ujianId: U.id }, GURU));
ok('setelah terkirim → kembali dari serverB, 0 baris D1', b3 === 0 && h.ok, [b3]);

await dev({ offset: 0 });
await call('deleteUjian', { id: U.id, paksa: true, hapusHasil: true }, ADM);
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
