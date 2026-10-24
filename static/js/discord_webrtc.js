// DevCord - Motor WebRTC Nativo para Llamadas de Voz, Videollamadas y Screen Share
// Cumple con el estándar W3C/IETF sin dependencias externas ni librerías de terceros.

(function() {
    // Configuración ICE STUN (nativo para resolver direcciones de red)
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    let peerConnection = null;
    let localStream = null;
    let remoteStream = null;
    let screenStream = null;
    let currentCallType = 'audio'; // 'audio' | 'video'
    let isCallActive = false;
    let callTimerInterval = null;
    let callSeconds = 0;
    let incomingCaller = null;
    let audioContext = null;
    let ringOscillator = null;
    let ringInterval = null;
    let audioAnalyser = null;
    let isSpeaking = false;

    // Elementos del DOM
    const callOverlay = document.getElementById('activeCallOverlay');
    const incomingModal = document.getElementById('incomingCallModal');
    const localVideo = document.getElementById('localVideoElement');
    const remoteVideo = document.getElementById('remoteVideoElement');
    const localAvatarBox = document.getElementById('localAvatarPlaceholder');
    const remoteAvatarBox = document.getElementById('remoteAvatarPlaceholder');
    const btnMic = document.getElementById('btnCallMic');
    const btnCam = document.getElementById('btnCallCam');
    const btnScreen = document.getElementById('btnCallScreen');
    const durationTimer = document.getElementById('callDurationTimer');

    // =========================================================================
    // 1. SINTETIZADOR DE TONOS WEB AUDIO API (Cero archivos .mp3 externos)
    // =========================================================================
    function getAudioContext() {
        if (!audioContext) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) audioContext = new AudioCtx();
        }
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
        return audioContext;
    }

    function playTone(freq, type, duration, gainValue = 0.15) {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(gainValue, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {
            console.warn('[WebRTC Audio] No se pudo generar tono:', e);
        }
    }

    function playCallConnectedTone() {
        playTone(523.25, 'sine', 0.12, 0.12); // C5
        setTimeout(() => playTone(659.25, 'sine', 0.18, 0.15), 100); // E5
        setTimeout(() => playTone(783.99, 'sine', 0.35, 0.18), 220); // G5
    }

    function playCallHangupTone() {
        playTone(659.25, 'triangle', 0.15, 0.18);
        setTimeout(() => playTone(523.25, 'triangle', 0.15, 0.16), 120);
        setTimeout(() => playTone(392.00, 'triangle', 0.35, 0.14), 240);
    }

    function startRingingTone(isIncoming) {
        stopRingingTone();
        ringInterval = setInterval(() => {
            if (isIncoming) {
                // Tono doble de campana entrante Discord
                playTone(880, 'sine', 0.25, 0.2);
                setTimeout(() => playTone(987.77, 'sine', 0.3, 0.2), 150);
            } else {
                // Tono suave de llamada saliente
                playTone(440, 'sine', 0.6, 0.12);
                setTimeout(() => playTone(480, 'sine', 0.6, 0.12), 100);
            }
        }, isIncoming ? 1800 : 3000);
    }

    function stopRingingTone() {
        if (ringInterval) {
            clearInterval(ringInterval);
            ringInterval = null;
        }
    }

    // =========================================================================
    // 2. DETECTOR DE VOZ ACTIVA (HALO VERDE BRILLANTE ESTILO DISCORD)
    // =========================================================================
    function setupVoiceSpeakingDetector(stream) {
        try {
            const ctx = getAudioContext();
            if (!ctx || !stream || stream.getAudioTracks().length === 0) return;
            const source = ctx.createMediaStreamSource(stream);
            audioAnalyser = ctx.createAnalyser();
            audioAnalyser.fftSize = 256;
            source.connect(audioAnalyser);

            const buffer = new Uint8Array(audioAnalyser.frequencyBinCount);
            const checkVolume = () => {
                if (!isCallActive) return;
                audioAnalyser.getByteFrequencyData(buffer);
                let sum = 0;
                for (let i = 0; i < buffer.length; i++) sum += buffer[i];
                const avg = sum / buffer.length;
                const speakingNow = avg > 18;

                if (speakingNow !== isSpeaking) {
                    isSpeaking = speakingNow;
                    setSpeakingHalo('local', isSpeaking);
                    // Emitir a los demás para sincronizar anillo verde
                    sendWebRtcSignal('voice_speaking', { is_speaking: isSpeaking });
                }
                requestAnimationFrame(checkVolume);
            };
            requestAnimationFrame(checkVolume);
        } catch (e) {
            console.warn('[WebRTC Voice] Detector no inicializado:', e);
        }
    }

    function setSpeakingHalo(who, speaking) {
        const card = document.getElementById(`participantCard_${who}`);
        const avatarCircle = document.getElementById(`${who}AvatarCircle`);
        if (card) card.classList.toggle('speaking', speaking);
        if (avatarCircle) avatarCircle.classList.toggle('speaking', speaking);
    }

    // =========================================================================
    // 3. INICIO Y GESTIÓN DE LLAMADAS (VOZ Y VIDEO)
    // =========================================================================
    window.startCall = async function(type = 'audio') {
        currentCallType = type;
        const targetUser = window.DEV_TARGET_USER;

        try {
            // Solicitar permisos de audio y video según tipo
            const constraints = {
                audio: true,
                video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
            };

            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            setupLocalMedia(localStream, type === 'video');

            showCallOverlay();
            startRingingTone(false);

            // Enviar solicitud de llamada al destinatario / sala
            sendWebRtcSignal('call_request', {
                target: targetUser,
                call_type: type
            });

            console.log(`[WebRTC] Llamada iniciada (${type}) hacia`, targetUser || 'Canal');
        } catch (err) {
            console.error('[WebRTC] Error al acceder a dispositivos:', err);
            alert(`No se pudo acceder a tu micrófono/cámara: ${err.message || 'Permiso denegado'}`);
            hideCallOverlay();
        }
    };

    function setupLocalMedia(stream, isVideo) {
        if (localVideo) {
            localVideo.srcObject = stream;
            localVideo.style.display = isVideo ? 'block' : 'none';
        }
        if (localAvatarBox) {
            localAvatarBox.style.display = isVideo ? 'none' : 'flex';
        }
        setupVoiceSpeakingDetector(stream);
    }

    function showCallOverlay() {
        if (callOverlay) {
            callOverlay.classList.add('active');
            isCallActive = true;
        }
    }

    function hideCallOverlay() {
        if (callOverlay) {
            callOverlay.classList.remove('active');
            callOverlay.classList.remove('fullscreen');
        }
        isCallActive = false;
        stopCallTimer();
        stopRingingTone();
        setSpeakingHalo('local', false);
        setSpeakingHalo('remote', false);
    }

    // =========================================================================
    // 4. ATENCIÓN DE LLAMADA ENTRANTE
    // =========================================================================
    window.handleIncomingCallRequest = function(data) {
        incomingCaller = data.sender;
        currentCallType = data.call_type || 'audio';

        const callerNameEl = document.getElementById('incomingCallCaller');
        const callerSubEl = document.getElementById('incomingCallType');
        const avatarEl = document.getElementById('incomingCallAvatar');

        if (callerNameEl) callerNameEl.textContent = data.sender_display || data.sender;
        if (callerSubEl) {
            callerSubEl.textContent = data.call_type === 'video' 
                ? 'Videollamada entrante segura (DTLS-SRTP)' 
                : 'Llamada de voz entrante cifrada E2EE';
        }
        if (avatarEl) {
            if (data.sender_avatar) {
                avatarEl.innerHTML = `<img src="${data.sender_avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
            } else {
                avatarEl.textContent = (data.sender || 'U').charAt(0).toUpperCase();
            }
        }

        if (incomingModal) incomingModal.style.display = 'flex';
        startRingingTone(true);
    };

    window.acceptIncomingCall = async function(requestedType) {
        stopRingingTone();
        if (incomingModal) incomingModal.style.display = 'none';

        const useVideo = requestedType === 'video' || currentCallType === 'video';
        currentCallType = useVideo ? 'video' : 'audio';

        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: useVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
            });
            setupLocalMedia(localStream, useVideo);
            showCallOverlay();

            sendWebRtcSignal('call_response', {
                target: incomingCaller,
                accepted: true,
                call_type: currentCallType
            });

            initPeerConnection(incomingCaller, false);
        } catch (err) {
            alert('Error al acceder al micrófono/cámara: ' + err.message);
            rejectIncomingCall();
        }
    };

    window.rejectIncomingCall = function() {
        stopRingingTone();
        if (incomingModal) incomingModal.style.display = 'none';
        if (incomingCaller) {
            sendWebRtcSignal('call_response', {
                target: incomingCaller,
                accepted: false
            });
            incomingCaller = null;
        }
        playCallHangupTone();
    };

    // =========================================================================
    // 5. NEGOCIACIÓN WEBRTC PEER CONNECTION (OFFER / ANSWER / ICE)
    // =========================================================================
    async function initPeerConnection(remoteUser, isInitiator) {
        peerConnection = new RTCPeerConnection(rtcConfig);

        // Agregar tracks locales
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        // Manejo de tracks remotos
        peerConnection.ontrack = (event) => {
            console.log('[WebRTC] Track remoto recibido:', event.track.kind);
            remoteStream = event.streams[0];
            if (remoteVideo) {
                remoteVideo.srcObject = remoteStream;
                const hasVideo = remoteStream.getVideoTracks().length > 0;
                remoteVideo.style.display = hasVideo ? 'block' : 'none';
                if (remoteAvatarBox) remoteAvatarBox.style.display = hasVideo ? 'none' : 'flex';
            }
        };

        // Candidatos ICE
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendWebRtcSignal('webrtc_ice_candidate', {
                    target: remoteUser,
                    candidate: event.candidate
                });
            }
        };

        peerConnection.onconnectionstatechange = () => {
            console.log('[WebRTC] Estado de conexión:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                stopRingingTone();
                playCallConnectedTone();
                startCallTimer();
            } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
                endCall(false);
            }
        };

        // Si es el iniciador, crear Offer
        if (isInitiator) {
            try {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                sendWebRtcSignal('webrtc_offer', {
                    target: remoteUser,
                    sdp: offer
                });
            } catch (err) {
                console.error('[WebRTC] Error al crear oferta:', err);
            }
        }
    }

    // =========================================================================
    // 6. CONTROLADORES DURANTE LA LLAMADA (MIC, CAM, SCREEN SHARE, HANGUP)
    // =========================================================================
    window.toggleCallMic = function() {
        if (!localStream) return;
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            if (btnMic) {
                btnMic.classList.toggle('muted', !audioTrack.enabled);
                btnMic.textContent = audioTrack.enabled ? '🎙️' : '🔇';
            }
            const localMicIcon = document.getElementById('localMicIcon');
            if (localMicIcon) localMicIcon.textContent = audioTrack.enabled ? '🎙️' : '🔇';
        }
    };

    window.toggleCallCam = async function() {
        if (!localStream) return;
        let videoTrack = localStream.getVideoTracks()[0];

        if (videoTrack) {
            // Ya tiene track, alternar enabled
            videoTrack.enabled = !videoTrack.enabled;
            if (localVideo) localVideo.style.display = videoTrack.enabled ? 'block' : 'none';
            if (localAvatarBox) localAvatarBox.style.display = videoTrack.enabled ? 'none' : 'flex';
            if (btnCam) btnCam.classList.toggle('active', videoTrack.enabled);
        } else {
            // Añadir video a llamada en curso
            try {
                const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
                videoTrack = camStream.getVideoTracks()[0];
                localStream.addTrack(videoTrack);
                if (peerConnection) {
                    peerConnection.addTrack(videoTrack, localStream);
                    // Renegociar
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    sendWebRtcSignal('webrtc_offer', { target: window.DEV_TARGET_USER, sdp: offer });
                }
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    localVideo.style.display = 'block';
                }
                if (localAvatarBox) localAvatarBox.style.display = 'none';
                if (btnCam) btnCam.classList.add('active');
            } catch (e) {
                alert('No se pudo activar la cámara: ' + e.message);
            }
        }
    };

    window.toggleScreenShare = async function() {
        if (screenStream) {
            // Detener screen share y volver a cámara
            stopScreenShare();
            return;
        }

        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            const screenTrack = screenStream.getVideoTracks()[0];

            // Reemplazar track en el peer connection
            if (peerConnection) {
                const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(screenTrack);
                } else {
                    peerConnection.addTrack(screenTrack, screenStream);
                }
            }

            if (localVideo) {
                localVideo.srcObject = screenStream;
                localVideo.style.display = 'block';
            }
            if (localAvatarBox) localAvatarBox.style.display = 'none';
            if (btnScreen) btnScreen.classList.add('active');

            screenTrack.onended = () => {
                stopScreenShare();
            };
        } catch (e) {
            console.warn('[WebRTC] Compartir pantalla cancelado o no soportado:', e);
        }
    };

    function stopScreenShare() {
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        if (btnScreen) btnScreen.classList.remove('active');

        // Restaurar video local
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (peerConnection) {
                const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(videoTrack || null);
            }
            if (localVideo) {
                localVideo.srcObject = localStream;
                localVideo.style.display = (videoTrack && videoTrack.enabled) ? 'block' : 'none';
            }
            if (localAvatarBox) {
                localAvatarBox.style.display = (videoTrack && videoTrack.enabled) ? 'none' : 'flex';
            }
        }
    }

    window.endCall = function(notifyRemote = true) {
        if (notifyRemote && isCallActive) {
            sendWebRtcSignal('call_hangup', {
                target: window.DEV_TARGET_USER || ''
            });
        }

        stopScreenShare();

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }

        playCallHangupTone();
        hideCallOverlay();
    };

    // =========================================================================
    // 7. TEMPORIZADOR Y UTILIDADES
    // =========================================================================
    function startCallTimer() {
        stopCallTimer();
        callSeconds = 0;
        if (durationTimer) durationTimer.textContent = '00:00';
        callTimerInterval = setInterval(() => {
            callSeconds++;
            const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
            const secs = String(callSeconds % 60).padStart(2, '0');
            if (durationTimer) durationTimer.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    function stopCallTimer() {
        if (callTimerInterval) {
            clearInterval(callTimerInterval);
            callTimerInterval = null;
        }
    }

    window.toggleCallFullscreen = function() {
        if (callOverlay) callOverlay.classList.toggle('fullscreen');
    };

    window.toggleCallMinimize = function() {
        if (callOverlay) callOverlay.classList.toggle('minimized');
    };

    // =========================================================================
    // 8. ENVÍO Y RECEPCIÓN DE MENSAJES WEBRTC POR WEBSOCKET
    // =========================================================================
    function sendWebRtcSignal(type, extra = {}) {
        if (window.DEV_SOCKET && window.DEV_SOCKET.readyState === WebSocket.OPEN) {
            window.DEV_SOCKET.send(JSON.stringify({
                type: type,
                ...extra
            }));
        }
    }

    // Despachador de eventos entrantes de WebSockets para WebRTC
    window.handleWebRtcSignal = async function(data) {
        const type = data.type;
        const sender = data.sender;

        if (type === 'call_request') {
            window.handleIncomingCallRequest(data);
        } else if (type === 'call_response') {
            stopRingingTone();
            if (data.accepted) {
                console.log('[WebRTC] Llamada aceptada por', sender);
                initPeerConnection(sender, true);
            } else {
                alert(`Llamada rechazada por ${sender}`);
                endCall(false);
            }
        } else if (type === 'webrtc_offer') {
            if (!peerConnection) {
                await initPeerConnection(sender, false);
            }
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            sendWebRtcSignal('webrtc_answer', {
                target: sender,
                sdp: answer
            });
        } else if (type === 'webrtc_answer') {
            if (peerConnection) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            }
        } else if (type === 'webrtc_ice_candidate') {
            if (peerConnection && data.candidate) {
                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                    console.warn('[WebRTC] Error al agregar candidato ICE:', e);
                }
            }
        } else if (type === 'call_hangup') {
            console.log('[WebRTC] Llamada finalizada por el otro participante');
            endCall(false);
        } else if (type === 'voice_speaking') {
            setSpeakingHalo('remote', Boolean(data.is_speaking));
        }
    };
})();
