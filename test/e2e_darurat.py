# Uji tombol darurat Ctrl+C+B (aplikasi Windows): pesan {t:'kirim'} dari aplikasi → jawaban langsung dikirim.
#   A: online  → terkirim tanpa konfirmasi, aplikasi dibuka kuncinya (buka), alasan tercatat di hasil
#   B: offline → gagal terkirim; aplikasi ditutup & dibuka lagi (halaman dimuat ulang) → langsung terkirim
# Aplikasi ditiru dengan window.CBTAndroid (antarmuka yang sama dipakai halaman untuk .apk/.exe).
# Butuh wrangler dev (port 8787).
import sys, time
from playwright.sync_api import sync_playwright
exec(open('/home/claude/cbt/test/e2e_browser.py').read().split('# --- data ujian via API')[0])

adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
t0 = int(time.time() * 1000)
U = call('saveUjian', {'nama': 'Uji Darurat', 'bankId': 'bcontoh01', 'kelas': ['X-1'], 'mulai': t0 - 60000, 'selesai': t0 + 7200000, 'durasi': 60,
                       'pengawas': [{'id': 'gcontoh', 'kelas': []}], 'acakSoal': False, 'acakOpsi': False, 'tampilNilai': True, 'pakaiToken': False}, adm)['data']
APP = """window.__app = []; window.CBTAndroid = { kunci(i){ __app.push('kunci') }, buka(){ __app.push('buka') }, tutup(){ __app.push('tutup') }, siap(){ return true } };
window.CBT_SIMPAN_DETIK = 4;"""
KIRIM = "window.dispatchEvent(new CustomEvent('cbt-app', { detail: { t: 'kirim' } }))"

def masuk(b, nis):
    ctx = b.new_context(viewport={'width': 1280, 'height': 860}); ctx.add_init_script(APP)
    s = ctx.new_page(); s.route('**/*', rute); s.on('dialog', lambda d: d.accept())
    err = []; s.on('pageerror', lambda e: err.append(str(e)))
    s.goto(BASE + '/ujian-cbt/')
    s.wait_for_selector('button:has-text("Masuk")'); s.wait_for_timeout(800)
    s.fill('input >> nth=0', nis); s.fill('input >> nth=1', nis)   # mode aplikasi: kolom tanpa isi-otomatis
    s.click('button:has-text("Masuk")')
    try: s.wait_for_selector('.kartu:has-text("Uji Darurat")', timeout=15000)
    except Exception: print(s.inner_text('body')[:300]); print(err); raise
    s.click('.kartu:has-text("Uji Darurat") button:has-text("Mulai")')
    s.click('button:has-text("Mulai mengerjakan")')
    s.wait_for_selector('text=Soal 1 dari', timeout=10000)
    s.click('.opsi >> nth=0'); s.wait_for_timeout(300)
    return ctx, s, err

def hasil(nis):
    r = call('hasilUjian', {'ujianId': U['id']}, adm)['data']
    return next((x for x in r['peserta'] if x['nis'] == nis), None)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    # ---- A: online
    ca, sa, ea = masuk(b, '1001')
    ok('A: aplikasi terkunci saat mulai', sa.evaluate('__app.includes("kunci")'))
    sa.evaluate(KIRIM)
    sa.wait_for_selector('.selesai-box', timeout=20000)
    ok('A: jawaban terkirim tanpa konfirmasi', sa.is_visible('.selesai-box'))
    ok('A: aplikasi dibuka kuncinya setelah terkirim', sa.evaluate('__app.lastIndexOf("buka") > __app.indexOf("kunci")'), sa.evaluate('__app'))
    h = hasil('1001')
    ok('A: hasil tersimpan di server dengan alasan tombol darurat', h and h['status'] == 'selesai' and 'darurat' in str(h), h)
    ok('A: penanda darurat dihapus dari perangkat', sa.evaluate("Object.keys(localStorage).every(k => !k.startsWith('cbt_darurat_'))"))
    # ---- B: offline saat tombol ditekan → terkirim saat aplikasi dibuka lagi
    cb, sb, eb = masuk(b, '1002')
    cb.set_offline(True)
    sb.evaluate(KIRIM)
    try: sb.wait_for_function("() => document.body.innerText.includes('Jawaban belum terkirim')", timeout=120000)
    except Exception: print(sb.inner_text('body')[:400]); raise
    ok('B: offline → jawaban belum terkirim, penanda darurat tersimpan', sb.evaluate("Object.keys(localStorage).some(k => k.startsWith('cbt_darurat_'))"))
    ok('B: belum ada hasil selesai di server', not hasil('1002') or hasil('1002')['status'] != 'selesai', hasil('1002'))
    sb.close()                                   # aplikasi ditutup (batas 30 detik habis) …
    cb.set_offline(False)
    sb = cb.new_page(); sb.route('**/*', rute)   # … lalu dibuka lagi saat internet sudah menyala
    sb.on('pageerror', lambda e: eb.append(str(e)))
    sb.goto(BASE + '/ujian-cbt/')
    sb.wait_for_selector('.selesai-box', timeout=30000)
    h = hasil('1002')
    ok('B: dibuka lagi → langsung terkirim (tidak melanjutkan ujian)', h and h['status'] == 'selesai' and 'darurat' in str(h), h)
    ok('B: aplikasi dibuka kuncinya', sb.evaluate('__app.includes("buka")'), sb.evaluate('__app'))
    ok('tanpa galat halaman', not ea and not eb, ea + eb)
    b.close()
print(('\n%d GAGAL' % fails) if fails else '\nSEMUA LULUS'); sys.exit(1 if fails else 0)
