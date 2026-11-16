// Uji beban: N siswa (default 1300) login, mulai, autosave lewat WebSocket, dan selesai BERSAMAAN.
// Juga menghitung pemakaian kuota Cloudflare per ujian.
// node test/beban.mjs [fase]    fase: semua | siapkan | mulai | lanjut
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const N = Number(process.env.N || 1300);
const AUTOSAVE = Number(process.env.AUTOSAVE || 6);   // jumlah autosave per siswa dalam uji
const FASE = process.argv[2] || 'semua';
const STATE = '/tmp/beban-state.json';
const hit = { worker: 0, doHttp: 0, wsConn: 0, wsMsg: 0 };
const LOKAL = new Set(['ping', 'loginSiswa', 'loginGuru', 'ujianSaya', 'getConfig']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (n, c, info) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : '  ' + JSON.stringify(info).slice(0, 300))); if (!c) fails++; };

async function call(action, data = {}, token = '', coba = 4) {
  for (let i = 0; ; i++) {
    hit.worker++; if (!LOKAL.has(action)) hit.doHttp++;
    try {
      const r = await fetch(BASE + '/api?a=' + action, { method: 'POST', body: JSON.stringify({ action, data, token }) });
      const j = await r.json();
      if (j.ok || j.code !== 'BUSY' || i >= coba) return j;
    } catch (e) { if (i >= coba) return { ok: false, error: String(e), code: 'NET' }; }
    await sleep(300 * 2 ** i * Math.random());
  }
}
async function pool(items, conc, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
function wsBuka(q) {
  hit.worker++; hit.wsConn++;
  const ws = new WebSocket(WSB + '/api/ws?' + new URLSearchParams(q));
  const inbox = []; let w = null;
  ws.addEventListener('message', ev => { inbox.push(JSON.parse(ev.data)); if (w) { const f = w; w = null; f(); } });
  ws.tunggu = async (pred, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) return null;
      await new Promise(r => { w = r; setTimeout(r, 200); });
    }
  };
  ws.kirimJ = o => { hit.wsMsg++; ws.send(JSON.stringify(o)); };
  ws.terbuka = new Promise(res => { ws.addEventListener('open', () => res(true)); ws.addEventListener('error', () => res(false)); });
  return ws;
}
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0; };
const waktu = arr => `median ${pct(arr, 0.5)} ms · p95 ${pct(arr, 0.95)} ms · maks ${pct(arr, 1)} ms`;

// ------------------------------------------------------------------
async function siapkan() {
  console.log(`Persiapan: ${N} siswa, 3 ujian (X, XI, XII)`);
  const adm = (await call('loginGuru', { username: 'admin', password: 'admin123' })).data.token;
  const rows = [], tingkat = ['X', 'XI', 'XII'];
  for (let i = 0; i < N; i++) { const t = tingkat[i % 3]; rows.push({ nis: String(70000 + i), nama: 'Siswa ' + i, kelas: t + '-' + (1 + Math.floor(i / 3) % 12) }); }
  let t = Date.now();
  const imp = await call('importSiswa', { rows }, adm);
  ok(`impor ${N} siswa dalam ${Date.now() - t} ms`, imp.ok && imp.data.baru === N, imp);
  // bank 40 soal PG + beberapa jenis lain (seperti ujian sungguhan)
  const contoh = (await call('getBank', { id: 'bcontoh01' }, adm)).data;
  const soal = [];
  for (let k = 0; k < 40; k++) soal.push({ tipe: 'pg', teks: `Soal nomor ${k + 1}: ` + 'Lorem ipsum dolor sit amet, teks soal yang cukup panjang. '.repeat(3), bobot: 1, opsi: ['A', 'B', 'C', 'D', 'E'].map(x => ({ teks: 'Pilihan ' + x + ' untuk soal ' + (k + 1) })), kunci: '' });
  const b = (await call('saveBank', { bank: { judul: 'Beban 45 soal', mapel: 'Matematika', tingkat: 'X', soal: soal.concat(contoh.soal.slice(1, 6)) } }, adm)).data.bank;
  b.soal.forEach(s => { if (s.tipe === 'pg' && !s.kunci) s.kunci = s.opsi[0].id; });
  await call('saveBank', { bank: b }, adm);
  const t0 = Date.now(), ujian = [];
  for (const tg of tingkat) {
    const kelas = [...new Set(rows.filter(r => r.kelas.startsWith(tg + '-')).map(r => r.kelas))];
    const u = (await call('saveUjian', { nama: 'PAS ' + tg, bankId: b.id, kelas, mulai: t0 - 60000, selesai: t0 + 4 * 3600000, durasi: 90, acakSoal: true, acakOpsi: true, tampilNilai: true, pakaiToken: true, maxPelanggaran: 0 }, adm)).data;
    ujian.push(u);
  }
  ok('3 jadwal dibuat', ujian.length === 3 && ujian.every(u => u.token), ujian);
  fs.writeFileSync(STATE, JSON.stringify({ adm, ujian, bankId: b.id, rows }));
}

