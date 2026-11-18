# Uji Chrome HEMAT KUOTA: hitung request yang benar-benar diterima server (Worker) per aplikasi.
#   Guru  : login → bank soal → edit & Simpan → jadwal → monitor 2 ujian           target 1 request (guru pemilik soal)
#   Siswa A: login → mulai → menjawab → Selesai → nilai → kembali ke daftar         target 1 request
#   Siswa B: koneksi putus di tengah ujian + halaman dimuat ulang → Selesai         target 2 request (1 + kirim akhir)
#   Siswa C: offline saat waktu habis → Pending di monitor → internet kembali → Selesai   target 2 request
import re, sys, time
from playwright.sync_api import sync_playwright
exec(open('/home/claude/cbt-cloudflare/test/e2e_browser.py').read().split('# --- data ujian via API')[0])

panggilan = [0]
_call = call
def call(a, d=None, tok=''):
    panggilan[0] += 1
    return _call(a, d, tok)
def log_api():
    return sum(1 for l in open('/tmp/wd.log', encoding='utf-8', errors='ignore') if re.search(r'\] (GET|POST) /api', l))

adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
gtok = call('loginGuru', {'username': 'guru', 'password': 'guru123'})['data']['token']   # guru pemilik soal (melihat jawaban & nilai)
t0 = int(time.time() * 1000)
U = call('saveUjian', {'nama': 'Uji Hemat', 'bankId': 'bcontoh01', 'kelas': ['X-1'], 'mulai': t0 - 60000, 'selesai': t0 + 7200000, 'durasi': 60, 'pengawas': [{'id': 'gcontoh', 'kelas': []}],
                       'acakSoal': False, 'acakOpsi': False, 'tampilNilai': True, 'pakaiToken': True}, adm)['data']
U2 = call('saveUjian', {'nama': 'Kuis Singkat', 'bankId': 'bcontoh01', 'kelas': ['X-2'], 'mulai': t0 - 60000, 'selesai': t0 + 7200000, 'durasi': 1, 'pengawas': [{'id': 'gcontoh', 'kelas': []}],
                        'acakSoal': False, 'acakOpsi': False, 'tampilNilai': True, 'pakaiToken': False}, adm)['data']

def pantau(page):
    c = {'http': [], 'ws': 0}
    page.on('requestfinished', lambda r: c['http'].append(r.url.split('?a=')[-1]) if '/api' in r.url and r.resource_type != 'websocket' else None)
    def ws(w):
        if '/api/ws' not in w.url: return
        dapat = [False]
        def f(_):
            if not dapat[0]: dapat[0] = True; c['ws'] += 1
        w.on('framereceived', f)
    page.on('websocket', ws)
    return c
def total(c): return len(c['http']) + c['ws']
def baris(g, nis, teks, ms=15000):
    g.wait_for_function("([n, t]) => [...document.querySelectorAll('tr')].some(tr => tr.textContent.includes(n) && tr.textContent.includes(t))", arg=[nis, teks], timeout=ms)

def siswa_masuk(b, nis):
    ctx = b.new_context(viewport={'width': 1280, 'height': 860}); ctx.add_init_script('window.CBT_SIMPAN_DETIK = 4')
    s = ctx.new_page(); s.route('**/*', rute); c = pantau(s); s.on('dialog', lambda d: d.accept())
    err = []; s.on('pageerror', lambda e: err.append(str(e)))
    s.goto(BASE + '/ujian-cbt/')
    s.fill('input[autocomplete="username"]', nis); s.fill('input[type=password]', nis); s.click('button:has-text("Masuk")')
    return ctx, s, c, err
def mulai(s, nama, token=None):
    s.wait_for_selector('text=' + nama, timeout=10000)
    s.click(f'.kartu:has-text("{nama}") button:has-text("Mulai")')
    if token: s.fill('input.token-in', token)
    s.click('button:has-text("Mulai mengerjakan")')
    s.wait_for_selector('text=Soal 1 dari', timeout=10000)
def jawab(s, no):
    if no > 1: s.keyboard.press('ArrowRight'); s.wait_for_selector(f'text=Soal {no} dari', timeout=5000)
    s.click('.opsi >> nth=0')
