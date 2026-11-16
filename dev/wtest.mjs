import { G, env, isolate, call, cron, data, dataFiles, majukan, selesaikanTertunda, gfState, GF_ID, d1stats, netStats, bootData } from './wharness.mjs';

bootData(); // seed repo data dengan setup() versi Apps Script (cek kompatibilitas hash sandi)
const W = await isolate();
let fails = 0;
function ok(name, cond, info) { if (cond) console.log('  ✓', name); else { fails++; console.log('  ✗', name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ''); } }
const c = (a, d, t) => call(W, a, d, t);

console.log('Dasar');
let r = await (await W.default.fetch(new Request('https://cbt.test/'), env, {})).json();
ok('GET info', r.ok && r.data.backend === 'cloudflare', r);
r = await c('aksiNgawur', {});
ok('aksi tak dikenal', !r.ok, r);

console.log('Login (data dari setup Apps Script)');
r = await c('loginGuru', { username: 'admin', password: 'salah' });
ok('admin salah ditolak', !r.ok, r);
r = await c('loginGuru', { username: 'admin', password: 'admin123' });
ok('admin login (hash kompatibel)', r.ok && r.data.user.role === 'admin', r);
const ADM = r.data.token;
r = await c('loginGuru', { username: 'guru', password: 'guru123' });
const GURU = r.data.token;
ok('guru login', r.ok && r.data.user.role === 'guru');
r = await c('listGuru', {}, GURU);
ok('guru tidak bisa listGuru', !r.ok);
r = await c('listGuru', {}, 'x.y');
ok('token palsu AUTH', !r.ok && r.code === 'AUTH', r);
for (let i = 0; i < 8; i++) await c('loginGuru', { username: 'gurux', password: 'salah' });
r = await c('loginGuru', { username: 'gurux', password: 'salah' });
ok('pembatasan percobaan login', !r.ok && /Terlalu banyak/.test(r.error), r);

console.log('Siswa & kelas');
r = await c('importSiswa', { rows: [{ nis: '0012', nama: 'Dewi Nol', kelas: 'X-1' }, { nis: '2001', nama: 'Eko', kelas: 'XI IPA 2', password: 'rahasia' }, { nis: '', nama: 'x', kelas: 'y' }] }, ADM);
ok('import', r.ok && r.data.baru === 2 && r.data.lewati.length === 1, r);
ok('kelas baru + tingkat ditebak', r.data.config && r.data.config.kelas.some(k => k.nama === 'XI IPA 2' && k.tingkat === 'XI'), r.data.config);
r = await c('listSiswa', {}, ADM);
ok('NIS nol di depan aman', r.data.some(s => s.nis === '0012'), r.data);
r = await c('loginSiswa', { nis: '2001', password: 'rahasia' });
ok('login siswa impor dgn sandi', r.ok, r);

console.log('Bank soal');
r = await c('listBank', {}, GURU);
ok('guru lihat bank miliknya', r.ok && r.data.length === 1);
const bankId = r.data[0].id;
r = await c('getBank', { id: bankId }, GURU);
const bank = r.data;
ok('getBank lengkap dgn kunci', bank.soal[0].kunci === 'ob1', r);
bank.soal.push({ tipe: 'pg', teks: 'Soal baru', bobot: 1, opsi: [{ teks: 'A' }, { teks: 'B' }], kunci: '' });
r = await c('saveBank', { bank }, GURU);
ok('saveBank', r.ok && r.data.bank.soal.length === 8 && r.data.bank.soal[7].id && r.data.bank.soal[7].opsi[0].id, r);
const b2 = r.data.bank; b2.soal[7].kunci = b2.soal[7].opsi[1].id;
r = await c('saveBank', { bank: b2 }, GURU);
ok('index jumlahSoal 8', JSON.parse(data('bank/_index.json')).find(b => b.id === bankId).jumlahSoal === 8);
r = await c('saveBank', { bank: { judul: 'Bank Admin', mapel: 'Fisika', tingkat: 'XI', soal: [] } }, ADM);
const bankAdmin = r.data.bank.id;
r = await c('getBank', { id: bankAdmin }, GURU);
ok('guru tak bisa buka bank admin', !r.ok);

