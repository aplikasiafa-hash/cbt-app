# Uji tampilan baris "Gagal dikirim" di Pengaturan: petunjuk menyesuaikan penyebab.
# Butuh wrangler dev + github-tiruan dan keadaan cadangan gagal (lihat /tmp/uji_hapus_ui.sh).
# Pakai: python3 test/e2e_cadangan_gagal.py [harap: token|ulang] [folder-foto]
import sys
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8787'
HARAP = sys.argv[1] if len(sys.argv) > 1 else 'ulang'
FOTO = sys.argv[2] if len(sys.argv) > 2 else ''
V = '/tmp/vendor'
CDN = {'vue.global.prod.js': V + '/vue-3.5.45/package/dist/vue.global.prod.js', 'katex.min.js': V + '/katex-0.19.1/package/dist/katex.min.js',
       'auto-render.min.js': V + '/katex-0.19.1/package/dist/contrib/auto-render.min.js', 'katex.min.css': V + '/katex-0.19.1/package/dist/katex.min.css'}
fails = 0
def ok(n, c, info=''):
    global fails
    print(('  ✓ ' if c else '  ✗ ') + n + ('' if c else '  ' + str(info)[:400]))
    if not c: fails += 1
def rute(route):
    url = route.request.url
    for k, f in CDN.items():
        if url.endswith(k): return route.fulfill(path=f, content_type='text/css' if f.endswith('.css') else 'application/javascript')
    if 'cdn.jsdelivr.net' in url or 'unpkg.com' in url or 'fonts.' in url or 'sheetjs' in url: return route.fulfill(status=404, body='')
    return route.continue_()
with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    g = br.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    g.route('**/*', rute)
    errs = []
    g.on('pageerror', lambda e: errs.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input >> nth=0', 'admin'); g.fill('input[type=password]', 'admin123'); g.click('button:has-text("Masuk")')
    g.wait_for_selector('text=Beranda', timeout=10000)
    g.goto(BASE + '/guru/#/pengaturan')
    g.wait_for_selector('td:has-text("Gagal dikirim")', timeout=10000)
    baris = g.locator('tr:has(td:has-text("Gagal dikirim"))')
    t = baris.inner_text()
    if HARAP == 'token':
        ok('masalah token: diminta memeriksa token', 'Periksa token serverB' in t, t)
    else:
        ok('bukan masalah token: tidak menyuruh memeriksa token', 'Periksa token' not in t and 'Tekan tombol di bawah untuk mencoba lagi.' in t, t)
    if FOTO: baris.screenshot(path=FOTO + '/cadangan-gagal-' + HARAP + '.png')
    if HARAP == 'ulang':
        g.click('button:has-text("Kirim ke serverB sekarang")')
        g.wait_for_function('() => !document.body.innerText.includes("Gagal dikirim")', timeout=15000)
        ok('setelah tombol ditekan: baris gagal hilang', 'Gagal dikirim' not in g.inner_text('body'))
        ok('semua perubahan sudah terkirim', 'semua perubahan sudah terkirim' in g.inner_text('body'))
    ok('tanpa galat halaman', not errs, errs)
    br.close()
print(('\n%d GAGAL' % fails) if fails else '\nSEMUA LULUS'); sys.exit(1 if fails else 0)
