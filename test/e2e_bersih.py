# Uji tampilan 2.19: Pengaturan → "Bersihkan hasil ujian…" (kata sandi). Panel "Sambungan" sudah tidak ada.
import time, sys
from playwright.sync_api import sync_playwright
exec(open('/home/claude/cbt/test/e2e_browser.py').read().split('# --- data ujian via API')[0])
FOTO = sys.argv[1] if len(sys.argv) > 1 else ''
adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
t0 = int(time.time() * 1000)
U = call('saveUjian', {'nama': 'Ujian Bersih', 'bankId': 'bcontoh01', 'kelas': ['X-1'], 'mulai': t0 - 60000, 'selesai': t0 + 3600000, 'durasi': 30}, adm)['data']
for nis in ['1001', '1002']:
    tok = call('loginSiswa', {'nis': nis, 'password': nis, 'perangkat': 'hp' + nis})['data']['token']
    m = call('mulaiUjian', {'ujianId': U['id'], 'perangkat': 'hp' + nis}, tok)['data']
    call('selesaiUjian', {'ujianId': U['id'], 'jawaban': {'j': {}, 'r': []}, 'perangkat': 'hp' + nis, 'mulai': m['mulai']}, tok)
call('_dev', {'flush': True})
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    g = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); g.route('**/*', rute)
    err = []; g.on('pageerror', lambda e: err.append(str(e)))
    g.goto(BASE + '/guru/'); g.fill('input[autocomplete="username"]', 'admin'); g.fill('input[type=password]', 'admin123'); g.click('button:has-text("Masuk")')
    g.wait_for_selector('.page-head h1'); g.goto(BASE + '/guru/#/pengaturan'); g.wait_for_selector('text=Sistem & cadangan')
    g.wait_for_selector('button:has-text("Bersihkan hasil ujian")', timeout=10000)
    ok('panel "Sambungan serverB & serverC" sudah tidak ada', g.locator('text=Sambungan serverB').count() == 0 and g.locator('.sambungan').count() == 0)
    ok('tidak ada nama variabel teknis di layar', not any(x in g.inner_text('body') for x in ['GITHUB_TOKEN', 'APP_KUNCI', 'CF_API_TOKEN', 'Cloudflare', 'D1']))
    if FOTO: g.locator('.panel:has-text("Sistem & cadangan")').first.screenshot(path=FOTO + '/sistem.png')
    g.click('button:has-text("Bersihkan hasil ujian")')
    g.wait_for_selector('text=2 hasil dari 1 ujian', timeout=8000)
    ok('jendela konfirmasi menampilkan jumlah hasil', True)
    ok('tombol Bersihkan nonaktif sebelum kata sandi diisi', g.locator('.modal button:has-text("Bersihkan hasil")').is_disabled())
    g.fill('.modal .sandi-wrap input', 'salah'); g.click('.modal button:has-text("Bersihkan hasil")')
    g.wait_for_selector('.modal >> text=Kata sandi salah', timeout=8000)
    ok('kata sandi salah → pesan di jendela, data tidak dihapus', call('jumlahHasil', {}, adm)['data']['hasil'] == 2)
    g.fill('.modal .sandi-wrap input', 'admin123')
    if FOTO: g.locator('.modal').screenshot(path=FOTO + '/bersih-dialog.png')
    g.click('.modal button:has-text("Bersihkan hasil")')
    g.wait_for_selector('text=2 hasil ujian dibersihkan', timeout=10000)
    ok('kata sandi benar → hasil dibersihkan', call('jumlahHasil', {}, adm)['data']['hasil'] == 0)
    ok('jadwal tetap ada', any(u['id'] == U['id'] for u in call('listUjian', {}, adm)['data']))
    ok('tanpa galat JavaScript', not err, err)
    b.close()
print('LULUS' if not fails else 'GAGAL %d' % fails)