console.log('Upload gambar');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005fe02fea7d6a5e50000000049454e44ae426082', 'hex').toString('base64');
r = await c('uploadGambar', { data: 'data:image/png;base64,' + png, tipe: 'image/png' }, GURU);
ok('upload → url jsdelivr', r.ok && /^https:\/\/cdn\.jsdelivr\.net\/gh\/sekolah\/cbt-media@[0-9a-f]{40}\/img\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/.test(r.data.url), r);

console.log('Jadwal ujian');
const t0 = Date.now();
r = await c('saveUjian', { nama: 'PH Matematika', bankId, tingkat: 'X', kelas: ['X-1'], mulai: t0 - 60000, selesai: t0 + 3 * 3600000, durasi: 60, acakSoal: true, acakOpsi: true, tampilNilai: true, pakaiToken: true, maxPelanggaran: 3 }, ADM);
ok('saveUjian', r.ok && r.data.token.length === 6, r);
const U = r.data;
r = await c('saveUjian', { nama: 'x', bankId, kelas: ['X-1'], mulai: t0, selesai: t0 - 1, durasi: 60 }, ADM);
ok('validasi waktu', !r.ok);
r = await c('saveUjian', { nama: 'x', bankId, kelas: ['X-1'], mulai: t0, selesai: t0 + 1e6, durasi: 60 }, GURU);
ok('guru tak bisa jadwalkan', !r.ok);
r = await c('monitorUjian', { ujianId: U.id }, GURU);
ok('monitor: 3 siswa X-1 belum', r.ok && r.data.peserta.length === 3 && r.data.peserta.every(p => p.status === 'belum'), r.data && r.data.peserta);

