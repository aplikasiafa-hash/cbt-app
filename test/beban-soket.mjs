// Uji beban CARA BARU: N siswa (default 1300), masing-masing SATU koneksi untuk
// login → daftar ujian → mulai → autosave → selesai → lihat nilai. Menghitung kuota Cloudflare.
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const N = Number(process.env.N || 1300);
const GURU = Number(process.env.GURU || 3);              // guru yang memantau (masing-masing 1 koneksi)
const MENIT = Number(process.env.MENIT || 0);            // >0: simulasi ujian MENIT menit (jam server dimajukan)
const CADANGAN_MENIT = 5;                                // cadangan jawaban tiap 5 menit, hanya lewat koneksi yang masih terbuka
const AUTOSAVE = MENIT > 0 ? Math.floor((MENIT - 1) / CADANGAN_MENIT) : Number(process.env.AUTOSAVE || 6);
const PUTUS = Number(process.env.PUTUS ?? 0.1);          // bagian siswa yang koneksinya putus di tengah ujian (tidak disambung ulang)
const OFFLINE = Number(process.env.OFFLINE ?? 0.02);     // bagian siswa yang offline saat waktu habis → Pending → kirim belakangan
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

// ---------------- pemakaian baris D1 & penyimpanan internal DO (hanya tersedia saat DEV_MODE)
const BARIS = [];
let ukurLalu = null;
async function ukur(label, opsi = {}) {
  const r = await adm.rpc('_dev', { flush: true, ...opsi });
  const u = r.data && r.data.ukur; if (!u) return;
  if (ukurLalu && label) BARIS.push({ label, d1r: u.d1r - ukurLalu.d1r, d1w: u.d1w - ukurLalu.d1w, dor: u.dor - ukurLalu.dor, dow: u.dow - ukurLalu.dow });
  ukurLalu = u;
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
await ukur(null);
for (let i = 0; i < GURU; i++) await adm.rpc('saveGuru', { username: 'pengawas' + i, nama: 'Pengawas ' + i, password: 'awas123', role: 'admin' }, A);
await ukur(null);   // pembuatan akun guru (sekali saja) tidak dihitung

// ---------------- GURU guru memantau, masing-masing 1 koneksi: login lalu buka monitor
const UJ = Object.values(ujian);
const mons = await Promise.all(Array.from({ length: GURU }, async (_, i) => {
  const m = soket('guru'); await m.terbuka;
  const l = await m.rpc('loginGuru', { username: 'pengawas' + i, password: 'awas123' });
  if (!l.ok) return m;
  m.kirimJ({ t: 'pantau', tok: l.data.token, m: UJ[i % 3].id }); m.snap = await m.tunggu(x => x.t === 'snap'); return m;
}));
ok(`${mons.filter(m => m.snap).length}/${GURU} guru memantau, snapshot diterima`, mons.every(m => m.snap && m.snap.data.peserta.length > 0));
await ukur(`${GURU} guru login & membuka monitor`);

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
  s.soal = m.data.soal; s.deadline = m.data.deadline; s.mulai = m.data.mulai;
  s.ws.kirimJ({ t: 'ikut', tok: s.tok, u: s.u.id, p: s.dev });
  s.hai = await s.ws.tunggu(x => x.t === 'hai' || x.t === 'err');
  lat.push(Date.now() - a);
});
await ukur(`${N} siswa login, daftar ujian, mulai`);
ok(`${sis.filter(s => s.hai && s.hai.t === 'hai').length}/${N} siswa siap mengerjakan dalam ${Date.now() - t} ms (${waktu(lat)})`, sis.every(s => s.hai && s.hai.t === 'hai'), (sis.find(s => s.err) || {}).err);

