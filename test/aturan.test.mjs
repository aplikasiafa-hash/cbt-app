// Uji aturan v2.4.0-CBT: jadwal hari ini, bank guru terkunci untuk admin, nilai hanya untuk guru pemilik,
// monitor tanpa nilai, kolom password Excel, mapel guru sesuai pilihan admin, versi.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const call = async (a, d = {}, t = '') => (await fetch(BASE + '/api?a=' + a, { method: 'POST', body: JSON.stringify({ action: a, data: d, token: t }) })).json();
let fails = 0; const ok = (n, c, i) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(i).slice(0, 400))); if (!c) fails++; };
const ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;

console.log('Versi');
ok('versi 2.4.0-CBT', (await call('ping')).data.versi === '2.4.0-CBT');

console.log('Akun guru & mata pelajaran');
let r = await call('saveGuru', { username: 'bu_sri', nama: 'Bu Sri', password: 'sri12345', role: 'guru', mapel: ['Biologi', 'Kimia'] }, ADM);
ok('admin membuat guru dengan mapel Biologi & Kimia', r.ok, r);
const GS = (await call('loginGuru', { username: 'bu_sri', password: 'sri12345' })).data.token;
r = await call('profilSaya', {}, GS); ok('profil guru: mapel sesuai pilihan admin', JSON.stringify(r.data.mapel) === '["Biologi","Kimia"]', r);
r = await call('saveBank', { bank: { judul: 'Bank Bu Sri', mapel: 'Sejarah', tingkat: 'X', soal: [{ tipe: 'pg', teks: 'Sel?', bobot: 1, opsi: [{ teks: 'a' }, { teks: 'b' }], kunci: '' }] } }, GS);
ok('bank baru guru dengan mapel di luar pilihan → dipakai mapel pertama (Biologi)', r.ok && r.data.bank.mapel === 'Biologi', r);
const bank = r.data.bank; bank.soal[0].kunci = bank.soal[0].opsi[0].id;
r = await call('saveBank', { bank: { ...bank, mapel: 'Kimia' } }, GS); ok('guru mengganti mapel ke Kimia (diizinkan)', r.ok && r.data.bank.mapel === 'Kimia', r);
r = await call('saveBank', { bank: { ...bank, mapel: 'Sejarah' } }, GS); ok('guru mengganti mapel ke Sejarah ditolak', !r.ok, r);
r = await call('saveBank', { bank: { ...bank, mapel: 'Kimia' } }, GS);

console.log('Bank soal milik guru terkunci untuk admin');
r = await call('saveBank', { bank: { ...bank, judul: 'Diubah admin' } }, ADM); ok('admin tidak bisa mengubah bank milik guru', !r.ok && /tidak bisa diubah oleh admin/.test(r.error), r);
r = await call('deleteBank', { id: bank.id }, ADM); ok('admin tidak bisa menghapus bank milik guru', !r.ok && /tidak bisa dihapus oleh admin/.test(r.error), r);
r = await call('saveBank', { bank: { judul: 'Bank milik admin', mapel: 'Fisika', tingkat: 'X', soal: [] } }, ADM); ok('admin tetap bisa membuat & mengubah bank miliknya sendiri', r.ok, r);
r = await call('saveBank', { bank: { ...r.data.bank, judul: 'Bank milik admin (ubah)' } }, ADM); ok('…dan mengubahnya', r.ok, r);

console.log('Jadwal siswa hanya hari ini (WITA)');
const t0 = Date.now(), HARI = 86400000;
const jadwal = async (nama, mulai, selesai) => (await call('saveUjian', { nama, bankId: bank.id, kelas: ['X-1'], mulai, selesai, durasi: 30, acakSoal: false, acakOpsi: false, tampilNilai: true, pakaiToken: false }, ADM)).data;
const zona = 8 * 3600000, awal = Math.floor((t0 + zona) / HARI) * HARI - zona;
const Ukemarin = await jadwal('Kemarin', awal - HARI + 3600000, awal - HARI + 7200000);
const Ubesok = await jadwal('Besok', awal + HARI + 3600000, awal + HARI + 7200000);
const Uhari = await jadwal('Hari ini', t0 - 60000, t0 + 3 * 3600000);
const Upagi = await jadwal('Tadi pagi (sudah lewat)', Math.max(awal, t0 - 3 * 3600000), Math.max(awal + 60000, t0 - 2 * 3600000));
const S1 = (await call('loginSiswa', { nis: '1001', password: '1001' })).data.token;
r = await call('ujianSaya', {}, S1);
const nama = r.data.map(u => u.nama);
ok('siswa melihat jadwal hari ini: ' + nama.join(', '), nama.includes('Hari ini') && nama.includes('Tadi pagi (sudah lewat)') && !nama.includes('Kemarin') && !nama.includes('Besok'), nama);

