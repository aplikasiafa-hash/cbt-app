// Harness: menjalankan Code.gs asli di Node dengan tiruan layanan Google Apps Script + GitHub API
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

let TIME_OFFSET = 0;
const now = () => Date.now() + TIME_OFFSET;

// ---------------- Fake GitHub ----------------
const repos = {};
function mkRepo(name, isPrivate) { repos[name] = { private: isPrivate, head: null, commits: {}, trees: {}, log: [] }; }
function sha() { return crypto.randomBytes(20).toString('hex'); }
function headFiles(repo) { const r = repos[repo]; if (!r.head) return new Map(); return r.trees[r.commits[r.head].tree]; }
function commitFiles(repo, files, message) {
  const r = repos[repo]; const t = new Map(headFiles(repo));
  for (const [p, c] of Object.entries(files)) { if (c === null) t.delete(p); else t.set(p, c); }
  const ts = sha(); r.trees[ts] = t; const cs = sha();
  r.commits[cs] = { tree: ts, parents: r.head ? [r.head] : [], message }; r.head = cs; r.log.push(message); return cs;
}
const ghStats = { calls: 0 };
function ghRoute(method, path, headers, body) {
  ghStats.calls++;
  let m;
  const [p, q] = path.split('?');
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)$/)) && method === 'get') {
    const r = repos[m[1]]; if (!r) return [404, '{"message":"Not Found"}'];
    return [200, JSON.stringify({ full_name: m[1], private: r.private })];
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/))) {
    const repo = m[1], fp = decodeURIComponent(m[2]); const r = repos[repo]; if (!r) return [404, '{}'];
    if (method === 'get') {
      const f = headFiles(repo).get(fp); if (f === undefined) return [404, '{"message":"Not Found"}'];
      return [200, Buffer.isBuffer(f) ? f.toString('utf8') : f];
    }
    if (method === 'put') {
      const b = JSON.parse(body); if (headFiles(repo).has(fp) && !b.sha) return [422, '{"message":"sha required"}'];
      const buf = Buffer.from(b.content, 'base64');
      const isText = /\.(json|md|txt)$/.test(fp);
      const cs = commitFiles(repo, { [fp]: isText ? buf.toString('utf8') : buf }, b.message);
      return [201, JSON.stringify({ content: { path: fp }, commit: { sha: cs } })];
    }
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/)) && method === 'get') {
    const r = repos[m[1]]; if (!r.head) return [409, '{"message":"Git Repository is empty."}'];
    return [200, JSON.stringify({ object: { sha: r.head } })];
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/commits\/([0-9a-f]+)$/)) && method === 'get') {
    const c = repos[m[1]].commits[m[2]]; if (!c) return [404, '{}'];
    return [200, JSON.stringify({ sha: m[2], tree: { sha: c.tree } })];
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/trees$/)) && method === 'post') {
    const r = repos[m[1]], b = JSON.parse(body); const t = new Map(r.trees[b.base_tree]);
    for (const e of b.tree) { if (e.sha === null) { if (!t.has(e.path)) return [422, '{"message":"path not in tree"}']; t.delete(e.path); } else t.set(e.path, e.content); }
    const ts = sha(); r.trees[ts] = t; return [201, JSON.stringify({ sha: ts })];
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/commits$/)) && method === 'post') {
    const r = repos[m[1]], b = JSON.parse(body); const cs = sha();
    r.commits[cs] = { tree: b.tree, parents: b.parents, message: b.message }; return [201, JSON.stringify({ sha: cs })];
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/)) && method === 'patch') {
    const r = repos[m[1]], b = JSON.parse(body); const c = r.commits[b.sha];
    if (!c || c.parents[0] !== r.head) return [422, '{"message":"Update is not a fast forward"}'];
    r.head = b.sha; r.log.push(c.message); return [200, JSON.stringify({ object: { sha: b.sha } })];
  }
  return [404, JSON.stringify({ message: 'route not mocked: ' + method + ' ' + path })];
}

