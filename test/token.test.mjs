// Uji 2.15: token ujian (satu untuk semua ujian, manual/otomatis, hanya admin), kunci perangkat saat login,
// batas waktu tombol kirim jawaban, dan jadwal perawatan 00.00 WITA.
// Jalankan wrangler dev dengan --var DEV_MODE:1 --var MIN_KIRIM_DETIK:20
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let fails = 0;
const ok = (name, cond, info) => { if (cond) console.log('  ✓', name); else { fails++; console.log('  ✗', name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ''); } };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
const dev = d => call('_dev', d);
const MENIT = 60000;

await dev({ offset: 0 });
const ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
const GURU = (await call('loginGuru', { username: 'guru', password: 'guru123' })).data.token;   // gcontoh
let r;

console.log('Token otomatis butuh ujian hari ini');
r = await call('aturTokenUjian', { mode: 'otomatis', menit: 5 }, ADM);
ok('tanpa ujian hari ini: token otomatis ditolak', !r.ok && /ujian hari ini/.test(r.error), r);
r = await call('aturTokenUjian', { mode: 'otomatis', menit: 0 }, ADM);
ok('menit di luar 1–120 ditolak', !r.ok, r);

console.log('Siapkan ujian');
await call('importSiswa', { rows: [1, 2, 3, 4, 5].map(i => ({ nis: '810' + i, nama: 'Siswa ' + i, kelas: 'X-1' })) }, ADM);
r = await call('saveBank', { bank: { judul: 'Token', mapel: 'Matematika', tingkat: 'X', soal: [{ tipe: 'pg', teks: '1+1?', bobot: 1, opsi: [{ teks: '2' }, { teks: '3' }], kunci: '' }] } }, ADM);
const bank = r.data.bank; bank.soal[0].kunci = bank.soal[0].opsi[0].id; await call('saveBank', { bank }, ADM);
const t0 = Date.now();
r = await call('saveUjian', { nama: 'Uji token', bankId: bank.id, kelas: ['X-1'], mulai: t0 - MENIT, selesai: t0 + 20 * MENIT, durasi: 15, pakaiToken: true, pengawas: [{ id: 'gcontoh', kelas: [] }] }, ADM);
ok('jadwal tersimpan tanpa token per jadwal', r.ok && r.data.token === '' && r.data.pakaiToken === false, r);
const U = r.data;
const lg = async (nis, perangkat) => call('loginSiswa', { nis, password: nis, perangkat });
const S = {};
for (const i of [1, 2, 3, 4, 5]) S[i] = (await lg('810' + i, 'hp' + i)).data.token;

console.log('Token otomatis');
r = await call('aturTokenUjian', { mode: 'otomatis', menit: 5 }, GURU);
ok('guru/pengawas tidak bisa mengaktifkan token', !r.ok, r);
r = await call('aturTokenUjian', { mode: 'otomatis', menit: 5 }, ADM);
ok('admin mengaktifkan token otomatis 5 menit', r.ok && r.data.mode === 'otomatis' && /^[A-Z2-9]{6}$/.test(r.data.nilai) && r.data.berikutnya - r.data.serverTime <= 5 * MENIT, r);
const T1 = r.data.nilai;
r = await call('tokenUjian', {}, GURU);
ok('pengawas melihat token yang sama (muat ulang)', r.ok && r.data.nilai === T1 && r.data.mode === 'otomatis', r);
r = await call('ujianSaya', {}, S[1]);
ok('siswa: ujian butuh token, nilai token tidak dikirim', r.ok && r.data[0].pakaiToken === true && !JSON.stringify(r.data).includes(T1), r);
r = await call('mulaiUjian', { ujianId: U.id, perangkat: 'hp1' }, S[1]);
ok('tanpa token ditolak', !r.ok && r.code === 'TOKEN', r);
r = await call('mulaiUjian', { ujianId: U.id, token: T1.toLowerCase(), perangkat: 'hp1' }, S[1]);
ok('token benar → mulai', r.ok && r.data.soal.length === 1, r);
ok('kirimSetelah = mulai + 20 detik (uji)', r.ok && r.data.kirimSetelah === r.data.mulai + 20000, r.data && [r.data.mulai, r.data.kirimSetelah]);
const M1 = r.data;

console.log('Token berganti sendiri');
await dev({ offset: 5 * MENIT + 10000 });
r = await call('tokenUjian', {}, ADM);
const T2 = r.data.nilai;
ok('5 menit kemudian token sudah berganti', r.ok && T2 && T2 !== T1, [T1, r.data]);
r = await call('mulaiUjian', { ujianId: U.id, token: T1, perangkat: 'hp2' }, S[2]);
ok('token lama masih diterima ±2 menit setelah berganti', r.ok, r);
await dev({ offset: 8 * MENIT });
r = await call('mulaiUjian', { ujianId: U.id, token: T1, perangkat: 'hp3' }, S[3]);
ok('token lama ditolak setelah masa tenggang', !r.ok && r.code === 'TOKEN', r);
r = await call('mulaiUjian', { ujianId: U.id, token: T2, perangkat: 'hp3' }, S[3]);
ok('token baru diterima', r.ok, r);
r = await call('mulaiUjian', { ujianId: U.id, perangkat: 'hp1' }, S[1]);
ok('melanjutkan ujian (muat ulang) tidak perlu token', r.ok && r.data.mulai === M1.mulai, r);

