# Uji end-to-end di Chrome (headless): monitor guru langsung + siswa mengerjakan.
# Butuh: npm run dev (port 8787). CDN dialihkan ke paket npm lokal di /tmp/vendor.
import json, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8787'
V = '/tmp/vendor'
CDN = {
    'vue.global.prod.js': V + '/vue-3.5.45/package/dist/vue.global.prod.js',
    'katex.min.js': V + '/katex-0.19.1/package/dist/katex.min.js',
    'auto-render.min.js': V + '/katex-0.19.1/package/dist/contrib/auto-render.min.js',
    'katex.min.css': V + '/katex-0.19.1/package/dist/katex.min.css',
    'xlsx.full.min.js': V + '/xlsx-0.18.5/package/dist/xlsx.full.min.js',
}
fails = 0
def ok(n, c, info=''):
    global fails
    print(('  ✓ ' if c else '  ✗ ') + n + ('' if c else '  ' + str(info)[:300]))
    if not c: fails += 1

def call(a, d=None, tok=''):
    req = urllib.request.Request(BASE + '/api?a=' + a, data=json.dumps({'action': a, 'data': d or {}, 'token': tok}).encode(), method='POST')
    return json.loads(urllib.request.urlopen(req).read())

def rute(route):
    url = route.request.url
    for k, f in CDN.items():
        if url.endswith(k):
            ct = 'text/css' if f.endswith('.css') else 'application/javascript'
            return route.fulfill(path=f, content_type=ct)
    if 'cdn.jsdelivr.net' in url or 'unpkg.com' in url or 'fonts.' in url:
        return route.fulfill(status=404, body='')
    return route.continue_()

# --- data ujian via API
adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
bank = call('listBank', {}, adm)['data'][0]['id']
t0 = int(time.time() * 1000)
U = call('saveUjian', {'nama': 'Uji Browser', 'bankId': bank, 'kelas': ['X-1'], 'mulai': t0 - 60000, 'selesai': t0 + 7200000, 'durasi': 60,
                       'acakSoal': False, 'acakOpsi': False, 'tampilNilai': True, 'pakaiToken': True}, adm)['data']

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    # ---------- guru: monitor
    g = b.new_context(viewport={'width': 1366, 'height': 860}).new_page()
    g.route('**/*', rute)
    errs = []
    g.on('pageerror', lambda e: errs.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input[autocomplete="username"], input >> nth=0', 'admin')
    g.fill('input[type=password]', 'admin123')
    g.click('button:has-text("Masuk")')
    g.wait_for_selector('text=Beranda', timeout=10000)
    ok('guru: login & beranda', True)
    g.goto(BASE + '/guru/#/monitor/' + U['id'])
    g.wait_for_selector('text=● Status diperbarui otomatis', timeout=10000)
    ok('guru: monitor tersambung langsung (WebSocket)', g.is_visible('text=● Status diperbarui otomatis'))
    ok('guru: token tampil', g.is_visible('text=' + U['token']))

    # ---------- siswa
    sc = b.new_context(viewport={'width': 1280, 'height': 860})
    sc.add_init_script('window.CBT_SIMPAN_DETIK = 4')
    s = sc.new_page()
    s.route('**/*', rute)
    serr = []
    s.on('pageerror', lambda e: serr.append(str(e)))
    s.goto(BASE + '/ujian-cbt/')
    s.fill('input[autocomplete="username"]', '1001')
    s.fill('input[type=password]', '1001')
    s.click('button:has-text("Masuk")')
    s.wait_for_selector('text=Uji Browser', timeout=10000)
    ok('siswa: daftar ujian tampil', True)
    s.click('.kartu:has-text("Uji Browser") button:has-text("Mulai")')
    s.fill('input.token-in', U['token'])
    s.click('button:has-text("Mulai mengerjakan")')
    s.wait_for_selector('text=Soal 1 dari', timeout=10000)
    ok('siswa: soal tampil', True)
    s.click('.opsi >> nth=1')        # jawab soal 1 (B = 16, benar)
    s.wait_for_selector('text=Tersimpan di server', timeout=15000)
    ok('siswa: "Tersimpan di server" (autosave WebSocket di-ack)', True)
    # monitor guru menerima perubahan tanpa refresh
    g.wait_for_function("() => [...document.querySelectorAll('tr')].some(tr => tr.textContent.includes('1001') && tr.textContent.includes('Mengerjakan'))", timeout=15000)
    ok('guru: status "Mengerjakan" muncul otomatis di monitor', True)
    g.screenshot(path='/tmp/shot_monitor.png', full_page=False)
    s.screenshot(path='/tmp/shot_siswa.png')
    # selesai
    s.click('button:has-text("Daftar soal")') if s.is_visible('button:has-text("Daftar soal")') else None
    s.click('button:has-text("Selesai ujian") >> visible=true')
    s.check('input[type=checkbox] >> visible=true')
    s.click('.dlg button:has-text("Kirim"), button:has-text("Kirim jawaban") >> visible=true')
    s.wait_for_selector('.selesai-box .nilai', timeout=20000)
    nilai = s.inner_text('.selesai-box .nilai')
    ok('siswa: layar "Jawaban terkirim" dengan nilai ' + nilai, nilai.strip() == '6.67', nilai)
    s.screenshot(path='/tmp/shot_selesai.png')
    g.wait_for_function("() => [...document.querySelectorAll('tr')].some(tr => tr.textContent.includes('1001') && /Selesai/i.test(tr.textContent))", timeout=15000)
    ok('guru: status Selesai muncul otomatis', True)
    ok('tanpa error JavaScript (guru)', not errs, errs)
    ok('tanpa error JavaScript (siswa)', not serr, serr)
    b.close()

print('\nSEMUA LULUS' if not fails else f'\n{fails} GAGAL')
sys.exit(1 if fails else 0)
