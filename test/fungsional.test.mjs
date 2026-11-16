// Uji fungsional backend Cloudflare (jalankan "npm run dev" dulu di terminal lain).
// node test/fungsional.test.mjs        (BASE=http://127.0.0.1:8787)
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
let fails = 0;
const ok = (name, cond, info) => { if (cond) console.log('  ✓', name); else { fails++; console.log('  ✗', name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ''); } };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dev = (offset, rawat) => call('_dev', { offset, rawat });

function wsBuka(q) {
  const ws = new WebSocket(WSB + '/api/ws?' + new URLSearchParams(q));
  const inbox = [], waiters = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); inbox.push(m); waiters.splice(0).forEach(w => w()); });
  ws.tunggu = async (pred, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) return null;
      await new Promise(r => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  ws.terbuka = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.tertutup = new Promise(res => ws.addEventListener('close', ev => res(ev)));
  ws.kirimJ = o => ws.send(JSON.stringify(o));
  return ws;
}

await dev(0);
console.log('Setup');
let r = await call('ping');
ok('ping', r.ok && r.data.namaSekolah, r);

console.log('Login');
r = await call('loginGuru', { username: 'admin', password: 'salah' });
ok('admin salah ditolak', !r.ok, r);
r = await call('loginGuru', { username: 'admin', password: 'admin123' });
ok('admin login', r.ok && r.data.user.role === 'admin', r);
const ADM = r.data.token;
r = await call('loginGuru', { username: 'guru', password: 'guru123' });
const GURU = r.data.token;
ok('guru login', r.ok && r.data.user.role === 'guru');
r = await call('listGuru', {}, GURU);
ok('guru tidak bisa listGuru', !r.ok);
r = await call('listGuru', {}, 'x.y');
ok('token palsu AUTH', !r.ok && r.code === 'AUTH', r);

console.log('Siswa & kelas');
r = await call('importSiswa', { rows: [{ nis: '0012', nama: 'Dewi Nol', kelas: 'X-1' }, { nis: '2001', nama: 'Eko', kelas: 'XI IPA 2', password: 'rahasia' }, { nis: '', nama: 'x', kelas: 'y' }] }, ADM);
ok('import', r.ok && r.data.baru === 2 && r.data.lewati.length === 1, r);
ok('kelas baru ditambahkan + tingkat ditebak', r.data.config && r.data.config.kelas.some(k => k.nama === 'XI IPA 2' && k.tingkat === 'XI'), r.data.config && r.data.config.kelas);
r = await call('listSiswa', {}, ADM);
ok('NIS nol di depan aman', r.data.some(s => s.nis === '0012'), r.data);
r = await call('loginSiswa', { nis: '2001', password: 'rahasia' });
ok('login siswa impor dgn sandi', r.ok, r);

console.log('Bank soal');
r = await call('listBank', {}, GURU);
ok('guru lihat bank miliknya', r.ok && r.data.length === 1, r);
const bankId = r.data[0].id;
r = await call('getBank', { id: bankId }, GURU);
const bank = r.data;
ok('getBank lengkap dgn kunci', bank.soal[0].kunci === 'ob1');
bank.soal.push({ tipe: 'pg', teks: 'Soal baru', bobot: 1, opsi: [{ teks: 'A' }, { teks: 'B' }], kunci: '' });
r = await call('saveBank', { bank }, GURU);
ok('saveBank', r.ok && r.data.bank.soal.length === 8 && r.data.bank.soal[7].id && r.data.bank.soal[7].opsi[0].id, r);
const b2 = r.data.bank; b2.soal[7].kunci = b2.soal[7].opsi[1].id;
r = await call('saveBank', { bank: b2 }, GURU);
r = await call('listBank', {}, GURU);
ok('index jumlahSoal 8', r.data.find(b => b.id === bankId).jumlahSoal === 8, r.data);
r = await call('saveBank', { bank: { judul: 'Bank Admin', mapel: 'Fisika', tingkat: 'XI', soal: [] } }, ADM);
const bankAdmin = r.data.bank.id;
r = await call('getBank', { id: bankAdmin }, GURU);
ok('guru tak bisa buka bank admin', !r.ok);

