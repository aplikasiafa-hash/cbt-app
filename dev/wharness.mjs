// Harness: menjalankan worker.js (Cloudflare) di Node dengan D1 tiruan (node:sqlite),
// GitHub tiruan (dari gasmock) dan Google Form tiruan.
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
export const G = require('./gasmock.js');

// ---------------- waktu ----------------
const realNow = Date.now.bind(Date);
let OFFSET = 0;
Date.now = () => realNow() + OFFSET;
export const majukan = ms => { OFFSET += ms; };

// ---------------- D1 tiruan ----------------
export const d1stats = { reads: 0, writes: 0, queries: 0 };
class Stmt {
  constructor(db, sql, params) { this.db = db; this.sql = sql; this.params = params || []; }
  bind(...p) { for (const v of p) if (v === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\''); return new Stmt(this.db, this.sql, p); }
  _run() {
    d1stats.queries++;
    const st = this.db.d.prepare(this.sql);
    const rows = st.all(...this.params).map(r => ({ ...r }));
    const ch = this.db.d.prepare('SELECT changes() AS n').get().n;
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(this.sql)) d1stats.writes += ch; else d1stats.reads += rows.length;
    return rows;
  }
  async first(col) { const r = this._run()[0]; if (!r) return null; return col ? r[col] : r; }
  async all() { return { results: this._run(), success: true, meta: {} }; }
  async run() { this._run(); return { success: true, meta: {} }; }
}
export class D1 {
  constructor() { this.d = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(list) {
    this.d.exec('BEGIN');
    try { const out = list.map(s => ({ results: s._run(), success: true })); this.d.exec('COMMIT'); return out; }
    catch (e) { this.d.exec('ROLLBACK'); throw e; }
  }
}

// ---------------- Google Form tiruan ----------------
export const GF_ID = '1FAIpQLSeUjiCobaFormCBT_test1234567890abcdef';
const IMG1 = 'https://docs.google.com/forms-images-rt/GAMBAR_STIMULUS_1?key=abc&amp;w=640';
const IMG2 = 'https://lh3.googleusercontent.com/GAMBAR_SOAL_2=w600';
export const FB = [null, [
  'Ulangan harian Bab 1. Kerjakan dengan jujur.',
  [
    [111, 'Nama Lengkap', null, 0, [[1001, null, 1]]],
    [112, 'Kelas', null, 0, [[1002, null, 0]]],
    [126, 'No. Absen / NIS', null, 0, [[1013, null, 0]]],
    [113, 'Ibu kota Indonesia adalah ...', 'Pilih satu.', 2, [[1003, [['Jakarta', null, null, null, 0], ['Bandung', null, null, null, 0], ['Surabaya', null, null, null, 0], ['', null, null, null, 1]], 1]]],
    [114, 'Pilih bilangan genap', null, 4, [[1004, [['2', null, null, null, 0], ['3', null, null, null, 0], ['4', null, null, null, 0]], 0]]],
    [115, 'Petunjuk bagian A', 'Bacalah teks berikut: "Laut itu biru."', 6, null],
    [116, null, null, 11, null, null, ['img-x', 0, [640, 480, 0]]],
    [117, 'Warna laut menurut teks adalah ...', null, 3, [[1005, [['Biru', null, null, null, 0], ['Hijau', null, null, null, 0]], 0]]],
    [118, 'Seberapa yakin kamu?', null, 5, [[1006, [['1'], ['2'], ['3'], ['4'], ['5']], 0, ['Ragu', 'Yakin']]]],
    [119, 'Bagian 2', 'Uraian', 8, null],
    [120, 'Jelaskan proses hujan.', null, 1, [[1007, null, 0]]],
    [121, 'Isilah tabel kebiasaan', null, 7, [
      [1008, [['Pernah'], ['Tidak']], 0, ['Membaca buku'], null, null, null, null, null, null, null, [0]],
      [1009, [['Pernah'], ['Tidak']], 0, ['Berolahraga'], null, null, null, null, null, null, null, [0]]
    ]],
    [122, 'Tanggal lahir', null, 9, [[1010, null, 0]]],
    [123, 'Jam bangun pagi', null, 10, [[1011, null, 0]]],
    [124, 'Unggah tugas', null, 13, [[1012, null, 0]]],
    [125, 'Video pembelajaran', null, 12, null]
  ],
  null, null, null, [null, 0], null, null, 'Ulangan Bab 1'
], '/forms', 'Ulangan Bab 1 (file)', null, null, null, '0', null, 0, 0, null, 'Google.com', 1, 'e/' + GF_ID];

function htmlForm() {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const items = FB[1][1].map(it => {
    const img = it[0] === 116 ? '<img src="' + IMG1 + '">' : it[0] === 117 ? '<img src="' + IMG2 + '">' : '';
    const attr = it[3] === 11 ? 'data-item-id="' + it[0] + '"' : 'data-params="%.@.[' + it[0] + ',' + esc(JSON.stringify(it[1])) + ',null]"';
    return '<div class="Qr7Oae" role="listitem"><div jsmodel="x" ' + attr + '>' + esc(it[1] || '') + img + '</div></div>';
  }).join('');
  return '<!doctype html><html><head><script>var FB_PUBLIC_LOAD_DATA_ = ' + JSON.stringify(FB) + '\n;</script></head><body><form action="formResponse"><input type="hidden" name="fbzx" value="-123">' + items + '</form></body></html>';
}
export const gfState = { submissions: [], tolakSemua: false, mintaLogin: false };
function terimaForm(body) {
  const p = new URLSearchParams(body);
  if (gfState.tolakSemua) return [400, '<html>FB_PUBLIC_LOAD_DATA_ = []; <input name="entry.1003"></html>'];
  const items = FB[1][1];
  for (const it of items) {
    const qs = it[3] === 7 ? it[4] : (it[4] ? [it[4][0]] : []);
    for (const q of qs) {
      const e = 'entry.' + q[0];
      const vals = p.getAll(e);
      if (it[3] === 9) { if (q[2] && !p.get(e + '_year')) return [400, 'wajib']; continue; }
      if (it[3] === 10) { if (q[2] && !p.get(e + '_hour')) return [400, 'wajib']; continue; }
      if (q[2] && !vals.length) return [400, '<html>FB_PUBLIC_LOAD_DATA_ = []; wajib ' + e + '</html>'];
      if (q[1] && vals.length) {
        const ok = q[1].map(o => String(o[0]));
        for (const v of vals) if (!ok.includes(v)) return [400, '<html>FB_PUBLIC_LOAD_DATA_ = []; pilihan tidak valid ' + e + '=' + v + '</html>'];
      }
    }
  }
  gfState.submissions.push(p);
  return [200, '<html><div class="vHW8K">Tanggapan Anda telah direkam.</div></html>'];
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005fe02fea7d6a5e50000000049454e44ae426082', 'hex');

// ---------------- fetch tiruan ----------------
export const netStats = { github: 0, gform: 0, lain: 0 };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toLowerCase();
  const mk = (status, body, headers, finalUrl) => { const r = new Response(body, { status, headers }); Object.defineProperty(r, 'url', { value: finalUrl || url.href }); return r; };
  await new Promise(r => setTimeout(r, 1));
  if (url.host === 'api.github.com') {
    netStats.github++;
    if (!String(init.headers.Authorization).includes('TEST_TOKEN')) return mk(401, '{"message":"Bad credentials"}');
    const [code, text] = G.ghRoute(method, url.pathname + url.search, init.headers, init.body);
    return mk(code, Buffer.isBuffer(text) ? text : text, { 'content-type': 'application/json' });
  }
  if (url.host === 'gform.test' || url.host === 'docs.google.com' || url.host.endsWith('googleusercontent.com')) {
    netStats.gform++;
    if (/GAMBAR_/.test(url.pathname)) return mk(200, PNG, { 'content-type': 'image/png' });
    if (gfState.mintaLogin) return mk(200, '<html>login</html>', {}, 'https://accounts.google.com/ServiceLogin?continue=x');
    if (url.pathname === '/forms/d/e/' + GF_ID + '/viewform') return mk(200, htmlForm(), { 'content-type': 'text/html' });
    if (url.pathname === '/forms/d/e/' + GF_ID + '/formResponse' && method === 'post') { const [c, t] = terimaForm(init.body); return mk(c, t, { 'content-type': 'text/html' }); }
    return mk(404, 'not found');
  }
  netStats.lain++;
  throw new Error('fetch tak terduga: ' + url.href);
};

// ---------------- worker ----------------
export function bootData() { G.boot(); return G; }
export const env = { DB: new D1(), GITHUB_TOKEN: 'TEST_TOKEN', SECRET: 'rahasia-uji-123', DATA_REPO: 'sekolah/cbt-data', MEDIA_REPO: 'sekolah/cbt-media', BRANCH: 'main', GFORM_BASE: 'https://gform.test' };
let n = 0;
export async function isolate() { return (await import('../worker/worker.js?i=' + (n++))); }
export const tertunda = [];
export async function call(w, action, data, token) {
  const ctx = { waitUntil: p => tertunda.push(p) };
  const res = await w.default.fetch(new Request('https://cbt.test/', { method: 'POST', body: JSON.stringify({ action, data, token }) }), env, ctx);
  return res.json();
}
export async function selesaikanTertunda() { while (tertunda.length) await Promise.allSettled(tertunda.splice(0)); }
export async function cron(w) { const ps = []; await w.default.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, { waitUntil: p => ps.push(p) }); await Promise.allSettled(ps); }
export const data = p => G.headFiles('sekolah/cbt-data').get(p);
export const dataFiles = () => [...G.headFiles('sekolah/cbt-data').keys()];