// ------------------------------------------------------------------
async function mulai() {
  const { adm, ujian, rows } = JSON.parse(fs.readFileSync(STATE));
  const uMap = Object.fromEntries(ujian.map(u => [u.nama.split(' ')[1], u]));
  const sis = rows.map(r => ({ ...r, u: uMap[r.kelas.split('-')[0]], dev: 'dev-' + r.nis }));

  console.log(`\nFase 1 — ${N} siswa login BERSAMAAN`);
  let lat = [], t = Date.now();
  const login = await pool(sis, N, async s => { const a = Date.now(); const r = await call('loginSiswa', { nis: s.nis, password: s.nis }); lat.push(Date.now() - a); if (r.ok) s.tok = r.data.token; return r.ok; });
  ok(`${login.filter(Boolean).length}/${N} login berhasil dalam ${Date.now() - t} ms (${waktu(lat)})`, login.every(Boolean));

  console.log(`\nFase 2 — ${N} siswa membuka daftar & mulai ujian BERSAMAAN`);
  lat = []; t = Date.now();
  const mul = await pool(sis, N, async s => {
    const a = Date.now();
    const d = await call('ujianSaya', {}, s.tok);
    if (!d.ok || !d.data.length) return d;
    const r = await call('mulaiUjian', { ujianId: s.u.id, token: s.u.token, perangkat: s.dev }, s.tok);
    lat.push(Date.now() - a);
    if (r.ok) { s.soal = r.data.soal; s.deadline = r.data.deadline; }
    return r.ok;
  });
  ok(`${mul.filter(x => x === true).length}/${N} mulai berhasil dalam ${Date.now() - t} ms (${waktu(lat)})`, mul.every(x => x === true), mul.find(x => x !== true));

  console.log(`\nFase 3 — ${N} WebSocket + 3 monitor guru, ${AUTOSAVE}× autosave per siswa`);
  const mons = ujian.map(u => wsBuka({ t: adm, m: u.id }));
  await Promise.all(mons.map(m => m.terbuka));
  const snaps = await Promise.all(mons.map(m => m.tunggu(x => x.t === 'snap')));
  ok('3 monitor menerima snapshot', snaps.every(s => s && s.data.peserta.length > 0), snaps.map(s => s && s.data.peserta.length));
  t = Date.now();
  await pool(sis, N, async s => { s.ws = wsBuka({ t: s.tok, u: s.u.id, p: s.dev }); await s.ws.terbuka; s.hai = await s.ws.tunggu(m => m.t === 'hai'); });
  ok(`${sis.filter(s => s.hai).length}/${N} WebSocket tersambung dalam ${Date.now() - t} ms`, sis.every(s => s.hai));
  lat = []; t = Date.now();
  for (let k = 0; k < AUTOSAVE; k++) {
    await Promise.all(sis.map(async s => {
      const j = {}; s.soal.slice(0, Math.round((k + 1) / AUTOSAVE * s.soal.length)).forEach(q => { if (q.opsi) j[q.id] = q.opsi[Math.floor(Math.random() * q.opsi.length)].id; else if (q.tipe === 'isian' || q.tipe === 'uraian') j[q.id] = 'jawaban ' + s.nis; });
      s.j = j;
      const a = Date.now(); s.ws.kirimJ({ t: 'j', j: { j, r: [] }, p: 0, v: k + 1 });
      const ack = await s.ws.tunggu(m => m.t === 'ok' && m.v === k + 1);
      if (ack) lat.push(Date.now() - a);
    }));
  }
  ok(`${lat.length}/${N * AUTOSAVE} autosave di-ack dalam ${Date.now() - t} ms (${waktu(lat)})`, lat.length === N * AUTOSAVE);
  await sleep(5000);
  const d = await call('monitorUjian', { ujianId: ujian[0].id }, adm);
  const target = sis.filter(s => s.u.id === ujian[0].id);
  const cocok = target.filter(s => { const p = d.data.peserta.find(x => x.nis === s.nis); return p && p.terjawab === Object.keys(s.j).length && p.online; }).length;
  ok(`monitor: ${cocok}/${target.length} siswa PAS X terlihat online dengan progres benar`, cocok === target.length);
  const diffN = mons[0]; let diffRows = 0; for (;;) { const m = await diffN.tunggu(x => x.t === 'diff', 500); if (!m) break; diffRows += m.rows.length; }
  ok(`monitor menerima pembaruan langsung (${diffRows} baris diff)`, diffRows > 0);
  fs.writeFileSync(STATE, JSON.stringify({ adm, ujian, rows, sis: sis.map(s => ({ nis: s.nis, tok: s.tok, u: s.u, dev: s.dev, j: s.j, deadline: s.deadline })), hit }));
  // simpan cadangan jawaban sekarang (biasanya otomatis tiap 2 menit)
  const sy = await call('sinkronSekarang', {}, adm);
  ok('cadangan jawaban sementara ditulis', sy.ok, sy);
  sis.forEach(s => s.ws.close()); mons.forEach(m => m.close());
  await sleep(1000);
}