console.log('Upload gambar');
r = await call('uploadGambar', { data: 'data:image/png;base64,AAAA', tipe: 'image/png' }, GURU);
ok('tanpa MEDIA_REPO → pesan jelas', !r.ok && /MEDIA_REPO/.test(r.error), r);

console.log('Jadwal ujian');
const t0 = Date.now();
r = await call('saveUjian', { nama: 'PH Matematika', bankId, tingkat: 'X', kelas: ['X-1'], mulai: t0 - 60000, selesai: t0 + 3 * 3600000, durasi: 60, acakSoal: true, acakOpsi: true, tampilNilai: true, pakaiToken: true, maxPelanggaran: 3 }, ADM);
ok('saveUjian', r.ok && r.data.token.length === 6, r);
const U = r.data;
r = await call('saveUjian', { nama: 'x', bankId, kelas: ['X-1'], mulai: t0, selesai: t0 - 1, durasi: 60 }, ADM);
ok('validasi waktu', !r.ok);
r = await call('saveUjian', { nama: 'x', bankId, kelas: ['X-1'], mulai: t0, selesai: t0 + 1e6, durasi: 60 }, GURU);
ok('guru tak bisa jadwalkan', !r.ok);
r = await call('monitorUjian', { ujianId: U.id }, GURU);
ok('peserta tampil (X-1 = 3 siswa, semua belum)', r.ok && r.data.peserta.length === 3 && r.data.peserta.every(p => p.status === 'belum'), r.data && r.data.peserta);

console.log('Siswa mengerjakan (HTTP)');
r = await call('loginSiswa', { nis: '1001', password: '1001' });
ok('siswa login', r.ok, r);
const S1 = r.data.token;
r = await call('ujianSaya', {}, S1);
ok('ujianSaya tampil', r.ok && r.data.length === 1 && r.data[0].jadwal === 'berlangsung' && r.data[0].token === undefined && r.data[0].jumlahSoal === 8, r);
r = await call('mulaiUjian', { ujianId: U.id, token: 'SALAH', perangkat: 'devA' }, S1);
ok('token salah ditolak', !r.ok && r.code === 'TOKEN', r);
r = await call('mulaiUjian', { ujianId: U.id, token: U.token.toLowerCase(), perangkat: 'devA' }, S1);
ok('mulai', r.ok && r.data.soal.length === 8, r);
const soal = r.data.soal;
const bocor = JSON.stringify(soal);
ok('tidak ada kunci di payload', !/"kunci"|"benar"|"jawaban"|"idKanan"|"pasangan"|"rubrik"|"pembahasan"/.test(bocor), bocor.slice(0, 300));
const s1b = await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devA' }, S1);
ok('resume urutan sama', JSON.stringify(s1b.data.soal.map(s => s.id)) === JSON.stringify(soal.map(s => s.id)));
r = await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devB' }, S1);
ok('perangkat lain ditolak', !r.ok && r.code === 'PERANGKAT', r);

const full = (await call('getBank', { id: bankId }, GURU)).data;
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

