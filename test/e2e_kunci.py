# Uji tampilan fitur kunci bank soal di Chrome (admin & guru). Butuh wrangler dev (DEV_MODE) dengan data baru.
import json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8787'
V = '/tmp/vendor'
CDN = {'vue.global.prod.js': V + '/vue-3.5.45/package/dist/vue.global.prod.js', 'katex.min.js': V + '/katex-0.19.1/package/dist/katex.min.js',
       'auto-render.min.js': V + '/katex-0.19.1/package/dist/contrib/auto-render.min.js', 'katex.min.css': V + '/katex-0.19.1/package/dist/katex.min.css'}
FOTO = sys.argv[1] if len(sys.argv) > 1 else '/tmp'
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
        if url.endswith(k): return route.fulfill(path=f, content_type='text/css' if f.endswith('.css') else 'application/javascript')
    if 'cdn.jsdelivr.net' in url or 'fonts.' in url or 'sheetjs' in url: return route.fulfill(status=404, body='')
    return route.continue_()

adm = call('loginGuru', {'username': 'admin', 'password': 'admin123'})['data']['token']
call('importGuru', {'rows': [{'username': 'bu.rina', 'nama': 'Bu Rina', 'mapel': 'Kimia', 'password': 'rahasia1', 'peran': 'guru', 'status': 'aktif'}]}, adm)
gt = call('loginGuru', {'username': 'bu.rina', 'password': 'rahasia1'})['data']['token']
soal = [{'id': f'q{k}z', 'tipe': 'pg', 'teks': f'Soal kimia nomor {k + 1}', 'bobot': 1, 'opsi': [{'id': f'o{k}{h}', 'teks': h} for h in 'abcd'], 'kunci': f'o{k}a'} for k in range(3)]
B = call('saveBank', {'bank': {'judul': 'PAS Kimia X', 'mapel': 'Kimia', 'tingkat': 'X', 'soal': soal}}, gt)['data']['bank']
call('saveBank', {'bank': {'judul': 'Latihan Kimia (tidak dijadwalkan)', 'mapel': 'Kimia', 'tingkat': 'X', 'soal': soal[:1]}}, gt)
t = int(time.time() * 1000)
call('saveUjian', {'nama': 'PAS Kimia X', 'bankId': B['id'], 'tingkat': 'X', 'kelas': ['X-1'], 'mulai': t - 60000, 'selesai': t + 7200000, 'durasi': 90}, adm)