const langkahP = PUTUS > 0 ? Math.round(1 / PUTUS) : 0, langkahO = OFFLINE > 0 ? Math.round(1 / OFFLINE) : 0;
sis.forEach((s, i) => { s.peran = langkahO && i % langkahO === 1 ? 'offline' : langkahP && i % langkahP === 0 ? 'putus' : 'normal'; });
const jawabAcak = (s, frac) => { const j = {}; s.soal.slice(0, Math.max(1, Math.round(frac * s.soal.length))).forEach(q => { if (q.opsi) j[q.id] = q.opsi[Math.floor(Math.random() * q.opsi.length)].id; else if (q.tipe === 'isian' || q.tipe === 'uraian') j[q.id] = 'jawaban ' + s.nis; }); return j; };
const menit = k => (k + 1) * CADANGAN_MENIT;
console.log(`\nFase 2 — ujian ${MENIT || '?'} menit: cadangan jawaban tiap ${CADANGAN_MENIT} menit lewat koneksi yang masih terbuka (${AUTOSAVE}×);`
  + ` ${sis.filter(s => s.peran === 'putus').length} siswa koneksinya putus di menit ke-30, ${sis.filter(s => s.peran === 'offline').length} siswa offline saat waktu habis`);
lat = []; t = Date.now();
while (await mons[0].tunggu(x => x.t === 'diff', 4500)) {}   // habiskan perubahan status "mulai"
let kirimCad = 0;
for (let k = 0; k < AUTOSAVE; k++) {
  if (MENIT) await adm.rpc('_dev', { offset: menit(k) * 60000 });
  if (menit(k) >= 30) sis.forEach(s => { if (s.peran === 'putus' && s.ws.readyState === 1) s.ws.close(); });
  await Promise.all(sis.map(async s => {
    s.j = jawabAcak(s, (k + 1) / (AUTOSAVE + 1));   // jawaban di perangkat terus bertambah walau koneksi putus
    if (s.ws.readyState !== 1) return;            // koneksi putus → tidak disambung ulang, jawaban tetap di perangkat
    const a = Date.now(); kirimCad++;
    s.ws.kirimJ({ t: 'j', j: { j: s.j, r: [] }, p: 0, v: k + 1, mulai: s.mulai });
    if (await s.ws.tunggu(m => m.t === 'ok' && m.v === k + 1)) lat.push(Date.now() - a);
  }));
  await adm.rpc('_dev', { flush: true });   // server menyimpan cadangan jawaban sekali per ±5 menit
}
sis.forEach(s => { s.j = jawabAcak(s, 1); });
await ukur(`ujian ${MENIT || '?'} menit: cadangan jawaban`);
ok(`${lat.length}/${kirimCad} cadangan jawaban diterima server dalam ${Date.now() - t} ms (${waktu(lat)})`, lat.length === kirimCad);
await sleep(5000);
let diffRows = 0; for (;;) { const m = await mons[0].tunggu(x => x.t === 'diff', 500); if (!m) break; diffRows += m.rows.length; }
ok(`monitor guru tidak menerima data jawaban/progres selama ujian (${diffRows} baris)`, diffRows === 0);
const putusKon = sis.filter(s => s.peran === 'putus').length;
ok(`${putusKon} siswa yang koneksinya putus tidak menyambung ulang`, sis.filter(s => s.peran === 'putus').every(s => s.ws.readyState !== 1));
if (MENIT) { await adm.rpc('_dev', { offset: (MENIT - 0.5) * 60000 }); console.log(`  (jam server sekarang menit ke-${MENIT - 0.5} dari ${MENIT})`); }

console.log(`\nFase 3 — siswa menekan "Selesai" BERSAMAAN (yang koneksinya putus membuka 1 koneksi baru), lalu melihat nilai`);
async function kirimAkhir(s) {
  if (s.ws.readyState === 1) {
    s.ws.kirimJ({ t: 'selesai', id: 'f' + s.nis, j: { j: s.j, r: [] }, p: 0, a: '', mulai: s.mulai });
    const h = await s.ws.tunggu(m => m.t === 'hasil' || m.t === 'selesai' || m.t === 'err');
    return h && (h.t === 'hasil' || h.t === 'selesai') ? h.data : h;
  }
  s.ws = soket('siswa'); await s.ws.terbuka;      // 1 koneksi baru, hanya untuk mengirim jawaban akhir
  const r = await s.ws.rpc('selesaiUjian', { ujianId: s.u.id, jawaban: { j: s.j, r: [] }, pelanggaran: 0, perangkat: s.dev, mulai: s.mulai }, s.tok);
  return r.ok ? r.data : r;
}
const kirimSekarang = sis.filter(s => s.peran !== 'offline');
lat = []; t = Date.now();
const res = await Promise.all(kirimSekarang.map(async s => { const a = Date.now(); const h = await kirimAkhir(s); lat.push(Date.now() - a); return h; }));
ok(`${res.filter(x => x && x.status === 'selesai').length}/${kirimSekarang.length} selesai & dinilai dalam ${Date.now() - t} ms (${waktu(lat)})`, res.every(x => x && x.status === 'selesai'), res.find(x => !x || x.status !== 'selesai'));
const lihat = await Promise.all(sis.filter(s => s.peran === 'normal').slice(0, 50).map(s => s.ws.rpc('ujianSaya', {}, s.tok)));
ok('siswa melihat nilai di daftar ujian lewat koneksi yang sama', lihat.every(x => x.ok && x.data.some(u => u.status === 'selesai')), lihat.find(x => !x.ok));

