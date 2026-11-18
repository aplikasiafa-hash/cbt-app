// Uji salinan data di penyimpanan mesin ujian: perubahan tetap benar setelah mesin tidur lalu bangun (restart),
// dan bangun tidak membaca D1. Dijalankan oleh test/bangun.sh (yang me-restart wrangler di antara tahap).
const BASE = 'http://127.0.0.1:8787', tahap = process.argv[2];
const call = async (a, d = {}, t = '') => (await fetch(BASE + '/api?a=' + a, { method: 'POST', body: JSON.stringify({ action: a, data: d, token: t }) })).json();
let fails = 0; const ok = (n, c, i) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(i).slice(0, 300))); if (!c) fails++; };
const A = async () => (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
if (tahap === '1') {
  const t = await A();
  let r = await call('saveGuru', { username: 'bu_ani', nama: 'Bu Ani', password: 'ani123', role: 'guru' }, t); ok('tambah guru', r.ok, r);
  r = await call('saveBank', { bank: { judul: 'Bank Uji Bangun', mapel: 'IPA', tingkat: 'X', soal: [{ tipe: 'pg', teks: 'x?', bobot: 1, opsi: [{ teks: 'a' }, { teks: 'b' }], kunci: '' }] } }, t); ok('tambah bank', r.ok, r);
  const t0 = Date.now();
  r = await call('saveUjian', { nama: 'Ujian Uji Bangun', bankId: 'bcontoh01', kelas: ['X-1'], mulai: t0, selesai: t0 + 3600000, durasi: 30, acakSoal: false, acakOpsi: false, tampilNilai: true, pakaiToken: false }, t); ok('tambah jadwal', r.ok, r);
  r = await call('saveUjian', { nama: 'Ujian Dihapus', bankId: 'bcontoh01', kelas: ['X-1'], mulai: t0, selesai: t0 + 3600000, durasi: 30, acakSoal: false, acakOpsi: false, tampilNilai: true, pakaiToken: false }, t);
  r = await call('deleteUjian', { id: r.data.id }, t); ok('hapus jadwal', r.ok, r);
  const c = (await call('getConfig', {}, t)).data;
  r = await call('saveConfig', { ...c, namaSekolah: 'SMA Uji Bangun' }, t); ok('ubah pengaturan', r.ok, r);
  r = await call('dashboard', {}, t); ok('Beranda: jumlah siswa ' + r.data.jumlahSiswa, r.data.jumlahSiswa === 3, r);
}
if (tahap === '2') {
  const u = (await call('_dev', { perKueri: true })).data;
  ok('bangun dari tidur: 0 baris D1 dibaca untuk data dasar', !Object.keys(u.kueri).some(k => /FROM (guru|bank|ujian|kv)\b/.test(k) && !/WHERE id = \?/.test(k)), u.kueri);
  const t = await A();
  const g = (await call('loginGuru', { username: 'bu_ani', password: 'ani123' })); ok('guru baru bisa login setelah bangun', g.ok, g);
  ok('bank baru masih ada', (await call('listBank', {}, t)).data.some(b => b.judul === 'Bank Uji Bangun'));
  const L = (await call('listUjian', {}, t)).data;
  ok('jadwal baru masih ada, yang dihapus hilang', L.some(x => x.nama === 'Ujian Uji Bangun') && !L.some(x => x.nama === 'Ujian Dihapus'), L.map(x => x.nama));
  ok('pengaturan tersimpan', (await call('getConfig', {}, t)).data.namaSekolah === 'SMA Uji Bangun');
  const d = (await call('dashboard', {}, t)).data; ok('Beranda: jumlah siswa dari simpanan (tanpa COUNT)', d.jumlahSiswa === 3, d);
  const k = (await call('_dev', { perKueri: true })).data.kueri;
  ok('tidak ada COUNT(*) siswa', !Object.keys(k).some(x => /COUNT\(\*\) AS n FROM siswa/.test(x)), k);
  let r = await call('gantiPassword', { lama: 'ani123', baru: 'ani456' }, g.data.token); ok('guru ganti kata sandi', r.ok, r);
  r = await call('saveSiswa', { nis: '1009', nama: 'Siswa Baru', kelas: 'X-1', password: '1009' }, t); ok('tambah siswa', r.ok, r);
}
if (tahap === '3') {
  ok('kata sandi baru berlaku setelah bangun', (await call('loginGuru', { username: 'bu_ani', password: 'ani456' })).ok);
  ok('kata sandi lama ditolak', !(await call('loginGuru', { username: 'bu_ani', password: 'ani123' })).ok);
  const t = await A();
  ok('Beranda: jumlah siswa diperbarui setelah tambah siswa', (await call('dashboard', {}, t)).data.jumlahSiswa === 4);
  const r = await call('muatUlangData', {}, t); ok('Muat ulang data dari database', r.ok && r.data.guru >= 3, r);
}
console.log(fails ? `${fails} GAGAL` : 'LULUS'); process.exit(fails ? 1 : 0);