def masuk(pg, u, p):
    pg.route('**/*', rute)
    pg.goto(BASE + '/guru/'); pg.fill('input >> nth=0', u); pg.fill('input[type=password]', p); pg.click('button:has-text("Masuk")')
    pg.wait_for_selector('text=Beranda', timeout=10000)

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    errs = []
    a = br.new_context(viewport={'width': 1366, 'height': 760}).new_page(); a.on('pageerror', lambda e: errs.append(str(e)))
    g = br.new_context(viewport={'width': 1366, 'height': 820}).new_page(); g.on('pageerror', lambda e: errs.append(str(e)))
    masuk(a, 'admin', 'admin123'); masuk(g, 'bu.rina', 'rahasia1')

    print('Admin mengunci dari halaman Bank soal')
    a.goto(BASE + '/guru/#/bank'); a.wait_for_selector('text=PAS Kimia X')
    TG = '.toolbar button:has-text("Kunci semua"), .toolbar button:has-text("Buka semua kunci")'
    ok('tombol "Impor file JSON" dan "Kunci bank yang dijadwalkan" tidak ada', not a.is_visible('button:has-text("Impor file JSON")') and not a.is_visible('button:has-text("dijadwalkan")'))
    tg = a.locator(TG)
    ok('belum ada yang dikunci: tombol hitam "Kunci semua"', tg.inner_text().strip() == 'Kunci semua' and 'btn-primary' in tg.get_attribute('class'), (tg.inner_text(), tg.get_attribute('class')))
    tg.click(); a.click('.modal-foot .btn-primary:has-text("Kunci semua")')
    a.wait_for_selector('.toolbar button:has-text("Buka semua kunci")', timeout=8000)
    ok('setelah "Kunci semua": semua bank 🔒, tombol menjadi "Buka semua kunci" (putih)', a.locator('tbody tr .chip:has-text("Dikunci")').count() == a.locator('tbody tr').count() and 'btn-primary' not in tg.get_attribute('class'))
    tg.click(); a.click('.modal-foot .btn-primary:has-text("Buka semua")')
    a.wait_for_selector('.toolbar button:has-text("Kunci semua")', timeout=8000)
    ok('setelah "Buka semua kunci": tidak ada yang dikunci, tombol kembali hitam "Kunci semua"', a.locator('tbody tr .chip:has-text("Dikunci")').count() == 0 and 'btn-primary' in tg.get_attribute('class'))
    a.click('tr:has-text("PAS Kimia X") button:has-text("Kunci")'); a.click('.modal-foot .btn-primary:has-text("Kunci")')
    a.wait_for_selector('tr:has-text("PAS Kimia X") .chip:has-text("Dikunci")', timeout=8000)
    ok('kunci satu bank: bertanda 🔒 Dikunci, tombolnya jadi "Buka kunci"', a.is_visible('tr:has-text("PAS Kimia X") button:has-text("Buka kunci")'))
    ok('masih ada bank terbuka → tombol tetap hitam "Kunci semua"', tg.inner_text().strip() == 'Kunci semua' and 'btn-primary' in tg.get_attribute('class'))
    ok('bank lain tetap terbuka', not a.is_visible('tr:has-text("Latihan Kimia") .chip:has-text("Dikunci")') and a.is_visible('tr:has-text("Latihan Kimia") button:has-text("Kunci")'))
    ok('ringkasan "1 bank dikunci"', a.is_visible('text=1 bank dikunci'))
    a.screenshot(path=FOTO + '/kunci-admin.png')

    print('Guru membuka bank yang dikunci')
    g.goto(BASE + '/guru/#/bank'); g.wait_for_selector('text=PAS Kimia X')
    ok('guru melihat tanda Dikunci dan tombol "Lihat"', g.is_visible('tr:has-text("PAS Kimia X") .chip:has-text("Dikunci")') and g.is_visible('tr:has-text("PAS Kimia X") a:has-text("Lihat")'))
    g.click('tr:has-text("PAS Kimia X") a:has-text("Lihat")'); g.wait_for_selector('.warn-bar.kunci')
    ok('editor menampilkan pemberitahuan dikunci oleh Administrator', 'dikunci' in g.inner_text('.warn-bar.kunci') and 'Administrator' in g.inner_text('.warn-bar.kunci'))
    ok('judul, isian soal, tambah soal, dan Impor cepat tidak bisa dipakai',
       g.is_disabled('input.judul') and g.is_disabled('fieldset.fs-polos textarea >> nth=0') and g.is_disabled('.type-menu button >> nth=0') and g.is_disabled('.ed-head button:has-text("Impor cepat")'),
       [g.is_disabled('input.judul'), g.is_disabled('fieldset.fs-polos textarea >> nth=0'), g.is_disabled('.type-menu button >> nth=0'), g.is_disabled('.ed-head button:has-text("Impor cepat")')])
    ok('tidak ada tombol Simpan', not g.is_visible('.ed-head button:has-text("Simpan")'))
    g.screenshot(path=FOTO + '/kunci-guru.png')
    g.click('button:has-text("Pratinjau siswa")')
    ok('Pratinjau siswa tetap bisa dibuka', g.wait_for_selector('text=seperti yang dilihat siswa', timeout=5000) is not None)
    g.click('.bub >> nth=2'); ok('pindah nomor soal tetap bisa', g.is_visible('h3:has-text("Soal nomor 3 seperti yang dilihat siswa")'))

    print('Dikunci saat guru sedang mengedit')
    call('kunciBank', {'ids': [B['id']], 'kunci': False}, adm)
    g.goto(BASE + '/guru/#/bank'); g.goto(BASE + '/guru/#/editor/' + B['id']); g.wait_for_selector('.ed-head input.judul')
    ok('setelah dibuka, guru bisa mengedit lagi', g.is_enabled('input.judul') and not g.is_visible('.warn-bar.kunci'))
    g.fill('input.judul', 'PAS Kimia X (revisi)'); g.fill('fieldset.fs-polos textarea >> nth=0', 'Soal kimia nomor 1 (revisi)'); time.sleep(1)
    call('kunciBank', {'ids': [B['id']], 'kunci': True}, adm)
    g.click('.ed-head button:has-text("Simpan")')
    g.wait_for_selector('.warn-bar.kunci', timeout=8000)
    ok('Simpan ditolak, pemberitahuan kunci langsung muncul', g.is_visible('text=draf di perangkat ini'))
    ok('di server soal tidak berubah', call('getBank', {'id': B['id']}, gt)['data']['soal'][0]['teks'] == 'Soal kimia nomor 1')
    call('kunciBank', {'pilih': 'semua', 'kunci': False}, adm)
    g.evaluate("window.confirm = () => true")   # guru menjawab OK pada "Tinggalkan halaman ini?"
    g.evaluate("location.hash = '#/bank'"); g.wait_for_selector('text=Buat bank soal'); g.evaluate("location.hash = '#/editor/" + B['id'] + "'")
    g.wait_for_selector('text=Pulihkan draf?', timeout=8000); g.click('.modal-foot .btn-primary:has-text("Pulihkan")')
    g.click('.ed-head button:has-text("Simpan")'); g.wait_for_selector('.ed-status:has-text("Tersimpan")', timeout=8000)
    bk = call('getBank', {'id': B['id']}, gt)['data']
    ok('setelah kunci dibuka, draf dipulihkan dan tersimpan', bk['judul'] == 'PAS Kimia X (revisi)' and bk['soal'][0]['teks'] == 'Soal kimia nomor 1 (revisi)' and not bk.get('terkunci'), bk['judul'])

    print('Admin membuka kunci dari editor bank miliknya')
    own = call('saveBank', {'bank': {'judul': 'Bank admin', 'mapel': 'Kimia', 'tingkat': 'X', 'soal': soal[:1]}}, adm)['data']['bank']
    call('kunciBank', {'ids': [own['id']], 'kunci': True}, adm)
    a.goto(BASE + '/guru/#/editor/' + own['id']); a.wait_for_selector('.warn-bar.kunci')
    a.click('.warn-bar.kunci button:has-text("Buka kunci")'); a.wait_for_selector('.warn-bar.kunci', state='detached', timeout=8000)
    ok('kunci terbuka, status tidak berubah jadi "belum disimpan"', a.is_enabled('input.judul') and 'belum disimpan' not in a.inner_text('.ed-status'))
    ok('tidak ada galat JavaScript', not errs, errs)
    br.close()
print('\n' + (f'{fails} GAGAL' if fails else 'SEMUA LULUS'))
sys.exit(1 if fails else 0)