const sisOff = sis.filter(s => s.peran === 'offline');
if (sisOff.length) {
  console.log(`\nFase 4 — ${sisOff.length} siswa offline saat waktu habis`);
  sisOff.forEach(s => s.ws.close());
  await adm.rpc('_dev', { offset: (MENIT + 3) * 60000, rawat: true });
  await sleep(5000);
  const mo = await adm.rpc('monitorUjian', { ujianId: ujian.X.id }, A);
  const hit = {}; mo.data.peserta.forEach(p => { hit[p.status] = (hit[p.status] || 0) + 1; });
  ok(`monitor PAS X: ${JSON.stringify(hit)} — siswa offline tampil Pending`, (hit.pending || 0) === sisOff.filter(s => s.u.id === ujian.X.id).length, hit);
  const rp = await Promise.all(sisOff.map(kirimAkhir));
  ok(`${rp.filter(x => x && x.status === 'selesai').length}/${sisOff.length} jawaban siswa offline diterima saat internet kembali (ditandai terlambat)`, rp.every(x => x && x.status === 'selesai' && /setelah waktu habis/.test(x.catatan)), rp.find(x => !x || x.status !== 'selesai'));
}
await sleep(4000);
await ukur('Selesai, penilaian & simpan hasil ke D1');
const uk = (await adm.rpc('_dev', { ukuranHasil: true })).data;
globalThis.UK = uk;
await ukur(null);   // kueri pengukuran ukuran di atas tidak dihitung
let total = 0, cocokJawab = 0;
for (const u of Object.values(ujian)) {
  const h = await adm.rpc('hasilUjian', { ujianId: u.id }, A);
  h.data.peserta.forEach(p => { if (p.status === 'selesai' && p.hasil) { total++; const s = sis.find(x => x.nis === p.nis); if (s && Object.keys(p.jawaban.j).length === Object.keys(s.j).length) cocokJawab++; } });
}
ok(`D1: ${total}/${N} hasil tersimpan permanen`, total === N);
ok(`${cocokJawab}/${N} hasil memakai jawaban LENGKAP dari perangkat (termasuk yang koneksinya putus)`, cocokJawab === N);
await ukur('admin membuka Hasil 3 ujian');
// sesi dilepas dari memori setelah jadwal ditutup (menghapus data sementara di penyimpanan internal)
mons.forEach(m => m.kirimJ({ t: 'lepas' })); await sleep(500);
await adm.rpc('_dev', { offset: 5 * 3600000, rawat: true });
await ukur('bersih-bersih setelah jadwal ditutup');
await adm.rpc('_dev', { offset: 0 });

// ---------------- guru mengedit soal: buka bank → edit → Simpan (lewat koneksi monitor masing-masing)
const bankG = (await adm.rpc('getBank', { id: b.id }, A)).data;
await Promise.all(mons.map(async (m, i) => {
  const tok = (await m.rpc('loginGuru', { username: 'pengawas' + i, password: 'awas123' })).data.token;
  const nb = (await m.rpc('saveBank', { bank: { judul: 'Bank guru ' + i, mapel: 'Matematika', tingkat: 'X', soal: bankG.soal } }, tok)).data.bank;
  const isi = (await m.rpc('getBank', { id: nb.id }, tok)).data;
  isi.soal[0].teks += ' (diperbaiki)';
  m.simpan = await m.rpc('saveBank', { bank: isi }, tok);
}));
ok(`${mons.filter(m => m.simpan && m.simpan.ok).length}/${GURU} guru membuat, membuka, mengedit & menyimpan bank soal`, mons.every(m => m.simpan && m.simpan.ok));
await ukur(`${GURU} guru membuat & mengedit bank soal (45 soal)`);
const hg = await Promise.all(mons.slice(0, 10).map(async (m, i) => { const tok = (await m.rpc('loginGuru', { username: 'pengawas' + i, password: 'awas123' })).data.token; return m.rpc('hasilUjian', { ujianId: UJ[i % 3].id }, tok); }));
ok('10 guru membuka Hasil & koreksi setelah sesi dilepas (dibaca dari D1)', hg.every(x => x.ok && x.data.peserta.length > 400));
await ukur('10 guru membuka Hasil (dari D1)');
sis.forEach(s => s.ws.close()); mons.forEach(m => m.close()); adm.close();

