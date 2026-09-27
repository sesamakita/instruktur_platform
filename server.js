const express = require('express');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const os = require('os');
const selfsigned = require('selfsigned');

const app = express();

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to find local LAN IP for easy mobile access
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const localIp = getLocalIpAddress();
const HTTPS_PORT = process.env.HTTPS_PORT || 3000;
const HTTP_PORT = process.env.PORT || 3001;

async function startServer() {
    console.log('Generating local SSL certificate for secure WebRTC connection...');
    const pems = await selfsigned.generate([
        { name: 'commonName', value: localIp }
    ], { days: 365 });

    const httpsOptions = {
        key: pems.private,
        cert: pems.cert
    };

    // Create HTTPS and HTTP servers
    const httpsServer = https.createServer(httpsOptions, app);
    const httpServer = http.createServer(app);

    // Attach Socket.io to HTTPS server with aggressive ping for mobile tunnel stability
    const io = socketIo(httpsServer, {
        cors: { origin: '*' },
        pingInterval: 10000,
        pingTimeout: 10000
    });

    // Also attach socket.io to HTTP server if accessed from localhost
    io.attach(httpServer);

    // In-memory room management
    // rooms: { [roomId]: { hostSocketId, students: { [socketId]: { name, hasScreen, hasCamera } } } }
    const rooms = {};

    app.get('/api/status', (req, res) => {
        res.json({
            rooms,
            totalClients: io.engine.clientsCount
        });
    });

    io.on('connection', (socket) => {
        console.log(`[Socket Connected] ID: ${socket.id}`);

        // --- HOST (INSTRUCTOR) EVENTS ---
        socket.on('register-host', ({ roomId }) => {
            const normRoomId = (roomId || 'KODING-101').trim().toUpperCase();
            if (!rooms[normRoomId]) {
                rooms[normRoomId] = { hostSocketId: socket.id, students: {} };
            } else {
                rooms[normRoomId].hostSocketId = socket.id;
            }

            socket.join(normRoomId);
            socket.role = 'host';
            socket.roomId = normRoomId;

            console.log(`[Host Registered] Room: ${normRoomId}, Host ID: ${socket.id}`);
            socket.emit('host-registered', {
                roomId: normRoomId,
                localIp,
                httpsPort: HTTPS_PORT,
                existingStudents: rooms[normRoomId].students
            });
        });

        // --- STUDENT (PARTICIPANT HP) EVENTS ---
        socket.on('student-join', ({ roomId, studentName, previousSocketId }) => {
            const normRoomId = (roomId || 'KODING-101').trim().toUpperCase();
            if (!rooms[normRoomId]) {
                rooms[normRoomId] = { hostSocketId: null, students: {} };
            }

            // If previous socket exists in grace period, clear its timeout and remove old entry
            if (previousSocketId && rooms[normRoomId].students[previousSocketId]) {
                if (rooms[normRoomId].students[previousSocketId].disconnectTimeout) {
                    clearTimeout(rooms[normRoomId].students[previousSocketId].disconnectTimeout);
                }
                delete rooms[normRoomId].students[previousSocketId];
            }

            // Also check if any existing student has the same name and is marked disconnected
            Object.keys(rooms[normRoomId].students).forEach(sId => {
                const s = rooms[normRoomId].students[sId];
                if (s.name === studentName && s.disconnected) {
                    if (s.disconnectTimeout) clearTimeout(s.disconnectTimeout);
                    delete rooms[normRoomId].students[sId];
                }
            });

            rooms[normRoomId].students[socket.id] = {
                id: socket.id,
                name: studentName || 'Peserta Tanpa Nama',
                hasScreen: false,
                hasCamera: false,
                disconnected: false,
                joinedAt: new Date().toLocaleTimeString()
            };

            socket.join(normRoomId);
            socket.role = 'student';
            socket.roomId = normRoomId;
            socket.studentName = studentName;

            console.log(`[Student Joined] Room: ${normRoomId}, Student: ${studentName} (${socket.id})`);

            socket.emit('student-joined-success', {
                studentId: socket.id,
                hostSocketId: rooms[normRoomId].hostSocketId,
                hostConnected: !!rooms[normRoomId].hostSocketId
            });

            if (rooms[normRoomId].hostSocketId) {
                console.log(`[Notifying Host] Sending student-connected to host ${rooms[normRoomId].hostSocketId}`);
                io.to(rooms[normRoomId].hostSocketId).emit('student-connected', {
                    student: rooms[normRoomId].students[socket.id]
                });
            }
        });

        socket.on('student-status-update', ({ hasScreen, hasCamera }) => {
            const roomId = socket.roomId;
            if (roomId && rooms[roomId] && rooms[roomId].students[socket.id]) {
                const student = rooms[roomId].students[socket.id];
                student.hasScreen = hasScreen;
                student.hasCamera = hasCamera;

                if (rooms[roomId].hostSocketId) {
                    io.to(rooms[roomId].hostSocketId).emit('student-status-changed', {
                        studentId: socket.id,
                        hasScreen,
                        hasCamera
                    });
                }
            }
        });

        socket.on('student-alert', ({ message, type }) => {
            const roomId = socket.roomId;
            if (roomId && rooms[roomId] && rooms[roomId].hostSocketId) {
                io.to(rooms[roomId].hostSocketId).emit('student-alert-received', {
                    studentId: socket.id,
                    studentName: socket.studentName,
                    message,
                    type: type || 'warning',
                    time: new Date().toLocaleTimeString()
                });
            }
        });

        // WebRTC Signaling Router: Auto-routes to host if targetId is missing
        socket.on('signal', ({ targetId, signalData, streamType }) => {
            let destinationId = targetId;
            const roomId = socket.roomId;
            if (!destinationId && roomId && rooms[roomId]) {
                if (socket.role === 'student') {
                    destinationId = rooms[roomId].hostSocketId;
                }
            }
            if (destinationId) {
                console.log(`[Signal Routed] From ${socket.id} (${socket.role}) to ${destinationId}`);
                io.to(destinationId).emit('signal', {
                    senderId: socket.id,
                    senderName: socket.studentName || 'Instruktur',
                    signalData,
                    streamType
                });
            } else {
                console.warn(`[Signal Dropped] No destination found for signal from ${socket.id}`);
            }
        });

        socket.on('host-command', ({ targetStudentId, command }) => {
            io.to(targetStudentId).emit('host-command', { command });
        });

        socket.on('disconnect', (reason) => {
            console.log(`[Socket Disconnected] ID: ${socket.id} (${socket.role}) Reason: ${reason}`);
            const roomId = socket.roomId;

            if (roomId && rooms[roomId]) {
                if (socket.role === 'host') {
                    console.log(`[Host Left] Room: ${roomId}`);
                    rooms[roomId].hostSocketId = null;
                    io.to(roomId).emit('host-disconnected');
                } else if (socket.role === 'student') {
                    const student = rooms[roomId].students[socket.id];
                    if (student) {
                        const studentName = student.name || 'Peserta';
                        student.disconnected = true;

                        // Notify host that student is temporarily reconnecting (keep card alive)
                        if (rooms[roomId].hostSocketId) {
                            io.to(rooms[roomId].hostSocketId).emit('student-reconnecting', {
                                studentId: socket.id,
                                studentName
                            });
                        }

                        // 15 seconds grace period for mobile reconnection
                        student.disconnectTimeout = setTimeout(() => {
                            if (rooms[roomId] && rooms[roomId].students[socket.id] && rooms[roomId].students[socket.id].disconnected) {
                                console.log(`[Grace Period Expired] Removing student ${studentName} (${socket.id})`);
                                delete rooms[roomId].students[socket.id];
                                if (rooms[roomId].hostSocketId) {
                                    io.to(rooms[roomId].hostSocketId).emit('student-disconnected', {
                                        studentId: socket.id,
                                        studentName,
                                        time: new Date().toLocaleTimeString()
                                    });
                                }
                            }
                        }, 15000);
                    }
                }
            }
        });
    });

    // Start HTTPS Server
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
        console.log('================================================================');
        console.log('🚀 ZOOM KW - KODING LAB & SCREEN MONITORING SERVER BERJALAN!');
        console.log('================================================================');
        console.log(`💻 Buka di PC Instruktur  : https://localhost:${HTTPS_PORT}/host.html`);
        console.log(`📱 Buka di HP Peserta     : https://${localIp}:${HTTPS_PORT}/student.html`);
        console.log('----------------------------------------------------------------');
        console.log('⚠️ PETUNJUK PENGGUNAAN :');
        console.log(`1. Pastikan PC dan HP terhubung ke jaringan WiFi/Hotspot yang SAMA.`);
        console.log(`2. Buka di HP (Google Chrome): https://${localIp}:${HTTPS_PORT}/student.html`);
        console.log(`3. Di HP akan muncul peringatan "Koneksi tidak privat" (karena sertifikat lokal).`);
        console.log(`   Cukup klik tombol "Lanjutan" (Advanced) -> "Lanjutkan ke situs" (Proceed).`);
        console.log('================================================================');
    });

    // Start HTTP Server fallback
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
        console.log(`[HTTP Fallback] Port ${HTTP_PORT} juga aktif di http://localhost:${HTTP_PORT}`);
    });
}

startServer().catch(err => {
    console.error('Fatal Server Error:', err);
});
