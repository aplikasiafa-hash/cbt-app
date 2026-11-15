const G = require('./gasmock');
const assert = require('assert');
const ctx = G.boot();
let fails = 0;
function ok(name, cond, info) { if (cond) console.log('  ✓', name); else { fails++; console.log('  ✗', name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ''); } }
const call = (a, d, t) => G.call(ctx, a, d, t);
const data = p => G.headFiles('sekolah/cbt-data').get(p);

console.log('Setup');
ok('config dibuat', !!data('config.json'));
ok('guru.json', JSON.parse(data('users/guru.json')).length === 2);
ok('bank contoh', JSON.parse(data('bank/_index.json'))[0].jumlahSoal === 7);

console.log('Login');
let r = call('loginGuru', { username: 'admin', password: 'salah' });
ok('admin salah ditolak', !r.ok, r);
r = call('loginGuru', { username: 'admin', password: 'admin123' });
ok('admin login', r.ok && r.data.user.role === 'admin', r);
const ADM = r.data.token;
r = call('loginGuru', { username: 'guru', password: 'guru123' });
const GURU = r.data.token;
ok('guru login', r.ok && r.data.user.role === 'guru');
r = call('listGuru', {}, GURU);
ok('guru tidak bisa listGuru', !r.ok);
r = call('listGuru', {}, 'x.y');
ok('token palsu AUTH', !r.ok && r.code === 'AUTH', r);

console.log('Siswa & kelas');
r = call('importSiswa', { rows: [{ nis: '0012', nama: 'Dewi Nol', kelas: 'X-1' }, { nis: '2001', nama: 'Eko', kelas: 'XI IPA 2', password: 'rahasia' }, { nis: '', nama: 'x', kelas: 'y' }] }, ADM);
ok('import', r.ok && r.data.baru === 2 && r.data.lewati.length === 1, r);
ok('kelas baru ditambahkan + tingkat ditebak', r.data.config && r.data.config.kelas.some(k => k.nama === 'XI IPA 2' && k.tingkat === 'XI'), r.data.config && r.data.config.kelas);
r = call('listSiswa', {}, ADM);
ok('NIS nol di depan aman', r.data.some(s => s.nis === '0012'), r.data);

console.log('Bank soal');
r = call('listBank', {}, GURU);
ok('guru lihat bank miliknya', r.ok && r.data.length === 1);
const bankId = r.data[0].id;
r = call('getBank', { id: bankId }, GURU);
const bank = r.data;
ok('getBank lengkap dgn kunci', bank.soal[0].kunci === 'ob1');
bank.soal.push({ tipe: 'pg', teks: 'Soal baru', bobot: 1, opsi: [{ teks: 'A' }, { teks: 'B' }], kunci: '' });
r = call('saveBank', { bank }, GURU);
ok('saveBank', r.ok && r.data.bank.soal.length === 8 && r.data.bank.soal[7].id && r.data.bank.soal[7].opsi[0].id, r);
// set kunci soal baru
const b2 = r.data.bank; b2.soal[7].kunci = b2.soal[7].opsi[1].id;
r = call('saveBank', { bank: b2 }, GURU);
ok('index jumlahSoal 8', JSON.parse(data('bank/_index.json')).find(b => b.id === bankId).jumlahSoal === 8);
r = call('saveBank', { bank: { judul: 'Bank Admin', mapel: 'Fisika', tingkat: 'XI', soal: [] } }, ADM);
const bankAdmin = r.data.bank.id;
r = call('getBank', { id: bankAdmin }, GURU);
ok('guru tak bisa buka bank admin', !r.ok);

console.log('Upload gambar');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005fe02fea7d6a5e50000000049454e44ae426082', 'hex').toString('base64');
r = call('uploadGambar', { data: 'data:image/png;base64,' + png, tipe: 'image/png' }, GURU);
ok('upload → url jsdelivr', r.ok && /^https:\/\/cdn\.jsdelivr\.net\/gh\/sekolah\/cbt-media@[0-9a-f]{40}\/img\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/.test(r.data.url), r);