// ---------------- kuota (hanya siswa & guru pemantau; persiapan admin tidak dihitung)
const kon = per.siswa.koneksi + per.guru.koneksi, pes = per.siswa.pesan + per.guru.pesan;
console.log(`\nPemakaian kuota: ${N} siswa × 1 ujian${MENIT ? ' ' + MENIT + ' menit' : ''} + ${GURU} guru memantau`);
console.log(`  Worker requests ("Requests today") : ${kon}  (siswa ${per.siswa.koneksi} = ${N} + ${per.siswa.koneksi - N} kirim akhir setelah koneksi putus/offline; guru ${per.guru.koneksi}) · HTTP: ${hit.http}`);
console.log(`  Durable Object : ${kon} koneksi + ${pes} pesan masuk ÷ 20 = ${Math.round(kon + pes / 20)}  (pesan siswa ${per.siswa.pesan}, guru ${per.guru.pesan})`);
const doUjian = kon + pes / 20;
console.log(`\nBaris database untuk 1 sesi (${N} siswa, 3 ujian bersamaan, ${GURU} guru):`);
console.log('  ' + 'Kegiatan'.padEnd(48) + 'D1 baca'.padStart(9) + 'D1 tulis'.padStart(10) + 'DO baca'.padStart(9) + 'DO tulis'.padStart(10));
const jml = { d1r: 0, d1w: 0, dor: 0, dow: 0 };
for (const x of BARIS) { console.log('  ' + x.label.padEnd(48) + String(x.d1r).padStart(9) + String(x.d1w).padStart(10) + String(x.dor).padStart(9) + String(x.dow).padStart(10)); for (const k in jml) jml[k] += x[k]; }
console.log('  ' + 'JUMLAH'.padEnd(48) + String(jml.d1r).padStart(9) + String(jml.d1w).padStart(10) + String(jml.dor).padStart(9) + String(jml.dow).padStart(10));
globalThis.JML = jml;
console.log(`\nProyeksi 1 hari = 6 ujian seperti ini:`);
console.log(`  Worker  : ${(6 * kon).toLocaleString('id')} / 100.000  (tanpa koneksi putus: ${(6 * (N + GURU)).toLocaleString('id')}; terburuk, semua siswa putus: ${(6 * (2 * N + GURU)).toLocaleString('id')})`);
console.log(`  DO      : ±${Math.round(6 * doUjian).toLocaleString('id')} / 100.000`);
if (globalThis.UK) {
  const h = globalThis.UK.hasil, perHari = 6 * N * (h.rata + 60);
  console.log(`  Ukuran D1: hasil ${h.n} siswa = ${(h.total / 1048576).toFixed(2)} MB (rata-rata ${Math.round(h.rata)} byte/siswa, dikompres);`
    + ` ±${(perHari / 1048576).toFixed(1)} MB per hari 6 ujian → batas 500 MB tercapai setelah ±${Math.floor(500 * 1048576 / perHari)} hari ujian penuh`);
}
if (globalThis.JML) {
  const j = globalThis.JML;
  console.log(`  D1 baca : ±${(6 * j.d1r).toLocaleString('id')} / 5.000.000 baris`);
  console.log(`  D1 tulis: ±${(6 * j.d1w).toLocaleString('id')} / 100.000 baris`);
  console.log(`  DO baca : ±${(6 * j.dor).toLocaleString('id')} / 5.000.000 baris (penyimpanan internal mesin ujian)`);
  console.log(`  DO tulis: ±${(6 * j.dow).toLocaleString('id')} / 100.000 baris (penyimpanan internal mesin ujian)`);
}
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