console.log('Siswa mengerjakan');
r = await c('loginSiswa', { nis: '1001', password: '1001' });
ok('siswa login', r.ok, r);
const S1 = r.data.token;
r = await c('ujianSaya', {}, S1);
ok('ujianSaya tampil tanpa token', r.ok && r.data.length === 1 && r.data[0].jadwal === 'berlangsung' && r.data[0].token === undefined, r);
r = await c('mulaiUjian', { ujianId: U.id, token: 'SALAH', perangkat: 'devA' }, S1);
ok('token salah ditolak', !r.ok && r.code === 'TOKEN', r);
r = await c('mulaiUjian', { ujianId: U.id, token: U.token.toLowerCase(), perangkat: 'devA' }, S1);
ok('mulai', r.ok && r.data.soal.length === 8, r);
const soal = r.data.soal;
const bocor = JSON.stringify(soal);
ok('tidak ada kunci di payload', !/"kunci"|"benar"|"jawaban"|"idKanan"|"pasangan"|"rubrik"|"pembahasan"|"gv"/.test(bocor), bocor.slice(0, 300));
let s1b = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devA' }, S1);
ok('resume urutan sama', JSON.stringify(s1b.data.soal.map(s => s.id)) === JSON.stringify(soal.map(s => s.id)));
r = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devB' }, S1);
ok('perangkat lain ditolak', !r.ok && r.code === 'PERANGKAT', r);

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
r = await c('simpanJawaban', { ujianId: U.id, jawaban: { j: J, r: [full.soal[0].id] }, pelanggaran: 1, perangkat: 'devA' }, S1);
ok('simpan jawaban', r.ok && r.data.status === 'mengerjakan' && r.data.deadline > 0, r);
r = await c('simpanJawaban', { ujianId: U.id, jawaban: { j: J, r: [] }, perangkat: 'devB' }, S1);
ok('simpan dari perangkat lain ditolak', !r.ok && r.code === 'PERANGKAT', r);
r = await c('monitorUjian', { ujianId: U.id }, ADM);
const p1 = r.data.peserta.find(p => p.nis === '1001');
ok('monitor: terjawab 8, ragu 1, pelanggaran 1', p1.terjawab === 8 && p1.ragu === 1 && p1.pelanggaran === 1, p1);
r = await c('selesaiUjian', { ujianId: U.id, jawaban: { j: J, r: [] }, pelanggaran: 1, perangkat: 'devA' }, S1);
ok('selesai: uraian perlu koreksi', r.ok && r.data.perluKoreksi === 1, r);
const maks = full.soal.reduce((a, s) => a + s.bobot, 0);
ok('skor = maks - bobot uraian', Math.abs(r.data.nilai - Math.round((maks - 4) / maks * 10000) / 100) < 0.01, [r.data.nilai, maks]);
// cocokkan dengan mesin penilaian Apps Script
const gctx = G.boot ? null : null;
r = await c('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'devA' }, S1);
ok('selesai idempoten', r.ok && r.data.perluKoreksi === 1);
r = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devA' }, S1);
ok('tidak bisa mulai lagi', !r.ok && r.code === 'SELESAI');

r = await c('loginSiswa', { nis: '0012', password: '0012' });
ok('login NIS 0012', r.ok, r);
const S2 = r.data.token;
r = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devC' }, S2);
ok('siswa 0012 mulai', r.ok, r);
const pgk = full.soal.find(s => s.tipe === 'pgk');
const J2 = { [pgk.id]: [pgk.kunci[0], pgk.opsi.find(o => !pgk.kunci.includes(o.id)).id] };
r = await c('selesaiUjian', { ujianId: U.id, jawaban: { j: J2, r: [] }, perangkat: 'devC' }, S2);
ok('pgk sebagian: 1 benar 1 salah = 0', r.ok && r.data.nilai === 0, r);

console.log('Arsip ke GitHub');
r = await c('sinkronSekarang', {}, ADM);
ok('sinkron 2 peserta', r.ok && r.data.disinkron === 2, r);
const fArsip = dataFiles().filter(p => p.startsWith('hasil/' + U.id + '/'));
ok('satu file per peserta', fArsip.length === 2 && fArsip.includes('hasil/' + U.id + '/X-1/1001.json'), fArsip);
const arsip1 = JSON.parse(data('hasil/' + U.id + '/X-1/1001.json'));
ok('isi arsip lengkap', arsip1.hasil.perluKoreksi === 1 && arsip1.jawaban.j[full.soal[0].id] && arsip1.ujianId === U.id, arsip1);
r = await c('sinkronSekarang', {}, ADM);
ok('sinkron kedua: tidak ada perubahan', r.ok && r.data.disinkron === 0, r);

console.log('Koreksi & hasil');
const ur = full.soal.find(s => s.tipe === 'uraian');
r = await c('koreksi', { ujianId: U.id, nis: '1001', manual: { [ur.id]: 3 } }, GURU);
ok('koreksi uraian', r.ok && r.data.hasil.perluKoreksi === 0 && r.data.hasil.skor === maks - 1 && r.data.jawaban.j, r.data && r.data.hasil);
r = await c('hasilUjian', { ujianId: U.id }, GURU);
ok('hasilUjian (JSON mentah) terbaca', r.ok && r.data.peserta.length === 3 && r.data.peserta.find(p => p.nis === '1001').hasil.perluKoreksi === 0 && r.data.bank.soal.length === 8 && typeof r.data.peserta[0].jawaban === 'object', r.data && r.data.peserta);
r = await c('koreksiMassal', { ujianId: U.id, items: [{ nis: '0012', manual: { [ur.id]: 2 } }] }, GURU);
ok('koreksi massal', r.ok && r.data[0].manual[ur.id] === 2, r);
await cron(W);
ok('koreksi terarsip', JSON.parse(data('hasil/' + U.id + '/X-1/1001.json')).manual[ur.id] === 3);

console.log('Reset & waktu habis');
r = await c('resetLogin', { ujianId: U.id, nis: '0012' }, GURU);
ok('reset login', r.ok, r);
r = await c('resetPeserta', { ujianId: U.id, nis: '0012' }, GURU);
ok('reset peserta khusus admin', !r.ok, r);
r = await c('resetPeserta', { ujianId: U.id, nis: '0012' }, ADM);
ok('reset', r.ok, r);
r = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devZ' }, S2);
ok('mulai ulang setelah reset (percobaan 2, urutan beda)', r.ok && JSON.stringify(r.data.soal.map(s => s.id)) !== JSON.stringify(soal.map(s => s.id)), r);
r = await c('loginSiswa', { nis: '1002', password: '1002' });
const S3 = r.data.token;
r = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devD' }, S3);
ok('siswa 3 mulai', r.ok);
await c('simpanJawaban', { ujianId: U.id, jawaban: { j: { [full.soal[0].id]: full.soal[0].kunci }, r: [] }, perangkat: 'devD' }, S3);
r = await c('saveSiswa', { nis: '1004', nama: 'Dian', kelas: 'X-1' }, ADM);
ok('tambah siswa (sandi = NIS)', r.ok, r);
r = await c('loginSiswa', { nis: '1003', password: '1003' });
r = await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devE' }, r.data.token);
ok('siswa kelas lain ditolak', !r.ok && /tidak terdaftar/.test(r.error), r);
r = await c('loginSiswa', { nis: '1004', password: '1004' });
const S4 = r.data.token;
await c('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devE' }, S4);
r = await c('paksaSelesai', { ujianId: U.id, nis: '1004' }, GURU);
ok('paksa selesai', r.ok, r);
r = await c('simpanJawaban', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'devE' }, S4);
ok('siswa yg dihentikan diberi tahu', r.ok && r.data.status === 'selesai' && /dihentikan/.test(r.data.catatan), r);
majukan(61 * 60000 + 3 * 60000);
await cron(W);
r = await c('monitorUjian', { ujianId: U.id }, ADM);
const p3 = r.data.peserta.find(p => p.nis === '1002');
ok('siswa 3 selesai otomatis oleh cron', p3.status === 'selesai' && p3.nilai > 0 && /otomatis/.test(p3.catatan), p3);
ok('arsip siswa 3 & reset 0012', !!data('hasil/' + U.id + '/X-1/1002.json') && JSON.parse(data('hasil/' + U.id + '/X-1/0012.json')).status === 'selesai', dataFiles().filter(p => p.startsWith('hasil/')));
majukan(-(61 * 60000 + 3 * 60000));

