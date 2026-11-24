# Uji tampilan sakelar "Kunci link" di Pengaturan (Chrome).
# Butuh wrangler dev (port 8787) dengan --var APP_KUNCI:kunciuji  (mode "tanpa": tanpa APP_KUNCI)
# Pakai: python3 test/e2e_kunci_link.py [terpasang|tanpa] [folder-foto]
import sys, urllib.error, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8787'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'terpasang'
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
def halaman():
    try: return urllib.request.urlopen(urllib.request.Request(BASE + '/ujian-cbt/', headers={'user-agent': 'Mozilla/5.0 Chrome'})).status
    except urllib.error.HTTPError as e: return e.code

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
    g.wait_for_selector('#kunci-link', timeout=10000)
    sk = g.locator('#kunci-link .sakelar')
    teks = lambda: g.inner_text('#kunci-link')
    ok('tidak ada tulisan "APP_KUNCI" di aplikasi', 'APP_KUNCI' not in g.inner_text('body') and 'app_kunci' not in g.content().lower())
    if MODE == 'tanpa':
        ok('belum dipasang: keterangan + sakelar tidak bisa ditekan', 'belum dipasang di serverC' in teks() and sk.is_disabled(), teks())
        if FOTO: g.locator('#kunci-link').screenshot(path=FOTO + '/kunci-link-tanpa.png')
    else:
        ok('awal: ON (hijau) + keterangan aktif', sk.get_attribute('aria-checked') == 'true' and 'ON' in teks() and 'hanya bisa dibuka lewat aplikasi CBT Ujian' in teks(), teks())
        if FOTO: g.locator('#kunci-link').screenshot(path=FOTO + '/kunci-link-on.png')
        sk.click()
        g.wait_for_selector('.modal h2:has-text("Matikan kunci link?")', timeout=5000)
        g.click('.modal-foot .btn-danger:has-text("Matikan")')
        g.wait_for_function('() => document.querySelector("#kunci-link .sakelar").getAttribute("aria-checked") === "false"', timeout=8000)
        ok('setelah dimatikan: OFF + keterangan mati', 'OFF' in teks() and 'bisa dibuka di browser mana pun' in teks(), teks())
        if FOTO: g.locator('#kunci-link').screenshot(path=FOTO + '/kunci-link-off.png')
        g.reload(); g.wait_for_selector('#kunci-link', timeout=10000)
        ok('dibuka ulang: tetap OFF (tersimpan di server)', g.locator('#kunci-link .sakelar').get_attribute('aria-checked') == 'false')
        g.wait_for_timeout(31000)
        ok('browser biasa bisa membuka halaman ujian', halaman() == 200)
        g.locator('#kunci-link .sakelar').click()
        g.wait_for_selector('.modal h2:has-text("Aktifkan kunci link?")', timeout=5000)
        g.click('.modal-foot .btn-primary:has-text("Aktifkan")')
        g.wait_for_function('() => document.querySelector("#kunci-link .sakelar").getAttribute("aria-checked") === "true"', timeout=8000)
        ok('dinyalakan lagi: ON', 'ON' in teks(), teks())
        g.wait_for_timeout(31000)
        ok('browser biasa kembali ditolak (404)', halaman() == 404)
        g.locator('#kunci-link .sakelar').click()
        g.wait_for_selector('.modal h2', timeout=5000)
        g.click('.modal-foot .btn:has-text("Batal")')
        g.wait_for_timeout(500)
        ok('menekan Batal tidak mengubah apa pun', g.locator('#kunci-link .sakelar').get_attribute('aria-checked') == 'true')
    ok('tidak ada galat JavaScript', not errs, errs)
    br.close()
print('SEMUA LULUS' if not fails else f'{fails} GAGAL'); sys.exit(1 if fails else 0)
