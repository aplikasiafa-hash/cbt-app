#!/bin/bash
# Uji salinan data setelah mesin ujian tidur-bangun: tiap tahap diawali restart wrangler (data tetap tersimpan).
cd "$(dirname "$0")/.."
mulai() { pkill -f "wrangler dev"; pkill -f workerd; sleep 1; (npx wrangler dev --var DEV_MODE:1 --port 8787 --ip 127.0.0.1 > /tmp/wd.log 2>&1 &); sleep 9; }
rm -rf .wrangler/state; mulai; node test/bangun.test.mjs 1 || exit 1
mulai; node test/bangun.test.mjs 2 || exit 1
mulai; node test/bangun.test.mjs 3 || exit 1
echo "SEMUA LULUS"
