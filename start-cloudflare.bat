@echo off
title Cloudflare Tunnel - Zoom KW
cd /d "%~dp0"
echo ========================================================
echo   Menjalankan Cloudflare Tunnel (QUIC Protocol) Zoom KW
echo ========================================================
.\cloudflared.exe tunnel --url http://127.0.0.1:3001
pause
