// Uji beban CARA BARU: N siswa (default 1300), masing-masing SATU koneksi untuk
// login → daftar ujian → mulai → autosave → selesai → lihat nilai. Menghitung kuota Cloudflare.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const N = Number(process.env.N || 1300);
const GURU = Number(process.env.GURU || 3);              // guru yang memantau (masing-masing 1 koneksi)
const MENIT = Number(process.env.MENIT || 0);            // >0: simulasi ujian MENIT menit, autosave tiap menit (jam server dimajukan)
const AUTOSAVE = MENIT > 0 ? MENIT - 1 : Number(process.env.AUTOSAVE || 6);
const hit = { koneksi: 0, pesan: 0, http: 0 };
const per = { siswa: { koneksi: 0, pesan: 0 }, guru: { koneksi: 0, pesan: 0 } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + String(JSON.stringify(info)).slice(0, 300))); if (!c) fails++; };
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0; };
const waktu = arr => `median ${pct(arr, 0.5)} ms · p95 ${pct(arr, 0.95)} ms · maks ${pct(arr, 1)} ms`;
async function pool(items, conc, fn) { let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

function soket(jenis) {
  hit.koneksi++; const c = jenis && per[jenis]; if (c) c.koneksi++;
  const hitung = () => { hit.pesan++; if (c) c.pesan++; };
  const ws = new WebSocket(WSB + '/api/ws?r=1');
  const inbox = [], waiters = [], parts = new Map(); let seq = 0;
  const terima = raw => {
    const m = JSON.parse(raw);
    if (m.t === 'pt') { let b = parts.get(m.id); if (!b) parts.set(m.id, b = { n: m.n, a: [], k: 0 }); b.a[m.i] = m.s; if (++b.k === b.n) { parts.delete(m.id); terima(b.a.join('')); } return; }
    inbox.push(m); waiters.splice(0).forEach(w => w());
  };
  ws.addEventListener('message', ev => terima(ev.data));
  ws.terbuka = new Promise(r => { ws.addEventListener('open', () => r(true)); ws.addEventListener('error', () => r(false)); });
  ws.tunggu = async (pred, ms = 60000) => { const t0 = Date.now(); for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (Date.now() - t0 > ms) return null; await new Promise(r => { waiters.push(r); setTimeout(r, 250); }); } };
  ws.kirimJ = o => { const s = JSON.stringify(o), P = 400000; if (s.length <= P) { hitung(); return ws.send(s); } const id = 'k' + (++seq), n = Math.ceil(s.length / P); for (let i = 0; i < n; i++) { hitung(); ws.send(JSON.stringify({ t: 'pt', id, i, n, s: s.slice(i * P, (i + 1) * P) })); } };
  ws.rpc = async (a, d = {}, tok = '', coba = 4) => {
    for (let k = 0; ; k++) {
      const id = ++seq; ws.kirimJ({ t: 'rpc', id, a, d, tok });
      const r = (await ws.tunggu(m => m.t === 'res' && m.id === id)) || { ok: false, error: 'timeout' };
      if (r.ok || r.code !== 'BUSY' || k >= coba) return r;
      await sleep(300 * 2 ** k * Math.random());
    }
  };
  return ws;
}

