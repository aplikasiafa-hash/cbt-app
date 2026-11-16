// GitHub API tiruan (untuk uji lokal unggah gambar, cadangan, dan impor). node test/github-tiruan.mjs <tar.gz>
import http from 'node:http'; import fs from 'node:fs'; import crypto from 'node:crypto';
const TAR = process.argv[2];
const sha = () => crypto.randomBytes(20).toString('hex');
const log = [], trees = {}, commits = {}; let head = sha(); commits[head] = { tree: 't0' }; trees.t0 = {};
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const p = req.url.split('?')[0], m = req.method; let o = 404, j = { message: 'Not Found' }, m2;
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) { o = 401; j = { message: 'Bad credentials' }; }
    else if ((m2 = p.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && m === 'GET') { o = 200; j = { full_name: m2[1] + '/' + m2[2], private: m2[2] === 'cbt-data' }; }
    else if (/\/tarball\//.test(p) && m === 'GET') { res.writeHead(200, { 'content-type': 'application/x-gzip' }); return res.end(fs.readFileSync(TAR)); }
    else if (/\/contents\//.test(p) && m === 'PUT') { const b = JSON.parse(body); log.push({ put: p, bytes: b.content.length }); o = 201; j = { commit: { sha: sha() } }; }
    else if (/\/git\/ref\/heads\//.test(p) && m === 'GET') { o = 200; j = { object: { sha: head } }; }
    else if ((m2 = p.match(/\/git\/commits\/(\w+)$/)) && m === 'GET') { o = 200; j = { tree: { sha: commits[m2[1]].tree } }; }
    else if (/\/git\/trees$/.test(p) && m === 'POST') { const b = JSON.parse(body), t = sha(); trees[t] = { ...trees[b.base_tree] }; b.tree.forEach(x => { if (x.sha === null) delete trees[t][x.path]; else trees[t][x.path] = x.content; }); o = 201; j = { sha: t }; }
    else if (/\/git\/commits$/.test(p) && m === 'POST') { const b = JSON.parse(body), c = sha(); commits[c] = { tree: b.tree, message: b.message }; o = 201; j = { sha: c }; }
    else if (/\/git\/refs\/heads\//.test(p) && m === 'PATCH') { const b = JSON.parse(body); head = b.sha; log.push({ commit: commits[head].message, files: Object.keys(trees[commits[head].tree]) }); o = 200; j = { object: { sha: head } }; }
    else if (p === '/_log') { o = 200; j = { log, files: trees[commits[head].tree] }; }
    res.writeHead(o, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
  });
}).listen(9999, '127.0.0.1', () => console.log('github tiruan :9999'));
