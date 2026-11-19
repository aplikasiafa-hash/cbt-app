# Uji Impor cepat dari file Word (.docx) di Chrome: teks → soal, gambar → diunggah ke serverB sesuai nomor soal.
# Butuh: wrangler dev (port 8787, DEV_MODE, MEDIA_REPO + GITHUB_API ke serverB tiruan :9999).
# Pakai: python3 test/e2e_word.py <file.docx> <kunci, contoh CBDCA...>
import base64, json, math, sys, time, urllib.request, zipfile, re
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8787'
DOCX, KUNCI = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ''
V = '/tmp/vendor'
CDN = {
    'vue.global.prod.js': V + '/vue-3.5.45/package/dist/vue.global.prod.js',
    'katex.min.js': V + '/katex-0.19.1/package/dist/katex.min.js',
    'auto-render.min.js': V + '/katex-0.19.1/package/dist/contrib/auto-render.min.js',
    'katex.min.css': V + '/katex-0.19.1/package/dist/katex.min.css',
}
fails = 0
def ok(n, c, info=''):
    global fails
    print(('  ✓ ' if c else '  ✗ ') + n + ('' if c else '  ' + str(info)[:400]))
    if not c: fails += 1
def call(a, d=None, tok=''):
    req = urllib.request.Request(BASE + '/api?a=' + a, data=json.dumps({'action': a, 'data': d or {}, 'token': tok}).encode(), method='POST')
    return json.loads(urllib.request.urlopen(req).read())
def rute(route):
    url = route.request.url
    for k, f in CDN.items():
        if url.endswith(k):
            return route.fulfill(path=f, content_type='text/css' if f.endswith('.css') else 'application/javascript')
    if 'cdn.jsdelivr.net' in url or 'unpkg.com' in url or 'fonts.' in url or 'sheetjs' in url:
        return route.fulfill(status=404, body='')
    return route.continue_()

# ukuran tiap gambar di dalam file Word, urut sesuai kemunculan di dokumen
z = zipfile.ZipFile(DOCX)
rels = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', z.read('word/_rels/document.xml.rels').decode()))
rels.update({a: b for b, a in re.findall(r'Target="([^"]+)"[^>]*Id="(rId\d+)"', z.read('word/_rels/document.xml.rels').decode())})
urut = [rels[r] for r in re.findall(r'r:embed="(rId\d+)"', z.read('word/document.xml').decode())]
ukuran = [len(z.read('word/' + t)) for t in urut]
print(f'File {DOCX}: {len(urut)} gambar')

adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
bank = call('saveBank', {'bank': {'judul': 'Uji impor Word', 'mapel': 'Kimia', 'tingkat': 'X', 'soal': []}}, adm)['data']['bank']['id']

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    g = b.new_context(viewport={'width': 1366, 'height': 900}).new_page()
    g.route('**/*', rute)
    errs = []
    g.on('pageerror', lambda e: errs.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input[autocomplete="username"], input >> nth=0', 'admin')
    g.fill('input[type=password]', 'admin123')
    g.click('button:has-text("Masuk")')
    g.wait_for_selector('text=Beranda', timeout=10000)
    g.goto(BASE + '/guru/#/editor/' + bank)
    g.click('button:has-text("Impor cepat")')
    g.set_input_files('.ip-alat input[type=file]', DOCX)
    g.wait_for_selector('text=Terbaca', timeout=20000)
    ringkas = g.inner_text('.modal-body p.small')
    n = len(urut)
    ok('ringkasan: ' + ringkas.strip()[:120], 'Terbaca 25 soal' in ringkas and f'{n} gambar' in ringkas, ringkas)
    baris = g.query_selector_all('.ip-baris')
    ok(f'pratinjau {len(baris)} baris, tiap soal 1 gambar', len(baris) == 25 and all(len(r.query_selector_all('img')) == 1 for r in baris))
    kunci = ''.join(r.query_selector('.k').inner_text().strip() for r in baris)
    if KUNCI: ok('kunci terbaca sama dengan Word: ' + kunci, kunci == KUNCI, kunci)
    teks = g.input_value('.modal textarea')
    ok('penanda [gambar N] berada di bawah nomor soal yang benar', all(re.search(rf'(?m)^{k}\. .*\n\[gambar {k}\]', teks) for k in range(1, 26)), teks[:300])
    t0 = time.time()
    g.click('.modal-foot button.btn-primary')
    g.wait_for_selector('text=ditambahkan. Jangan lupa simpan', timeout=240000)
    dt = time.time() - t0
    ok(f'25 soal + {n} gambar ditambahkan ({dt:.0f} s)', True)
    g.click('button:has-text("Simpan")')
    g.wait_for_selector('.ed-status:has-text("Tersimpan")', timeout=20000)
    ok('bank disimpan', True)
    ok('tidak ada galat JavaScript', not errs, errs)
    b.close()

bk = call('getBank', {'id': bank}, adm)['data']
log = json.loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9999/_log', headers={'Authorization': 'Bearer uji'})).read())['log']
puts = {x['put'].split('/contents/')[1]: x['bytes'] for x in log if 'put' in x}
tolak = [x for x in log if 'tolak' in x]
ok(f'tersimpan {len(bk["soal"])} soal pilihan ganda', len(bk['soal']) == 25 and all(s['tipe'] == 'pg' and len(s['opsi']) == 4 for s in bk['soal']))
cocok = 0
for k, s in enumerate(bk['soal']):
    u = s['gambar'][0] if s['gambar'] else ''
    path = u.split('@', 1)[1].split('/', 1)[1] if '@' in u else ''
    if path in puts and puts[path] == 4 * math.ceil(ukuran[k] / 3): cocok += 1
ok(f'{cocok}/25 soal memakai gambar yang tepat dari Word (dicocokkan dari isi berkas yang diunggah)', cocok == 25)
if KUNCI:
    kb = ''.join('ABCD'[[o['id'] for o in s['opsi']].index(s['kunci'])] for s in bk['soal'])
    ok('kunci tersimpan = kunci Word', kb == KUNCI, kb)
ok('soal 1 teks rapi', bk['soal'][0]['teks'].startswith('Perhatikan model atom Bohr') and bk['soal'][0]['opsi'][2]['teks'] == '16', bk['soal'][0])
if tolak: ok(f'serverB menolak {len(tolak)} unggahan (batas), aplikasi menunggu lalu mencoba lagi → semua tetap terunggah', len(puts) == n)
print('\n' + (f'{fails} GAGAL' if fails else 'SEMUA LULUS'))
sys.exit(1 if fails else 0)
