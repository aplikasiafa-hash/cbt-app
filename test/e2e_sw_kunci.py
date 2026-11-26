# Uji 2.19.1: aplikasi Android — permintaan dari service worker TIDAK membawa User-Agent aplikasi (kunci link).
# Tiruan: User-Agent berkunci hanya dipasang untuk halaman (CDP per halaman), service worker memakai UA bawaan.
# Jalankan dengan: wrangler dev --local-protocol https --var DEV_MODE:1 --var APP_KUNCI:kunciuji
import sys, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'https://127.0.0.1:8787'
gagal = 0
def ok(n, c, info=''):
    global gagal
    print(('  ✓ ' if c else '  ✗ ') + n + ('' if c else '  ' + str(info)[:300]))
    if not c: gagal += 1

with sync_playwright() as p:
    b = p.chromium.launch(args=['--ignore-certificate-errors'])
    c = b.new_context(ignore_https_errors=True)
    g = c.new_page()
    cdp = c.new_cdp_session(g)
    ua_asli = g.evaluate('navigator.userAgent')
    cdp.send('Network.setUserAgentOverride', {'userAgent': ua_asli + ' CBTUjian/1.3 (Android) k/kunciuji'})
    r = g.goto(BASE + '/ujian-cbt/')
    ok('buka pertama dari aplikasi → 200', r.status == 200, r.status)
    g.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller !== undefined', timeout=10000)
    g.evaluate('navigator.serviceWorker.ready')
    time.sleep(1.5)
    sw_ua = None
    for w in c.service_workers:
        try: sw_ua = w.evaluate('navigator.userAgent')
        except Exception: pass
    ok('service worker aktif & UA-nya tanpa kunci link (seperti Android)', bool(sw_ua) and 'k/kunciuji' not in sw_ua, sw_ua)
    ok('salinan halaman tersimpan untuk dibuka tanpa internet', g.evaluate("caches.open('cbt-ujian-v1').then(c => c.match(new URL('./', location.href).href)).then(r => !!r && r.ok)"))
    for i in range(3):
        r = g.reload()
        ok('buka ulang ke-%d dari aplikasi → 200 (bukan "Halaman tidak ditemukan")' % (i + 1), r.status == 200 and 'tidak ditemukan' not in g.title().lower(), (r.status, g.title()))
    # tanpa internet → salinan di perangkat
    c.set_offline(True)
    try:
        g.reload(wait_until='domcontentloaded')
        # (pustaka dari jsDelivr tidak terjangkau di lingkungan uji ini; yang diuji: HTML halaman dari salinan)
        ok('tanpa internet → halaman ujian dibuka dari salinan di perangkat', g.title() == 'Ujian CBT', g.title())
    except Exception as e:
        ok('tanpa internet → halaman ujian tetap terbuka dari salinan', False, e)
    c.set_offline(False)
    # browser biasa (tanpa kunci) tetap ditolak
    c2 = b.new_context(ignore_https_errors=True); g2 = c2.new_page()
    r = g2.goto(BASE + '/ujian-cbt/')
    ok('browser biasa → 404', r.status == 404, r.status)
    # aplikasi dengan kunci berbeda / tanpa kunci → pesan jelas + kode
    for ua, kode in ((' CBTUjian/1.3 (Windows) k/kunci-lain', 'K1'), (' CBTUjian/1.3 (Windows)', 'K0')):
        c3 = b.new_context(ignore_https_errors=True, user_agent=ua_asli + ua); g3 = c3.new_page()
        r = g3.goto(BASE + '/ujian-cbt/'); t = g3.locator('body').inner_text()
        ok('aplikasi %s → 404 dengan pesan "belum cocok" & kode %s' % (kode, kode), r.status == 404 and 'belum cocok' in t and ('Kode ' + kode) in t and 'APP_KUNCI' not in t, t)
        c3.close()
    b.close()
print('GAGAL %d' % gagal if gagal else 'SEMUA LULUS sw kunci')
sys.exit(1 if gagal else 0)