console.log('WebSocket siswa + monitor langsung');
const mon = wsBuka({ t: ADM, m: U.id });
await mon.terbuka;
const snap = await mon.tunggu(m => m.t === 'snap');
ok('monitor: snapshot awal', snap && snap.data.peserta.length === 3 && snap.data.peserta.find(p => p.nis === '1001').status === 'mengerjakan', snap);
const wsB = wsBuka({ t: S1, u: U.id, p: 'devB' });
const eB = await wsB.tunggu(m => m.t === 'err');
ok('WS perangkat lain ditolak', eB && eB.code === 'PERANGKAT', eB);
const ws1 = wsBuka({ t: S1, u: U.id, p: 'devA' });
await ws1.terbuka;
const hai = await ws1.tunggu(m => m.t === 'hai');
ok('WS hai + deadline', hai && hai.deadline > Date.now(), hai);
ws1.kirimJ({ t: 'j', j: { j: J, r: [full.soal[0].id] }, p: 1, v: 7 });
const ack = await ws1.tunggu(m => m.t === 'ok');
ok('WS autosave di-ack', ack && ack.v === 7 && ack.status === 'mengerjakan', ack);
const diff = await mon.tunggu(m => m.t === 'diff' && m.rows.some(x => x.nis === '1001' && x.terjawab === 8), 9000);
const p1 = diff && diff.rows.find(x => x.nis === '1001');
ok('monitor diff: terjawab 8, ragu 1, pelanggaran 1, online', p1 && p1.terjawab === 8 && p1.ragu === 1 && p1.pelanggaran === 1 && p1.online, diff);
r = await call('monitorUjian', { ujianId: U.id }, ADM);
ok('monitor HTTP sama', r.data.peserta.find(p => p.nis === '1001').terjawab === 8);
ws1.kirimJ({ t: 'selesai', id: 'x1', j: { j: J, r: [] }, p: 1, a: '' });
const hs = await ws1.tunggu(m => m.t === 'hasil');
ok('WS selesai: nilai tanpa uraian', hs && hs.data.perluKoreksi === 1, hs);
const maks = full.soal.reduce((a, s) => a + s.bobot, 0);
ok('skor = maks - bobot uraian', hs && Math.abs(hs.data.nilai - Math.round((maks - 4) / maks * 10000) / 100) < 0.01, [hs && hs.data.nilai, maks]);
const tutup1 = await Promise.race([ws1.tertutup, sleep(6000).then(() => null)]);
ok('server menutup WS setelah selesai', !!tutup1);
r = await call('selesaiUjian', { ujianId: U.id, jawaban: { j: {}, r: [] }, perangkat: 'devA' }, S1);
ok('selesai idempoten (retry tidak menimpa)', r.ok && r.data.perluKoreksi === 1, r);
r = await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devA' }, S1);
ok('tidak bisa mulai lagi', !r.ok && r.code === 'SELESAI');
await sleep(2500);
r = await call('ujianSaya', {}, S1);
ok('ujianSaya: status selesai + nilai (dari D1)', r.ok && r.data[0].status === 'selesai' && r.data[0].nilai > 0, r);

// siswa 2 via HTTP: jawab sebagian salah
r = await call('loginSiswa', { nis: '0012', password: '0012' });
ok('login NIS 0012', r.ok, r);
const S2 = r.data.token;
r = await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devC' }, S2);
ok('siswa 0012 mulai', r.ok, r);
const pgk = full.soal.find(s => s.tipe === 'pgk');
const J2 = { [pgk.id]: [pgk.kunci[0], pgk.opsi.find(o => !pgk.kunci.includes(o.id)).id] };
r = await call('simpanJawaban', { ujianId: U.id, jawaban: { j: J2, r: [] }, perangkat: 'devC' }, S2);
ok('simpan HTTP', r.ok && r.data.status === 'mengerjakan', r);
r = await call('selesaiUjian', { ujianId: U.id, jawaban: { j: J2, r: [] }, perangkat: 'devC' }, S2);
ok('pgk sebagian: 1 benar 1 salah = 0', r.ok && r.data.nilai === 0, r);

console.log('Sinkron D1');
r = await call('sinkronSekarang', {}, ADM);
ok('sinkron', r.ok, r);
r = await call('sinkronSekarang', {}, ADM);
ok('sinkron kedua: tidak ada perubahan', r.ok && r.data.disinkron === 0, r);

console.log('Koreksi & hasil');
const ur = full.soal.find(s => s.tipe === 'uraian');
r = await call('koreksi', { ujianId: U.id, nis: '1001', manual: { [ur.id]: 3 } }, GURU);
ok('koreksi uraian', r.ok && r.data.hasil.perluKoreksi === 0 && r.data.hasil.skor === maks - 1, r.data && r.data.hasil);
r = await call('hasilUjian', { ujianId: U.id }, GURU);
ok('hasilUjian gabungan (3 peserta: 2 selesai + 1 belum)', r.ok && r.data.peserta.length === 3 && r.data.peserta.find(p => p.nis === '1001').hasil.perluKoreksi === 0 && r.data.bank.soal.length === 8, r.data && r.data.peserta.map(p => p.status));
r = await call('koreksiMassal', { ujianId: U.id, items: [{ nis: '1001', manual: { [ur.id]: 4 } }, { nis: '0012', manual: { [ur.id]: 0 } }] }, GURU);
ok('koreksi massal', r.ok && r.data.length === 2 && r.data.find(x => x.nis === '1001').hasil.skor === maks, r);

