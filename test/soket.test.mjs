// Uji koneksi tunggal (?r=1): seluruh alur guru & siswa lewat SATU WebSocket per aplikasi.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
let fails = 0, sambungan = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 400))); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function soket() {
  sambungan++;
  const ws = new WebSocket(WSB + '/api/ws?r=1');
  const inbox = [], waiters = [], parts = new Map();
  let seq = 0;
  const terima = raw => {
    const m = JSON.parse(raw);
    if (m.t === 'pt') { let b = parts.get(m.id); if (!b) parts.set(m.id, b = { n: m.n, a: [], k: 0 }); b.a[m.i] = m.s; b.k++; if (b.k === b.n) { parts.delete(m.id); ws.dipotong = (ws.dipotong || 0) + 1; terima(b.a.join('')); } return; }
    inbox.push(m); waiters.splice(0).forEach(w => w());
  };
  ws.addEventListener('message', ev => terima(ev.data));
  ws.terbuka = new Promise(r => ws.addEventListener('open', r));
  ws.tutup = new Promise(r => ws.addEventListener('close', r));
  ws.tunggu = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() - t0 > ms) return null; await new Promise(r => { waiters.push(r); setTimeout(r, 100); }); } };
  ws.kirimJ = o => { const s = JSON.stringify(o), P = 400000; if (s.length <= P) return ws.send(s); const id = 'k' + (++seq), n = Math.ceil(s.length / P); for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: 'pt', id, i, n, s: s.slice(i * P, (i + 1) * P) })); };
  ws.rpc = async (a, d = {}, tok = '') => { const id = ++seq; ws.kirimJ({ t: 'rpc', id, a, d, tok }); const r = await ws.tunggu(m => m.t === 'res' && m.id === id, 30000); return r || { ok: false, error: 'timeout' }; };
  return ws;
}

console.log('Guru: satu koneksi untuk login, bank soal, jadwal');
const g = soket(); await g.terbuka;
await g.rpc('_dev', { offset: 0 });
let r = await g.rpc('ping');
ok('ping lewat soket', r.ok && r.data.namaSekolah, r);
r = await g.rpc('loginGuru', { username: 'admin', password: 'salah' });
ok('login salah ditolak', !r.ok && /salah/.test(r.error), r);
r = await g.rpc('loginGuru', { username: 'admin', password: 'admin123' });
ok('login admin lewat soket', r.ok && r.data.user.role === 'admin', r);
const ADM = r.data.token;
r = await g.rpc('listGuru', {}, 'x.y');
ok('token palsu → AUTH', !r.ok && r.code === 'AUTH', r);
r = await g.rpc('dashboard', {}, ADM);
ok('dashboard', r.ok && r.data.jumlahBank >= 1, r);
// bank contoh milik "guru" → disunting oleh guru pemiliknya (admin tidak boleh mengubah bank milik guru)
const GT = (await g.rpc('loginGuru', { username: 'guru', password: 'guru123' })).data.token;
const contoh = (await g.rpc('getBank', { id: 'bcontoh01' }, GT)).data;
const bank = (await g.rpc('saveBank', { bank: { judul: 'Bank besar', mapel: contoh.mapel, tingkat: 'X', soal: contoh.soal.map(x => ({ ...x, id: undefined })) } }, GT)).data.bank;
const bankId = bank.id;
const pjg = 'Teks soal panjang untuk menguji pesan besar. '.repeat(400);
for (let i = 0; i < 30; i++) bank.soal.push({ tipe: 'pg', teks: pjg + i, bobot: 1, opsi: [{ teks: 'A' }, { teks: 'B' }], kunci: '' });
r = await g.rpc('saveBank', { bank }, GT);
ok('simpan bank BESAR (>400 KB, dikirim terpotong)', r.ok && r.data.bank.soal.length === 37, { ok: r.ok, err: r.error, keys: r.data && Object.keys(r.data), n: r.data && r.data.bank && r.data.bank.soal.length });
r = await g.rpc('getBank', { id: bankId }, GT);
ok('buka bank BESAR (balasan server terpotong & tersusun lagi)', r.ok && r.data.soal.length === 37 && g.dipotong >= 1, { ok: r.ok, n: r.data && r.data.soal.length, dipotong: g.dipotong });
const kecil = r.data; kecil.soal = kecil.soal.slice(0, 7);
await g.rpc('saveBank', { bank: kecil }, ADM);
const t0 = Date.now();
r = await g.rpc('saveUjian', { nama: 'Uji Soket', bankId: 'bcontoh01', kelas: ['X-1'], mulai: t0 - 60000, selesai: t0 + 3600000, durasi: 60, tampilNilai: true, pakaiToken: true }, ADM);
ok('atur jadwal lewat soket', r.ok && r.data.token, r);
const U = r.data;
g.kirimJ({ t: 'pantau', tok: ADM, m: U.id });
const snap = await g.tunggu(m => m.t === 'snap');
ok('monitor di soket yang sama: snapshot (X-1 = 2 siswa)', snap && snap.data.peserta.length === 2, snap && snap.data.peserta.length);

