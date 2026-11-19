// Uji v2.5.0-CBT: pengawas per jadwal (monitoring hanya kelas yang diawasi), jadwal guru hari ini, impor guru.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const call = async (a, d = {}, t = '') => (await fetch(BASE + '/api?a=' + a, { method: 'POST', body: JSON.stringify({ action: a, data: d, token: t }) })).json();
let fails = 0; const ok = (n, c, i) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(i).slice(0, 500))); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sok() {
  const ws = new WebSocket(WSB + '/api/ws?r=1'), inbox = [], waiters = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); inbox.push(m); waiters.splice(0).forEach(w => w()); });
  ws.tunggu = async (pred, ms = 5000) => { const t0 = Date.now(); for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() - t0 > ms) return null; await new Promise(r => { waiters.push(r); setTimeout(r, 100); }); } };
  ws.terbuka = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.kirimJ = o => ws.send(JSON.stringify(o));
  ws.inbox = inbox;
  return ws;
}
const ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
const admin = (await call('profilSaya', {}, ADM)).data;

console.log('Versi');
ok('versi 2.10.0-CBT', (await call('ping')).data.versi === '2.10.0-CBT');

console.log('Impor guru dari Excel');
let r = await call('importGuru', { rows: [
  { username: 'Pengawas.A', nama: 'Pak Andi', mapel: 'kimia, Biologi', password: '', peran: 'Guru', status: 'Aktif' },
  { username: 'pengawas.b', nama: 'Bu Budi', mapel: 'Fisika', password: 'budi9999', peran: '', status: '' },
  { username: 'pemilik', nama: 'Bu Pemilik', mapel: 'Kimia', password: 'pemilik1', peran: 'Guru', status: 'Aktif' },
  { username: 'nonaktif.x', nama: 'Pak Nonaktif', mapel: '', password: 'xxxxxxx1', peran: 'Guru', status: 'Nonaktif' },
  { username: 'x', nama: 'Terlalu pendek', mapel: '', password: '' },
  { username: 'admin', nama: 'Administrator', mapel: '', password: '', peran: 'Guru', status: 'Nonaktif' }
] }, ADM);
ok('4 guru baru, 1 diperbarui, 1 baris dilewati', r.ok && r.data.baru === 4 && r.data.ubah === 1 && r.data.lewati.join() === '5', r);
let guru = (await call('listGuru', {}, ADM)).data;
const gA = guru.find(g => g.username === 'pengawas.a'), gB = guru.find(g => g.username === 'pengawas.b'), gP = guru.find(g => g.username === 'pemilik');
ok('nama pengguna dijadikan huruf kecil, mapel mengikuti ejaan Pengaturan', gA && JSON.stringify(gA.mapel) === '["Kimia","Biologi"]', gA);
ok('peran & status kosong untuk guru baru → Guru, Aktif', gB && gB.role === 'guru' && gB.aktif, gB);
ok('status Nonaktif terbaca', guru.find(g => g.username === 'nonaktif.x').aktif === false);
ok('akun admin sendiri tetap Admin & aktif', guru.find(g => g.id === admin.id).role === 'admin' && guru.find(g => g.id === admin.id).aktif, guru.find(g => g.id === admin.id));
ok('admin tetap bisa masuk dengan sandi lama', (await call('loginGuru', { username: 'admin', password: 'admin123' })).ok);
r = await call('loginGuru', { username: 'pengawas.a', password: 'pengawas.a' }); ok('password kosong → sama dengan nama pengguna', r.ok, r);
const GA = r.data.token;
const GB = (await call('loginGuru', { username: 'pengawas.b', password: 'budi9999' })).data.token;
const GP = (await call('loginGuru', { username: 'pemilik', password: 'pemilik1' })).data.token;
r = await call('sandiGuru', {}, ADM);
ok('Excel guru menampilkan password hasil impor', r.data[gA.id] === 'pengawas.a' && r.data[gB.id] === 'budi9999', r.data);
r = await call('importGuru', { rows: [{ username: 'pengawas.b', nama: 'Bu Budiarti', mapel: '', password: '(diganti sendiri oleh guru)', peran: '', status: '' }] }, ADM);
guru = (await call('listGuru', {}, ADM)).data;
ok('impor ulang: sel kosong tidak mengubah mapel/peran, keterangan password diabaikan', r.ok && r.data.ubah === 1 && guru.find(g => g.id === gB.id).nama === 'Bu Budiarti' && guru.find(g => g.id === gB.id).mapel.join() === 'Fisika' && (await call('loginGuru', { username: 'pengawas.b', password: 'budi9999' })).ok, guru.find(g => g.id === gB.id));
r = await call('importGuru', { rows: [{ username: 'zzz', nama: 'Z' }] }, GA); ok('guru biasa tidak bisa impor', !r.ok, r);