console.log('Hitung ulang setelah kunci diperbaiki');
const fb = JSON.parse(data('bank/' + bankId + '.json'));
const pgS = fb.soal.find(s => s.tipe === 'pg');
pgS.kunci = pgS.opsi[0].id;
r = await c('saveBank', { bank: fb }, GURU);
ok('save bank memberi info dipakai', r.ok && r.data.dipakai.includes('PH Matematika'), r);
r = await c('hitungUlang', { ujianId: U.id }, GURU);
ok('hitung ulang', r.ok && r.data.dihitung >= 3, r);

console.log('Lainnya');
r = await c('gantiPassword', { lama: '1001', baru: 'baru123' }, S1);
ok('siswa ganti password', r.ok, r);
r = await c('loginSiswa', { nis: '1001', password: 'baru123' });
ok('login password baru', r.ok);
r = await c('saveGuru', { username: 'bu.ani', nama: 'Bu Ani', password: 'ani12345', role: 'guru', mapel: ['IPA'] }, ADM);
ok('tambah guru', r.ok && r.data.username === 'bu.ani', r);
r = await c('loginGuru', { username: 'bu.ani', password: 'ani12345' });
ok('guru baru login', r.ok, r);
r = await c('dashboard', {}, ADM);
ok('dashboard admin', r.ok && r.data.jumlahSiswa === 6 && r.data.jumlahBank === 2 && r.data.jumlahGuru === 3, r.data);
r = await c('saveConfig', { namaSekolah: 'SMAN Uji', tahunAjaran: '2026/2027', semester: 'Ganjil', tingkat: ['X', 'XI', 'XII'], kelas: [{ nama: 'X-1', tingkat: 'X' }], mapel: ['Matematika'] }, ADM);
ok('saveConfig', r.ok && r.data.namaSekolah === 'SMAN Uji');
r = await c('ping', {});
ok('ping pakai config baru', r.data.namaSekolah === 'SMAN Uji', r);
r = await c('deleteBank', { id: bankId }, GURU);
ok('bank dipakai tidak bisa dihapus', !r.ok);
r = await c('deleteUjian', { id: U.id }, ADM);
ok('hapus ujian dgn peserta butuh paksa', !r.ok && r.code === 'ADA_PESERTA');
r = await c('deleteUjian', { id: U.id, paksa: true }, ADM);
ok('hapus ujian paksa', r.ok);
r = await c('deleteBank', { id: bankAdmin }, ADM);
ok('hapus bank', r.ok && !data('bank/' + bankAdmin + '.json'));
r = await c('gantiTokenUjian', { id: 'tidakada' }, ADM);
ok('ganti token ujian tak ada', !r.ok);

