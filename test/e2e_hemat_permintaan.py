# Uji 2.18: aplikasi guru hemat permintaan — data baca disimpan sebentar di perangkat, perubahan mengosongkannya,
# tombol Muat ulang tetap mengambil langsung dari server.
import time, sys, collections
from playwright.sync_api import sync_playwright
exec(open('/home/claude/cbt/test/e2e_browser.py').read().split('# --- data ujian via API')[0])
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    g = b.new_context(viewport={'width': 1366, 'height': 860}).new_page(); g.route('**/*', rute)
    log = []
    g.on('request', lambda req: log.append(req.url.split('a=')[1].split('&')[0]) if '/api?a=' in req.url else None)
    def hitung(fn):
        n0 = len(log); fn(); g.wait_for_timeout(1200); return log[n0:]
    g.goto(BASE + '/guru/'); g.wait_for_selector('input[type=password]')
    g.fill('input[autocomplete="username"]', 'admin'); g.fill('input[type=password]', 'admin123')
    x = hitung(lambda: (g.click('button:has-text("Masuk")'), g.wait_for_selector('.page-head h1')))
    ok('masuk: tanpa getConfig tambahan (pengaturan ikut jawaban login)', 'getConfig' not in x, x)
    for r in ['bank', 'jadwal', 'monitor', 'siswa', 'guru']:
        g.goto(BASE + '/guru/#/' + r); g.wait_for_timeout(500)
    x = hitung(lambda: [ (g.goto(BASE + '/guru/#/beranda'), g.reload(), g.wait_for_selector('.page-head h1')) for _ in range(3) ])
    ok('buka /guru/ 3 kali lagi: hampir tanpa permintaan', len(x) <= 1, x)
    x = hitung(lambda: [ (g.goto(BASE + '/guru/#/' + r), g.wait_for_timeout(400)) for r in ['bank', 'jadwal', 'siswa', 'guru'] ])
    ok('kembali ke menu yang sama: 0 permintaan', len(x) == 0, x)
    x = hitung(lambda: (g.goto(BASE + '/guru/#/jadwal'), g.wait_for_selector('.kartu-token'), g.click('.kartu-token button:has-text("Muat ulang")')))
    ok('tombol Muat ulang token tetap meminta ke server', x.count('tokenUjian') == 1, x)
    # perubahan → simpanan dikosongkan → daftar langsung terbaru
    adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
    g.goto(BASE + '/guru/#/siswa'); g.wait_for_timeout(600)
    g.evaluate("api('saveSiswa', { nis: '9991', nama: 'Siswa Baru Hemat', kelas: 'X-1', password: '' })")
    g.wait_for_timeout(800)
    x = hitung(lambda: (g.goto(BASE + '/guru/#/beranda'), g.wait_for_timeout(300), g.goto(BASE + '/guru/#/siswa'), g.wait_for_selector('text=Siswa Baru Hemat', timeout=8000)))
    ok('setelah menyimpan, daftar siswa diambil ulang dan data baru tampil', 'listSiswa' in x, x)
    print('Total permintaan uji ini:', len(log), dict(collections.Counter(log)))
    b.close()
print('LULUS' if not fails else 'GAGAL %d' % fails)
