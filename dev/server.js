// MODE UJI LOKAL — menjalankan Code.gs asli dengan tiruan Google Apps Script & GitHub (data di memori).
// Jalankan: node dev/server.js  lalu buka http://localhost:8787/guru/ dan http://localhost:8787/siswa/
// Login: admin/admin123, guru/guru123, siswa 1001/1001. Data hilang saat server dimatikan.
const http = require('http');
const fs = require('fs');
const path = require('path');
const G = require('./gasmock');
const ctx = G.boot();
const ROOT = path.join(__dirname, '..');
const NM = path.join(__dirname, 'node_modules');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
let delay = 0;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(405); return res.end(); } // GAS tidak melayani preflight
  if (u.pathname === '/exec' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      if (req.headers['content-type'] && !/^text\/plain/.test(req.headers['content-type'])) { res.writeHead(400); return res.end('content-type harus text/plain'); }
      setTimeout(() => {
        G.freshExec(ctx);
        const out = ctx.doPost({ postData: { contents: body } }).getContent();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out);
      }, delay);
    });
    return;
  }
  if (u.pathname.startsWith('/__debug/')) {
    const cmd = u.pathname.slice(9); let out = {};
    if (cmd === 'flush') { G.freshExec(ctx); out = ctx.prosesAntrian(true); }
    if (cmd === 'advance') { G.setOffset(G.getOffset() + Number(u.searchParams.get('ms'))); out = { offset: G.getOffset() }; }
    if (cmd === 'file') { const f = G.headFiles(u.searchParams.get('repo') || 'sekolah/cbt-data').get(u.searchParams.get('path')); out = { ada: f !== undefined, isi: f === undefined ? null : (Buffer.isBuffer(f) ? '(binary ' + f.length + ')' : f) }; }
    if (cmd === 'log') out = G.repos['sekolah/cbt-data'].log;
    if (cmd === 'delay') { delay = Number(u.searchParams.get('ms')); out = { delay }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
  }
  if (u.pathname.startsWith('/__media/')) { // tiruan CDN jsDelivr untuk repo media
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
    if (fp.endsWith('.html')) data = Buffer.from(String(data).replace('<head>', '<head><script>window.CBT_API_URL = "http://localhost:8787/exec";</script>'));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(8787, () => console.log('Mode uji lokal siap:\n  Guru : http://localhost:8787/guru/\n  Siswa: http://localhost:8787/siswa/'));