console.log('Reset & waktu habis');
const monR = wsBuka({ t: ADM, m: U.id }); await monR.terbuka; await monR.tunggu(m => m.t === 'snap');
r = await call('resetPeserta', { ujianId: U.id, nis: '0012' }, ADM);
ok('reset', r.ok, r);
r = await call('ujianSaya', {}, S2);
ok('setelah reset: siswa lihat belum', r.data[0].status === 'belum', r.data);
r = await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devZ' }, S2);
ok('mulai ulang setelah reset', r.ok, r);
const ws2 = wsBuka({ t: S2, u: U.id, p: 'devZ' }); await ws2.terbuka; await ws2.tunggu(m => m.t === 'hai');
r = await call('paksaSelesai', { ujianId: U.id, nis: '0012' }, GURU);
const pk = await ws2.tunggu(m => m.t === 'selesai');
ok('paksa selesai → siswa menerima "selesai" lewat WS', r.ok && pk && /dihentikan/.test(pk.data.catatan), [r, pk]);
r = await call('loginSiswa', { nis: '1002', password: '1002' });
const S3 = r.data.token;
r = await call('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'devD' }, S3);
ok('siswa 3 mulai', r.ok);
const ws3 = wsBuka({ t: S3, u: U.id, p: 'devD' }); await ws3.terbuka; await ws3.tunggu(m => m.t === 'hai');
ws3.kirimJ({ t: 'j', j: { j: { [full.soal[0].id]: full.soal[0].kunci }, r: [] }, p: 0, v: 1 });
await ws3.tunggu(m => m.t === 'ok');
ws3.close();
await dev(61 * 60000 + 3 * 60000, true); // lewati durasi + toleransi, jalankan perawatan
r = await call('monitorUjian', { ujianId: U.id }, ADM);
const p3 = r.data.peserta.find(p => p.nis === '1002');
ok('siswa 3 selesai otomatis dgn nilai dari autosave WS', p3.status === 'selesai' && p3.nilai > 0 && /otomatis/.test(p3.catatan), p3);
await dev(0);
monR.close(); mon.close();

console.log('Hitung ulang setelah kunci diperbaiki');
const fb = (await call('getBank', { id: bankId }, GURU)).data;
const pgS = fb.soal.find(s => s.tipe === 'pg');
pgS.kunci = pgS.opsi[0].id;
await call('saveBank', { bank: fb }, GURU);
r = await call('hitungUlang', { ujianId: U.id }, GURU);
ok('hitung ulang', r.ok && r.data.dihitung >= 3, r);

console.log('Lainnya');
r = await call('gantiPassword', { lama: '1001', baru: 'baru123' }, S1);
ok('siswa ganti password', r.ok, r);
r = await call('loginSiswa', { nis: '1001', password: 'baru123' });
ok('login password baru', r.ok);
for (let i = 0; i < 8; i++) await call('loginSiswa', { nis: '1003', password: 'x' });
r = await call('loginSiswa', { nis: '1003', password: '1003' });
ok('dibatasi setelah 8 kali gagal', !r.ok && /Terlalu banyak/.test(r.error), r);
r = await call('dashboard', {}, ADM);
ok('dashboard admin', r.ok && r.data.jumlahSiswa === 5 && r.data.jumlahBank === 2, r.data);
r = await call('deleteBank', { id: bankId }, GURU);
ok('bank dipakai tidak bisa dihapus', !r.ok);
r = await call('deleteUjian', { id: U.id }, ADM);
ok('hapus ujian dgn peserta butuh paksa', !r.ok && r.code === 'ADA_PESERTA', r);
r = await call('deleteUjian', { id: U.id, paksa: true }, ADM);
ok('hapus ujian paksa', r.ok, r);
r = await call('deleteBank', { id: bankAdmin }, ADM);
ok('hapus bank', r.ok);
r = await call('statusSistem', {}, ADM);
ok('status sistem', r.ok && r.data.versi, r);

console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