console.log('Nilai hanya untuk guru pemilik soal; monitor tanpa nilai');
const m = (await call('mulaiUjian', { ujianId: Uhari.id, perangkat: 'hp1' }, S1)).data;
r = await call('selesaiUjian', { ujianId: Uhari.id, jawaban: { j: { [m.soal[0].id]: bank.soal[0].kunci }, r: [] }, perangkat: 'hp1', mulai: m.mulai }, S1);
ok('siswa selesai (nilai 100 terlihat siswa karena tampilNilai)', r.ok && r.data.nilai === 100, r);
r = await call('hasilUjian', { ujianId: Uhari.id }, ADM);
const pa = r.data.peserta.find(p => p.nis === '1001');
ok('admin: hasil tanpa nilai, jawaban, kunci & analisis', r.data.lihatNilai === false && pa.status === 'selesai' && pa.hasil === undefined && pa.jawaban === undefined && r.data.bank.soal.length === 0, r.data);
r = await call('hasilUjian', { ujianId: Uhari.id }, GS);
ok('guru pemilik soal: melihat nilai', r.data.lihatNilai === true && r.data.peserta.find(p => p.nis === '1001').hasil.nilai === 100, r.data.peserta);
r = await call('koreksi', { ujianId: Uhari.id, nis: '1001', skor: {} }, ADM); ok('admin tidak bisa koreksi', !r.ok && /guru pemilik soal/.test(r.error), r);
r = await call('hitungUlang', { ujianId: Uhari.id }, ADM); ok('admin tidak bisa hitung ulang', !r.ok && /guru pemilik soal/.test(r.error), r);
r = await call('monitorUjian', { ujianId: Uhari.id }, ADM);
ok('monitor tanpa nilai', r.data.peserta.every(p => p.nilai === undefined) && r.data.peserta.find(p => p.nis === '1001').status === 'selesai', r.data.peserta);

console.log('Kolom password untuk Excel');
r = await call('saveSiswa', { nis: '5001', nama: 'Tanpa Sandi', kelas: 'X-1', password: '' }, ADM); ok('tambah siswa tanpa kata sandi', r.ok, r);
r = await call('saveSiswa', { nis: '5002', nama: 'Dengan Sandi', kelas: 'X-1', password: 'rahasia9' }, ADM); ok('tambah siswa dengan kata sandi', r.ok, r);
r = await call('saveSiswa', { nis: '5003', nama: 'Ganti Sendiri', kelas: 'X-1', password: 'awal1234' }, ADM);
const S3 = (await call('loginSiswa', { nis: '5003', password: 'awal1234' })).data.token;
r = await call('gantiPassword', { lama: 'awal1234', baru: 'pribadi99' }, S3); ok('siswa mengganti kata sandinya sendiri', r.ok, r);
r = await call('saveSiswa', { nis: '5001', nama: 'Tanpa Sandi (ubah nama)', kelas: 'X-1', password: '', nisLama: '5001' }, ADM);
r = await call('importSiswa', { rows: [{ nis: '6001', nama: 'Impor A', kelas: 'X-2', password: 'imporA1' }, { nis: '6002', nama: 'Impor B', kelas: 'X-2', password: '' }, { nis: '5002', nama: 'Dengan Sandi', kelas: 'X-1', password: '(diganti sendiri oleh siswa)' }] }, ADM);
ok('impor: kolom password dibaca, keterangan "(…)" diabaikan', r.ok, r);
r = await call('sandiSiswa', {}, ADM);
const sd = r.data;
ok('kosong → sama dengan NIS', sd['5001'] === '5001' && sd['6002'] === '6002' && sd['1002'] === '1002', sd);
ok('diisi admin → isinya tampil', sd['5002'] === 'rahasia9' && sd['6001'] === 'imporA1', sd);
ok('diganti sendiri → keterangan', /diganti sendiri/.test(sd['5003']), sd['5003']);
ok('siswa bisa login dengan sandi yang tampil', (await call('loginSiswa', { nis: '5002', password: sd['5002'] })).ok && (await call('loginSiswa', { nis: '6001', password: sd['6001'] })).ok);
r = await call('sandiSiswa', {}, GS); ok('guru tidak bisa mengunduh sandi siswa', !r.ok, r);
r = await call('saveGuru', { username: 'pak_tono', nama: 'Pak Tono', password: 'tono2026', role: 'guru', mapel: ['Fisika'] }, ADM);
r = await call('sandiGuru', {}, ADM);
const guruList = (await call('listGuru', {}, ADM)).data, idDari = u => guruList.find(g => g.username === u).id;
ok('sandi guru dari admin tampil', r.data[idDari('pak_tono')] === 'tono2026' && r.data[idDari('bu_sri')] === 'sri12345', r.data);
await call('gantiPassword', { lama: 'sri12345', baru: 'sriBaru99' }, GS);
r = await call('sandiGuru', {}, ADM);
ok('guru mengganti sendiri → keterangan', /diganti sendiri oleh guru/.test(r.data[idDari('bu_sri')]), r.data);
ok('akun lama (sebelum fitur ini) → tidak diketahui', /tidak diketahui/.test(r.data[idDari('admin')]), r.data);
ok('daftar guru tidak membocorkan sandi', !JSON.stringify(guruList).includes('sandi') && !JSON.stringify(guruList).includes('hash'));

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