// ---------------- persiapan oleh admin (1 koneksi)
console.log(`Persiapan: ${N} siswa, 3 ujian (X, XI, XII) — admin memakai 1 koneksi`);
const adm = soket(); await adm.terbuka;
await adm.rpc('_dev', { offset: 0 });
const A = (await adm.rpc('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
const rows = [], tingkat = ['X', 'XI', 'XII'];
for (let i = 0; i < N; i++) { const t = tingkat[i % 3]; rows.push({ nis: String(70000 + i), nama: 'Siswa ' + i, kelas: t + '-' + (1 + Math.floor(i / 3) % 12) }); }
let r = await adm.rpc('importSiswa', { rows }, A);
ok(`impor ${N} siswa`, r.ok && r.data.baru === N, r);
const contoh = (await adm.rpc('getBank', { id: 'bcontoh01' }, A)).data;
const soal = [];
for (let k = 0; k < 40; k++) soal.push({ tipe: 'pg', teks: `Soal nomor ${k + 1}: ` + 'Lorem ipsum dolor sit amet, teks soal yang cukup panjang. '.repeat(3), bobot: 1, opsi: ['A', 'B', 'C', 'D', 'E'].map(x => ({ teks: 'Pilihan ' + x })), kunci: '' });
const b = (await adm.rpc('saveBank', { bank: { judul: 'Beban 45 soal', mapel: 'Matematika', tingkat: 'X', soal: soal.concat(contoh.soal.slice(1, 6)) } }, A)).data.bank;
b.soal.forEach(s => { if (s.tipe === 'pg' && !s.kunci) s.kunci = s.opsi[0].id; });
await adm.rpc('saveBank', { bank: b }, A);
const t0 = Date.now(), ujian = {};
for (const tg of tingkat) {
  const kelas = [...new Set(rows.filter(x => x.kelas.startsWith(tg + '-')).map(x => x.kelas))];
  ujian[tg] = (await adm.rpc('saveUjian', { nama: 'PAS ' + tg, bankId: b.id, kelas, mulai: t0 - 60000, selesai: t0 + 4 * 3600000, durasi: 90, acakSoal: true, acakOpsi: true, tampilNilai: true, pakaiToken: true, maxPelanggaran: 0 }, A)).data;
}
ok('3 jadwal dibuat', Object.values(ujian).every(u => u && u.token));
for (let i = 0; i < GURU; i++) await adm.rpc('saveGuru', { username: 'pengawas' + i, nama: 'Pengawas ' + i, password: 'awas123', role: 'admin' }, A);

// ---------------- GURU guru memantau, masing-masing 1 koneksi: login lalu buka monitor
const UJ = Object.values(ujian);
const mons = await Promise.all(Array.from({ length: GURU }, async (_, i) => {
  const m = soket('guru'); await m.terbuka;
  const l = await m.rpc('loginGuru', { username: 'pengawas' + i, password: 'awas123' });
  if (!l.ok) return m;
  m.kirimJ({ t: 'pantau', tok: l.data.token, m: UJ[i % 3].id }); m.snap = await m.tunggu(x => x.t === 'snap'); return m;
}));
ok(`${mons.filter(m => m.snap).length}/${GURU} guru memantau, snapshot diterima`, mons.every(m => m.snap && m.snap.data.peserta.length > 0));

// ---------------- siswa
const sis = rows.map(x => ({ ...x, u: ujian[x.kelas.split('-')[0]], dev: 'dev-' + x.nis }));
console.log(`\nFase 1 — ${N} siswa membuka aplikasi BERSAMAAN: login, daftar ujian, mulai, ikut (1 koneksi/siswa)`);
let lat = [], t = Date.now();
await pool(sis, N, async s => {
  const a = Date.now();
  s.ws = soket('siswa'); if (!(await s.ws.terbuka)) return;
  const l = await s.ws.rpc('loginSiswa', { nis: s.nis, password: s.nis }); if (!l.ok) { s.err = l; return; }
  s.tok = l.data.token;
  const d = await s.ws.rpc('ujianSaya', {}, s.tok); if (!d.ok || !d.data.length) { s.err = d; return; }
  const m = await s.ws.rpc('mulaiUjian', { ujianId: s.u.id, token: s.u.token, perangkat: s.dev }, s.tok); if (!m.ok) { s.err = m; return; }
  s.soal = m.data.soal; s.deadline = m.data.deadline;
  s.ws.kirimJ({ t: 'ikut', tok: s.tok, u: s.u.id, p: s.dev });
  s.hai = await s.ws.tunggu(x => x.t === 'hai' || x.t === 'err');
  lat.push(Date.now() - a);
});
ok(`${sis.filter(s => s.hai && s.hai.t === 'hai').length}/${N} siswa siap mengerjakan dalam ${Date.now() - t} ms (${waktu(lat)})`, sis.every(s => s.hai && s.hai.t === 'hai'), (sis.find(s => s.err) || {}).err);

console.log(MENIT ? `\nFase 2 — ujian ${MENIT} menit: tiap menit jam server dimajukan 1 menit & semua siswa autosave (${AUTOSAVE}×)` : `\nFase 2 — ${AUTOSAVE}× autosave per siswa di koneksi yang sama`);
lat = []; t = Date.now();
for (let k = 0; k < AUTOSAVE; k++) {
  if (MENIT) await adm.rpc('_dev', { offset: (k + 1) * 60000 });
  await Promise.all(sis.map(async s => {
    const j = {}; s.soal.slice(0, Math.round((k + 1) / AUTOSAVE * s.soal.length)).forEach(q => { if (q.opsi) j[q.id] = q.opsi[Math.floor(Math.random() * q.opsi.length)].id; else if (q.tipe === 'isian' || q.tipe === 'uraian') j[q.id] = 'jawaban ' + s.nis; });
    s.j = j; const a = Date.now();
    s.ws.kirimJ({ t: 'j', j: { j, r: [] }, p: 0, v: k + 1 });
    if (await s.ws.tunggu(m => m.t === 'ok' && m.v === k + 1)) lat.push(Date.now() - a);
  }));
}
ok(`${lat.length}/${N * AUTOSAVE} autosave diterima server dalam ${Date.now() - t} ms (${waktu(lat)})`, lat.length === N * AUTOSAVE);
await sleep(4000);
let diffRows = 0; for (;;) { const m = await mons[0].tunggu(x => x.t === 'diff', 500); if (!m) break; diffRows += m.rows.length; }
ok(`monitor guru menerima progres langsung (${diffRows} baris)`, diffRows > 0);
if (MENIT) { await adm.rpc('_dev', { offset: (MENIT - 0.5) * 60000 }); console.log(`  (jam server sekarang menit ke-${MENIT - 0.5} dari ${MENIT})`); }

console.log(`\nFase 3 — ${N} siswa menekan "Selesai" BERSAMAAN, lalu melihat nilai`);
lat = []; t = Date.now();
const res = await Promise.all(sis.map(async s => {
  const a = Date.now(); s.ws.kirimJ({ t: 'selesai', id: 'f' + s.nis, j: { j: s.j, r: [] }, p: 0, a: '' });
  const h = await s.ws.tunggu(m => m.t === 'hasil' || m.t === 'selesai' || m.t === 'err');
  lat.push(Date.now() - a); return h && (h.t === 'hasil' || h.t === 'selesai') ? h.data : h;
}));
ok(`${res.filter(x => x && x.status === 'selesai').length}/${N} selesai & dinilai dalam ${Date.now() - t} ms (${waktu(lat)})`, res.every(x => x && x.status === 'selesai'), res.find(x => !x || x.status !== 'selesai'));
const lihat = await Promise.all(sis.slice(0, 50).map(s => s.ws.rpc('ujianSaya', {}, s.tok)));
ok('siswa melihat nilai di daftar ujian lewat koneksi yang sama', lihat.every(x => x.ok && x.data.some(u => u.status === 'selesai')), lihat.find(x => !x.ok));
await sleep(4000);
let total = 0;
for (const u of Object.values(ujian)) { const h = await adm.rpc('hasilUjian', { ujianId: u.id }, A); total += h.data.peserta.filter(p => p.status === 'selesai' && p.hasil).length; }
ok(`D1: ${total}/${N} hasil tersimpan permanen`, total === N);
sis.forEach(s => s.ws.close()); mons.forEach(m => m.close()); adm.close();

// ---------------- kuota (hanya siswa & guru pemantau; persiapan admin tidak dihitung)
const kon = per.siswa.koneksi + per.guru.koneksi, pes = per.siswa.pesan + per.guru.pesan;
console.log(`\nPemakaian kuota: ${N} siswa × 1 ujian${MENIT ? ' ' + MENIT + ' menit' : ''} + ${GURU} guru memantau`);
console.log(`  Worker requests ("Requests today") : ${kon}  (siswa ${per.siswa.koneksi} + guru ${per.guru.koneksi}) · HTTP: ${hit.http}`);
console.log(`  Durable Object : ${kon} koneksi + ${pes} pesan masuk ÷ 20 = ${Math.round(kon + pes / 20)}  (pesan siswa ${per.siswa.pesan}, guru ${per.guru.pesan})`);
const doUjian = kon + pes / 20;
console.log(`\nProyeksi 1 hari = 6 ujian seperti ini:`);
console.log(`  Worker  : ${(6 * kon).toLocaleString('id')} / 100.000  (+1 tiap siswa yang sambung ulang / muat ulang halaman)`);
console.log(`  DO      : ±${Math.round(6 * doUjian).toLocaleString('id')} / 100.000`);
console.log(`  D1 tulis: ±${Math.round(2 * 6 * N).toLocaleString('id')} baris / 100.000`);
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
