/**
 * GitHub: unggah gambar soal (repo media publik) + cadangan/impor data (repo data privat).
 * Dipanggil hanya dari Durable Object.
 */
import { AppError, uid_ } from './shared.js';

function token(env) {
  if (!env.GITHUB_TOKEN) throw new AppError('GITHUB_TOKEN belum diatur. Jalankan: npx wrangler secret put GITHUB_TOKEN');
  return env.GITHUB_TOKEN;
}
const branch = env => env.BRANCH || 'main';
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

export async function gh(env, method, path, body, accept) {
  const res = await fetch((env.GITHUB_API || 'https://api.github.com') + path, {
    method: method.toUpperCase(),
    headers: {
      Authorization: 'Bearer ' + token(env),
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cbt-sekolah-cloudflare',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return res;
}
async function ghJson(env, method, path, body) {
  const r = await gh(env, method, path, body);
  const text = await r.text();
  if (!r.ok) { const e = new AppError('GitHub ' + r.status + ' (' + method.toUpperCase() + ' ' + path.split('?')[0] + '): ' + text.slice(0, 200), r.status === 409 || r.status === 422 ? 'CONFLICT' : (r.status >= 500 || r.status === 429 ? 'BUSY' : 'ERR')); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
//  GAMBAR
// ---------------------------------------------------------------------------
export async function unggahGambar(env, d, namaGuru) {
  const repo = env.MEDIA_REPO;
  if (!repo) throw new AppError('MEDIA_REPO belum diatur. Di wrangler.jsonc ganti "namaakun" dengan nama akun GitHub Anda (contoh: sman5/cbt-media).');
  const tipe = String(d.tipe || '');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[tipe];
  if (!ext) throw new AppError('Format gambar tidak didukung (gunakan JPG, PNG, WEBP, GIF)');
  const data = String(d.data || '').replace(/^data:[^,]+,/, '');
  if (data.length > 2800000) throw new AppError('Ukuran gambar maksimal 2 MB');
  const t = new Date();
  const path = 'img/' + t.getUTCFullYear() + '/' + String(t.getUTCMonth() + 1).padStart(2, '0') + '/' + uid_('') + '.' + ext;
  let last = null;
  for (let i = 0; i < 4; i++) {
    const r = await gh(env, 'put', '/repos/' + repo + '/contents/' + encPath(path), { message: 'Gambar soal (' + namaGuru + ')', content: data, branch: branch(env) });
    const text = await r.text();
    if (r.status === 200 || r.status === 201) return { url: urlMedia(env, repo, JSON.parse(text).commit.sha, path), path };
    last = { status: r.status, text };
    if (r.status !== 409 && r.status !== 422) break;
    await new Promise(ok => setTimeout(ok, 300 + Math.random() * 700));
  }
  throw new AppError('Gagal mengunggah gambar ke GitHub (' + last.status + '): ' + last.text.slice(0, 150));
}
function urlMedia(env, repo, sha, path) {
  const mode = env.MEDIA_CDN || 'jsdelivr', parts = repo.split('/');
  if (mode === 'raw') return 'https://raw.githubusercontent.com/' + repo + '/' + sha + '/' + path;
  if (mode === 'pages') return 'https://' + parts[0].toLowerCase() + '.github.io/' + parts[1] + '/' + path;
  return 'https://cdn.jsdelivr.net/gh/' + repo + '@' + sha + '/' + path;
}

// ---------------------------------------------------------------------------
//  CADANGAN: commit banyak file sekaligus (Git Data API)
// ---------------------------------------------------------------------------
export async function cekRepoData(env) {
  const repo = env.DATA_REPO;
  if (!repo) throw new AppError('DATA_REPO belum diatur (opsional, untuk cadangan ke GitHub)');
  const info = await ghJson(env, 'get', '/repos/' + repo);
  if (!info.private) throw new AppError('Repo ' + repo + ' HARUS PRIVAT karena berisi kunci jawaban & kata sandi.');
  return repo;
}

/** files: { path: string | null(hapus) } */
export async function commitFiles(env, repo, files, message) {
  const paths = Object.keys(files);
  if (!paths.length) return null;
  const br = branch(env);
  for (let attempt = 0; attempt < 4; attempt++) {
    let headSha = null, baseTree = null;
    const refRes = await gh(env, 'get', '/repos/' + repo + '/git/ref/heads/' + br);
    if (refRes.ok) {
      headSha = (await refRes.json()).object.sha;
      baseTree = (await ghJson(env, 'get', '/repos/' + repo + '/git/commits/' + headSha)).tree.sha;
    } else {
      await refRes.text();
      // repo kosong: buat commit awal lewat contents API
      const init = await gh(env, 'put', '/repos/' + repo + '/contents/README.md', { message: 'Inisialisasi CBT Sekolah', content: btoa('# CBT Sekolah — cadangan data\n\nDikelola otomatis oleh aplikasi CBT.\n'), branch: br });
      await init.text();
      continue;
    }
    const tree = paths.map(p => files[p] === null ? { path: p, mode: '100644', type: 'blob', sha: null } : { path: p, mode: '100644', type: 'blob', content: files[p] });
    const t = await ghJson(env, 'post', '/repos/' + repo + '/git/trees', { base_tree: baseTree, tree });
    const cm = await ghJson(env, 'post', '/repos/' + repo + '/git/commits', { message, tree: t.sha, parents: [headSha] });
    const u = await gh(env, 'patch', '/repos/' + repo + '/git/refs/heads/' + br, { sha: cm.sha, force: false });
    await u.text();
    if (u.ok) return cm.sha;
    if (u.status !== 409 && u.status !== 422) throw new AppError('Gagal menyimpan ke GitHub (' + u.status + ')');
    await new Promise(ok => setTimeout(ok, 300 + Math.random() * 700));
  }
  throw new AppError('GitHub sedang sibuk, coba lagi', 'BUSY');
}

// ---------------------------------------------------------------------------
//  IMPOR: unduh seluruh repo data (1 permintaan tarball) → { path: isi }
// ---------------------------------------------------------------------------
export async function unduhRepo(env, repo) {
  const r = await gh(env, 'get', '/repos/' + repo + '/tarball/' + encodeURIComponent(branch(env)));
  if (!r.ok) throw new AppError('Gagal mengunduh repo ' + repo + ' (' + r.status + '). Periksa DATA_REPO dan izin token.');
  const buf = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return bacaTar(buf);
}

function bacaTar(buf) {
  const dec = new TextDecoder(), files = {};
  const teks = (a, b) => { let e = a; while (e < b && buf[e] !== 0) e++; return dec.decode(buf.subarray(a, e)); };
  let off = 0, paxPath = null;
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    let name = teks(off, off + 100);
    const size = parseInt(teks(off + 124, off + 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = teks(off + 345, off + 500);
    if (prefix) name = prefix + '/' + name;
    const isi = buf.subarray(off + 512, off + 512 + size);
    if (type === 'x') {
      const s = dec.decode(isi), m = s.match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
    } else if (type === '0' || type === '\0' || type === '7') {
      const p = (paxPath || name).replace(/^[^/]+\//, ''); // buang folder teratas "owner-repo-sha/"
      files[p] = dec.decode(isi);
      paxPath = null;
    } else if (type !== 'g') paxPath = null;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
