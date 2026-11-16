@echo off
chcp 65001 >nul
title Pasang CBT Sekolah ke Cloudflare
cd /d "%~dp0"
echo ============================================================
echo   CBT Sekolah - pasang / perbarui di Cloudflare (gratis)
echo ============================================================
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terpasang. Unduh versi LTS dari https://nodejs.org
  echo lalu jalankan file ini lagi.
  start https://nodejs.org
  pause
  exit /b 1
)
echo.
echo [1/3] Memasang alat bantu (sekali saja)...
call npm install --no-audit --no-fund
if errorlevel 1 goto gagal
echo.
echo [2/3] Masuk ke akun Cloudflare (browser akan terbuka, klik Allow)...
call npx wrangler whoami | find /i "You are logged in" >nul
if errorlevel 1 call npx wrangler login
if errorlevel 1 goto gagal
echo.
echo [3/3] Mengunggah aplikasi...
call npx wrangler deploy
if errorlevel 1 goto gagal
echo.
echo ============================================================
echo  SELESAI. Buka alamat https://cbt-sekolah....workers.dev di atas,
echo  tambahkan /guru/ untuk guru dan /siswa/ untuk siswa.
echo  Login pertama: admin / admin123  (segera ganti kata sandi)
echo ============================================================
pause
exit /b 0
:gagal
echo.
echo Terjadi kesalahan. Baca pesan di atas, atau lihat PANDUAN.md bagian Pemecahan masalah.
pause
exit /b 1
