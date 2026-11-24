// Uji 2.17: mesin ujian hanya menyala selama ada siswa yang sedang mengerjakan.
//  - guru/admin memakai permintaan biasa → tidak ada koneksi yang tertinggal
//  - Monitoring tanpa siswa yang mengerjakan → server mengirim "sepi" lalu menutup koneksi
//  - siswa terakhir selesai → koneksinya ditutup, Monitoring ditutup → 0 koneksi (mesin ujian bisa tidur)
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 400))); if (!c) fails++; };
const call = async (action, data = {}, token = '') => (await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const koneksi = async () => (await call('_dev', {})).data.sockets;

function soket() {
  const ws = new WebSocket(WSB + '/api/ws?r=1');
  const inbox = [], waiters = [];
  let seq = 0;
  ws.addEventListener('message', ev => { inbox.push(JSON.parse(ev.data)); waiters.splice(0).forEach(w => w()); });
  ws.terbuka = new Promise(r => ws.addEventListener('open', r));
  ws.tertutup = false; ws.addEventListener('close', () => { ws.tertutup = true; });
  ws.tunggu = async (pred, ms = 8000) => { const t0 = Date.now(); for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() - t0 > ms) return null; await new Promise(r => { waiters.push(r); setTimeout(r, 100); }); } };
  ws.kirimJ = o => ws.send(JSON.stringify(o));
  ws.rpc = async (a, d = {}, tok = '') => { const id = ++seq; ws.kirimJ({ t: 'rpc', id, a, d, tok }); return (await ws.tunggu(m => m.t === 'res' && m.id === id, 30000)) || { ok: false, error: 'timeout' }; };
  return ws;
}
const tungguTutup = async (ws, ms) => { const t0 = Date.now(); while (!ws.tertutup && Date.now() - t0 < ms) await sleep(200); return ws.tertutup; };

await call('_dev', { offset: 0 });
console.log('Guru & admin memakai permintaan biasa');
const ADM = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
const GURU = (await call('loginGuru', { username: 'guru', password: 'guru123' })).data.token;
let r = await call('getBank', { id: 'bcontoh01' }, GURU);
const bank = r.data; bank.soal[0].teks = bank.soal[0].teks + ' (diubah)';
r = await call('saveBank', { bank }, GURU);
ok('guru mengubah soal → tersimpan di server', r.ok && (await call('getBank', { id: 'bcontoh01' }, GURU)).data.soal[0].teks.endsWith('(diubah)'), r);
await call('dashboard', {}, ADM);
ok('admin membuka beranda & guru menyunting soal: 0 koneksi terbuka', (await koneksi()) === 0, await koneksi());

console.log('Monitoring tanpa siswa yang mengerjakan');
const t0 = Date.now();
const U = (await call('saveUjian', { nama: 'Uji Tidur', bankId: 'bcontoh01', kelas: ['X-1'], mulai: t0 - 60000, selesai: t0 + 3600000, durasi: 30, pengawas: [{ id: 'gcontoh', kelas: [] }] }, ADM)).data;
const m1 = soket(); await m1.terbuka;
m1.kirimJ({ t: 'pantau', tok: GURU, m: U.id });
ok('monitor tersambung', !!(await m1.tunggu(m => m.t === 'snap')));
const sepi1 = await m1.tunggu(m => m.t === 'sepi', 30000);
ok('belum ada yang mengerjakan → server mengirim "sepi"', !!sepi1);
ok('… lalu menutup koneksi monitor', await tungguTutup(m1, 5000));

console.log('Siswa mengerjakan → koneksi langsung');
const S1 = (await call('loginSiswa', { nis: '1001', password: '1001', perangkat: 'hp1' })).data.token;
const s = soket(); await s.terbuka;
const mulai = await s.rpc('mulaiUjian', { ujianId: U.id, perangkat: 'hp1' }, S1);
ok('mulai lewat koneksi langsung', mulai.ok, mulai);
s.kirimJ({ t: 'ikut', tok: S1, u: U.id, p: 'hp1' });
ok('sesi ujian terikat', !!(await s.tunggu(m => m.t === 'hai')));
const m2 = soket(); await m2.terbuka;
m2.kirimJ({ t: 'pantau', tok: GURU, m: U.id });
ok('monitor tersambung saat ada siswa mengerjakan', !!(await m2.tunggu(m => m.t === 'snap')));
await sleep(20000);
ok('selama siswa mengerjakan, monitor TIDAK ditutup', !m2.tertutup && !(await m2.tunggu(m => m.t === 'sepi', 100)));

console.log('Siswa terakhir mengumpulkan');
s.kirimJ({ t: 'selesai', id: 'x1', j: mulai.data.jawaban, p: 0, a: '', mulai: mulai.data.mulai });
const hasil = await s.tunggu(m => m.t === 'hasil' && m.id === 'x1', 10000);
ok('jawaban berhasil tersimpan', hasil && hasil.data && hasil.data.status === 'selesai', hasil);
ok('koneksi siswa ditutup server walau halaman tetap terbuka', await tungguTutup(s, 6000));
ok('monitor menerima status Selesai', !!(await m2.tunggu(m => m.t === 'diff' && m.rows.some(x => x.nis === '1001' && x.status === 'selesai'), 8000)));
ok('monitor mendapat "sepi" lalu ditutup', !!(await m2.tunggu(m => m.t === 'sepi', 30000)) && await tungguTutup(m2, 5000));
await sleep(500);
ok('0 koneksi terbuka → mesin ujian bisa tidur', (await koneksi()) === 0, await koneksi());
ok('hasil tetap tersimpan di server', (await call('monitorUjian', { ujianId: U.id }, ADM)).data.peserta.find(p => p.nis === '1001').status === 'selesai');

console.log('Siswa menutup aplikasi tanpa mengumpulkan → mesin ujian tidak dibangunkan tiap menit');
const S2 = (await call('loginSiswa', { nis: '1002', password: '1002', perangkat: 'hp2' })).data;
ok('login siswa sekaligus membawa daftar ujian (tanpa permintaan ujianSaya)', Array.isArray(S2.ujian) && S2.ujian.some(u => u.id === U.id), S2.ujian);
r = await call('mulaiUjian', { ujianId: U.id, perangkat: 'hp2' }, S2.token);
ok('siswa 2 mulai lewat permintaan biasa lalu pergi', r.ok, r);
await sleep(2500);
const dv = (await call('_dev', {})).data;
ok('alarm berikutnya bukan 1 menit lagi, melainkan saat jawaban pending dinilai (±3 jam): ' + dv.alarmDetik + ' detik', dv.alarmDetik > 2 * 3600 && dv.alarmDetik < 4 * 3600, dv);

await call('deleteUjian', { id: U.id, paksa: true, hapusHasil: true }, ADM);
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
