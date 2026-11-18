#!/bin/bash
# Uji gerbang /ujian-cbt/: dengan APP_KUNCI diatur, hanya User-Agent beraplikasi (k/<kunci>) yang dilayani.
cd "$(dirname "$0")/.."
pkill -f "wrangler dev" 2>/dev/null; pkill -f workerd 2>/dev/null; sleep 1; rm -rf .wrangler/state
KUNCI=UJICOBA_$RANDOM
(npx wrangler dev --var DEV_MODE:1 --var APP_KUNCI:$KUNCI --port 8787 --ip 127.0.0.1 >/tmp/wd-gerbang.log 2>&1 &)
sleep 12
gagal=0
cek() { local ua="$1" mau="$2" nama="$3"; local got=$(curl -s -o /dev/null -w "%{http_code}" -A "$ua" http://127.0.0.1:8787/ujian-cbt/); if [ "$got" = "$mau" ]; then echo "  ✓ $nama ($got)"; else echo "  ✗ $nama: mau $mau dapat $got"; gagal=1; fi; }
cek "Mozilla/5.0 Chrome"                    404 "browser biasa → 404"
cek "CBTUjian/1.0 (Android) k/SALAH"        404 "kunci salah → 404"
cek "CBTUjian/1.0 (Android) k/$KUNCI"       200 "aplikasi (kunci benar) → 200"
guru=$(curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0 Chrome" http://127.0.0.1:8787/guru/)
[ "$guru" = "200" ] && echo "  ✓ /guru/ tetap terbuka (200)" || { echo "  ✗ /guru/ = $guru"; gagal=1; }
pkill -f "wrangler dev" 2>/dev/null; pkill -f workerd 2>/dev/null
[ $gagal = 0 ] && echo "SEMUA LULUS" || { echo "ADA GAGAL"; exit 1; }