// ---------------- Fake Sheets ----------------
const spreadsheets = {};
function colIsText(sheet, c, r) { return sheet.formats[r + ':' + c] === '@'; }
class Range {
  constructor(sheet, r, c, nr, nc) {
    if (r + nr - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sheet.data[this.r + i - 1] || [])[this.c + j - 1]; row.push(v === undefined || v === null ? '' : v); } out.push(row); }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('setValues dimension mismatch ' + vals.length + 'x' + vals[0].length + ' vs ' + this.nr + 'x' + this.nc);
    for (let i = 0; i < this.nr; i++) {
      const R = this.r + i; this.sheet.data[R - 1] = this.sheet.data[R - 1] || [];
      for (let j = 0; j < this.nc; j++) {
        let v = vals[i][j]; const Cc = this.c + j;
        if (v === undefined || v === null) v = '';
        if (typeof v === 'string' && !colIsText(this.sheet, Cc, R) && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v); // perilaku Sheets
        if (typeof v === 'string' && v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
        this.sheet.data[R - 1][Cc - 1] = v;
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat(f) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.formats[(this.r + i) + ':' + (this.c + j)] = f; return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; this.formats = {}; }
  getName() { return this.name; } setName(n) { this.name = n; return this; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  setFrozenRows() { return this; }
  getLastRow() { for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i] && this.data[i].some(v => v !== '' && v !== undefined && v !== null)) return i + 1; return 0; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
}
function mkSpreadsheet(name) {
  const id = 'ss_' + crypto.randomBytes(6).toString('hex');
  const ss = { id, name, sheets: [new Sheet('Sheet1')] };
  const api = {
    getId: () => id, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id,
    getSheetByName: n => ss.sheets.find(s => s.name === n) || null,
    getSheets: () => ss.sheets, insertSheet: n => { const s = new Sheet(n); ss.sheets.push(s); return s; }
  };
  spreadsheets[id] = api; return api;
}

// ---------------- Cache / Properties / Lock ----------------
const cacheStore = new Map();
const Cache = {
  get(k) { const e = cacheStore.get(k); if (!e || e.exp < now()) return null; return e.v; },
  getAll(keys) { const o = {}; keys.forEach(k => { const v = Cache.get(k); if (v !== null) o[k] = v; }); return o; },
  put(k, v, ttl) { if (typeof v !== 'string') throw new Error('cache value must be string'); if (Buffer.byteLength(v) > 100 * 1024) throw new Error('Argument too large: value'); if (k.length > 250) throw new Error('key too long'); cacheStore.set(k, { v, exp: now() + (ttl || 600) * 1000 }); },
  putAll(o, ttl) { Object.entries(o).forEach(([k, v]) => Cache.put(k, v, ttl)); },
  remove(k) { cacheStore.delete(k); }
};
const propStore = {};
const Props = {
  getProperties: () => ({ ...propStore }), getProperty: k => (k in propStore ? propStore[k] : null),
  setProperty(k, v) { propStore[k] = String(v); return Props; }, setProperties(o) { Object.entries(o).forEach(([k, v]) => propStore[k] = String(v)); return Props; },
  deleteProperty(k) { delete propStore[k]; return Props; }
};
let lockHeld = false;
const Lock = { tryLock() { if (lockHeld) throw new Error('nested lock (deadlock in real GAS)'); lockHeld = true; return true; }, waitLock() { lockHeld = true; }, releaseLock() { lockHeld = false; }, hasLock: () => lockHeld };

// ---------------- Utilities ----------------
const toSigned = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const toBuf = x => Buffer.isBuffer(x) ? x : (Array.isArray(x) ? Buffer.from(x.map(b => (b + 256) % 256)) : Buffer.from(String(x), 'utf8'));
const Utilities = {
  DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
  computeDigest: (alg, s) => toSigned(crypto.createHash(alg).update(toBuf(s)).digest()),
  computeHmacSha256Signature: (v, k) => toSigned(crypto.createHmac('sha256', toBuf(k)).update(toBuf(v)).digest()),
  base64EncodeWebSafe: d => toBuf(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  base64DecodeWebSafe: s => toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
  base64Encode: d => toBuf(d).toString('base64'),
  newBlob: bytes => ({ getDataAsString: () => toBuf(bytes).toString('utf8') }),
  getUuid: () => crypto.randomUUID(), sleep: () => {}
};

function makeContext() {
  const ctx = {
    console: { log: () => {}, warn: (...a) => console.warn('[gas warn]', ...a), error: (...a) => console.error('[gas error]', ...a) },
    Utilities,
    PropertiesService: { getScriptProperties: () => Props },
    CacheService: { getScriptCache: () => Cache },
    LockService: { getScriptLock: () => Lock },
    SpreadsheetApp: { create: n => mkSpreadsheet(n), openById: id => { if (!spreadsheets[id]) throw new Error('no ss'); return spreadsheets[id]; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType() { return this; }, getContent: () => s }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => ({}) }) }) }) },
    UrlFetchApp: {
      fetch(url, opt) {
        const u = new URL(url); if (u.host !== 'api.github.com') throw new Error('unexpected host ' + u.host);
        if (!opt.headers.Authorization.includes('TEST_TOKEN')) return { getResponseCode: () => 401, getContentText: () => '{"message":"Bad credentials"}' };
        const [code, text] = ghRoute((opt.method || 'get').toLowerCase(), u.pathname + u.search, opt.headers, opt.payload);
        return { getResponseCode: () => code, getContentText: () => text };
      }
    },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } },
    Math, JSON, Object, Array, String, Number, Error, RegExp, isFinite, encodeURIComponent, decodeURIComponent, Buffer
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../backend/Code.gs', 'utf8'), ctx, { filename: 'Code.gs' });
  return ctx;
}

function boot() {
  mkRepo('sekolah/cbt-data', true); mkRepo('sekolah/cbt-media', false);
  Object.assign(propStore, { GITHUB_TOKEN: 'TEST_TOKEN', DATA_REPO: 'sekolah/cbt-data', MEDIA_REPO: 'sekolah/cbt-media' });
  const ctx = makeContext();
  ctx.setup();
  return ctx;
}

// setiap request = eksekusi baru (memo & cache per-eksekusi direset seperti GAS)
function freshExec(ctx) { vm.runInContext('MEMO_ = {}; PROPS_ = null; SHEET_ = null; JUMLAH_MEMO_ = null;', ctx); }
function call(ctx, action, data, token) {
  freshExec(ctx);
  const out = ctx.doPost({ postData: { contents: JSON.stringify({ action, data, token }) } });
  return JSON.parse(out.getContent());
}

module.exports = { ghRoute, boot, call, freshExec, repos, headFiles, spreadsheets, cacheStore, propStore, ghStats, setOffset: ms => { TIME_OFFSET = ms; }, getOffset: () => TIME_OFFSET, now };
