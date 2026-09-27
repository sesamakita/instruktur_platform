// Configuration and State
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room') || 'KODING-101';
document.getElementById('displayRoomId').textContent = roomId;

const socket = io();
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// Store active student connections: { [studentId]: { pc, student, screenStream, cameraStream, cardEl } }
const students = {};
let studentUrl = '';
let hostAudioStream = null;
let isMicOn = false;
let currentFocusedStudentId = null;

// Audio Beep for Alerts using Web Audio API
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playAlertBeep(isDanger = false) {
    try {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = isDanger ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(isDanger ? 880 : 587.33, audioCtx.currentTime); // A5 or D5
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
    } catch (e) {
        console.error('Audio beep error:', e);
    }
}

// 1. Socket Connection and Registration
socket.on('connect', () => {
    console.log('[Socket] Connected to signaling server with ID:', socket.id);
    socket.emit('register-host', { roomId });
});

socket.on('host-registered', (data) => {
    console.log('[Host Registered]', data);
    const host = window.location.hostname;
    const protocol = window.location.protocol;
    const port = window.location.port ? `:${window.location.port}` : '';
    
    // Construct student URL using actual IP if local
    const studentHost = (host === 'localhost' || host === '127.0.0.1') ? data.localIp : host;
    studentUrl = `${protocol}//${studentHost}${port}/student.html?room=${encodeURIComponent(roomId)}`;
    document.getElementById('studentUrlText').textContent = studentUrl;

    // Render QR Code
    const qrContainer = document.getElementById('qrcodeWrapper');
    qrContainer.innerHTML = '';
    if (window.QRCode) {
        new QRCode(qrContainer, {
            text: studentUrl,
            width: 180,
            height: 180,
            colorDark: "#0f172a",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    }

    // Populate existing students if reconnecting
    if (data.existingStudents) {
        Object.values(data.existingStudents).forEach(addStudentCard);
    }
});

// 2. Student Lifecycle Events
socket.on('student-connected', ({ student }) => {
    console.log('[Student Connected]', student);
    showAlertToast(`🟢 ${student.name} bergabung ke ruang kelas`, 'info');
    playAlertBeep(false);
    addStudentCard(student);
});

socket.on('student-status-changed', ({ studentId, hasScreen, hasCamera }) => {
    console.log('[Status Changed]', studentId, { hasScreen, hasCamera });
    const studentObj = students[studentId];
    if (studentObj) {
        studentObj.hasScreen = hasScreen;
        studentObj.hasCamera = hasCamera;
        updateStudentCardBadge(studentId);

        if (!hasScreen) {
            showAlertToast(`⚠️ Layar ${studentObj.student.name} terhenti!`, 'warning');
            playAlertBeep(true);
        }
    }
});

socket.on('student-alert-received', ({ studentName, message, type, time }) => {
    showAlertToast(`⚠️ [${time}] ${studentName}: ${message}`, type === 'danger' ? 'danger' : 'warning');
    playAlertBeep(true);
});

socket.on('student-reconnecting', ({ studentId, studentName }) => {
    showAlertToast(`⏳ ${studentName} koneksi terputus, menunggu menyambung kembali...`, 'warning');
    const studentObj = students[studentId];
    if (studentObj && studentObj.badgeEl) {
        studentObj.badgeEl.className = 'live-badge badge-warning';
        studentObj.badgeEl.innerHTML = '<span class="pulse-dot"></span> Reconnecting...';
    }
});

socket.on('student-disconnected', ({ studentId, studentName, time }) => {
    showAlertToast(`🔴 [${time}] ${studentName} keluar dari ruang kelas`, 'danger');
    playAlertBeep(true);
    removeStudent(studentId);
});

// 3. WebRTC Signaling Handling
socket.on('signal', async ({ senderId, senderName, signalData, streamType }) => {
    let studentObj = students[senderId];
    if (!studentObj) {
        console.log(`[WebRTC] Sinyal diterima dari peserta baru, membuat kartu otomatis: ${senderId}`);
        addStudentCard({ id: senderId, name: senderName || 'Peserta HP' });
        studentObj = students[senderId];
    }

    const pc = studentObj.pc;

    try {
        if (signalData.type === 'offer') {
            console.log(`[WebRTC] Received offer from ${senderId}`);
            await pc.setRemoteDescription(new RTCSessionDescription(signalData));

            // Attach host audio track if mic is currently on
            if (hostAudioStream) {
                hostAudioStream.getAudioTracks().forEach(track => {
                    pc.addTrack(track, hostAudioStream);
                });
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            socket.emit('signal', {
                targetId: senderId,
                signalData: {
                    type: answer.type,
                    sdp: answer.sdp
                }
            });
        } else if (signalData.type === 'answer') {
            console.log(`[WebRTC] Received answer from ${senderId}`);
            await pc.setRemoteDescription(new RTCSessionDescription(signalData));
        } else if (signalData.candidate) {
            console.log(`[WebRTC] Received ICE Candidate from ${senderId}`);
            await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
    } catch (err) {
        console.error('[WebRTC Signal Error]', err);
    }
});

// Helper: Setup Peer Connection for Student
function createPeerConnection(studentId) {
    const pc = new RTCPeerConnection(rtcConfig);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', {
                targetId: studentId,
                signalData: {
                    candidate: {
                        candidate: event.candidate.candidate,
                        sdpMid: event.candidate.sdpMid,
                        sdpMLineIndex: event.candidate.sdpMLineIndex
                    }
                }
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[Peer ${studentId}] Connection state:`, pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            updateStudentCardBadge(studentId, 'disconnected');
        }
    };

    // When remote track arrives (Screen or Camera)
    pc.ontrack = (event) => {
        console.log(`[Track Received from ${studentId}] Kind:`, event.track.kind, 'Stream ID:', event.streams[0].id);
        const stream = event.streams[0];
        const studentObj = students[studentId];
        if (!studentObj) return;

        // Differentiate screen vs camera by track label, settings or order
        // Screen tracks usually have large dimensions or label containing "screen"
        const track = event.track;
        const isScreen = track.label.toLowerCase().includes('screen') || 
                         track.label.toLowerCase().includes('display') || 
                         (track.getSettings && track.getSettings().displaySurface);

        if (track.kind === 'video') {
            if (isScreen || !studentObj.screenStream) {
                console.log(`[Stream Assigned as SCREEN] for ${studentId}`);
                studentObj.screenStream = stream;
                studentObj.screenVideoEl.srcObject = stream;
                studentObj.noScreenEl.style.display = 'none';
                studentObj.hasScreen = true;

                // Sync with focus modal if this student is currently focused
                if (currentFocusedStudentId === studentId) {
                    document.getElementById('focusScreenVideo').srcObject = stream;
                }
            } else {
                console.log(`[Stream Assigned as CAMERA] for ${studentId}`);
                studentObj.cameraStream = stream;
                studentObj.cameraVideoEl.srcObject = stream;
                studentObj.pipContainerEl.style.display = 'block';
                studentObj.hasCamera = true;

                if (currentFocusedStudentId === studentId) {
                    const focusCamEl = document.getElementById('focusCameraVideo');
                    focusCamEl.srcObject = stream;
                    document.getElementById('focusPipContainer').style.display = 'block';
                }
            }
            updateStudentCardBadge(studentId);
        } else if (track.kind === 'audio') {
            // Attach student audio to play through instructor speaker
            const audioEl = studentObj.audioEl || document.createElement('audio');
            audioEl.autoplay = true;
            audioEl.srcObject = stream;
            studentObj.audioEl = audioEl;
        }
    };

    return pc;
}

// 4. UI Card Management
function addStudentCard(student) {
    if (students[student.id]) return; // Already exists

    // If an existing student has the same name (reconnect case), remove old card cleanly
    Object.keys(students).forEach(oldId => {
        if (students[oldId].student && students[oldId].student.name === student.name && oldId !== student.id) {
            removeStudent(oldId);
        }
    });

    document.getElementById('emptyState').style.display = 'none';

    const card = document.createElement('div');
    card.className = 'student-card';
    card.id = `card-${student.id}`;

    card.innerHTML = `
        <div class="student-card-header">
            <span class="student-name">
                <span>📱</span> ${escapeHtml(student.name)}
            </span>
            <span id="badge-${student.id}" class="live-badge badge-warning">
                <span class="pulse-dot"></span> Menunggu Layar
            </span>
        </div>
        <div class="video-wrapper" id="stage-${student.id}">
            <div id="no-screen-${student.id}" class="no-screen-placeholder">
                <span style="font-size: 32px;">⏳</span>
                <span>Menunggu peserta membagikan layar HP...</span>
            </div>
            <video id="screen-${student.id}" class="screen-video" autoplay playsinline></video>
            <div id="pip-${student.id}" class="pip-camera-container" style="display: none;">
                <video id="cam-${student.id}" class="pip-camera-video" autoplay playsinline muted></video>
            </div>
        </div>
        <div class="student-card-footer">
            <button class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 12px;" onclick="openFocusMode('${student.id}')">
                🔍 Perbesar (Focus)
            </button>
            <button class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 12px;" onclick="requestStudentScreen('${student.id}')">
                🔄 Minta Share Layar
            </button>
        </div>
    `;

    document.getElementById('studentGrid').appendChild(card);

    const pc = createPeerConnection(student.id);

    students[student.id] = {
        student,
        pc,
        cardEl: card,
        screenVideoEl: card.querySelector(`#screen-${student.id}`),
        cameraVideoEl: card.querySelector(`#cam-${student.id}`),
        pipContainerEl: card.querySelector(`#pip-${student.id}`),
        noScreenEl: card.querySelector(`#no-screen-${student.id}`),
        badgeEl: card.querySelector(`#badge-${student.id}`),
        hasScreen: false,
        hasCamera: false
    };

    // Clicking the video directly also triggers focus mode
    card.querySelector(`#stage-${student.id}`).addEventListener('click', (e) => {
        if (!e.target.closest('.student-card-footer')) {
            openFocusMode(student.id);
        }
    });

    updateStudentCount();
}

function updateStudentCardBadge(studentId, forceState) {
    const studentObj = students[studentId];
    if (!studentObj) return;

    const badge = studentObj.badgeEl;
    if (forceState === 'disconnected') {
        badge.className = 'live-badge badge-danger';
        badge.innerHTML = '🔴 Terputus';
        studentObj.cardEl.style.borderColor = 'var(--danger)';
    } else if (studentObj.hasScreen) {
        badge.className = 'live-badge badge-live';
        badge.innerHTML = '<span class="pulse-dot"></span> LIVE LAYAR';
        studentObj.cardEl.style.borderColor = 'var(--primary)';
    } else {
        badge.className = 'live-badge badge-warning';
        badge.innerHTML = '⚠️ Layar Terhenti';
        studentObj.cardEl.style.borderColor = 'var(--warning)';
    }
}

function removeStudent(studentId) {
    const studentObj = students[studentId];
    if (studentObj) {
        if (studentObj.pc) studentObj.pc.close();
        if (studentObj.cardEl) studentObj.cardEl.remove();
        delete students[studentId];
    }

    if (currentFocusedStudentId === studentId) {
        closeFocusMode();
    }

    updateStudentCount();
    if (Object.keys(students).length === 0) {
        document.getElementById('emptyState').style.display = 'block';
    }
}

function updateStudentCount() {
    const count = Object.keys(students).length;
    document.getElementById('studentCountBadge').textContent = count;
}

// 5. Focus / Zoom-In Inspection Mode
function openFocusMode(studentId) {
    const studentObj = students[studentId];
    if (!studentObj) return;

    currentFocusedStudentId = studentId;
    document.getElementById('focusStudentName').textContent = `Layar HP: ${studentObj.student.name}`;

    const focusScreenVideo = document.getElementById('focusScreenVideo');
    const focusCameraVideo = document.getElementById('focusCameraVideo');
    const focusPip = document.getElementById('focusPipContainer');

    if (studentObj.screenStream) {
        focusScreenVideo.srcObject = studentObj.screenStream;
    } else {
        focusScreenVideo.srcObject = null;
    }

    if (studentObj.cameraStream) {
        focusCameraVideo.srcObject = studentObj.cameraStream;
        focusPip.style.display = 'block';
    } else {
        focusPip.style.display = 'none';
    }

    document.getElementById('focusModal').classList.add('active');
}

function closeFocusMode() {
    currentFocusedStudentId = null;
    document.getElementById('focusModal').classList.remove('active');
    document.getElementById('focusScreenVideo').srcObject = null;
    document.getElementById('focusCameraVideo').srcObject = null;
}

document.getElementById('btnCloseFocus').addEventListener('click', closeFocusMode);
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFocusMode();
});

// 6. Host Mic Control (Audio Broadcast to all participants)
async function ensureHostMicStream() {
    if (!hostAudioStream) {
        try {
            hostAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            hostAudioStream.getAudioTracks().forEach(t => {
                t.enabled = isMicOn;
            });
            // Attach to existing students
            Object.values(students).forEach(studentObj => {
                if (studentObj.pc && hostAudioStream) {
                    try {
                        const track = hostAudioStream.getAudioTracks()[0];
                        studentObj.pc.addTrack(track, hostAudioStream);
                    } catch (e) {}
                }
            });
        } catch (err) {
            console.error('Failed to access microphone:', err);
            throw err;
        }
    }
    return hostAudioStream;
}

document.getElementById('btnToggleMic').addEventListener('click', async () => {
    try {
        await ensureHostMicStream();
        isMicOn = !isMicOn;

        if (hostAudioStream) {
            hostAudioStream.getAudioTracks().forEach(t => {
                t.enabled = isMicOn;
            });
        }

        if (isMicOn) {
            document.getElementById('micIcon').textContent = '🔊';
            document.getElementById('micLabel').textContent = 'Mic: AKTIF';
            document.getElementById('btnToggleMic').classList.remove('btn-secondary');
            document.getElementById('btnToggleMic').classList.add('btn-success');
            showAlertToast('🎙️ Mikrofon aktif. Suara Anda disiarkan ke semua peserta.', 'info');
        } else {
            document.getElementById('micIcon').textContent = '🎙️';
            document.getElementById('micLabel').textContent = 'Mic: Mati';
            document.getElementById('btnToggleMic').classList.remove('btn-success');
            document.getElementById('btnToggleMic').classList.add('btn-secondary');
            showAlertToast('🔇 Mikrofon dimatikan.', 'info');
        }
    } catch (err) {
        alert('Gagal mengakses mikrofon PC: ' + err.message);
    }
});

// 7. Request Screen Share from Student
function requestStudentScreen(studentId) {
    socket.emit('host-command', {
        targetStudentId: studentId,
        command: 'request-screen'
    });
    showAlertToast(`Meminta peserta untuk membagikan ulang layar...`, 'info');
}

// 8. Sharing & UI Utilities
function copyStudentLink() {
    if (!studentUrl) {
        alert('URL belum siap, tunggu koneksi...');
        return;
    }
    navigator.clipboard.writeText(studentUrl).then(() => {
        showAlertToast('📋 Link ruang kelas berhasil disalin ke clipboard!', 'info');
    }).catch(err => {
        prompt('Salin link ini untuk peserta:', studentUrl);
    });
}

document.getElementById('btnShareLink').addEventListener('click', copyStudentLink);

function toggleQRModal(show) {
    const modal = document.getElementById('qrModal');
    if (show) {
        modal.classList.add('active');
    } else {
        modal.classList.remove('active');
    }
}

document.getElementById('btnShowQR').addEventListener('click', () => toggleQRModal(true));

// Fullscreen Toggle
document.getElementById('btnFullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen().catch(err => console.log(err));
    }
});

// Toast notification helper
function showAlertToast(message, type = 'info') {
    const container = document.getElementById('alertContainer');
    const toast = document.createElement('div');
    toast.className = `alert-toast ${type === 'danger' ? 'danger' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.4s ease';
        setTimeout(() => toast.remove(), 400);
    }, 4500);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