console.log('Jadwal ujian');
const t0 = G.now();
r = call('saveUjian', { nama: 'PH Matematika', bankId, tingkat: 'X', kelas: ['X-1'], mulai: t0 - 60000, selesai: t0 + 3 * 3600000, durasi: 60, acakSoal: true, acakOpsi: true, tampilNilai: true, pakaiToken: true, maxPelanggaran: 3 }, ADM);
ok('saveUjian', r.ok && r.data.token.length === 6, r);
const U = r.data;
r = call('saveUjian', { nama: 'x', bankId, kelas: ['X-1'], mulai: t0, selesai: t0 - 1, durasi: 60 }, ADM);
ok('validasi waktu', !r.ok);
r = call('saveUjian', { nama: 'x', bankId, kelas: ['X-1'], mulai: t0, selesai: t0 + 1e6, durasi: 60 }, GURU);
ok('guru tak bisa jadwalkan', !r.ok);
r = call('monitorUjian', { ujianId: U.id }, GURU);
ok('peserta disiapkan (X-1 = 3 siswa)', r.ok && r.data.peserta.length === 3 && r.data.peserta.every(p => p.status === 'belum'), r.data && r.data.peserta);

console.log('Siswa mengerjakan');
r = call('loginSiswa', { nis: '1001', password: '1001' });
ok('siswa login', r.ok, r);
const S1 = r.data.token;
r = call('ujianSaya', {}, S1);
ok('ujianSaya tampil', r.ok && r.data.length === 1 && r.data[0].jadwal === 'berlangsung' && r.data[0].token === undefined, r);
r = call('mulaiUjian', { ujianId: U.id, token: 'SALAH', perangkat: 'devA' }, S1);
ok('token salah ditolak', !r.ok && r.code === 'TOKEN', r);
r = call('mulaiUjian', { ujianId: U.id, token: U.token.toLowerCase(), perangkat: 'devA' }, S1);
ok('mulai', r.ok && r.data.soal.length === 8, r);
const soal = r.data.soal;
const bocor = JSON.stringify(soal);
ok('tidak ada kunci di payload', !/"kunci"|"benar"|"jawaban"|"idKanan"|"pasangan"|"rubrik"|"pembahasan"/.test(bocor), bocor.slice(0, 300));
const s1b = call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devA' }, S1);
ok('resume urutan sama', JSON.stringify(s1b.data.soal.map(s => s.id)) === JSON.stringify(soal.map(s => s.id)));
r = call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devB' }, S1);
ok('perangkat lain ditolak', !r.ok && r.code === 'PERANGKAT', r);

