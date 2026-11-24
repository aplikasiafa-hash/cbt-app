# Uji tampilan 2.15: kartu token di aplikasi guru (admin: mati/manual/otomatis, pengawas: muat ulang),
# hitung mundur tombol kirim jawaban di halaman siswa, dan penolakan login dari HP lain selama ujian.
# Butuh wrangler dev --var DEV_MODE:1 --var MIN_KIRIM_DETIK:15 (port 8787).
# Pakai: python3 test/e2e_token.py [folder-foto]
import sys, time, re
from playwright.sync_api import sync_playwright
exec(open('/home/claude/cbt/test/e2e_browser.py').read().split('# --- data ujian via API')[0])
FOTO = sys.argv[1] if len(sys.argv) > 1 else ''

adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
t0 = int(time.time() * 1000)
U = call('saveUjian', {'nama': 'Uji Token', 'bankId': 'bcontoh01', 'kelas': ['X-1'], 'mulai': t0 - 60000, 'selesai': t0 + 7200000, 'durasi': 60,
                       'pengawas': [{'id': 'gcontoh', 'kelas': []}], 'acakSoal': False, 'acakOpsi': False, 'tampilNilai': True}, adm)['data']

def guru(b, user, pw):
    g = b.new_context(viewport={'width': 1366, 'height': 900}).new_page()
    g.route('**/*', rute)
    err = []; g.on('pageerror', lambda e: err.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input[autocomplete="username"], input >> nth=0', user)
    g.fill('input[type=password]', pw)
    g.click('button:has-text("Masuk")')
    g.wait_for_selector('text=Beranda', timeout=10000)
    return g, err

def siswa(b, nis):
    ctx = b.new_context(viewport={'width': 1280, 'height': 860})
    s = ctx.new_page(); s.route('**/*', rute)
    err = []; s.on('pageerror', lambda e: err.append(str(e)))
    s.goto(BASE + '/ujian-cbt/')
    s.fill('input[autocomplete="username"]', nis)
    s.fill('input[type=password]', nis)
    s.click('button:has-text("Masuk")')
    return ctx, s, err

def nilai_token(pg):
    pg.wait_for_selector('.kartu-token .token-box b', timeout=10000)
    return pg.inner_text('.kartu-token .token-box b').strip()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    # ---------- admin: token otomatis dari Beranda
    a, ea = guru(b, 'admin', 'admin123')
    a.wait_for_selector('.kartu-token h3:has-text("Token ujian")', timeout=10000)
    ok('admin: kartu token di Beranda, bawaan mati', 'tanpa token' in a.inner_text('.kartu-token'), a.inner_text('.kartu-token'))
    a.click('.kartu-token button:has-text("Otomatis")')
    a.fill('.kartu-token input[type=number]', '5')
    a.click('.kartu-token button:has-text("Aktifkan token otomatis")')
    T1 = nilai_token(a)
    ok('admin: token otomatis aktif (6 karakter) + jam berganti', re.fullmatch(r'[A-Z2-9]{6}', T1) and 'berganti pukul' in a.inner_text('.kartu-token'), T1)
    if FOTO: a.locator('.kartu-token').screenshot(path=FOTO + '/token-admin-otomatis.png')

    # ---------- pengawas: lihat + muat ulang, tanpa tombol atur
    g, eg = guru(b, 'guru', 'guru123')
    ok('pengawas: melihat token yang sama di Beranda', nilai_token(g) == T1)
    ok('pengawas: tidak ada tombol mengatur token', g.locator('.kartu-token .token-atur').count() == 0)
    a.click('.kartu-token button:has-text("Manual")')
    a.fill('.kartu-token input[maxlength="8"]', 'siap1')
    a.click('.kartu-token button:has-text("Pakai token ini")')
    a.wait_for_function("() => document.querySelector('.kartu-token .token-box b')?.textContent.trim() === 'SIAP1'", timeout=10000)
    ok('admin: token manual SIAP1', nilai_token(a) == 'SIAP1')
    ok('pengawas: sebelum muat ulang masih token lama', nilai_token(g) == T1)
    g.click('.kartu-token button:has-text("Muat ulang")')
    g.wait_for_function("() => document.querySelector('.kartu-token .token-box b')?.textContent.trim() === 'SIAP1'", timeout=10000)
    ok('pengawas: tombol "↻ Muat ulang" menampilkan token baru', nilai_token(g) == 'SIAP1')
    if FOTO: g.locator('.kartu-token').screenshot(path=FOTO + '/token-pengawas.png')

    # ---------- jadwal & monitor
    a.goto(BASE + '/guru/#/jadwal'); a.wait_for_selector('.kartu-token', timeout=10000); a.wait_for_selector('text=Uji Token', timeout=10000)
    hdr = a.inner_text('thead') if a.locator('thead').count() else ''
    ok('jadwal: kartu token di atas, kolom Token per jadwal dihapus', 'Token' not in hdr, hdr)
    a.click('tr:has-text("Uji Token") button[aria-label="Aksi lain"]')
    a.click('.pop button:has-text("Ubah jadwal")')
    a.wait_for_selector('text=Ubah jadwal', timeout=5000); a.wait_for_timeout(400)
    ok('form jadwal: tidak ada centang "Wajib memasukkan token"', 'Wajib memasukkan token' not in a.inner_text('body'))
    ok('form jadwal: pilihan "Semua guru" ada, kolom nama pengawas tampil', a.locator('label.semua-guru').count() == 1 and a.locator('input[placeholder*="nama guru"]').count() == 1)
    a.check('label.semua-guru input')
    ok('centang "Semua guru" → kolom nama pengawas disembunyikan', a.locator('input[placeholder*="nama guru"]').count() == 0)
    if FOTO: a.screenshot(path=FOTO + '/jadwal-semua-guru.png')
    a.click('button:has-text("Simpan jadwal")')
    a.wait_for_function("() => [...document.querySelectorAll('tr')].some(tr => tr.textContent.includes('Uji Token') && tr.textContent.includes('Semua guru'))", timeout=10000)
    ok('daftar jadwal: kolom pengawas menampilkan "Semua guru"', True)
    ok('jadwal: kartu "Waktu minimal sebelum selesai" di bawah kartu token', a.evaluate("() => { const t = document.querySelector('.kartu-token'), s = document.querySelector('.kartu-selesai'); return !!(t && s && (t.compareDocumentPosition(s) & 4)); }"))
    a.wait_for_function("() => document.querySelector('.kartu-selesai input')?.value === '1'", timeout=10000)
    a.fill('.kartu-selesai input', '5'); a.click('.kartu-selesai button:has-text("Simpan")')
    a.wait_for_function("() => document.body.innerText.includes('Siswa bisa selesai 5 menit')", timeout=10000)
    ok('admin menyimpan 5 menit', call('waktuSelesai', {}, adm)['data']['menit'] == 5)
    if FOTO: a.locator('.kartu-selesai').screenshot(path=FOTO + '/kartu-selesai.png')
    a.fill('.kartu-selesai input', '1'); a.click('.kartu-selesai button:has-text("Simpan")')
    a.wait_for_function("() => document.body.innerText.includes('Siswa bisa selesai 1 menit')", timeout=10000)
    g.goto(BASE + '/guru/#/monitor/' + U['id'])
    g.wait_for_selector('.token-box b', timeout=10000)
    ok('monitor: token ringkas + muat ulang', g.inner_text('.token-box b').strip() == 'SIAP1' and g.locator('.token-box button:has-text("Muat ulang")').count() == 1)

    a.goto(BASE + '/guru/#/pengaturan'); a.wait_for_selector('text=Sistem & cadangan', timeout=10000)
    ok('pengaturan: isian waktu selesai sudah dipindah ke Jadwal ujian', 'Aturan ujian' not in a.inner_text('body'))

    # ---------- siswa: token, hitung mundur tombol kirim, HP lain ditolak
    cs, s, es = siswa(b, '1001')
    s.wait_for_selector('.kartu:has-text("Uji Token")', timeout=15000)
    s.click('.kartu:has-text("Uji Token") button:has-text("Mulai")')
    s.wait_for_selector('input.token-in', timeout=5000)
    s.fill('input.token-in', 'SALAH')
    s.click('button:has-text("Mulai mengerjakan")')
    s.wait_for_function("() => document.body.innerText.includes('Token ujian salah')", timeout=10000)
    ok('siswa: token salah ditolak', True)
    s.fill('input.token-in', 'siap1')
    s.click('button:has-text("Mulai mengerjakan")')
    s.wait_for_selector('text=Soal 1 dari', timeout=10000)
    s.click('.opsi >> nth=1'); s.wait_for_timeout(300)
    ok('siswa: tombol Selesai disembunyikan selama waktu minimal berjalan', s.locator('button.btn-selesai >> visible=true').count() == 0)
    ok('siswa: keterangan hitung mundur tampil', re.search(r'Tombol Selesai muncul 0:\d\d lagi', s.inner_text('body')) is not None, s.inner_text('.tunggu-selesai') if s.locator('.tunggu-selesai').count() else '')
    s.click('.bub >> nth=-1'); s.wait_for_timeout(300)
    ok('siswa: soal terakhir — tombol Selesai di bawah juga tersembunyi', s.locator('.uj-foot button.btn-selesai >> visible=true').count() == 0)
    if FOTO: s.screenshot(path=FOTO + '/siswa-hitung-mundur.png')

    c2, s2, e2 = siswa(b, '1001')    # HP lain (perangkat baru)
    s2.wait_for_function("() => document.body.innerText.includes('perangkat lain')", timeout=10000)
    ok('HP lain: login ditolak selama ujian berlangsung', 'sedang dipakai mengerjakan ujian di perangkat lain' in s2.inner_text('body'), s2.inner_text('body')[:300])
    if FOTO: s2.screenshot(path=FOTO + '/siswa-hp-lain.png')
    c2.close()

    s.wait_for_function("() => [...document.querySelectorAll('button.btn-selesai')].some(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden')", timeout=30000)
    ok('siswa: setelah waktu minimal habis tombol Selesai tampil', s.locator('.uj-foot button.btn-selesai >> visible=true').count() == 1)
    s.click('button.btn-selesai >> visible=true')
    s.check('input[type=checkbox] >> visible=true')
    s.click('.dlg button:has-text("Kirim"), button:has-text("Kirim jawaban") >> visible=true')
    s.wait_for_selector('.selesai-box', timeout=20000)
    ok('siswa: jawaban terkirim', True)
    c3, s3, e3 = siswa(b, '1001')
    s3.wait_for_selector('.kartu:has-text("Uji Token")', timeout=15000)
    ok('setelah selesai: bisa masuk di HP lain', True)

    errs = [x for x in ea + eg + es + e3 if 'ResizeObserver' not in x]
    ok('tanpa galat JavaScript', not errs, errs)
    b.close()

print('LULUS' if not fails else 'GAGAL: %d' % fails)
