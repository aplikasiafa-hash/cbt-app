// Uji sakelar "Kunci link" (versi 2.14): halaman ujian siswa hanya untuk aplikasi CBT Ujian, bisa dimatikan/dinyalakan admin.
// Jalankan dengan wrangler dev --var DEV_MODE:1 --var APP_KUNCI:kunciuji   (TANPA=1: tanpa APP_KUNCI)
const BASE = process.env.BASE || 'http://127.0.0.1:8787', WSB = BASE.replace(/^http/, 'ws'), TANPA = process.env.TANPA === '1';
const KUNCI = 'kunciuji';
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 300))); if (!c) fails++; };
function soket() {
  const ws = new WebSocket(WSB + '/api/ws?r=1'), inbox = [], w = []; let seq = 0;
  ws.addEventListener('message', ev => { inbox.push(JSON.parse(ev.data)); w.splice(0).forEach(f => f()); });
  ws.buka = new Promise(r => ws.addEventListener('open', r));
  ws.rpc = async (a, d = {}, tok = '') => { const id = ++seq; ws.send(JSON.stringify({ t: 'rpc', id, a, d, tok })); for (;;) { const i = inbox.findIndex(m => m.t === 'res' && m.id === id); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise(r => { w.push(r); setTimeout(r, 200); }); } };
  return ws;
}
const halaman = async (ua = 'Mozilla/5.0 Chrome') => (await fetch(BASE + '/ujian-cbt/', { headers: { 'user-agent': ua } })).status;
const tunggu = ms => new Promise(r => setTimeout(r, ms));
const s = soket(); await s.buka;
const A = (await s.rpc('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
await s.rpc('importGuru', { rows: [{ username: 'gurulink', nama: 'Pak Budi', mapel: 'IPA', password: 'rahasia1', peran: 'guru', status: 'aktif' }] }, A);
const G = (await s.rpc('loginGuru', { username: 'gurulink', password: 'rahasia1' })).data.token;

if (TANPA) {
  console.log('Kunci link belum dipasang di server');
  const st = (await s.rpc('statusSistem', {}, A)).data;
  ok('status: terpasang = false, aktif = false', st.kunciLink && st.kunciLink.terpasang === false && st.kunciLink.aktif === false, st.kunciLink);
  const r = await s.rpc('aturKunciLink', { aktif: true }, A);
  ok('sakelar ditolak: "Kunci link belum dipasang di serverC."', !r.ok && /Kunci link belum dipasang/.test(r.error), r);
  ok('halaman ujian terbuka untuk browser biasa', await halaman() === 200);
} else {
  console.log('Kunci link terpasang');
  let st = (await s.rpc('statusSistem', {}, A)).data;
  ok('awal: terpasang & aktif', st.kunciLink.terpasang && st.kunciLink.aktif, st.kunciLink);
  ok('browser biasa → 404', await halaman() === 404);
  ok('aplikasi CBT Ujian (UA berisi kunci) → 200', await halaman('Mozilla/5.0 CBTUjian k/' + KUNCI) === 200);
  let r = await s.rpc('aturKunciLink', { aktif: false }, G);
  ok('guru biasa tidak boleh mengubah sakelar', !r.ok, r);
  r = await s.rpc('aturKunciLink', { aktif: false }, A);
  ok('admin mematikan kunci link', r.ok && r.data.aktif === false && r.data.terpasang, r);
  st = (await s.rpc('statusSistem', {}, A)).data;
  ok('status sekarang: mati', st.kunciLink.aktif === false, st.kunciLink);
  await tunggu(31000);
  ok('±30 detik kemudian: browser biasa bisa membuka halaman ujian (200)', await halaman() === 200);
  ok('aplikasi CBT Ujian tetap bisa (200)', await halaman('Mozilla/5.0 CBTUjian k/' + KUNCI) === 200);
  r = await s.rpc('aturKunciLink', { aktif: true }, A);
  ok('admin menyalakan lagi', r.ok && r.data.aktif === true, r);
  await tunggu(31000);
  ok('±30 detik kemudian: browser biasa kembali 404', await halaman() === 404);
  ok('aplikasi CBT Ujian tetap 200', await halaman('Mozilla/5.0 CBTUjian k/' + KUNCI) === 200);
  const res = await (await fetch(BASE + '/ujian-cbt/', { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
  ok('jawaban 404 tidak menyebut nama rahasia', !/APP_KUNCI/i.test(res));
}
s.close();
console.log(fails ? fails + ' GAGAL' : 'SEMUA LULUS');
process.exit(fails ? 1 : 0);
