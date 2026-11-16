// Server uji untuk versi Cloudflare: POST /exec -> worker.js (D1 & GitHub tiruan), file statis /guru /siswa
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { G, env, isolate, cron, majukan, bootData, gfState, selesaikanTertunda } from './wharness.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
bootData();
const W = await isolate();
const ROOT = path.join(__dirname, '..');
const NM = path.join(__dirname, 'node_modules');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
let delay = 0;
const tunda = [];

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/exec') {
    let body = ''; req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    if (delay) await new Promise(r => setTimeout(r, delay));
    const r = await W.default.fetch(new Request('https://cbt.test/', { method: req.method, body: req.method === 'POST' ? body : undefined, headers: req.headers }), env, { waitUntil: p => tunda.push(p) });
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (u.pathname.startsWith('/__debug/')) {
    const cmd = u.pathname.slice(9); let out = {};
    if (cmd === 'flush') { await Promise.allSettled(tunda.splice(0)); await cron(W); out = { ok: true }; }
    if (cmd === 'advance') { majukan(Number(u.searchParams.get('ms'))); out = { ok: true }; }
    if (cmd === 'file') { const f = G.headFiles(u.searchParams.get('repo') || 'sekolah/cbt-data').get(u.searchParams.get('path')); out = { ada: f !== undefined, isi: f === undefined ? null : (Buffer.isBuffer(f) ? '(binary ' + f.length + ')' : f) }; }
    if (cmd === 'files') out = [...G.headFiles('sekolah/cbt-data').keys()];
    if (cmd === 'log') out = G.repos['sekolah/cbt-data'].log;
    if (cmd === 'delay') { delay = Number(u.searchParams.get('ms')); out = { delay }; }
    if (cmd === 'gform') { await Promise.allSettled(tunda.splice(0)); out = gfState.submissions.map(p => [...p.entries()]); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
  }
  if (u.pathname.startsWith('/__media/')) {
    const p = decodeURIComponent(u.pathname.slice(9)); const f = G.headFiles('sekolah/cbt-media').get(p);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); return res.end(f);
  }
  let fp;
  if (u.pathname.startsWith('/__lib/')) fp = path.join(NM, u.pathname.slice(7));
  else { fp = path.join(ROOT, u.pathname); if (u.pathname.endsWith('/')) fp = path.join(fp, 'index.html'); }
  if (!fp.startsWith(ROOT) && !fp.startsWith(NM)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(8787, () => console.log('server worker siap :8787'));