def selesai(s):
    s.click('button:has-text("Selesai ujian") >> visible=true')
    s.check('input[type=checkbox] >> visible=true')
    s.click('.dlg button:has-text("Kirim"), button:has-text("Kirim jawaban") >> visible=true')
    s.wait_for_selector('.selesai-box .nilai', timeout=30000)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'])
    # ---------------- GURU: buka aplikasi sekali, edit soal, jadwal, monitor
    g = b.new_context(viewport={'width': 1366, 'height': 860}).new_page(); g.route('**/*', rute)
    gc = pantau(g); gerr = []; g.on('pageerror', lambda e: gerr.append(str(e)))
    g.goto(BASE + '/guru/')
    g.fill('input >> nth=0', 'guru'); g.fill('input[type=password]', 'guru123'); g.click('button:has-text("Masuk")')   # guru pemilik bank contoh
    g.wait_for_selector('text=Beranda', timeout=10000)
    g.goto(BASE + '/guru/#/bank'); g.wait_for_selector('text=Contoh — Semua Jenis Soal', timeout=10000)
    g.goto(BASE + '/guru/#/editor/bcontoh01'); g.wait_for_selector('input.judul', timeout=10000)
    for i in range(3):   # beberapa kali mengedit sebelum menyimpan
        g.fill('input.judul', 'Contoh — Semua Jenis Soal (edit %d)' % (i + 1)); g.wait_for_timeout(400)
    g.click('.ed-head button:has-text("Simpan")')
    g.wait_for_selector('.ed-status:has-text("Tersimpan ")', timeout=10000)
    ok('guru: edit soal lalu Simpan', True)
    g.goto(BASE + '/guru/#/jadwal'); g.wait_for_selector('text=Uji Hemat', timeout=10000)
    g.goto(BASE + '/guru/#/monitor/' + U['id']); g.wait_for_selector('text=● Status diperbarui otomatis', timeout=10000)
    ok('guru: monitor menampilkan 4 status', all(g.is_visible('.stat-status >> text=' + t) for t in ['Belum mulai', 'Mengerjakan', 'Pending', 'Selesai']))
    ok('guru: monitor tanpa kolom progres', not g.is_visible('th:has-text("Progres")'))

    # ---------------- SISWA A: alur normal
    ca, sa, cA, eA = siswa_masuk(b, '1001')
    mulai(sa, 'Uji Hemat', U['token'])
    baris(g, '1001', 'Mengerjakan'); ok('monitor: siswa A "Mengerjakan"', True)
    jawab(sa, 1); jawab(sa, 2)
    sa.wait_for_selector('text=Tersimpan di server', timeout=15000)
    ok('siswa A: cadangan jawaban lewat koneksi yang sama', True)
    selesai(sa)
    ok('siswa A: selesai, nilai ' + sa.inner_text('.selesai-box .nilai'), True)
    baris(g, '1001', 'Selesai'); ok('monitor: siswa A "Selesai"', True)
    sa.click('button:has-text("Kembali ke daftar ujian")'); sa.wait_for_selector('.kartu:has-text("Uji Hemat") >> text=Selesai', timeout=10000)
    ok('siswa A: daftar ujian menampilkan Selesai', True)

    # ---------------- SISWA B: koneksi putus + halaman dimuat ulang di tengah ujian
    cb, sb, cB, eB = siswa_masuk(b, '1002')
    mulai(sb, 'Uji Hemat', U['token'])
    jawab(sb, 1)
    sb.wait_for_selector('text=Tersimpan di server', timeout=15000)
    sb.evaluate('Sok.ws && Sok.ws.close()')
    sb.wait_for_selector('text=dikirim saat Selesai', timeout=5000)
    sb.wait_for_timeout(8000)
    jawab(sb, 2)
    sb.wait_for_timeout(6000)
    ok('siswa B: koneksi putus → TIDAK menyambung ulang selama ujian', cB['ws'] == 1, cB)
    sb.reload(); sb.wait_for_selector('text=Soal 2 dari', timeout=10000)
    ok('siswa B: muat ulang → ujian lanjut dari perangkat (soal 2, tanpa server)', total(cB) == 1, cB)
    for k in (3, 4, 5): sb.keyboard.press('ArrowRight'); sb.wait_for_selector(f'text=Soal {k} dari', timeout=5000)
    sb.fill('input.isian', 'jawaban setelah muat ulang')
    sb.wait_for_timeout(6000)
    selesai(sb)
    hb = call('hasilUjian', {'ujianId': U['id']}, gtok)['data']
    pb = next(x for x in hb['peserta'] if x['nis'] == '1002')
    ok('siswa B: 3 jawaban (termasuk yang dibuat saat terputus & setelah muat ulang) diterima server', len(pb['jawaban']['j']) == 3, pb['jawaban'])
    baris(g, '1002', 'Selesai'); ok('monitor: siswa B "Selesai"', True)

    # ---------------- SISWA C: offline saat waktu habis → Pending → internet kembali
    g.goto(BASE + '/guru/#/monitor'); g.wait_for_selector('text=Kuis Singkat', timeout=10000)
    g.goto(BASE + '/guru/#/monitor/' + U2['id']); g.wait_for_selector('h1:has-text("Kuis Singkat")', timeout=10000); g.wait_for_selector('text=● Status diperbarui otomatis', timeout=10000)
    cc, sc, cC, eC = siswa_masuk(b, '1003')
    mulai(sc, 'Kuis Singkat')
    jawab(sc, 1)
    sc.wait_for_selector('text=Tersimpan di server', timeout=15000)
    jawab(sc, 2)
    cc.set_offline(True); sc.evaluate('Sok.ws && Sok.ws.close()')
    sc.wait_for_selector('text=Jawaban belum terkirim', timeout=90000)
    ok('siswa C: waktu habis saat offline → "belum terkirim, aman di perangkat"', True)
    call('_dev', {'offset': 150000, 'rawat': True})
    baris(g, '1003', 'Pending', 20000); ok('monitor: siswa C "Pending"', True)
    cc.set_offline(False)
    sc.wait_for_selector('.selesai-box', timeout=30000)
    ok('siswa C: internet kembali → jawaban terkirim otomatis', True)
    baris(g, '1003', 'Selesai'); ok('monitor: siswa C "Selesai"', True)
    hc = call('hasilUjian', {'ujianId': U2['id']}, gtok)['data']
    pc = next(x for x in hc['peserta'] if x['nis'] == '1003')
    ok('siswa C: 2 jawaban dari perangkat dinilai, catatan terlambat', len(pc['jawaban']['j']) == 2 and 'setelah waktu habis' in pc['catatan'], pc)
    call('_dev', {'offset': 0})
    g.wait_for_timeout(1000)

    print('\n  Request yang diterima server:')
    for n, c in [('GURU   (edit soal, jadwal, 2 monitor)', gc), ('SISWA A (normal)', cA), ('SISWA B (putus + muat ulang)', cB), ('SISWA C (offline saat waktu habis)', cC)]:
        print('   %-40s %d  (koneksi %d, HTTP %s)' % (n, total(c), c['ws'], c['http']))
    ok('guru: 1 request', total(gc) == 1, gc)
    ok('siswa A: 1 request untuk 1 ujian', total(cA) == 1, cA)
    ok('siswa B: 2 request (1 + kirim akhir karena koneksi sempat putus)', total(cB) == 2, cB)
    ok('siswa C: 2 request (1 + kirim akhir setelah internet kembali)', total(cC) == 2, cC)
    time.sleep(1.5)
    dari_log = log_api() - panggilan[0]   # server baru: semua baris /api = panggilan uji ini + browser
    ok('cocok dengan log server: %d request dari browser' % dari_log, dari_log == total(gc) + total(cA) + total(cB) + total(cC), dari_log)
    ok('tanpa error JavaScript', not (gerr + eA + eB + eC), gerr + eA + eB + eC)
    b.close()
print('\nSEMUA LULUS' if not fails else f'\n{fails} GAGAL')
sys.exit(1 if fails else 0)
