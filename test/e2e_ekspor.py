# Uji Ekspor Word (.docx) di Chrome: semua jenis soal → Word → dibaca lagi oleh Impor cepat harus sama persis,
# bank kosong → contoh format, gambar dari serverB disisipkan dan dipakai ulang (tidak diunggah lagi).
# Butuh: wrangler dev (port 8787, DEV_MODE). Pakai: python3 test/e2e_ekspor.py <folder-keluaran> [docx-lama-untuk-regresi]
import base64, json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8787'
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ekspor'
LAMA = sys.argv[2] if len(sys.argv) > 2 else ''
os.makedirs(OUT, exist_ok=True)
V = '/tmp/vendor'
CDN = {
    'vue.global.prod.js': V + '/vue-3.5.45/package/dist/vue.global.prod.js',
    'katex.min.js': V + '/katex-0.19.1/package/dist/katex.min.js',
    'auto-render.min.js': V + '/katex-0.19.1/package/dist/contrib/auto-render.min.js',
    'katex.min.css': V + '/katex-0.19.1/package/dist/katex.min.css',
}
GB = 'https://cdn.jsdelivr.net/gh/sekolah/cbt-media@abc123/img/2026/'
GAMBAR = {GB + 'a.png': ('/tmp/uji-a.png', 'image/png'), GB + 'b.jpg': ('/tmp/uji.jpg', 'image/jpeg'), GB + 'c.webp': ('/tmp/uji.webp', 'image/webp')}
HILANG = GB + 'hilang.png'
fails = 0
def ok(n, c, info=''):
    global fails
    print(('  ✓ ' if c else '  ✗ ') + n + ('' if c else '  ' + str(info)[:600]))
    if not c: fails += 1
def call(a, d=None, tok=''):
    req = urllib.request.Request(BASE + '/api?a=' + a, data=json.dumps({'action': a, 'data': d or {}, 'token': tok}).encode(), method='POST')
    return json.loads(urllib.request.urlopen(req).read())
diminta = []
def rute(route):
    url = route.request.url
    for k, f in CDN.items():
        if url.endswith(k):
            return route.fulfill(path=f, content_type='text/css' if f.endswith('.css') else 'application/javascript')
    if url in GAMBAR:
        diminta.append(url)
        f, t = GAMBAR[url]
        return route.fulfill(path=f, content_type=t, headers={'access-control-allow-origin': '*'})
    if 'cdn.jsdelivr.net' in url or 'unpkg.com' in url or 'fonts.' in url or 'sheetjs' in url:
        return route.fulfill(status=404, body='')
    return route.continue_()

import shutil
shutil.copy('/mnt/user-data/outputs/Soal IPA 90 Bergambar/gambar/soal-14.png', '/tmp/uji-a.png')

