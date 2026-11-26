// Uji 2.19: "Bersihkan hasil ujian" (wajib kata sandi admin).
// Jalankan dengan wrangler dev --var DEV_MODE:1 + test/github-tiruan.mjs dan isian serverB lewat --var
// (GITHUB_TOKEN, GITHUB_API, DATA_REPO, MEDIA_REPO) seperti di serverC.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const GH = 'http://127.0.0.1:9999';
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 400))); if (!c) fails++; };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
const repo = async () => (await (await fetch(GH + '/_log', { headers: { authorization: 'Bearer x' } })).json());
const MENIT = 60000;

await call('_dev', { offset: 0 });
const ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
const GURU = (await call('loginGuru', { username: 'guru', password: 'guru123' })).data.token;
let r;

console.log('Fitur sambungan di aplikasi sudah dihapus (isian lewat serverC)');
r = await call('sambungan', {}, ADM); ok('aksi "sambungan" tidak ada lagi', !r.ok, r);
r = await call('aturSambungan', { dataRepo: 'a/b' }, ADM); ok('aksi "aturSambungan" tidak ada lagi', !r.ok, r);
r = await call('statusSistem', {}, ADM);
ok('status: serverB siap dipakai (dari isian serverC)', r.ok && r.data.adaB && r.data.adaMedia, r.data);
ok('kunci link: tidak terpasang di uji lokal tanpa kunci', r.data.kunciLink && r.data.kunciLink.terpasang === false, r.data.kunciLink);

console.log('Siapkan ujian + hasil');
await call('importSiswa', { rows: [1, 2, 3].map(i => ({ nis: '720' + i, nama: 'Siswa ' + i, kelas: 'X-1' })) }, ADM);
const bankId = 'bcontoh01';
const t0 = Date.now();
const U = (await call('saveUjian', { nama: 'Ujian lama', bankId, kelas: ['X-1'], mulai: t0 - MENIT, selesai: t0 + 60 * MENIT, durasi: 30 }, ADM)).data;
const masuk = async nis => (await call('loginSiswa', { nis, password: nis, perangkat: 'hp' + nis })).data.token;
const S = {}; for (const i of [1, 2, 3]) S[i] = await masuk('720' + i);
for (const i of [1, 2]) {
  const m = (await call('mulaiUjian', { ujianId: U.id, perangkat: 'hp720' + i }, S[i])).data;
  r = await call('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'hp720' + i, mulai: m.mulai }, S[i]);
  ok('siswa ' + i + ' selesai', r.ok && r.data.status === 'selesai', r);
}
await call('_dev', { flush: true });
r = await call('sinkronSekarang', {}, ADM);
ok('hasil dicadangkan ke serverB', r.ok && r.data.cadangan && !r.data.cadangan.error, r);
let g = await repo();
ok('repo data berisi berkas hasil ujian', !!g.files['hasil/' + U.id + '.json'], Object.keys(g.files));
r = await call('jumlahHasil', {}, ADM); ok('jumlah hasil = 2', r.ok && r.data.hasil === 2 && r.data.ujian === 1, r);

console.log('Bersihkan hasil ujian');
await call('mulaiUjian', { ujianId: U.id, perangkat: 'hp7203' }, S[3]);
r = await call('bersihkanHasil', { sandi: 'admin123' }, GURU); ok('guru biasa tidak boleh', !r.ok, r);
r = await call('bersihkanHasil', { sandi: 'salah' }, ADM); ok('kata sandi salah ditolak', !r.ok && r.code === 'SANDI', r);
r = await call('bersihkanHasil', { sandi: 'admin123' }, ADM); ok('masih ada siswa mengerjakan → ditolak', !r.ok && r.code === 'ADA_PESERTA', r);
await call('paksaSelesai', { ujianId: U.id, nis: '7203' }, ADM);
const sebelum = { siswa: (await call('listSiswa', {}, ADM)).data.length, guru: (await call('listGuru', {}, ADM)).data.length, bank: (await call('listBank', {}, ADM)).data.length };
r = await call('bersihkanHasil', { sandi: 'admin123' }, ADM);
ok('kata sandi benar → 3 hasil dibersihkan, jadwal tetap', r.ok && r.data.hasil === 3 && r.data.jadwal === 0, r);
r = await call('jumlahHasil', {}, ADM); ok('database: 0 hasil', r.data.hasil === 0, r);
const sesudah = { siswa: (await call('listSiswa', {}, ADM)).data.length, guru: (await call('listGuru', {}, ADM)).data.length, bank: (await call('listBank', {}, ADM)).data.length };
ok('data siswa, guru, dan bank soal tidak berubah', JSON.stringify(sebelum) === JSON.stringify(sesudah), [sebelum, sesudah]);
r = await call('listUjian', {}, ADM); ok('jadwal tetap ada', r.data.some(u => u.id === U.id), r.data);
r = await call('hasilUjian', { ujianId: U.id }, ADM); ok('hasil ujian itu kosong', r.ok && (r.data.hasil || r.data.peserta || []).filter(p => p.status === 'selesai').length === 0, r.data && Object.keys(r.data));
r = await call('ujianSaya', {}, S[1]); ok('siswa bisa mengerjakan jadwal itu lagi', r.ok && r.data.find(u => u.id === U.id).status !== 'selesai', r.data);
r = await call('mulaiUjian', { ujianId: U.id, perangkat: 'hp7201' }, S[1]); ok('… dan mulai lagi dari awal', r.ok && r.data.mulai > 0 && r.data.soal.length > 0, r.ok);
await call('paksaSelesai', { ujianId: U.id, nis: '7201' }, ADM);
r = await call('sinkronSekarang', {}, ADM); g = await repo();
ok('salinan hasil lama di serverB diganti dengan hasil terbaru', r.ok && g.files['hasil/' + U.id + '.json'], Object.keys(g.files));

console.log('Bersihkan + hapus jadwal');
const adaB4 = Object.keys(g.files).filter(f => !f.startsWith('hasil/') && !f.startsWith('ujian/'));
r = await call('bersihkanHasil', { sandi: 'admin123', hapusJadwal: true }, ADM);
ok('hasil & semua jadwal dihapus', r.ok && r.data.hasil === 1 && r.data.jadwal >= 1, r);
r = await call('listUjian', {}, ADM); ok('tidak ada jadwal lagi', r.ok && r.data.length === 0, r.data);
r = await call('sinkronSekarang', {}, ADM); g = await repo();
ok('berkas hasil di serverB ikut terhapus', r.ok && !g.files['hasil/' + U.id + '.json'], Object.keys(g.files));
ok('data siswa/guru/bank di serverB tetap', adaB4.length > 0 && adaB4.every(f => g.files[f]), { sebelum: adaB4, sesudah: Object.keys(g.files) });

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