// ------------------------------------------------------------------
async function lanjut(setelahRestart) {
  const st = JSON.parse(fs.readFileSync(STATE));
  Object.assign(hit, st.hit || {});
  const { adm, ujian } = st, sis = st.sis;
  if (setelahRestart) {
    console.log(`\nFase 4 — server di-restart di tengah ujian: ${N} siswa menyambung ulang`);
    const d = await call('monitorUjian', { ujianId: ujian[1].id }, adm);
    const target = sis.filter(s => s.u.id === ujian[1].id);
    const pulih = target.filter(s => { const p = d.data.peserta.find(x => x.nis === s.nis); return p && p.status === 'mengerjakan' && p.terjawab === Object.keys(s.j).length && p.deadline === s.deadline; }).length;
    ok(`setelah restart: ${pulih}/${target.length} siswa PAS XI pulih (status, deadline, dan jawaban sama)`, pulih === target.length);
  }
  let t = Date.now();
  await pool(sis, N, async s => { s.ws = wsBuka({ t: s.tok, u: s.u.id, p: s.dev }); await s.ws.terbuka; s.hai = await s.ws.tunggu(m => m.t === 'hai'); });
  ok(`${sis.filter(s => s.hai && s.hai.deadline === s.deadline).length}/${N} tersambung ulang dengan deadline tetap (${Date.now() - t} ms)`, sis.every(s => s.hai && s.hai.deadline === s.deadline));

  console.log(`\nFase 5 — ${N} siswa menekan "Selesai" BERSAMAAN`);
  const lat = []; t = Date.now();
  const res = await Promise.all(sis.map(async s => {
    const a = Date.now(); s.ws.kirimJ({ t: 'selesai', id: 'f' + s.nis, j: { j: s.j, r: [] }, p: 0, a: '' });
    const h = await s.ws.tunggu(m => m.t === 'hasil' || m.t === 'selesai' || m.t === 'err', 60000);
    lat.push(Date.now() - a); return h && (h.t === 'hasil' || h.t === 'selesai') ? h.data : h;
  }));
  ok(`${res.filter(r => r && r.status === 'selesai').length}/${N} selesai & dinilai dalam ${Date.now() - t} ms (${waktu(lat)})`, res.every(r => r && r.status === 'selesai'), res.find(r => !r || r.status !== 'selesai'));
  sis.forEach(s => s.ws.close());
  await sleep(4000);
  let total = 0;
  for (const u of ujian) {
    const h = await call('hasilUjian', { ujianId: u.id }, adm);
    const n = h.data.peserta.filter(p => p.status === 'selesai' && p.hasil).length; total += n;
  }
  ok(`D1: ${total}/${N} hasil tersimpan permanen`, total === N);
  const sx = await call('ujianSaya', {}, sis[5].tok);
  ok('siswa melihat nilainya di daftar ujian', sx.ok && sx.data.some(u => u.status === 'selesai' && u.nilai !== undefined), sx);

  // ---------------- kuota
  const SE = N;
  const perSE_W = hit.worker / SE, perSE_DO = (hit.doHttp + hit.wsConn + hit.wsMsg / 20) / SE;
  console.log(`\nPemakaian kuota dalam uji ini (${N} siswa × 1 ujian, ${AUTOSAVE} autosave/siswa):`);
  console.log(`  Worker requests : ${hit.worker}  (${perSE_W.toFixed(2)} per siswa-ujian)`);
  console.log(`  Durable Object  : ${hit.doHttp} HTTP + ${hit.wsConn} koneksi WS + ${hit.wsMsg} pesan WS (÷20) = ${(hit.doHttp + hit.wsConn + hit.wsMsg / 20).toFixed(0)}  (${perSE_DO.toFixed(2)} per siswa-ujian)`);
  // proyeksi ujian 90 menit nyata: autosave tiap 60 dtk saat ada perubahan → ±90 pesan; + 1 sambung ulang
  const nyataW = 0.33 /*login 1x/hari*/ + 1.5 /*ujianSaya*/ + 1.1 /*mulai*/ + 2 /*koneksi WS + 1x sambung ulang*/;
  const nyataDO = 1.1 + 2 + (90 + 2) / 20;
  const sehari = 6 * N;
  console.log(`\nProyeksi 1 hari: ${N} siswa × 6 ujian @90 menit (autosave tiap 60 detik):`);
  console.log(`  Worker  : ±${Math.round(nyataW * sehari).toLocaleString('id')} / 100.000 per hari`);
  console.log(`  DO      : ±${Math.round(nyataDO * sehari).toLocaleString('id')} / 100.000 per hari`);
  console.log(`  D1 tulis: ±${Math.round(2 * sehari).toLocaleString('id')} baris / 100.000 per hari`);
}

if (FASE === 'siapkan' || FASE === 'semua') await siapkan();
if (FASE === 'mulai' || FASE === 'semua') await mulai();
if (FASE === 'lanjut' || FASE === 'semua') await lanjut(FASE === 'lanjut');
console.log(fails ? `\n${fails} GAGAL` : '\nSEMUA LULUS');
process.exit(fails ? 1 : 0);
