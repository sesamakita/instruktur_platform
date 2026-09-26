import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  StatusBar,
  SafeAreaView,
  ActivityIndicator
} from 'react-native';
import io from 'socket.io-client';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices
} from 'react-native-webrtc';

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export default function App() {
  const [serverUrl, setServerUrl] = useState('http://192.168.30.74:3001');
  const [roomId, setRoomId] = useState('KODING-101');
  const [studentName, setStudentName] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isJoined, setIsJoined] = useState(false);

  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);

  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const hostSocketIdRef = useRef(null);
  const screenStreamRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const micStreamRef = useRef(null);

  // Initialize socket and signaling
  const handleConnectAndJoin = () => {
    if (!studentName.trim()) {
      Alert.alert('Peringatan', 'Silakan masukkan nama Anda terlebih dahulu.');
      return;
    }
    if (!serverUrl.trim() || !roomId.trim()) {
      Alert.alert('Peringatan', 'Server URL dan Room ID tidak boleh kosong.');
      return;
    }

    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    try {
      const socket = io(serverUrl.trim(), {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 5,
        rejectUnauthorized: false
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        console.log('[Socket Connected] ID:', socket.id);
        setIsConnected(true);

        socket.emit('student-join', {
          roomId: roomId.trim(),
          studentName: studentName.trim()
        });
      });

      socket.on('student-joined-success', (data) => {
        console.log('[Joined Room Success]', data);
        setIsJoined(true);
        initPeerConnection();
      });

      socket.on('signal', async ({ senderId, signalData }) => {
        hostSocketIdRef.current = senderId;
        const pc = pcRef.current;
        if (!pc) return;

        try {
          if (signalData.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signalData));
          } else if (signalData.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
          }
        } catch (err) {
          console.error('[WebRTC Signal Error]', err);
        }
      });

      socket.on('host-command', ({ command }) => {
        if (command === 'request-screen') {
          Alert.alert('Permintaan Instruktur', 'Instruktur meminta Anda membagikan ulang layar HP.');
          startScreenShare();
        }
      });

      socket.on('disconnect', () => {
        setIsConnected(false);
        setIsJoined(false);
      });

      socket.on('connect_error', (err) => {
        Alert.alert('Gagal Terhubung', `Tidak dapat menghubungi server: ${err.message}\nPastikan IP dan Port benar.`);
      });

    } catch (err) {
      Alert.alert('Error', err.message);
    }
  };

  const initPeerConnection = () => {
    if (pcRef.current) {
      pcRef.current.close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && hostSocketIdRef.current) {
        socketRef.current?.emit('signal', {
          targetId: hostSocketIdRef.current,
          signalData: { candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[Peer Connection State]:', pc.connectionState);
    };
  };

  const sendOffer = async () => {
    const pc = pcRef.current;
    if (!pc) return;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socketRef.current?.emit('signal', {
        targetId: hostSocketIdRef.current,
        signalData: offer
      });
      console.log('[WebRTC Offer Sent]');
    } catch (err) {
      console.error('[Offer Error]', err);
    }
  };

  // Start Screen Sharing via Android MediaProjection
  const startScreenShare = async () => {
    try {
      // In react-native-webrtc, getDisplayMedia triggers Android system MediaProjection dialog!
      const stream = await mediaDevices.getDisplayMedia();
      screenStreamRef.current = stream;

      const screenTrack = stream.getVideoTracks()[0];
      screenTrack.contentHint = 'detail'; // Optimize for code clarity

      pcRef.current?.addTrack(screenTrack, stream);
      await sendOffer();

      setIsScreenSharing(true);

      screenTrack.onended = () => {
        stopScreenShare();
        socketRef.current?.emit('student-alert', {
          message: 'Layar dihentikan oleh peserta',
          type: 'warning'
        });
      };

      socketRef.current?.emit('student-status-update', {
        hasScreen: true,
        hasCamera: isCameraActive
      });

    } catch (err) {
      console.error('[Screen Share Error]', err);
      Alert.alert('Gagal Berbagi Layar', err.message);
    }
  };

  const stopScreenShare = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    setIsScreenSharing(false);

    socketRef.current?.emit('student-status-update', {
      hasScreen: false,
      hasCamera: isCameraActive
    });
  };

  // Toggle Camera
  const toggleCamera = async () => {
    if (!isCameraActive) {
      try {
        const stream = await mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false
        });
        cameraStreamRef.current = stream;
        const camTrack = stream.getVideoTracks()[0];

        pcRef.current?.addTrack(camTrack, stream);
        await sendOffer();

        setIsCameraActive(true);
        socketRef.current?.emit('student-status-update', {
          hasScreen: isScreenSharing,
          hasCamera: true
        });
      } catch (err) {
        Alert.alert('Gagal Buka Kamera', err.message);
      }
    } else {
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach(t => t.stop());
        cameraStreamRef.current = null;
      }
      setIsCameraActive(false);
      socketRef.current?.emit('student-status-update', {
        hasScreen: isScreenSharing,
        hasCamera: false
      });
    }
  };

  // Toggle Mic
  const toggleMic = async () => {
    if (!isMicActive) {
      try {
        const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        micStreamRef.current = stream;
        const micTrack = stream.getAudioTracks()[0];

        pcRef.current?.addTrack(micTrack, stream);
        await sendOffer();

        setIsMicActive(true);
      } catch (err) {
        Alert.alert('Gagal Akses Mic', err.message);
      }
    } else {
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
      }
      setIsMicActive(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      <ScrollView contentContainerStyle={styles.scrollContent}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logoBadge}>⚡ ZOOM KW MOBILE</Text>
          <View style={[styles.badge, isConnected ? styles.badgeSuccess : styles.badgeWarning]}>
            <Text style={styles.badgeText}>
              {isConnected ? 'Terhubung ke Server' : 'Belum Terhubung'}
            </Text>
          </View>
        </View>

        {!isJoined ? (
          /* Form Pendaftaran Masuk */
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Masuk Kelas Koding</Text>
            <Text style={styles.cardSubtitle}>
              Layar HP Anda akan ditampilkan kepada instruktur untuk panduan praktek koding.
            </Text>

            <Text style={styles.label}>Nama Anda</Text>
            <TextInput
              style={styles.input}
              placeholder="Contoh: Budi Santoso"
              placeholderTextColor="#64748b"
              value={studentName}
              onChangeText={setStudentName}
            />

            <Text style={styles.label}>Kode Ruang Kelas (Room ID)</Text>
            <TextInput
              style={styles.input}
              placeholder="KODING-101"
              placeholderTextColor="#64748b"
              value={roomId}
              onChangeText={setRoomId}
            />

            <Text style={styles.label}>Alamat Server Instruktur</Text>
            <TextInput
              style={styles.input}
              placeholder="http://192.168.30.74:3001"
              placeholderTextColor="#64748b"
              value={serverUrl}
              onChangeText={setServerUrl}
            />

            <TouchableOpacity style={styles.btnPrimary} onPress={handleConnectAndJoin}>
              <Text style={styles.btnPrimaryText}>Gabung Kelas Koding ➜</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* Tampilan Kontrol Live Streaming */
          <View>
            {isScreenSharing && (
              <View style={styles.liveBanner}>
                <Text style={styles.liveBannerTitle}>🔴 LIVE: LAYAR ANDA TERKIRIM</Text>
                <Text style={styles.liveBannerSub}>
                  Instruktur sedang memantau layar HP Anda dari PC.
                </Text>
                <View style={styles.tipBox}>
                  <Text style={styles.tipTitle}>💡 Langkah Selanjutnya:</Text>
                  <Text style={styles.tipText}>1. Tekan tombol HOME di HP Anda sekarang.</Text>
                  <Text style={styles.tipText}>2. Buka aplikasi koding Anda (Acode, Termux, dll).</Text>
                  <Text style={styles.tipText}>3. Koding seperti biasa! Layar Anda tetap live.</Text>
                </View>
              </View>
            )}

            {/* Step 1: Share Screen */}
            <View style={styles.card}>
              <Text style={styles.stepTitle}>1. Berbagi Layar HP (Wajib)</Text>
              <Text style={styles.cardSubtitle}>
                Menampilkan layar HP Anda ke monitor PC Instruktur.
              </Text>
              {!isScreenSharing ? (
                <TouchableOpacity style={styles.btnPrimary} onPress={startScreenShare}>
                  <Text style={styles.btnPrimaryText}>📲 Mulai Bagikan Layar HP</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.btnDanger} onPress={stopScreenShare}>
                  <Text style={styles.btnDangerText}>⏹ Hentikan Berbagi Layar</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Step 2: Camera */}
            <View style={styles.card}>
              <Text style={styles.stepTitle}>2. Kamera Wajah (Opsional)</Text>
              <Text style={styles.cardSubtitle}>
                Menampilkan kotak wajah Anda di sudut layar instruktur.
              </Text>
              <TouchableOpacity
                style={[styles.btnSecondary, isCameraActive && styles.btnSecondaryActive]}
                onPress={toggleCamera}
              >
                <Text style={styles.btnSecondaryText}>
                  {isCameraActive ? '❌ Matikan Kamera' : '📷 Aktifkan Kamera Depan'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Step 3: Microphone */}
            <View style={styles.card}>
              <Text style={styles.stepTitle}>3. Mikrofon Suara</Text>
              <Text style={styles.cardSubtitle}>
                Bicara langsung ke instruktur jika ada pertanyaan.
              </Text>
              <TouchableOpacity
                style={[styles.btnSecondary, isMicActive && styles.btnSecondaryActive]}
                onPress={toggleMic}
              >
                <Text style={styles.btnSecondaryText}>
                  {isMicActive ? '🔇 Matikan Mikrofon' : '🎙️ Aktifkan Mikrofon'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Keluar */}
            <TouchableOpacity
              style={styles.btnExit}
              onPress={() => {
                stopScreenShare();
                if (socketRef.current) socketRef.current.disconnect();
                setIsJoined(false);
              }}
            >
              <Text style={styles.btnExitText}>Keluar dari Kelas</Text>
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a'
  },
  scrollContent: {
    padding: 20
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20
  },
  logoBadge: {
    backgroundColor: '#0284c7',
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8
  },
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12
  },
  badgeSuccess: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)'
  },
  badgeWarning: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)'
  },
  badgeText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '600'
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#334155'
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6
  },
  stepTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4
  },
  cardSubtitle: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 14,
    lineHeight: 18
  },
  label: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6
  },
  input: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    color: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 14
  },
  btnPrimary: {
    backgroundColor: '#38bdf8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center'
  },
  btnPrimaryText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 15
  },
  btnDanger: {
    backgroundColor: '#ef4444',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center'
  },
  btnDangerText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 15
  },
  btnSecondary: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center'
  },
  btnSecondaryActive: {
    borderColor: '#22c55e',
    backgroundColor: 'rgba(34, 197, 94, 0.1)'
  },
  btnSecondaryText: {
    color: '#f8fafc',
    fontWeight: '600',
    fontSize: 14
  },
  btnExit: {
    marginTop: 10,
    paddingVertical: 12,
    alignItems: 'center'
  },
  btnExitText: {
    color: '#f87171',
    fontSize: 14,
    fontWeight: '600'
  },
  liveBanner: {
    backgroundColor: 'rgba(34, 197, 94, 0.1)',
    borderWidth: 2,
    borderColor: '#22c55e',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16
  },
  liveBannerTitle: {
    color: '#4ade80',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 4
  },
  liveBannerSub: {
    color: '#e2e8f0',
    fontSize: 13,
    marginBottom: 10
  },
  tipBox: {
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    borderRadius: 8,
    padding: 12
  },
  tipTitle: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4
  },
  tipText: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 18
  }
});