o = lambda i, t, g='': {'id': 'o%d' % i, 'teks': t, 'gambar': g}
SOAL = [
    {'tipe': 'pg', 'id': 's1', 'stimulus': 'Paragraf **pertama** bacaan.\n\nParagraf kedua: 1. bukan nomor soal\nA. juga bukan pilihan', 'teks': 'Berdasarkan bacaan, manakah yang *benar*?\n1. Pernyataan satu\n2. Pernyataan dua\nKunci: ini teks biasa',
     'gambar': [GB + 'a.png', GB + 'c.webp'], 'bobot': 1, 'pembahasan': 'Baris pertama.\n1. Langkah satu\nB. masih pembahasan',
     'opsi': [o(1, '*Oryza sativa*'), o(2, 'Nilai $x^2 + 1 = 5$', GB + 'b.jpg'), o(3, 'Dua baris\nlanjutan pilihan'), o(4, '__garis__ dan **tebal** sebagian')], 'kunci': 'o2'},
    {'tipe': 'pgk', 'id': 's2', 'teks': 'Pilih semua (kunci hanya satu)', 'gambar': [HILANG], 'bobot': 2, 'pembahasan': '', 'penilaian': 'mutlak',
     'opsi': [o(5, 'Satu'), o(6, 'Dua'), o(7, 'Tiga')], 'kunci': ['o6']},
    {'tipe': 'pgk', 'id': 's3', 'teks': 'Dua kunci', 'gambar': [], 'bobot': 1.5, 'pembahasan': '', 'penilaian': 'sebagian',
     'opsi': [o(8, 'P'), o(9, 'Q'), o(10, 'R'), o(11, 'S')], 'kunci': ['o11', 'o8']},
    {'tipe': 'bs', 'id': 's4', 'teks': 'Fakta atau opini?', 'gambar': [], 'bobot': 3, 'pembahasan': '', 'penilaian': 'mutlak', 'label': ['Fakta', 'Opini'],
     'pernyataan': [{'id': 'p1', 'teks': 'Air terdiri dari **hidrogen** dan oksigen.', 'benar': True}, {'id': 'p2', 'teks': 'Biru warna terindah.', 'benar': False}]},
    {'tipe': 'bs', 'id': 's5', 'teks': 'Ya atau tidak', 'gambar': [], 'bobot': 1, 'pembahasan': '', 'penilaian': 'sebagian', 'label': ['Ya', 'Tidak'],
     'pernyataan': [{'id': 'p3', 'teks': 'Satu', 'benar': False}, {'id': 'p4', 'teks': 'Dua', 'benar': False}]},
    {'tipe': 'jodoh', 'id': 's6', 'teks': 'Jodohkan', 'gambar': [], 'bobot': 3, 'pembahasan': '', 'penilaian': 'sebagian',
     'pasangan': [{'idKiri': 'l1', 'idKanan': 'r1', 'kiri': 'Persegi', 'kanan': '$s \\times s$'}, {'idKiri': 'l2', 'idKanan': 'r2', 'kiri': '$a = b$ jika', 'kanan': 'sama'},
                  {'idKiri': 'l3', 'idKanan': 'r3', 'kiri': '2H₂ + O₂ → 2H₂O', 'kanan': 'Reaksi pembentukan air'}, {'idKiri': 'l4', 'idKanan': 'r4', 'kiri': '', 'kanan': 'Pengecoh saja'}]},
    {'tipe': 'isian', 'id': 's7', 'teks': 'Ibu kota Sulsel', 'gambar': [], 'bobot': 1, 'pembahasan': '', 'jawaban': ['Makassar', 'Kota Makassar']},
    {'tipe': 'isian', 'id': 's8', 'teks': 'Isian belum diisi', 'gambar': [], 'bobot': 1, 'pembahasan': '', 'jawaban': []},
    {'tipe': 'urut', 'id': 's9', 'teks': 'Urutkan', 'gambar': [], 'bobot': 2, 'pembahasan': '', 'penilaian': 'sebagian',
     'opsi': [o(12, 'Telur'), o(13, 'Larva'), o(14, 'Pupa'), o(15, 'Imago')]},
    {'tipe': 'uraian', 'id': 's10', 'teks': 'Jelaskan!', 'gambar': [], 'bobot': 5, 'pembahasan': 'Pembahasan uraian', 'rubrik': 'Skor 4: lengkap.\nSkor 2: sebagian.\n\nSkor 0: salah.'},
    {'tipe': 'uraian', 'id': 's11', 'teks': '', 'gambar': [GB + 'a.png'], 'bobot': 4, 'pembahasan': '', 'rubrik': ''},
    {'tipe': 'pg', 'id': 's12', 'teks': 'Bacaan: ini bukan bacaan', 'gambar': [], 'bobot': 1, 'pembahasan': '', 'opsi': [o(16, 'Benar: bukan pernyataan'), o(17, 'Y')], 'kunci': 'o16'},
]