console.log('Jadwal dengan pengawas');
for (const [nis, kelas] of [['7001', 'X-1'], ['7002', 'X-1'], ['7003', 'X-2']]) await call('saveSiswa', { nis, nama: 'Siswa ' + nis, kelas, password: '' }, ADM);
r = await call('saveBank', { bank: { judul: 'Kimia Pengawas', mapel: 'Kimia', tingkat: 'X', soal: [{ tipe: 'pg', teks: '1+1?', bobot: 1, opsi: [{ teks: '2' }, { teks: '3' }], kunci: '' }] } }, GP);
const bank = r.data.bank; bank.soal[0].kunci = bank.soal[0].opsi[0].id; await call('saveBank', { bank }, GP);
const t0 = Date.now();
r = await call('saveUjian', { nama: 'PAS Kimia X', bankId: bank.id, kelas: ['X-1', 'X-2'], mulai: t0 - 60000, selesai: t0 + 3 * 3600000, durasi: 60, pakaiToken: true,
  pengawas: [{ id: gA.id, kelas: ['X-1'] }, { id: gB.id, kelas: ['X-1', 'X-2'] }, { id: gA.id, kelas: [] }, { id: 'tidak-ada', kelas: [] }] }, ADM);
const U = r.data;
ok('pengawas tersimpan: A (X-1), B (semua kelas → []), duplikat & id asing dibuang',
  r.ok && U.pengawas.length === 2 && U.pengawas[0].id === gA.id && U.pengawas[0].kelas.join() === 'X-1' && U.pengawas[0].nama === 'Pak Andi' && U.pengawas[1].kelas.length === 0, U.pengawas);
const Ubesok = (await call('saveUjian', { nama: 'Besok', bankId: bank.id, kelas: ['X-1'], mulai: t0 + 86400000 * 2, selesai: t0 + 86400000 * 2 + 3600000, durasi: 30, pengawas: [{ id: gA.id, kelas: [] }] }, ADM)).data;
const Ulain = (await call('saveUjian', { nama: 'Ujian lain hari ini', bankId: bank.id, kelas: ['X-2'], mulai: t0 - 60000, selesai: t0 + 3600000, durasi: 30, pakaiToken: true, pengawas: [{ id: gB.id, kelas: [] }] }, ADM)).data;
r = await call('listUjian', {}, ADM);
ok('admin: kolom pengawas di semua jadwal', r.data.find(u => u.id === U.id).pengawas.map(p => p.nama).join() === 'Pak Andi,Bu Budiarti', r.data.find(u => u.id === U.id).pengawas);

console.log('Jadwal guru = ujian hari ini');
r = await call('listUjian', { untuk: 'jadwal' }, GA);
const namaJ = r.data.map(u => u.nama);
ok('guru melihat semua ujian hari ini, tanpa jadwal hari lain', namaJ.includes('PAS Kimia X') && namaJ.includes('Ujian lain hari ini') && !namaJ.includes('Besok'), namaJ);
ok('token hanya untuk ujian yang ia awasi', r.data.find(u => u.id === U.id).token === U.token && r.data.find(u => u.id === Ulain.id).token === '', r.data.map(u => [u.nama, u.token]));
ok('kelas yang ia awasi ditandai', r.data.find(u => u.id === U.id).awasi.join() === 'X-1', r.data.find(u => u.id === U.id));