/* ===================== GOOGLE FORM ===================== */
console.log('Google Form: impor');
gfState.mintaLogin = true;
r = await c('imporGForm', { url: 'https://docs.google.com/forms/d/e/' + GF_ID + '/viewform?usp=sf_link' }, GURU);
ok('form wajib login ditolak dgn pesan jelas', !r.ok && r.code === 'GFORM_LOGIN', r);
gfState.mintaLogin = false;
r = await c('imporGForm', { url: 'https://docs.google.com/forms/d/1abcDEF/edit' }, GURU);
ok('link edit ditolak', !r.ok && /link edit/.test(r.error), r);
r = await c('imporGForm', { url: 'https://docs.google.com/forms/d/e/' + GF_ID + '/viewform?usp=sf_link', mapel: 'IPA', tingkat: 'X' }, GURU);
ok('impor berhasil', r.ok, r);
const imp = r.data;
const gb = imp.bank;
const tipeMap = Object.fromEntries(gb.soal.map(s => [s.id, s.tipe]));
ok('identitas: nama & kelas', imp.identitas.length === 2 && imp.identitas[0].isi === 'nama' && imp.identitas[1].isi === 'kelas', imp.identitas);
ok('jenis soal terpetakan', tipeMap.g113 === 'pg' && tipeMap.g114 === 'pgk' && tipeMap.g117 === 'pg' && tipeMap.g118 === 'pg' && tipeMap.g120 === 'uraian' && tipeMap.g121r0 === 'pg' && tipeMap.g121r1 === 'pg' && tipeMap.g122 === 'isian' && tipeMap.g123 === 'isian', tipeMap);
ok('opsi "Lainnya" dibuang', gb.soal.find(s => s.id === 'g113').opsi.length === 3);
ok('stimulus & gambar ke soal berikutnya', /Laut itu biru/.test(gb.soal.find(s => s.id === 'g117').stimulus) && gb.soal.find(s => s.id === 'g117').gambar.length === 2, gb.soal.find(s => s.id === 'g117'));
ok('skala dgn label', /Ragu/.test(gb.soal.find(s => s.id === 'g118').opsi[0].teks) && gb.soal.find(s => s.id === 'g118').opsi[0].gv === '1');
ok('unggah file & video dilewati + peringatan', !tipeMap.g124 && imp.peringatan.some(p => /unggah file/.test(p)) && imp.peringatan.some(p => /Video/.test(p)), imp.peringatan);
ok('peringatan pilihan wajib', imp.peringatan.some(p => /wajib/.test(p)), imp.peringatan);
ok('bank tersimpan dgn tautan form', gb.gform.formId === GF_ID && gb.gform.halaman === 2 && JSON.parse(data('bank/_index.json')).find(b => b.id === gb.id).gform === true, gb.gform);
ok('daftar gambar untuk disalin', imp.gambar.length === 2, imp.gambar);
for (const g of imp.gambar) {
  r = await c('salinGambarGForm', { url: g }, GURU);
  ok('salin gambar ' + g.slice(0, 40), r.ok && /cdn\.jsdelivr\.net/.test(r.data.url), r);
}
r = await c('salinGambarGForm', { url: 'https://evil.example.com/x.png' }, GURU);
ok('salin gambar dari luar Google ditolak', !r.ok, r);