def ringkas(s):
    """bentuk pembanding: tanpa id, kunci → nomor pilihan"""
    t = s['tipe']
    r = {k: s.get(k) for k in ('tipe', 'teks', 'stimulus', 'gambar', 'bobot', 'pembahasan')}
    r['teks'] = (r['teks'] or '').strip(); r['stimulus'] = (r['stimulus'] or '').strip(); r['pembahasan'] = (r['pembahasan'] or '').strip()
    r['bobot'] = float(r['bobot'])
    if t in ('pg', 'pgk', 'urut'):
        ids = [x['id'] for x in s['opsi']]
        r['opsi'] = [(x['teks'], x.get('gambar') or '') for x in s['opsi']] if t != 'urut' else [x['teks'] for x in s['opsi']]
        if t == 'pg': r['kunci'] = ids.index(s['kunci']) if s['kunci'] in ids else -1
        if t == 'pgk': r['kunci'] = sorted(ids.index(k) for k in s['kunci'])
    if t == 'bs': r['label'] = s['label']; r['pernyataan'] = [(p['teks'], p['benar']) for p in s['pernyataan']]
    if t == 'jodoh': r['pasangan'] = [(p['kiri'], p['kanan']) for p in s['pasangan']]
    if t == 'isian': r['jawaban'] = [j for j in s['jawaban'] if j]
    if t == 'uraian': r['rubrik'] = (s.get('rubrik') or '').strip()
    if t in ('pgk', 'bs', 'jodoh', 'urut'): r['penilaian'] = s['penilaian']
    return r

UJI_JS = '''async ([bank, petunjuk]) => {
  const b = bank ? { ...bank, soal: bank.soal.map(normalisasiSoal) } : { judul: 'Contoh Format Soal', soal: soalContoh() };
  const h = await buatWordBank(b, { petunjuk });
  const f = new File([h.blob], 'x.docx');
  const d = await bacaDocx(f);
  const soal = parseImporCepat(d.teks);
  const buf = new Uint8Array(await h.blob.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  return { b64: btoa(bin), teks: d.teks, gambarDocx: d.gambar, soal, gagal: h.gagal, nGbr: h.gambar, asli: b.soal };
}'''
BACA_JS = '''async (b64) => {
  const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const d = await bacaDocx(new File([u8], 'x.docx'));
  return { teks: d.teks, soal: parseImporCepat(d.teks), gambar: d.gambar };
}'''

adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
bk = call('saveBank', {'bank': {'judul': '1. Uji Ekspor Word', 'mapel': 'IPA', 'tingkat': 'X', 'soal': SOAL}}, adm)['data']['bank']
kosong = call('saveBank', {'bank': {'judul': 'Bank kosong', 'mapel': 'IPA', 'tingkat': 'X', 'soal': []}}, adm)['data']['bank']['id']

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    ctx = br.new_context(viewport={'width': 1366, 'height': 900}, accept_downloads=True)
    g = ctx.new_page()
    g.route('**/*', rute)
    errs = []
    g.on('pageerror', lambda e: errs.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input >> nth=0', 'admin')
    g.fill('input[type=password]', 'admin123')
    g.click('button:has-text("Masuk")')
    g.wait_for_selector('text=Beranda', timeout=10000)

    print('1) Bolak-balik semua jenis soal: bank → Word → Impor cepat')
    full = call('getBank', {'id': bk['id']}, adm)['data']
    r = g.evaluate(UJI_JS, [full, False])
    open(OUT + '/ekspor-uji.docx', 'wb').write(base64.b64decode(r['b64']))
    ok('jumlah soal sama (%d)' % len(r['soal']), len(r['soal']) == len(SOAL), r['teks'][:800])
    ok('gambar disisipkan 3 (png, jpg, webp→png), 1 gagal ditulis sebagai alamat', r['nGbr'] == 3 and r['gagal'] == 1, (r['nGbr'], r['gagal']))
    ok('tidak ada gambar yang perlu diunggah ulang (semua dikenali dari alamat asal)', r['gambarDocx'] == [], r['gambarDocx'])
    for a, b in zip(r['asli'], r['soal']):
        A, B = ringkas(a), ringkas(b)
        if a['id'] == 's1':   # pilihan yang seluruhnya ditebalkan tidak ada; yang lain harus sama
            pass
        ok('soal %s (%s) sama' % (a['id'], a['tipe']), A == B, {k: (A.get(k), B.get(k)) for k in set(A) | set(B) if A.get(k) != B.get(k)})
    # ekspor kedua dari hasil impor harus identik (stabil)
    r2 = g.evaluate(UJI_JS, [{'judul': full['judul'], 'mapel': 'IPA', 'tingkat': 'X', 'soal': r['soal']}, False])
    ok('ekspor ulang dari hasil impor menghasilkan teks yang sama', r2['teks'] == r['teks'], (r['teks'][:300], r2['teks'][:300]))

    print('2) Bank kosong → contoh format')
    c = g.evaluate(UJI_JS, [None, True])
    open(OUT + '/contoh-format.docx', 'wb').write(base64.b64decode(c['b64']))
    tipe = [s['tipe'] for s in c['soal']]
    ok('10 contoh soal terbaca: ' + ','.join(tipe), tipe == ['pg', 'pg', 'pgk', 'bs', 'jodoh', 'isian', 'isian', 'urut', 'uraian', 'pg'], tipe)
    ok('5 gambar contoh (gelas ukur + 4 bangun) akan diunggah saat impor', len(c['gambarDocx']) == 5, c['gambarDocx'])
    for a, b in zip(c['asli'], c['soal']):
        A, B = ringkas(a), ringkas(b)
        A['gambar'] = len(A['gambar']); B['gambar'] = len(B['gambar'])
        if 'opsi' in A and A['tipe'] != 'urut': A['opsi'] = [(t, bool(x)) for t, x in A['opsi']]; B['opsi'] = [(t, bool(x)) for t, x in B['opsi']]
        ok('contoh %s sama' % A['tipe'], A == B, {k: (A.get(k), B.get(k)) for k in set(A) | set(B) if A.get(k) != B.get(k)})
    ok('petunjuk & tabel tidak ikut terbaca sebagai soal', c['soal'][0]['teks'].startswith('Perhatikan gambar gelas ukur'), c['soal'][0]['teks'])

    print('3) Tombol di aplikasi')
    g.goto(BASE + '/guru/#/editor/' + kosong)
    g.wait_for_selector('button:has-text("Ekspor Word")', timeout=10000)
    with g.expect_download() as dl: g.click('button:has-text("Ekspor Word")')
    d = dl.value; ok('bank kosong: Ekspor Word mengunduh ' + d.suggested_filename, d.suggested_filename == 'Contoh_Format_Soal_Word.docx')
    g.wait_for_selector('text=yang diunduh contoh format', timeout=5000); ok('pemberitahuan contoh format tampil', True)
    g.goto(BASE + '/guru/#/editor/' + bk['id'])
    g.wait_for_selector('.ed-head', timeout=10000)
    with g.expect_download() as dl: g.click('button:has-text("Ekspor Word")')
    d = dl.value; d.save_as(OUT + '/dari-tombol.docx')
    ok('bank berisi: mengunduh ' + d.suggested_filename, d.suggested_filename == '1_Uji_Ekspor_Word.docx')
    g.wait_for_selector('text=gambar tidak bisa diambil', timeout=8000); ok('pemberitahuan gambar gagal tampil', True)
    g.click('button:has-text("Impor cepat")')
    with g.expect_download() as dl: g.click('button:has-text("Unduh contoh format Word")')
    ok('Impor cepat → Unduh contoh format Word', dl.value.suggested_filename == 'Contoh_Format_Soal_Word.docx')
    # impor kembali file hasil tombol: semua gambar dipakai ulang, tidak ada unggahan
    g.set_input_files('.ip-alat input[type=file]', OUT + '/dari-tombol.docx')
    g.wait_for_selector('text=Terbaca', timeout=20000)
    ring = g.inner_text('.modal-body p.small')
    ok('impor file ekspor: ' + ring.strip()[:150], 'Terbaca 12 soal' in ring and 'dipakai lagi' in ring and 'gambar dari serverB' in ring, ring)
    tombol = g.inner_text('.modal-foot button.btn-primary')
    ok('tombol tanpa unggah gambar: ' + tombol, tombol.strip() == 'Tambahkan 12 soal', tombol)
    g.screenshot(path=OUT + '/impor-ulang.png')
    g.click('.modal-foot button.btn:has-text("Batal")')
    g.goto(BASE + '/guru/#/bank')
    g.wait_for_selector('text=1. Uji Ekspor Word', timeout=10000)
    baris = g.locator('tr', has_text='1. Uji Ekspor Word').first
    baris.locator('button[aria-label="Aksi lain"]').click()
    with g.expect_download() as dl: g.click('text=Unduh Word')
    ok('menu daftar bank → Unduh Word: ' + dl.value.suggested_filename, dl.value.suggested_filename == '1_Uji_Ekspor_Word.docx')

    if LAMA:
        print('4) Regresi impor Word lama: teks sama dengan versi 2.11 kecuali tanda format')
        b64 = base64.b64encode(open(LAMA, 'rb').read()).decode()
        baru = g.evaluate(BACA_JS, b64)
        lama_html = open('/tmp/v211/index.html', 'rb').read()
        g2 = ctx.new_page()
        g2.route('**/*', lambda rt: rt.fulfill(body=lama_html, content_type='text/html') if rt.request.url.rstrip('/').endswith('/guru') else rute(rt))
        g2.goto(BASE + '/guru/')
        g2.wait_for_function('typeof bacaDocx === "function"')
        lama = g2.evaluate(BACA_JS, b64)
        import re
        polos = lambda t: re.sub(r'\*\*|__|(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])', '', t)
        ok('jumlah soal sama: %d' % len(baru['soal']), len(baru['soal']) == len(lama['soal']))
        ok('teks hasil baca sama (tanpa tanda format)', polos(baru['teks']) == lama['teks'], [(a, b) for a, b in zip(polos(baru['teks']).split('\n'), lama['teks'].split('\n')) if a != b][:5])
        ok('kunci & jenis sama', [(s['tipe'], s.get('kunci') and 1) for s in baru['soal']] == [(s['tipe'], s.get('kunci') and 1) for s in lama['soal']])
        beda = [l for l in baru['teks'].split('\n') if l not in lama['teks'].split('\n')]
        print('     baris yang kini berformat:', len(beda), beda[:4])
    SU = os.environ.get('SIMPAN_ULANG')   # file ekspor-uji.docx yang sudah dibuka & disimpan ulang aplikasi lain (LibreOffice/Word)
    if SU and os.path.exists(SU):
        print('5) File ekspor yang disimpan ulang aplikasi lain: ' + SU)
        u = g.evaluate(BACA_JS, base64.b64encode(open(SU, 'rb').read()).decode())
        ok('jumlah soal sama (%d)' % len(u['soal']), len(u['soal']) == len(SOAL))
        ok('gambar tetap dikenali (tidak diunggah ulang): %d perlu unggah' % len(u['gambar']), u['gambar'] == [], u['gambar'])
        for a, b in zip(r['asli'], u['soal']):
            A, B = ringkas(a), ringkas(b)
            ok('soal %s (%s) sama' % (a['id'], a['tipe']), A == B, {k: (A.get(k), B.get(k)) for k in set(A) | set(B) if A.get(k) != B.get(k)})
    ok('tidak ada galat JavaScript', not errs, errs)
    br.close()

print('SEMUA LULUS' if not fails else f'{fails} GAGAL'); sys.exit(1 if fails else 0)
