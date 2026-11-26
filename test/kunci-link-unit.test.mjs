// Uji 2.19.1: kunci link hanya dari serverC; spasi/enter yang ikut tertempel diabaikan; kosong/"-" → gerbang mati.
import assert from 'node:assert/strict';
import { kunciLinkDari } from '../src/shared.js';
import { readFileSync } from 'node:fs';
assert.equal(kunciLinkDari({ APP_KUNCI: 'abc123' }), 'abc123');
assert.equal(kunciLinkDari({ APP_KUNCI: '  abc123 \n' }), 'abc123', 'spasi/enter diabaikan');
assert.equal(kunciLinkDari({ APP_KUNCI: '' }), '', 'kosong → mati');
assert.equal(kunciLinkDari({ APP_KUNCI: '-' }), '', '"-" → mati');
assert.equal(kunciLinkDari({}), '', 'tidak ada → mati (tidak memakai kunci bawaan)');
assert.equal(kunciLinkDari({ DEV_MODE: '0' }), '');
const src = readFileSync('src/shared.js', 'utf8') + readFileSync('src/index.js', 'utf8') + readFileSync('src/engine.js', 'utf8');
assert.ok(!/cbt_[A-Za-z0-9_]{20,}/.test(src), 'kode aplikasi tidak memuat kunci link');
console.log('SEMUA LULUS kunci link unit');