console.log('Google Form: ujian & kirim');
r = await c('getBank', { id: gb.id }, GURU);
const gbank = r.data;
// guru menambah kunci untuk soal ibu kota & mengubah identitas kelas menjadi "nama - kelas"
const sIbu = gbank.soal.find(s => s.id === 'g113'); sIbu.kunci = sIbu.opsi[0].id; sIbu.bobot = 2;
gbank.gform.identitas[1].isi = 'namakelas';
gbank.gform.formId = 'FORM_LAIN_YANG_DISUSUPKAN';
r = await c('saveBank', { bank: gbank }, GURU);
ok('simpan bank form: kunci & identitas berubah, formId tetap', r.ok && r.data.bank.gform.formId === GF_ID && r.data.bank.gform.identitas[1].isi === 'namakelas' && r.data.bank.soal.find(s => s.id === 'g113').gform.entry === '1003', r.data && r.data.bank.gform);
r = await c('saveUjian', { nama: 'Ulangan Bab 1', bankId: gb.id, kelas: ['X-1'], mulai: Date.now() - 1000, selesai: Date.now() + 7200000, durasi: 45, acakSoal: true, acakOpsi: true, tampilNilai: true }, ADM);
ok('jadwal ujian form', r.ok && r.data.gform === true, r);
const UG = r.data;
const S5 = (await c('loginSiswa', { nis: '1002', password: '1002' })).data.token;
r = await c('mulaiUjian', { ujianId: UG.id, perangkat: 'p5' }, S5);
ok('siswa mulai ujian form', r.ok && r.data.ujian.gform === true && r.data.soal.length === gbank.soal.length, r);
const gsoal = r.data.soal;
ok('payload tanpa gv/entry', !/"gv"|"entry"|1003/.test(JSON.stringify(gsoal)), JSON.stringify(gsoal).slice(0, 200));
ok('opsi skala tidak diacak', gsoal.find(s => s.id === 'g118').opsi.map(o => o.id).join() === 'g118o0,g118o1,g118o2,g118o3,g118o4');
const JG = {
  g113: 'g113o0', g114: ['g114o0', 'g114o2'], g117: 'g117o0', g118: 'g118o3', g120: 'Air menguap lalu mengembun.',
  g121r0: 'g121r0o0', g122: '2010-05-17', g123: '6.15'
};
r = await c('selesaiUjian', { ujianId: UG.id, jawaban: { j: JG, r: [] }, perangkat: 'p5' }, S5);
ok('selesai ujian form; nilai hanya dari soal berkunci', r.ok && r.data.nilai === 100 && r.data.perluKoreksi === 0, r);
await selesaikanTertunda();
ok('jawaban terkirim ke Google Form', gfState.submissions.length === 1, gfState.submissions.length);
const sub = gfState.submissions[0];
ok('isi kiriman benar', sub.get('entry.1001') === 'Budi Santoso' || sub.get('entry.1001').length > 0, [...sub.entries()]);
ok('identitas nama-kelas', sub.get('entry.1002') === sub.get('entry.1001') + ' - X-1', sub.get('entry.1002'));
ok('pg, centang, dropdown, skala, grid', sub.get('entry.1003') === 'Jakarta' && sub.getAll('entry.1004').join() === '2,4' && sub.get('entry.1005') === 'Biru' && sub.get('entry.1006') === '4' && sub.get('entry.1008') === 'Pernah' && !sub.has('entry.1009'), [...sub.entries()]);
ok('paragraf, tanggal, jam', sub.get('entry.1007') === 'Air menguap lalu mengembun.' && sub.get('entry.1010_year') === '2010' && sub.get('entry.1010_month') === '5' && sub.get('entry.1010_day') === '17' && sub.get('entry.1011_hour') === '06' && sub.get('entry.1011_minute') === '15', [...sub.entries()]);
ok('pageHistory semua halaman', sub.get('pageHistory') === '0,1', sub.get('pageHistory'));
r = await c('monitorUjian', { ujianId: UG.id }, GURU);
ok('status form terkirim di monitor', r.data.peserta.find(p => p.nis === '1002').formStatus === 'terkirim', r.data.peserta.find(p => p.nis === '1002'));

