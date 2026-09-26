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

    // Attach Socket.io to HTTPS server
    const io = socketIo(httpsServer, {
        cors: { origin: '*' }
    });

    // Also attach socket.io to HTTP server if accessed from localhost
    io.attach(httpServer);

    // In-memory room management
    // rooms: { [roomId]: { hostSocketId, students: { [socketId]: { name, hasScreen, hasCamera } } } }
    const rooms = {};

    io.on('connection', (socket) => {
        console.log(`[Socket Connected] ID: ${socket.id}`);

        // --- HOST (INSTRUCTOR) EVENTS ---
        socket.on('register-host', ({ roomId }) => {
            if (!rooms[roomId]) {
                rooms[roomId] = { hostSocketId: socket.id, students: {} };
            } else {
                rooms[roomId].hostSocketId = socket.id;
            }

            socket.join(roomId);
            socket.role = 'host';
            socket.roomId = roomId;

            console.log(`[Host Registered] Room: ${roomId}, Host ID: ${socket.id}`);
            socket.emit('host-registered', {
                roomId,
                localIp,
                httpsPort: HTTPS_PORT,
                existingStudents: rooms[roomId].students
            });
        });

        // --- STUDENT (PARTICIPANT HP) EVENTS ---
        socket.on('student-join', ({ roomId, studentName }) => {
            if (!rooms[roomId]) {
                rooms[roomId] = { hostSocketId: null, students: {} };
            }

            rooms[roomId].students[socket.id] = {
                id: socket.id,
                name: studentName || 'Peserta Tanpa Nama',
                hasScreen: false,
                hasCamera: false,
                joinedAt: new Date().toLocaleTimeString()
            };

            socket.join(roomId);
            socket.role = 'student';
            socket.roomId = roomId;
            socket.studentName = studentName;

            console.log(`[Student Joined] Room: ${roomId}, Student: ${studentName} (${socket.id})`);

            socket.emit('student-joined-success', {
                studentId: socket.id,
                hostConnected: !!rooms[roomId].hostSocketId
            });

            if (rooms[roomId].hostSocketId) {
                io.to(rooms[roomId].hostSocketId).emit('student-connected', {
                    student: rooms[roomId].students[socket.id]
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

        socket.on('signal', ({ targetId, signalData, streamType }) => {
            io.to(targetId).emit('signal', {
                senderId: socket.id,
                senderName: socket.studentName || 'Instruktur',
                signalData,
                streamType
            });
        });

        socket.on('host-command', ({ targetStudentId, command }) => {
            io.to(targetStudentId).emit('host-command', { command });
        });

        socket.on('disconnect', () => {
            console.log(`[Socket Disconnected] ID: ${socket.id} (${socket.role})`);
            const roomId = socket.roomId;

            if (roomId && rooms[roomId]) {
                if (socket.role === 'host') {
                    console.log(`[Host Left] Room: ${roomId}`);
                    rooms[roomId].hostSocketId = null;
                    io.to(roomId).emit('host-disconnected');
                } else if (socket.role === 'student') {
                    const student = rooms[roomId].students[socket.id];
                    const studentName = student ? student.name : 'Peserta';
                    delete rooms[roomId].students[socket.id];

                    if (rooms[roomId].hostSocketId) {
                        io.to(rooms[roomId].hostSocketId).emit('student-disconnected', {
                            studentId: socket.id,
                            studentName,
                            time: new Date().toLocaleTimeString()
                        });
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
