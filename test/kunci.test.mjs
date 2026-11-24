// Uji fitur kunci bank soal oleh admin (versi 2.11).
// FASE=1 (default): alur lengkap. FASE=2: dijalankan setelah server dimulai ulang tanpa menghapus data → kunci tetap berlaku.
const BASE = process.env.BASE || 'http://127.0.0.1:8787', WSB = BASE.replace(/^http/, 'ws'), FASE = process.env.FASE || '1';
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 300))); if (!c) fails++; };
function soket() {
  const ws = new WebSocket(WSB + '/api/ws?r=1'), inbox = [], w = []; let seq = 0;
  ws.addEventListener('message', ev => { inbox.push(JSON.parse(ev.data)); w.splice(0).forEach(f => f()); });
  ws.buka = new Promise(r => ws.addEventListener('open', r));
  ws.rpc = async (a, d = {}, tok = '') => { const id = ++seq; ws.send(JSON.stringify({ t: 'rpc', id, a, d, tok })); for (;;) { const i = inbox.findIndex(m => m.t === 'res' && m.id === id); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise(r => { w.push(r); setTimeout(r, 200); }); } };
  return ws;
}
const s = soket(); await s.buka;
const tulis = async () => (await s.rpc('_dev', { flush: true })).data.ukur.d1w;
const A = (await s.rpc('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
const soal = n => Array.from({ length: n }, (_, k) => ({ id: 'q' + k + 'z', tipe: 'pg', teks: 'Soal ' + (k + 1), bobot: 1, opsi: ['a', 'b', 'c', 'd'].map(h => ({ id: 'o' + k + h, teks: h })), kunci: 'o' + k + 'a' }));

if (FASE === '1') {
  console.log('Fase 1 — admin mengunci bank soal guru');
  await s.rpc('importGuru', { rows: [{ username: 'gurukunci', nama: 'Bu Rina', mapel: 'Kimia', password: 'rahasia1', peran: 'guru', status: 'aktif' }] }, A);
  const G = (await s.rpc('loginGuru', { username: 'gurukunci', password: 'rahasia1' })).data.token;
  let r = await s.rpc('saveBank', { bank: { judul: 'Kimia X PAS', mapel: 'Kimia', tingkat: 'X', soal: soal(5) } }, G);
  const B = r.data.bank;
  ok('guru membuat bank (belum dikunci)', r.ok && !B.terkunci);
  const t = Date.now();
  r = await s.rpc('saveUjian', { nama: 'PAS Kimia X', bankId: B.id, tingkat: 'X', kelas: ['X-1'], mulai: t - 60000, selesai: t + 7200000, durasi: 90 }, A);
  ok('admin membuat jadwal yang memakai bank itu', r.ok, r);
  const ownBank = (await s.rpc('saveBank', { bank: { judul: 'Bank admin', mapel: 'Kimia', tingkat: 'X', soal: soal(2) } }, A)).data.bank;

  let w0 = await tulis();
  r = await s.rpc('kunciBank', { pilih: 'jadwal', kunci: true }, A);
  let w1 = await tulis();
  const m = r.data && r.data.list.find(b => b.id === B.id);
  ok('"Kunci bank yang dijadwalkan" mengunci 1 bank (hanya yang dipakai jadwal)', r.ok && r.data.diubah === 1 && m && m.terkunci && !r.data.list.find(b => b.id === ownBank.id).terkunci, r);
  ok('tercatat dikunci oleh Administrator beserta waktunya', m && m.dikunciOleh === 'Administrator' && m.dikunciPada > 0, m);
  ok('mengunci 1 bank = 2 baris D1 ditulis', w1 - w0 === 2, w1 - w0);
  w0 = await tulis(); r = await s.rpc('kunciBank', { pilih: 'jadwal', kunci: true }, A); w1 = await tulis();
  ok('mengunci lagi bank yang sudah terkunci tidak menulis apa-apa', r.ok && r.data.diubah === 0 && w1 === w0, { r: r.data && r.data.diubah, w: w1 - w0 });

  r = await s.rpc('listBank', {}, G);
  ok('guru melihat bank berstatus terkunci', r.ok && r.data[0].terkunci === true);
  r = await s.rpc('getBank', { id: B.id }, G);
  ok('guru masih bisa membuka & melihat soal', r.ok && r.data.soal.length === 5 && r.data.terkunci);
  const isi = r.data; isi.soal[0].teks = 'DIUBAH SAAT UJIAN';
  r = await s.rpc('saveBank', { bank: isi }, G);
  ok('guru menyimpan perubahan → ditolak (kode KUNCI)', !r.ok && r.code === 'KUNCI' && /dikunci oleh Administrator/.test(r.error), r);
  r = await s.rpc('deleteBank', { id: B.id }, G);
  ok('guru menghapus bank → ditolak', !r.ok && r.code === 'KUNCI', r);
  r = await s.rpc('getBank', { id: B.id }, G);
  ok('isi soal tidak berubah', r.data.soal[0].teks === 'Soal 1');
  r = await s.rpc('saveBank', { bank: { judul: 'Salinan', mapel: 'Kimia', tingkat: 'X', soal: isi.soal } }, G);
  ok('guru tetap bisa membuat salinan baru (tidak ikut terkunci)', r.ok && !r.data.bank.terkunci, r);
  r = await s.rpc('kunciBank', { ids: [B.id], kunci: true }, G);
  ok('guru tidak bisa memakai fitur kunci', !r.ok, r);

  r = await s.rpc('kunciBank', { ids: [ownBank.id], kunci: true }, A);
  const own = (await s.rpc('getBank', { id: ownBank.id }, A)).data;
  r = await s.rpc('saveBank', { bank: own }, A);
  ok('bank milik admin yang dikunci juga tidak bisa disimpan sebelum dibuka', !r.ok && r.code === 'KUNCI' && /Buka kuncinya dulu/.test(r.error), r);
  r = await s.rpc('kunciBank', { ids: [ownBank.id], kunci: false }, A);
  ok('admin membuka kunci bank sendiri', r.ok && r.data.diubah === 1);
  console.log('  (bank guru dibiarkan terkunci untuk fase 2)');
} else {
  console.log('Fase 2 — server dimulai ulang: kunci tetap berlaku');
  const G = (await s.rpc('loginGuru', { username: 'gurukunci', password: 'rahasia1' })).data.token;
  const B = (await s.rpc('listBank', {}, G)).data.find(b => b.judul === 'Kimia X PAS');
  ok('setelah mesin bangun ulang, bank masih terkunci', B && B.terkunci === true, B);
  const isi = (await s.rpc('getBank', { id: B.id }, G)).data;
  let r = await s.rpc('saveBank', { bank: isi }, G);
  ok('guru masih ditolak menyimpan', !r.ok && r.code === 'KUNCI', r);
  r = await s.rpc('kunciBank', { pilih: 'semua', kunci: false }, A);
  ok('admin "Buka semua kunci"', r.ok && r.data.diubah === 1 && r.data.list.every(b => !b.terkunci), r);
  isi.soal[0].teks = 'Soal 1 (diperbaiki)';
  r = await s.rpc('saveBank', { bank: isi }, G);
  ok('setelah dibuka, guru bisa menyimpan lagi', r.ok && r.data.bank.soal[0].teks === 'Soal 1 (diperbaiki)' && !r.data.bank.terkunci, r);
}
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