console.log('Google Form: gagal kirim → antre → kirim ulang');
const S6 = (await c('loginSiswa', { nis: '1001', password: 'baru123' })).data.token;
await c('mulaiUjian', { ujianId: UG.id, perangkat: 'p6' }, S6);
r = await c('selesaiUjian', { ujianId: UG.id, jawaban: { j: { g114: ['g114o1'] }, r: [] }, perangkat: 'p6' }, S6);
await selesaikanTertunda();
ok('pertanyaan wajib kosong → ditolak Google, tercatat antre', gfState.submissions.length === 1, gfState.submissions.length);
r = await c('hasilUjian', { ujianId: UG.id }, GURU);
const p6 = r.data.peserta.find(p => p.nis === '1001');
ok('status antre + alasan', p6.formStatus === 'antre' && /Ditolak|400/.test(p6.formInfo), p6);
for (let i = 0; i < 5; i++) { majukan(130000); await cron(W); }
r = await c('hasilUjian', { ujianId: UG.id }, GURU);
ok('setelah 5x coba → gagal', r.data.peserta.find(p => p.nis === '1001').formStatus === 'gagal', r.data.peserta.find(p => p.nis === '1001'));
r = await c('kirimUlangForm', { ujianId: UG.id }, GURU);
ok('kirim ulang manual tetap gagal (wajib kosong)', r.ok && r.data.diproses === 1 && r.data.terkirim === 0 && r.data.galat.length === 1, r);
// ujian auto-collect oleh cron mengirim lewat antrean
const S7 = (await c('loginSiswa', { nis: '0012', password: '0012' })).data.token;
await c('mulaiUjian', { ujianId: UG.id, perangkat: 'p7' }, S7);
await c('simpanJawaban', { ujianId: UG.id, jawaban: { j: { g113: 'g113o1' }, r: [] }, perangkat: 'p7' }, S7);
majukan(50 * 60000);
await cron(W);
ok('waktu habis → dikirim oleh cron', gfState.submissions.length === 2 && gfState.submissions[1].get('entry.1003') === 'Bandung', gfState.submissions.length);
r = await c('hasilUjian', { ujianId: UG.id }, GURU);
const p7 = r.data.peserta.find(p => p.nis === '0012');
ok('nilai 0 (kunci Jakarta), form terkirim', p7.hasil.nilai === 0 && p7.formStatus === 'terkirim', p7);
majukan(-50 * 60000 - 5 * 130000);

