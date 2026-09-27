// Configuration and State
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('room') || 'KODING-101';
let studentName = urlParams.get('name') || '';

document.getElementById('roomIdInput').value = roomId;
if (studentName) {
    document.getElementById('studentNameInput').value = studentName;
}

const socket = io();
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

let pc = null;
let hostSocketId = null;

// Streams & Tracks
let screenStream = null;
let cameraStream = null;
let micStream = null;

let isScreenSharing = false;
let isCameraActive = false;
let isMicActive = false;

// 1. Connection & Handshake
socket.on('connect', () => {
    console.log('[Socket] Connected with ID:', socket.id);
    document.getElementById('connectionBadge').className = 'live-badge badge-live';
    document.getElementById('connectionBadge').textContent = 'Server Terhubung';

    // Auto join if name is already provided via URL
    if (studentName && roomId) {
        joinRoom();
    }
});

socket.on('disconnect', () => {
    document.getElementById('connectionBadge').className = 'live-badge badge-danger';
    document.getElementById('connectionBadge').textContent = 'Terputus';
});

socket.on('student-joined-success', (data) => {
    console.log('[Join Success]', data);
    document.getElementById('joinFormSection').style.display = 'none';
    document.getElementById('streamingControlSection').style.display = 'block';
    document.getElementById('studentRoomBadge').textContent = `Room: ${roomId}`;

    initPeerConnection();
});

socket.on('host-disconnected', () => {
    alert('⚠️ Instruktur telah keluar dari ruang kelas.');
});

socket.on('host-command', ({ command }) => {
    if (command === 'request-screen') {
        alert('📢 Instruktur meminta Anda untuk membagikan layar HP kembali.');
        startScreenShare();
    }
});

// 2. WebRTC Peer Connection Setup
function initPeerConnection() {
    if (pc) pc.close();

    pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                targetId: hostSocketId, // or broadcasted to host room
                signalData: { candidate: event.candidate }
            });
        }
    };

    // Receive audio broadcast from instructor
    pc.ontrack = (event) => {
        console.log('[Remote Track Received]', event.track.kind);
        if (event.track.kind === 'audio') {
            const remoteAudio = document.getElementById('remoteInstructorAudio');
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.play().catch(e => console.log('Audio autoplay blocked, click anywhere to enable', e));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('[WebRTC State]', pc.connectionState);
    };
}

// 3. WebRTC Signaling Handling
socket.on('signal', async ({ senderId, signalData }) => {
    hostSocketId = senderId;

    try {
        if (signalData.type === 'answer') {
            console.log('[WebRTC] Received answer from Host');
            await pc.setRemoteDescription(new RTCSessionDescription(signalData));
        } else if (signalData.candidate) {
            console.log('[WebRTC] Received ICE Candidate from Host');
            await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
    } catch (err) {
        console.error('[WebRTC Signal Error]', err);
    }
});

async function sendOffer() {
    if (!pc) return;
    try {
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        socket.emit('signal', {
            targetId: hostSocketId,
            signalData: offer
        });
        console.log('[WebRTC] Offer sent to host');
    } catch (err) {
        console.error('Error sending offer:', err);
    }
}

// 4. Screen Sharing Logic (Core Feature)
async function startScreenShare() {
    try {
        // High quality display media capture for code readability
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                frameRate: { ideal: 24, max: 30 },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        });

        screenStream = stream;
        const screenTrack = stream.getVideoTracks()[0];
        screenTrack.contentHint = 'detail'; // Hints browser to optimize for text/code clarity

        // Add track to WebRTC connection
        pc.addTrack(screenTrack, screenStream);
        await sendOffer();

        isScreenSharing = true;
        updateUI();

        // Detect if user stops screen sharing from Android notification / system prompt
        screenTrack.onended = () => {
            console.log('[Screen Share Ended]');
            stopScreenShare(false);
            socket.emit('student-alert', {
                message: 'Layar dihentikan oleh peserta (aplikasi dihentikan / tombol stop ditekan)',
                type: 'warning'
            });
        };

        // Notify server & host
        socket.emit('student-status-update', {
            hasScreen: true,
            hasCamera: isCameraActive
        });

    } catch (err) {
        console.error('Failed to share screen:', err);
        if (err.name === 'NotAllowedError') {
            alert('Izin berbagi layar ditolak. Silakan izinkan untuk melanjutkan.');
        } else {
            alert('Error berbagi layar: ' + err.message);
        }
    }
}