console.log('Siswa: satu koneksi untuk login, daftar, mulai, menjawab, selesai');
const s = soket(); await s.terbuka;
r = await s.rpc('loginSiswa', { nis: '1001', password: '1001' });
ok('login siswa lewat soket', r.ok, r);
const S1 = r.data.token;
r = await s.rpc('ujianSaya', {}, S1);
ok('daftar ujian lewat soket', r.ok && r.data.some(u => u.id === U.id && u.status === 'belum'), r);
s.kirimJ({ t: 'j', j: { j: {}, r: [] }, p: 0, v: 1 });
const pi = await s.tunggu(m => m.t === 'perlu_ikut');
ok('autosave sebelum "ikut" → diminta ikut dulu', !!pi, pi);
r = await s.rpc('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'hpA' }, S1);
ok('mulai ujian lewat soket', r.ok && r.data.soal.length === 7, { err: r.error, n: r.data && r.data.soal && r.data.soal.length });
const soal = r.data.soal;
s.kirimJ({ t: 'ikut', tok: S1, u: U.id, p: 'hpA' });
const hai = await s.tunggu(m => m.t === 'hai');
ok('ikut sesi ujian di soket yang sama', hai && hai.deadline > Date.now(), hai);
r = await s.rpc('ujianSaya', {}, S1);
ok('daftar menunjukkan "mengerjakan" (tombol Lanjutkan)', r.data.find(u => u.id === U.id).status === 'mengerjakan', r.data);
const full = contoh;   // bank ujian = bank contoh (kunci jawaban dari guru pemiliknya)
const pg = full.soal.find(x => x.tipe === 'pg');
s.kirimJ({ t: 'j', j: { j: { [pg.id]: pg.kunci }, r: [] }, p: 0, v: 2 });
const ack = await s.tunggu(m => m.t === 'ok' && m.v === 2);
ok('autosave di-ack', ack && ack.status === 'mengerjakan', ack);
const dm = await g.tunggu(m => m.t === 'diff' && m.rows.some(x => x.nis === '1001' && x.status === 'mengerjakan'), 10000);
ok('monitor guru: status "mengerjakan" muncul', !!dm, dm);
const df = await g.tunggu(m => m.t === 'diff' && m.rows.some(x => x.nis === '1001'), 6000);
ok('cadangan jawaban tidak dikirim ke monitor (hanya status)', !df, df);
s.kirimJ({ t: 'selesai', id: 'q1', j: { j: { [pg.id]: pg.kunci }, r: [] }, p: 0, a: '' });
const hs = await s.tunggu(m => m.t === 'hasil' && m.id === 'q1');
ok('selesai + nilai lewat soket', hs && hs.data.status === 'selesai' && hs.data.nilai > 0, hs);
const ds = await g.tunggu(m => m.t === 'diff' && m.rows.some(x => x.nis === '1001' && x.status === 'selesai'), 10000);
ok('monitor guru: status "selesai" muncul', !!ds, ds);
const tutup = await Promise.race([s.tutup.then(() => true), sleep(4500).then(() => false)]);
ok('koneksi TIDAK ditutup setelah selesai (dipakai lagi untuk daftar)', !tutup);
r = await s.rpc('ujianSaya', {}, S1);
ok('daftar menunjukkan selesai + nilai (tanpa koneksi baru)', r.ok && r.data.find(u => u.id === U.id).status === 'selesai' && r.data.find(u => u.id === U.id).nilai > 0, r.data);

console.log('Reset & pindah perangkat');
r = await g.rpc('resetPeserta', { ujianId: U.id, nis: '1001' }, ADM);
ok('reset oleh admin', r.ok, r);
r = await s.rpc('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'hpA' }, S1);
s.kirimJ({ t: 'ikut', tok: S1, u: U.id, p: 'hpA' }); await s.tunggu(m => m.t === 'hai');
const s2 = soket(); await s2.terbuka;
await s2.rpc('resetLogin', { ujianId: U.id, nis: '1001' }, ADM).then(x => x);
r = await g.rpc('resetLogin', { ujianId: U.id, nis: '1001' }, ADM);
r = await s2.rpc('mulaiUjian', { ujianId: U.id, token: U.token, perangkat: 'hpB' }, S1);
ok('lanjut di perangkat lain setelah reset login', r.ok, r);
const tendang = await s.tunggu(m => m.t === 'err' && m.code === 'PERANGKAT');
ok('perangkat lama diberi tahu, koneksinya tetap hidup', !!tendang && (await s.rpc('ping')).ok, tendang);
g.kirimJ({ t: 'lepas' });

console.log(`\nKoneksi dibuka: ${sambungan} (guru 1, siswa 1, perangkat kedua 1) = ${sambungan} request kuota untuk seluruh alur di atas`);
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