console.log('Monitoring = kelas yang diawasi (bukan mapel)');
r = await call('listUjian', { untuk: 'monitor' }, GA);
ok('daftar monitoring A: hanya ujian berlangsung yang ia awasi (jadwal besok tidak tampil)', r.data.map(u => u.nama).join() === 'PAS Kimia X', r.data.map(u => u.nama));
r = await call('listUjian', { untuk: 'monitor' }, GP);
ok('guru pemilik soal yang bukan pengawas: daftar monitoring kosong', r.data.length === 0, r.data);
r = await call('listUjian', { untuk: 'hasil' }, GP);
ok('guru pemilik soal: daftar hasil berisi ujiannya', r.data.some(u => u.id === U.id), r.data);
r = await call('monitorUjian', { ujianId: U.id }, GA);
ok('A hanya melihat siswa X-1', r.ok && r.data.peserta.length > 0 && r.data.peserta.every(p => p.kelas === 'X-1') && r.data.ujian.kelas.join() === 'X-1' && !r.data.semuaKelas && !r.data.pemilik, r.data);
r = await call('monitorUjian', { ujianId: U.id }, GB);
ok('B melihat X-1 dan X-2', r.ok && r.data.peserta.some(p => p.kelas === 'X-1') && r.data.peserta.some(p => p.kelas === 'X-2'), r.data && r.data.peserta);
r = await call('monitorUjian', { ujianId: U.id }, GP); ok('pemilik soal (bukan pengawas) tidak bisa memantau', !r.ok && /bukan pengawas/.test(r.error), r);
r = await call('monitorUjian', { ujianId: Ulain.id }, GA); ok('A tidak bisa memantau ujian yang tidak ia awasi', !r.ok, r);
r = await call('monitorUjian', { ujianId: U.id }, ADM); ok('admin melihat semua kelas', r.data.semuaKelas && r.data.peserta.some(p => p.kelas === 'X-2'), r.data);
r = await call('hasilUjian', { ujianId: U.id }, GA); ok('pengawas tidak membuka hasil/nilai', !r.ok, r);
r = await call('hasilUjian', { ujianId: U.id }, GP); ok('pemilik soal tetap melihat hasil & nilai', r.ok && r.data.lihatNilai, r);

console.log('Aksi pengawas dibatasi kelasnya');
const S1 = (await call('loginSiswa', { nis: '7001', password: '7001' })).data.token;
const S3 = (await call('loginSiswa', { nis: '7003', password: '7003' })).data.token;
const mA = sok(); await mA.terbuka; mA.kirimJ({ t: 'pantau', tok: GA, m: U.id });
const snap = await mA.tunggu(m => m.t === 'snap');
ok('soket monitor A: snapshot hanya X-1', snap && snap.data.peserta.every(p => p.kelas === 'X-1'), snap);
await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'h3' }, S3);
await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'h1' }, S1);
const diff = await mA.tunggu(m => m.t === 'diff', 8000);
ok('perubahan status yang dikirim ke A hanya siswa X-1', diff && diff.rows.length && diff.rows.every(x => x.kelas === 'X-1') && diff.rows.some(x => x.nis === '7001'), diff);
r = await call('paksaSelesai', { ujianId: U.id, nis: '7003' }, GA); ok('A tidak bisa menghentikan siswa X-2', !r.ok && /kelas yang Anda awasi/.test(r.error), r);
r = await call('resetLogin', { ujianId: U.id, nis: '7001' }, GA); ok('A bisa reset login siswa X-1', r.ok, r);
r = await call('paksaSelesai', { ujianId: U.id, nis: '7003' }, GB); ok('B bisa menghentikan siswa X-2', r.ok, r);
r = await call('gantiTokenUjian', { id: U.id }, GA); ok('pengawas bisa mengganti token', r.ok && r.data.length === 6, r);
r = await call('gantiTokenUjian', { id: U.id }, GP); ok('pemilik soal (bukan pengawas) tidak bisa mengganti token', !r.ok, r);