console.log('Satu akun tidak bisa masuk di HP lain selama ujian');
r = await lg('8101', 'hpLain');
ok('login di perangkat lain ditolak selama mengerjakan', !r.ok && r.code === 'PERANGKAT', r);
r = await lg('8101', 'hp1');
ok('login lagi di perangkat yang sama boleh', r.ok, r);
r = await lg('8104', 'hpLain');
ok('siswa yang belum mulai bebas login di mana saja', r.ok, r);
r = await call('resetLogin', { ujianId: U.id, nis: '8103' }, GURU);
ok('pengawas reset login', r.ok, r);
r = await lg('8103', 'hpBaru');
ok('setelah reset login → bisa masuk di HP lain', r.ok, r);
const S3b = r.data.token;
r = await call('mulaiUjian', { ujianId: U.id, perangkat: 'hpBaru' }, S3b);
ok('lalu melanjutkan ujian di HP baru (tanpa token)', r.ok, r);

console.log('Tombol kirim jawaban baru aktif setelah batas waktu');
await dev({ offset: 0 });
r = await call('mulaiUjian', { ujianId: U.id, token: (await call('tokenUjian', {}, ADM)).data.nilai, perangkat: 'hp5' }, S[5]);
ok('siswa 5 mulai', r.ok, r);
const M5 = r.data;
r = await call('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'hp5', mulai: M5.mulai }, S[5]);
ok('kirim sebelum batas waktu ditolak', !r.ok && r.code === 'BELUM_WAKTU' && /Tunggu/.test(r.error), r);
r = await call('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'hp5', mulai: M5.mulai, alasan: 'batas pelanggaran tercapai' }, S[5]);
ok('pengiriman otomatis (pelanggaran/waktu habis/darurat) tidak ditahan', r.ok && r.data.status === 'selesai', r);
await dev({ offset: 8 * MENIT + 30000 });
r = await call('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'hp1', mulai: M1.mulai }, S[1]);
ok('setelah batas waktu → kirim berhasil', r.ok && r.data.status === 'selesai', r);
r = await lg('8101', 'hpLain');
ok('sudah selesai → bebas login di HP lain', r.ok, r);

console.log('Waktu minimal sebelum selesai (1–30 menit, hanya admin)');
r = await call('waktuSelesai', {}, ADM); ok('bawaan 1 menit', r.ok && r.data.menit === 1, r);
r = await call('waktuSelesai', { menit: 45 }, ADM); ok('lebih dari 30 ditolak', !r.ok, r);
r = await call('waktuSelesai', { menit: 0 }, ADM); ok('kurang dari 1 ditolak', !r.ok, r);
r = await call('waktuSelesai', { menit: 10 }, GURU); ok('guru tidak bisa mengubah', !r.ok, r);
r = await call('waktuSelesai', { menit: 12 }, ADM); ok('admin mengatur 12 menit', r.ok && r.data.menit === 12, r);
const cfg = (await call('getConfig', {}, ADM)).data;
r = await call('saveConfig', { ...cfg, minKirimMenit: 3, namaSekolah: 'SMA Uji' }, ADM);
ok('simpan Pengaturan tidak menimpa waktu selesai', r.ok && r.data.minKirimMenit === 12 && (await call('waktuSelesai', {}, GURU)).data.menit === 12, r);
await call('waktuSelesai', { menit: 1 }, ADM);

console.log('Token otomatis berhenti setelah semua siswa keluar dari ujian');
await dev({ offset: 25 * MENIT });   // jadwal sudah ditutup, tetapi siswa 2 & 3 masih tercatat mengerjakan
r = await call('tokenUjian', {}, ADM);
ok('masih ada siswa mengerjakan → token tetap aktif', r.ok && r.data.mode === 'otomatis', r);
for (const nis of ['8102', '8103']) await call('paksaSelesai', { ujianId: U.id, nis }, ADM);
r = await call('tokenUjian', {}, ADM);
ok('semua siswa keluar → token otomatis mati sendiri', r.ok && r.data.mode === 'mati' && r.data.berhenti > 0 && !r.data.nilai, r);
r = await call('aturTokenUjian', { mode: 'otomatis', menit: 5 }, ADM);
ok('tidak bisa diaktifkan lagi tanpa ujian', !r.ok, r);
r = await call('aturTokenUjian', { mode: 'manual', nilai: '' }, ADM);
ok('token manual kosong → dibuat acak', r.ok && r.data.mode === 'manual' && /^[A-Z0-9]{4,8}$/.test(r.data.nilai), r);
await dev({ offset: 0 });

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