// jawab semua benar menggunakan kunci dari bank
const full = JSON.parse(data('bank/' + bankId + '.json'));
const J = {};
for (const s of full.soal) {
  if (s.tipe === 'pg') J[s.id] = s.kunci;
  if (s.tipe === 'pgk') J[s.id] = s.kunci;
  if (s.tipe === 'bs') J[s.id] = Object.fromEntries(s.pernyataan.map(p => [p.id, p.benar]));
  if (s.tipe === 'jodoh') J[s.id] = Object.fromEntries(s.pasangan.filter(p => p.kiri).map(p => [p.idKiri, p.idKanan]));
  if (s.tipe === 'isian') J[s.id] = '  makassar. ';
  if (s.tipe === 'urut') J[s.id] = s.opsi.map(o => o.id);
  if (s.tipe === 'uraian') J[s.id] = 'Kurangi 6 lalu bagi 2, x = 4';
}
r = call('simpanJawaban', { ujianId: U.id, jawaban: { j: J, r: [full.soal[0].id] }, pelanggaran: 1, perangkat: 'devA' }, S1);
ok('simpan jawaban', r.ok && r.data.status === 'mengerjakan', r);
r = call('monitorUjian', { ujianId: U.id }, ADM);
const p1 = r.data.peserta.find(p => p.nis === '1001');
ok('monitor: terjawab 8, ragu 1, pelanggaran 1', p1.terjawab === 8 && p1.ragu === 1 && p1.pelanggaran === 1, p1);
r = call('selesaiUjian', { ujianId: U.id, jawaban: { j: J, r: [] }, pelanggaran: 1, perangkat: 'devA' }, S1);
ok('selesai: nilai tanpa uraian', r.ok && r.data.perluKoreksi === 1, r);
const maks = full.soal.reduce((a, s) => a + s.bobot, 0);
ok('skor = maks - bobot uraian', Math.abs(r.data.nilai - Math.round((maks - 4) / maks * 10000) / 100) < 0.01, [r.data.nilai, maks]);
r = call('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'devA' }, S1);
ok('selesai idempoten (retry tidak menimpa)', r.ok && r.data.perluKoreksi === 1);
r = call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devA' }, S1);
ok('tidak bisa mulai lagi', !r.ok && r.code === 'SELESAI');

// siswa 2: jawab sebagian salah
r = call('loginSiswa', { nis: '0012', password: '0012' });
ok('login NIS 0012', r.ok, r);
const S2 = r.data.token;
r = call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devC' }, S2);
ok('siswa 0012 mulai (baris disiapkan? tidak, dibuat saat mulai)', r.ok, r);
const pgk = full.soal.find(s => s.tipe === 'pgk');
const J2 = { [pgk.id]: [pgk.kunci[0], pgk.opsi.find(o => !pgk.kunci.includes(o.id)).id] };
r = call('selesaiUjian', { ujianId: U.id, jawaban: { j: J2, r: [] }, perangkat: 'devC' }, S2);
ok('pgk sebagian: 1 benar 1 salah = 0', r.ok && r.data.nilai === 0, r);

console.log('Sinkron ke GitHub');
r = call('sinkronSekarang', {}, ADM);
ok('sinkron 2 peserta', r.ok && r.data.disinkron === 2, r);
const hasil = JSON.parse(data('hasil/' + U.id + '.json'));
ok('hasil di GitHub', Object.keys(hasil.peserta).length === 2 && hasil.peserta['0012'], Object.keys(hasil.peserta));
r = call('sinkronSekarang', {}, ADM);
ok('sinkron kedua: tidak ada perubahan', r.ok && r.data.disinkron === 0, r);
G.freshExec(ctx);
r = ctx.prosesAntrian({ triggerUid: 'x' });
ok('trigger tanpa perubahan dilewati', r.info === 'tidak ada perubahan' || r.disinkron === 0, r);

console.log('Koreksi & hasil');
const ur = full.soal.find(s => s.tipe === 'uraian');
r = call('koreksi', { ujianId: U.id, nis: '1001', manual: { [ur.id]: 3 } }, GURU);
ok('koreksi uraian', r.ok && r.data.hasil.perluKoreksi === 0 && r.data.hasil.skor === maks - 1, r.data && r.data.hasil);
r = call('hasilUjian', { ujianId: U.id }, GURU);
ok('hasilUjian gabungan', r.ok && r.data.peserta.length === 3 && r.data.peserta.find(p => p.nis === '1001').hasil.perluKoreksi === 0, r.data && r.data.peserta.map(p => p.status));
r = call('sinkronSekarang', {}, ADM);
ok('koreksi tersinkron', r.data.disinkron === 1, r);
ok('nilai koreksi di GitHub', JSON.parse(data('hasil/' + U.id + '.json')).peserta['1001'].manual[ur.id] === 3);

console.log('Reset & waktu habis');
r = call('resetPeserta', { ujianId: U.id, nis: '0012' }, ADM);
ok('reset', r.ok);
r = call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devZ' }, S2);
ok('mulai ulang setelah reset', r.ok, r);
r = call('loginSiswa', { nis: '1002', password: '1002' });
const S3 = r.data.token;
r = call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devD' }, S3);
ok('siswa 3 mulai', r.ok);
r = call('simpanJawaban', { ujianId: U.id, jawaban: { j: { [full.soal[0].id]: full.soal[0].kunci }, r: [] }, perangkat: 'devD' }, S3);
G.setOffset(61 * 60000 + 3 * 60000); // lewati durasi + toleransi
r = call('sinkronSekarang', {}, ADM);
ok('auto-kumpul waktu habis + sinkron', r.ok && r.data.disinkron >= 2, r);
r = call('monitorUjian', { ujianId: U.id }, ADM);
const p3 = r.data.peserta.find(p => p.nis === '1002');
ok('siswa 3 selesai otomatis dgn nilai', p3.status === 'selesai' && p3.nilai > 0 && /otomatis/.test(p3.catatan), p3);
G.setOffset(0);

console.log('Hitung ulang setelah kunci diperbaiki');
const fb = JSON.parse(data('bank/' + bankId + '.json'));
const pgS = fb.soal.find(s => s.tipe === 'pg');
pgS.kunci = pgS.opsi[0].id; // ubah kunci
call('saveBank', { bank: fb }, GURU);
r = call('hitungUlang', { ujianId: U.id }, GURU);
ok('hitung ulang', r.ok && r.data.dihitung >= 2, r);

console.log('Lainnya');
r = call('gantiPassword', { lama: '1001', baru: 'baru123' }, S1);
ok('siswa ganti password', r.ok, r);
r = call('loginSiswa', { nis: '1001', password: 'baru123' });
ok('login password baru', r.ok);
r = call('dashboard', {}, ADM);
ok('dashboard admin', r.ok && r.data.jumlahSiswa === 5 && r.data.jumlahBank === 2, r.data);
r = call('deleteBank', { id: bankId }, GURU);
ok('bank dipakai tidak bisa dihapus', !r.ok);
r = call('deleteUjian', { id: U.id }, ADM);
ok('hapus ujian dgn peserta butuh paksa', !r.ok && r.code === 'ADA_PESERTA');
r = call('deleteUjian', { id: U.id, paksa: true }, ADM);
ok('hapus ujian paksa', r.ok);
r = call('deleteBank', { id: bankAdmin }, ADM);
ok('hapus bank', r.ok && !data('bank/' + bankAdmin + '.json'));

// beban: 400 siswa satu ujian
console.log('Beban 400 siswa');
const rows = []; for (let i = 0; i < 400; i++) rows.push({ nis: String(50000 + i), nama: 'Siswa ' + i, kelas: 'XII-1' });
call('importSiswa', { rows }, ADM);
const b3 = call('saveBank', { bank: { judul: 'Beban', mapel: 'Kimia', tingkat: 'XII', soal: full.soal } }, ADM).data.bank;
const U2 = call('saveUjian', { nama: 'Beban', bankId: b3.id, kelas: ['XII-1'], mulai: G.now() - 1000, selesai: G.now() + 7200000, durasi: 90, acakSoal: true }, ADM).data;
G.ghStats.calls = 0;
const t1 = Date.now();
for (let i = 0; i < 400; i++) {
  const tk = call('loginSiswa', { nis: String(50000 + i), password: String(50000 + i) }).data.token;
  const m = call('mulaiUjian', { ujianId: U2.id, perangkat: 'd' + i }, tk);
  if (!m.ok) { ok('mulai beban ' + i, false, m); break; }
  call('selesaiUjian', { ujianId: U2.id, jawaban: { j: J, r: [] }, perangkat: 'd' + i }, tk);
}
console.log('  GitHub API calls selama 400 siswa login+mulai+selesai:', G.ghStats.calls, '(' + (Date.now() - t1) + ' ms)');
ok('hampir tanpa panggilan GitHub (cache)', G.ghStats.calls < 20, G.ghStats.calls);
G.ghStats.calls = 0;
r = call('sinkronSekarang', {}, ADM);
ok('400 hasil dalam 1 sinkron', r.data.disinkron >= 400, r);
console.log('  GitHub API calls untuk sinkron 400:', G.ghStats.calls, ', ukuran hasil:', (data('hasil/' + U2.id + '.json').length / 1024).toFixed(0) + ' KB');

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