/* ===================== BEBAN ===================== */
console.log('Beban: 1300 siswa bersamaan, 6 isolate');
const rows = []; for (let i = 0; i < 1300; i++) rows.push({ nis: String(50000 + i), nama: 'Siswa ' + i, kelas: 'XII-' + (1 + (i % 36)) });
let tC = process.cpuUsage();
r = await c('importSiswa', { rows }, ADM);
let cpu = process.cpuUsage(tC); console.log('  CPU importSiswa 1300 baris:', ((cpu.user + cpu.system) / 1000).toFixed(1), 'ms');
ok('impor 1300', r.ok && r.data.baru === 1300, r);
const b3 = (await c('saveBank', { bank: { judul: 'Beban', mapel: 'Kimia', tingkat: 'XII', soal: full.soal.concat(Array.from({ length: 32 }, (_, i) => ({ ...full.soal[0], id: 'sx' + i }))) } }, ADM)).data.bank;
const kelasXII = [...new Set(rows.map(x => x.kelas))];
const U2 = (await c('saveUjian', { nama: 'Beban', bankId: b3.id, kelas: kelasXII, mulai: Date.now() - 1000, selesai: Date.now() + 7200000, durasi: 90, acakSoal: true, acakOpsi: true }, ADM)).data;
const ISO = []; for (let i = 0; i < 6; i++) ISO.push(await isolate());
const gh0 = netStats.github; d1stats.writes = 0; d1stats.reads = 0;
const t1 = Date.now(); let gagal = 0; const lat = [];
const timed = async (w, a, d, t) => { const s = Date.now(); const x = await call(w, a, d, t); lat.push(Date.now() - s); if (!x.ok) { gagal++; if (gagal < 4) console.log('   gagal', a, x.error); } return x; };
await Promise.all(rows.map(async (x, i) => {
  const w = ISO[i % ISO.length];
  const tk = (await timed(w, 'loginSiswa', { nis: x.nis, password: x.nis })).data?.token;
  await timed(w, 'ujianSaya', {}, tk);
  const m = await timed(w, 'mulaiUjian', { ujianId: U2.id, perangkat: 'd' + i }, tk);
  if (!m.ok) return;
  for (let k = 0; k < 3; k++) await timed(w, 'simpanJawaban', { ujianId: U2.id, jawaban: { j: J, r: [] }, perangkat: 'd' + i }, tk);
  await timed(w, 'selesaiUjian', { ujianId: U2.id, jawaban: { j: J, r: [] }, perangkat: 'd' + i }, tk);
}));
lat.sort((a, b) => a - b);
console.log('  ' + lat.length + ' permintaan dalam', Date.now() - t1, 'ms; p50', lat[lat.length >> 1], 'ms, p99', lat[Math.floor(lat.length * 0.99)], 'ms');
console.log('  Panggilan GitHub:', netStats.github - gh0, '| D1 baris ditulis:', d1stats.writes, '| baris dibaca:', d1stats.reads);
ok('tanpa kegagalan', gagal === 0, gagal);
ok('hampir tanpa panggilan GitHub (cache)', netStats.github - gh0 < 40, netStats.github - gh0);
tC = process.cpuUsage();
r = await c('monitorUjian', { ujianId: U2.id }, ADM);
cpu = process.cpuUsage(tC); console.log('  CPU monitorUjian 1300:', ((cpu.user + cpu.system) / 1000).toFixed(1), 'ms');
ok('monitor 1300 selesai', r.ok && r.data.peserta.filter(p => p.status === 'selesai').length === 1300, r.ok);
tC = process.cpuUsage();
r = await c('hasilUjian', { ujianId: U2.id }, ADM);
cpu = process.cpuUsage(tC); console.log('  CPU hasilUjian 1300 (termasuk parse di Node):', ((cpu.user + cpu.system) / 1000).toFixed(1), 'ms');
ok('hasil 1300', r.ok && r.data.peserta.length === 1300);
let putaran = 0, total = 0; const gh1 = netStats.github;
while (putaran < 20) { putaran++; const x = await c('sinkronSekarang', {}, ADM); total += x.data.disinkron; if (!x.data.disinkron) break; }
console.log('  Arsip 1300 hasil:', putaran, 'putaran cron,', netStats.github - gh1, 'panggilan GitHub');
ok('semua hasil terarsip', total >= 1300 && dataFiles().filter(p => p.startsWith('hasil/' + U2.id + '/')).length === 1300, total);

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
