# Uji panel "Penggunaan harian serverC" di Pengaturan (Chrome).
# Butuh: node test/cf-tiruan.mjs (port 9998) dan wrangler dev (port 8787, DEV_MODE) dengan
#   --var CF_API:http://127.0.0.1:9998 [--var CF_API_TOKEN:uji]
# Pakai: python3 test/e2e_pakai.py <mode> [folder-foto]
#   mode: tanpa-token | lengkap | ditolak | dua-akun | tanpa-obs
import json, sys, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8787'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'lengkap'
FOTO = sys.argv[2] if len(sys.argv) > 2 else ''
V = '/tmp/vendor'
CDN = {'vue.global.prod.js': V + '/vue-3.5.45/package/dist/vue.global.prod.js', 'katex.min.js': V + '/katex-0.19.1/package/dist/katex.min.js',
       'auto-render.min.js': V + '/katex-0.19.1/package/dist/contrib/auto-render.min.js', 'katex.min.css': V + '/katex-0.19.1/package/dist/katex.min.css'}
fails = 0
def ok(n, c, info=''):
    global fails
    print(('  ✓ ' if c else '  ✗ ') + n + ('' if c else '  ' + str(info)[:500]))
    if not c: fails += 1
def rute(route):
    url = route.request.url
    for k, f in CDN.items():
        if url.endswith(k): return route.fulfill(path=f, content_type='text/css' if f.endswith('.css') else 'application/javascript')
    if 'cdn.jsdelivr.net' in url or 'unpkg.com' in url or 'fonts.' in url or 'sheetjs' in url: return route.fulfill(status=404, body='')
    return route.continue_()
def log_cf():
    return json.loads(urllib.request.urlopen('http://127.0.0.1:9998/_log').read())