console.log('Admin mengubah pengawas saat monitor terbuka');
r = await call('saveUjian', { ...U, pengawas: [{ id: gB.id, kelas: [] }] }, ADM);
const putus = await mA.tunggu(m => m.t === 'err' && m.k === 'pantau', 5000);
ok('monitor A ditutup: bukan pengawas lagi', r.ok && putus && /tidak lagi menjadi pengawas/.test(putus.msg), [r, putus]);
r = await call('monitorUjian', { ujianId: U.id }, GA); ok('A tidak lagi bisa memantau', !r.ok, r);
mA.close();

console.log('Pilihan pengawas: tanpa admin, tanpa bentrok mapel sama tingkat lain');
r = await call('saveBank', { bank: { judul: 'Kimia XI', mapel: 'Kimia', tingkat: 'XI', soal: [{ tipe: 'pg', teks: 'a?', bobot: 1, opsi: [{ teks: 'a' }, { teks: 'b' }], kunci: '' }] } }, GP);
const bankXI = r.data.bank; bankXI.soal[0].kunci = bankXI.soal[0].opsi[0].id; await call('saveBank', { bank: bankXI }, GP);
r = await call('saveUjian', { nama: 'Kimia XI', bankId: bankXI.id, kelas: ['XI-1'], mulai: t0 + 3600000, selesai: t0 + 7200000, durasi: 30, pengawas: [{ id: gB.id, kelas: [] }] }, ADM);
ok('guru yang sudah mengawasi Kimia X ditolak untuk Kimia XI', !r.ok && /sudah menjadi pengawas Kimia tingkat X/.test(r.error), r);
r = await call('saveUjian', { nama: 'Kimia XI', bankId: bankXI.id, kelas: ['XI-1'], mulai: t0 + 3600000, selesai: t0 + 7200000, durasi: 30, pengawas: [{ id: gP.id, kelas: [] }, { id: admin.id, kelas: [] }] }, ADM);
ok('guru lain diterima; akun admin tidak ikut jadi pengawas', r.ok && r.data.pengawas.length === 1 && r.data.pengawas[0].id === gP.id, r);
const UXI = r.data;
r = await call('saveUjian', { nama: 'Kimia X susulan', bankId: bank.id, kelas: ['X-1'], mulai: t0 + 3600000, selesai: t0 + 7200000, durasi: 30, pengawas: [{ id: gB.id, kelas: [] }] }, ADM);
ok('mapel sama dan tingkat sama tetap boleh', r.ok, r);
const Ususulan = r.data;
r = await call('saveUjian', { ...UXI, nama: 'Kimia XI (ubah)' }, ADM);
ok('mengubah jadwal yang pengawasnya sudah ada tidak ditolak', r.ok, r);
await call('deleteUjian', { id: UXI.id, paksa: true, hapusHasil: true }, ADM); await call('deleteUjian', { id: Ususulan.id, paksa: true, hapusHasil: true }, ADM);

console.log('Beranda guru');
r = await call('dashboard', {}, GB);
ok('beranda B: jumlah tugas mengawas & ujian yang diawasi', r.data.jumlahAwas === 2 && r.data.mendatang.map(u => u.nama).sort().join() === 'PAS Kimia X,Ujian lain hari ini', r.data);
r = await call('dashboard', {}, GP);
ok('beranda pemilik: jadwal dari bank soalnya tetap terhitung', r.data.jumlahUjian >= 3 && r.data.mendatang.length === 0, r.data);

await call('deleteUjian', { id: Ubesok.id, paksa: true, hapusHasil: true }, ADM);
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
