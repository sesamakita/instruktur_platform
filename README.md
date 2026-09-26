# Zoom KW - Platform Lab Koding & Monitoring Layar HP Peserta

Platform video conference khusus monitoring kelas koding mobile (Termux, Acode, dll) dan pengawasan proctoring ujian. Instruktur di PC dapat melihat layar HP semua peserta secara realtime dalam bentuk grid CCTV dengan fitur perbesar (Focus Mode).

---

## 🚀 Fitur Utama
- **CCTV Multi-Screen Grid:** Menampilkan seluruh layar HP peserta secara live.
- **Focus Mode (Zoom-In):** Memperbesar layar salah satu peserta ke ukuran penuh untuk memeriksa sintaks kode & pesan error secara tajam.
- **Background Screen Streaming:** HP peserta tetap memancarkan layarnya meskipun peserta beralih ke aplikasi koding (Acode, Termux) berkat integrasi native `MediaProjectionService` Android.
- **Ringan & Hemat Kuota:** Arsitektur WebRTC Star Topology, HP peserta hanya mengunggah video ke instruktur tanpa mengunduh video peserta lain.
- **Audio Komunikasi Dua Arah:** Instruktur dapat berbicara melalui mikrofon ke semua peserta.

---

## 📁 Struktur Repositori
- `server.js` : Signaling Server (Express + Socket.io + WebRTC Router).
- `public/` : Web Dashboard PC untuk Instruktur (`host.html`) & Portal (`index.html`).
- `mobile_client/` : Aplikasi Android Peserta dibangun dengan React Native Expo + `react-native-webrtc`.

---

## 💻 Menjalankan Server Lokal (PC)
```bash
npm install
npm start
```
Buka di browser PC:
- Dashboard: `http://localhost:3001/host.html` atau `https://localhost:3000/host.html`

---

## 📱 Aplikasi Android Peserta
- Source code berada di folder `mobile_client/`.
- Kompilasi APK Release mandiri:
```bash
cd mobile_client/android
./gradlew assembleRelease
```
File APK yang dihasilkan siap diinstal di perangkat Android 10 s/d 15 (arsitektur `arm64-v8a`).