function stopScreenShare(notifyServer = true) {
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    isScreenSharing = false;
    updateUI();

    if (notifyServer) {
        socket.emit('student-status-update', {
            hasScreen: false,
            hasCamera: isCameraActive
        });
    }
}

// 5. Front Camera Logic (Optional PiP)
async function toggleCamera() {
    const btn = document.getElementById('btnToggleCamera');
    const preview = document.getElementById('cameraPreview');

    if (!isCameraActive) {
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: 'user',
                    width: { ideal: 480 },
                    height: { ideal: 640 },
                    frameRate: { ideal: 15 }
                }
            });

            const camTrack = cameraStream.getVideoTracks()[0];
            pc.addTrack(camTrack, cameraStream);
            await sendOffer();

            preview.srcObject = cameraStream;
            preview.style.display = 'block';

            isCameraActive = true;
            btn.textContent = '❌ Matikan Kamera Wajah';
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-danger');

            socket.emit('student-status-update', {
                hasScreen: isScreenSharing,
                hasCamera: true
            });
        } catch (err) {
            console.error('Failed to open camera:', err);
            alert('Gagal mengakses kamera depan: ' + err.message);
        }
    } else {
        if (cameraStream) {
            cameraStream.getTracks().forEach(t => t.stop());
            cameraStream = null;
        }
        preview.style.display = 'none';
        isCameraActive = false;
        btn.textContent = '📷 Aktifkan Kamera Depan';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-secondary');

        socket.emit('student-status-update', {
            hasScreen: isScreenSharing,
            hasCamera: false
        });
    }
}

// 6. Microphone Logic (Optional)
async function toggleMic() {
    const btn = document.getElementById('btnToggleMic');

    if (!isMicActive) {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const micTrack = micStream.getAudioTracks()[0];
            pc.addTrack(micTrack, micStream);
            await sendOffer();

            isMicActive = true;
            btn.textContent = '🔇 Matikan Mikrofon';
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-success');
        } catch (err) {
            console.error('Mic error:', err);
            alert('Gagal mengakses mikrofon: ' + err.message);
        }
    } else {
        if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
        }
        isMicActive = false;
        btn.textContent = '🎙️ Aktifkan Mikrofon';
        btn.classList.remove('btn-success');
        btn.classList.add('btn-secondary');
    }
}

// 7. UI Helpers
function updateUI() {
    const btnShare = document.getElementById('btnShareScreen');
    const btnStop = document.getElementById('btnStopScreen');
    const liveBanner = document.getElementById('liveBanner');

    if (isScreenSharing) {
        btnShare.style.display = 'none';
        btnStop.style.display = 'block';
        liveBanner.style.display = 'block';
    } else {
        btnShare.style.display = 'block';
        btnStop.style.display = 'none';
        liveBanner.style.display = 'none';
    }
}

function joinRoom() {
    studentName = document.getElementById('studentNameInput').value.trim();
    roomId = document.getElementById('roomIdInput').value.trim() || 'KODING-101';

    if (!studentName) {
        alert('Silakan masukkan nama Anda!');
        return;
    }

    socket.emit('student-join', {
        roomId,
        studentName
    });
}

// Event Listeners
document.getElementById('btnConnect').addEventListener('click', joinRoom);
document.getElementById('btnShareScreen').addEventListener('click', startScreenShare);
document.getElementById('btnStopScreen').addEventListener('click', () => stopScreenShare(true));
document.getElementById('btnToggleCamera').addEventListener('click', toggleCamera);
document.getElementById('btnToggleMic').addEventListener('click', toggleMic);
document.getElementById('btnExit').addEventListener('click', () => {
    if (confirm('Yakin ingin keluar dari kelas?')) {
        window.location.href = 'index.html';
    }
});