def dev(d):
    adm = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + '/api?a=loginGuru', data=json.dumps({'action': 'loginGuru', 'data': {'username': 'admin', 'password': 'admin123'}}).encode(), method='POST')).read())['data']['token']
    return json.loads(urllib.request.urlopen(urllib.request.Request(BASE + '/api?a=_dev', data=json.dumps({'action': '_dev', 'data': d, 'token': adm}).encode(), method='POST')).read())

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    g = br.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    g.route('**/*', rute)
    errs = []
    g.on('pageerror', lambda e: errs.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input >> nth=0', 'admin'); g.fill('input[type=password]', 'admin123'); g.click('button:has-text("Masuk")')
    g.wait_for_selector('text=Beranda', timeout=10000)
    g.evaluate('''() => { window.__panggil = []; const asli = window.api; window.api = function (a, ...r) { window.__panggil.push(a); return asli.call(this, a, ...r); }; }''')
    g.goto(BASE + '/guru/#/pengaturan')
    g.wait_for_selector('text=Identitas', timeout=10000)
    g.wait_for_function('() => window.__panggil.includes("pemakaianHarian")', timeout=10000)
    g.wait_for_timeout(1500)
    ada = g.locator('#pakai-harian').count() > 0
    teks = g.inner_text('#pakai-harian') if ada else ''
    if ada:
        ok('panel "Penggunaan harian serverC" ada di Pengaturan', 'Penggunaan harian serverC' in teks and 'pulih setiap pukul 08.00 WITA' in teks, teks[:300])
    ok('tidak ada kata "Cloudflare" di halaman', 'cloudflare' not in g.inner_text('body').lower())
    ok('tidak ada tulisan "batas yang ditampilkan" / "Diperbarui pukul" / petunjuk token', not any(x in teks for x in ('batas yang ditampilkan', 'Diperbarui pukul', 'sama dengan dasbor', 'CF_API_TOKEN', 'pembuatan token')), teks)

    if MODE == 'tanpa-token':
        ok('tanpa token: panel tidak ditampilkan sama sekali', not ada, teks)
        ok('tidak memanggil API serverC', log_cf() == [], log_cf())
        g.reload(); g.wait_for_selector('text=Identitas', timeout=10000); g.wait_for_timeout(300)
        ok('dibuka lagi: panel tidak berkedip "Memuat…"', g.locator('#pakai-harian').count() == 0)
    elif MODE == 'ditolak':
        ok('token salah: pesan singkat "ditolak" tanpa petunjuk', ada and 'Token API serverC ditolak' in teks, teks)
    elif MODE == 'dua-akun':
        ok('token membuka 2 akun: diminta CF_ACCOUNT_ID', ada and 'CF_ACCOUNT_ID' in teks and '2 akun' in teks, teks)
    elif MODE == 'tanpa-obs':
        ok('izin observability kurang: baris lain tetap tampil', '6.017' in teks and '112.937' in teks, teks)
        ok('baris observability: tanda — dan pesan izin', 'izin membaca log' in teks and '— / 180.000' in teks, teks)
    else:
        harap = [
            ['Server', 'Permintaan (Requests)', '6.017 / 90.000'],
            ['Server', 'Peristiwa observabilitas (Observability events)', '425 / 180.000'],
            ['Database', 'Baris dibaca (Rows read)', '112.937 / 4,5 juta'],
            ['Database', 'Baris ditulis (Rows written)', '848 / 90.000'],
            ['Database', 'Total penyimpanan (Total storage)', '1,3 MB / 4,5 GB'],
            ['Mesin ujian', 'Permintaan (Requests)', '2.394 / 90.000'],
            ['Mesin ujian', 'Durasi (Duration)', '2.521 GB-dtk / 11.700 GB-dtk'],
            ['Mesin ujian', 'Baris dibaca (Rows read)', '228.846 / 4,5 juta'],
            ['Mesin ujian', 'Baris ditulis (Rows written)', '2.496 / 90.000'],
            ['Mesin ujian', 'Penyimpanan (Storage)', '3,5 MB / 4,5 GB'],
        ]
        baris = g.eval_on_selector_all('#pakai-harian .pakai-baris', 'els => els.map(e => [e.closest(".pakai-grup").querySelector(".pakai-judul").innerText.trim(), e.querySelector(".pakai-label").innerText.trim(), e.querySelector(".pakai-nilai").innerText.trim(), e.querySelector(".pakai-nilai").classList.contains("lewat")])')
        for h, x in zip(harap, baris):
            ok(f'{h[0].lower()} · {h[1]}: {h[2]}', x[0].lower() == h[0].lower() and x[1] == h[1] and x[2] == h[2], x)
        ok('jumlah baris 10', len(baris) == 10, baris)
        ok('angka hari ini belum ada yang melewati batas (tidak ada yang merah)', not any(x[3] for x in baris), baris)
        ok('judul kelompok: Server, Database, Mesin ujian', [x.strip().lower() for x in g.eval_on_selector_all('#pakai-harian .pakai-judul', 'e => e.map(x => x.innerText)')] == ['server', 'database', 'mesin ujian'])
        ok('grafik cincin terisi sesuai persentase', 'conic-gradient' in (g.get_attribute('#pakai-harian .pakai-cincin', 'style') or ''))
        if FOTO:
            g.locator('#pakai-harian').screenshot(path=FOTO + '/pakai-harian.png')
        n0 = len([x for x in log_cf() if x['path'] == '/graphql'])
        ok('pertama dibuka: 3 kueri GraphQL + 1 observability (+ cari akun)', n0 == 3 and len([x for x in log_cf() if 'observability' in x['path']]) == 1, log_cf())
        # muat ulang: hanya angka penggunaan, tidak memuat ulang data lain
        g.evaluate('window.__panggil = []')
        urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9998/_angka', data=json.dumps({'req': 95000}).encode(), method='POST'))
        g.click('#pakai-harian button:has-text("Muat ulang")')
        g.wait_for_timeout(800)
        ok('muat ulang hanya memanggil pemakaianHarian', g.evaluate('window.__panggil') == ['pemakaianHarian'], g.evaluate('window.__panggil'))
        ok('dalam 30 detik memakai simpanan (Cloudflare tidak ditanya lagi)', len([x for x in log_cf() if x['path'] == '/graphql']) == n0)
        dev({'offset': 31000})
        g.click('#pakai-harian button:has-text("Muat ulang")')
        g.wait_for_function('() => document.querySelector("#pakai-harian").innerText.includes("95.000")', timeout=8000)
        ok('setelah 30 detik muat ulang mengambil angka baru (95.000 → merah)', '95.000 / 90.000' in g.inner_text('#pakai-harian') and g.eval_on_selector('#pakai-harian .pakai-nilai', 'e => e.classList.contains("lewat")'))
        ok('muat ulang tidak memuat ulang halaman/pengaturan lain', g.evaluate('window.__panggil') == ['pemakaianHarian', 'pemakaianHarian'], g.evaluate('window.__panggil'))
        dev({'offset': 0})
        g.set_viewport_size({'width': 390, 'height': 844})
        g.wait_for_timeout(300)
        lebar = g.evaluate('document.querySelector("#pakai-harian").scrollWidth <= document.querySelector("#pakai-harian").clientWidth + 1')
        ok('tampilan HP: panel tidak melebar ke samping', lebar)
        if FOTO: g.locator('#pakai-harian').screenshot(path=FOTO + '/pakai-harian-hp.png')
    if FOTO and MODE != 'lengkap' and g.locator('#pakai-harian').count():
        g.locator('#pakai-harian').screenshot(path=f'{FOTO}/pakai-{MODE}.png')
    ok('tidak ada galat JavaScript', not errs, errs)
    br.close()
print('SEMUA LULUS' if not fails else f'{fails} GAGAL'); sys.exit(1 if fails else 0)
