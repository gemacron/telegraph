// Telegraph - Motor WebRTC Nativo para Llamadas de Voz, Videollamadas y Screen Share
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
    let activeCallPeer = null;
    let audioContext = null;
    let ringOscillator = null;
    let ringInterval = null;
    let audioAnalyser = null;
    let isSpeaking = false;

    // Estados de medios de los participantes (Sincronización en tiempo real)
    let localMediaState = {
        micMuted: false,
        videoMuted: true,
        screenSharing: false
    };

    let remoteMediaState = {
        micMuted: false,
        videoMuted: true,
        screenSharing: false
    };

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
                // Tono doble de campana entrante Telegraph
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
    // 2. DETECTOR DE VOZ ACTIVA (HALO VERDE BRILLANTE ESTILO Telegraph)
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
                const speakingNow = !localMediaState.micMuted && (avg > 18);

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
        const targetUser = window.TELEGRAPH_TARGET_USER || window.DEV_TARGET_USER;
        activeCallPeer = targetUser;

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
                call_type: type,
                mic_muted: localMediaState.micMuted,
                video_muted: localMediaState.videoMuted,
                screen_sharing: localMediaState.screenSharing
            });

            console.log(`[WebRTC] Llamada iniciada (${type}) hacia`, targetUser || 'Canal');
        } catch (err) {
            console.error('[WebRTC] Error al acceder a dispositivos:', err);
            alert(`No se pudo acceder a tu micrófono/cámara: ${err.message || 'Permiso denegado'}`);
            hideCallOverlay();
        }
    };

    window.isWebRtcCallActive = function() {
        return Boolean(isCallActive);
    };

    window.setLocalMicMuted = function(muted) {
        if (!localStream) return;
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !muted;
            localMediaState.micMuted = muted;
            if (btnMic) {
                btnMic.classList.toggle('muted', muted);
                btnMic.textContent = muted ? '🔇' : '🎙️';
            }
            if (muted) {
                isSpeaking = false;
                setSpeakingHalo('local', false);
                sendWebRtcSignal('voice_speaking', { is_speaking: false });
            }
            updateParticipantMediaUI('local', localMediaState);
            if (window.syncUserPanelMic) {
                window.syncUserPanelMic(muted);
            }
            sendLocalMediaState();
        }
    };

    function updateParticipantMediaUI(who, state) {
        if (!state) return;
        const micIcon = document.getElementById(`${who}MicIcon`);
        const cardMutedBadge = document.getElementById(`${who}CardMutedBadge`);
        const cardCamOffBadge = document.getElementById(`${who}CardCamOffBadge`);
        const cardScreenBadge = document.getElementById(`${who}CardScreenBadge`);
        const screenPill = document.getElementById(`${who}ScreenPill`);
        const participantCard = document.getElementById(`participantCard_${who}`);
        const videoEl = document.getElementById(`${who}VideoElement`);
        const avatarBox = document.getElementById(`${who}AvatarPlaceholder`);

        // 1. Estado del Micrófono (Silenciado vs Activo)
        if (state.micMuted) {
            if (micIcon) {
                micIcon.textContent = '🔇 Silenciado';
                micIcon.className = 'call-mic-icon muted';
                micIcon.title = who === 'local' ? 'Tu micrófono está silenciado' : 'Micrófono silenciado por el usuario';
            }
            if (cardMutedBadge) cardMutedBadge.style.display = 'flex';
            if (participantCard) participantCard.classList.add('muted');
            // Anular halo verde si está silenciado
            setSpeakingHalo(who, false);
        } else {
            if (micIcon) {
                micIcon.textContent = '🎙️';
                micIcon.className = 'call-mic-icon active';
                micIcon.title = who === 'local' ? 'Tu micrófono está activo' : 'Micrófono activo';
            }
            if (cardMutedBadge) cardMutedBadge.style.display = 'none';
            if (participantCard) participantCard.classList.remove('muted');
        }

        // 2. Estado de la Cámara / Video
        if (state.videoMuted) {
            if (currentCallType === 'video' && cardCamOffBadge) {
                cardCamOffBadge.style.display = 'flex';
            } else if (cardCamOffBadge) {
                cardCamOffBadge.style.display = 'none';
            }
            if (videoEl && !state.screenSharing) videoEl.style.display = 'none';
            if (avatarBox && !state.screenSharing) avatarBox.style.display = 'flex';
        } else {
            if (cardCamOffBadge) cardCamOffBadge.style.display = 'none';
            if (videoEl) videoEl.style.display = 'block';
            if (avatarBox) avatarBox.style.display = 'none';
        }

        // 3. Estado de Compartir Pantalla
        if (state.screenSharing) {
            if (cardScreenBadge) cardScreenBadge.style.display = 'flex';
            if (screenPill) screenPill.style.display = 'inline-block';
            if (videoEl) videoEl.style.display = 'block';
            if (avatarBox) avatarBox.style.display = 'none';
        } else {
            if (cardScreenBadge) cardScreenBadge.style.display = 'none';
            if (screenPill) screenPill.style.display = 'none';
        }
    }

    function sendLocalMediaState() {
        const audioTrack = localStream ? localStream.getAudioTracks()[0] : null;
        const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;

        localMediaState.micMuted = audioTrack ? !audioTrack.enabled : false;
        localMediaState.videoMuted = videoTrack ? !videoTrack.enabled : (currentCallType !== 'video');
        localMediaState.screenSharing = Boolean(screenStream);

        updateParticipantMediaUI('local', localMediaState);
        if (window.syncUserPanelMic) {
            window.syncUserPanelMic(localMediaState.micMuted);
        }

        const targetUser = activeCallPeer || window.TELEGRAPH_TARGET_USER || window.DEV_TARGET_USER;
        sendWebRtcSignal('call_peer_state', {
            target: targetUser,
            mic_muted: localMediaState.micMuted,
            video_muted: localMediaState.videoMuted,
            screen_sharing: localMediaState.screenSharing
        });
    }

    function setupLocalMedia(stream, isVideo) {
        localMediaState.videoMuted = !isVideo;
        localMediaState.micMuted = false;
        localMediaState.screenSharing = false;

        if (localVideo) {
            localVideo.srcObject = stream;
            localVideo.style.display = isVideo ? 'block' : 'none';
        }
        if (localAvatarBox) {
            localAvatarBox.style.display = isVideo ? 'none' : 'flex';
        }
        if (btnCam) {
            btnCam.classList.toggle('active', isVideo);
            btnCam.classList.remove('muted');
        }
        if (btnMic) {
            btnMic.classList.remove('muted');
            btnMic.textContent = '🎙️';
        }
        if (window.syncUserPanelMic) {
            window.syncUserPanelMic(false);
        }
        updateParticipantMediaUI('local', localMediaState);
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
    // 4. ATENCIÓN DE LLAMADA ENTRANTE Y NOTIFICACIONES MULTICANAL
    // =========================================================================
    let currentDesktopNotif = null;
    let titleBlinkInterval = null;
    const originalPageTitle = document.title;

    // Solicitar permiso de notificaciones de escritorio al usuario
    if ("Notification" in window && Notification.permission === "default") {
        document.addEventListener('click', () => {
            if (Notification.permission === "default") {
                Notification.requestPermission();
            }
        }, { once: true });
    }

    // Desbloquear AudioContext en la primera interacción para garantizar reproducción de audio
    function unlockAudioContext() {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume();
        }
    }
    document.addEventListener('click', unlockAudioContext);
    document.addEventListener('keydown', unlockAudioContext);

    function startTitleBlink(callerName, isVideo) {
        stopTitleBlink();
        let icon = isVideo ? '📹' : '📞';
        let toggle = false;
        titleBlinkInterval = setInterval(() => {
            document.title = toggle ? `${icon} ¡Llamada de ${callerName}!` : `🔔 ¡LLAMADA ENTRANTE!`;
            toggle = !toggle;
        }, 800);
    }

    function stopTitleBlink() {
        if (titleBlinkInterval) {
            clearInterval(titleBlinkInterval);
            titleBlinkInterval = null;
            document.title = originalPageTitle;
        }
    }

    function showDesktopCallNotification(callerName, isVideo, avatarUrl) {
        if ("Notification" in window && Notification.permission === "granted") {
            try {
                const title = isVideo 
                    ? `📹 ¡Videollamada entrante de ${callerName}!` 
                    : `📞 ¡Llamada de voz entrante de ${callerName}!`;

                currentDesktopNotif = new Notification(title, {
                    body: 'Toca aquí para responder o entrar a Telegraph',
                    icon: avatarUrl || undefined,
                    tag: 'telegraph-call',
                    requireInteraction: true
                });

                currentDesktopNotif.onclick = function() {
                    window.focus();
                    currentDesktopNotif.close();
                };
            } catch (err) {
                console.warn('[Desktop Notification] Error:', err);
            }
        }
    }

    function closeDesktopCallNotification() {
        if (currentDesktopNotif) {
            currentDesktopNotif.close();
            currentDesktopNotif = null;
        }
    }

    window.handleIncomingCallRequest = function(data) {
        incomingCaller = data.sender;
        activeCallPeer = data.sender;
        currentCallType = data.call_type || 'audio';
        const isVideo = currentCallType === 'video';
        const callerName = data.sender_display || data.sender;

        const callerNameEl = document.getElementById('incomingCallCaller');
        const callerSubEl = document.getElementById('incomingCallType');
        const avatarEl = document.getElementById('incomingCallAvatar');
        const modalTitleEl = document.getElementById('incomingCallTitle') || document.querySelector('#incomingCallModal .incoming-call-title');
        const btnVoice = document.getElementById('btnIncomingAcceptVoice');
        const btnVideo = document.getElementById('btnIncomingAcceptVideo');

        if (callerNameEl) callerNameEl.textContent = callerName;
        if (modalTitleEl) {
            modalTitleEl.textContent = isVideo ? '¡Videollamada Entrante!' : '¡Llamada de Voz Entrante!';
            modalTitleEl.style.color = isVideo ? 'var(--accent-blurple)' : 'var(--accent-success)';
        }
        if (callerSubEl) {
            callerSubEl.textContent = isVideo 
                ? '📹 Videollamada HD cifrada de extremo a extremo (DTLS-SRTP)' 
                : '📞 Llamada de voz entrante cifrada E2EE';
        }
        if (avatarEl) {
            if (data.sender_avatar) {
                avatarEl.innerHTML = `<img src="${data.sender_avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
            } else {
                avatarEl.textContent = isVideo ? '📹' : (data.sender || 'U').charAt(0).toUpperCase();
            }
        }

        // Resaltar el botón correspondiente según el tipo de llamada (Voz o Video)
        if (btnVideo && btnVoice) {
            if (isVideo) {
                btnVideo.classList.add('btn-call-highlight');
                btnVoice.classList.remove('btn-call-highlight');
            } else {
                btnVoice.classList.add('btn-call-highlight');
                btnVideo.classList.remove('btn-call-highlight');
            }
        }

        // 1. Mostrar modal central de llamada entrante
        const modal = incomingModal || document.getElementById('incomingCallModal');
        if (modal) modal.style.display = 'flex';

        // 2. Mostrar toast flotante superior
        const incomingToast = document.getElementById('incomingCallToast');
        if (incomingToast) {
            const toastCaller = document.getElementById('incomingToastCaller');
            const toastType = document.getElementById('incomingToastType');
            if (toastCaller) toastCaller.textContent = callerName;
            if (toastType) toastType.textContent = isVideo ? '📹 Videollamada entrante' : '📞 Llamada de voz entrante';
            incomingToast.classList.add('show');
        }

        // 3. Iniciar tono sonoro de llamada (ringtone)
        unlockAudioContext();
        startRingingTone(true);

        // 4. Disparar notificación nativa de escritorio del navegador
        showDesktopCallNotification(callerName, isVideo, data.sender_avatar);

        // 5. Parpadeo en el título de la pestaña del navegador
        startTitleBlink(callerName, isVideo);

        // 6. Vibración en dispositivos con soporte
        if (navigator.vibrate) {
            navigator.vibrate([250, 150, 250, 150, 400]);
        }
    };

    function dismissIncomingAlerts() {
        stopRingingTone();
        stopTitleBlink();
        closeDesktopCallNotification();
        const modal = incomingModal || document.getElementById('incomingCallModal');
        if (modal) modal.style.display = 'none';
        const incomingToast = document.getElementById('incomingCallToast');
        if (incomingToast) incomingToast.classList.remove('show');
    }

    window.acceptIncomingCall = async function(requestedType) {
        dismissIncomingAlerts();

        const useVideo = requestedType === 'video' || currentCallType === 'video';
        currentCallType = useVideo ? 'video' : 'audio';
        activeCallPeer = incomingCaller;

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
                call_type: currentCallType,
                mic_muted: localMediaState.micMuted,
                video_muted: localMediaState.videoMuted,
                screen_sharing: localMediaState.screenSharing
            });

            initPeerConnection(incomingCaller, false);
        } catch (err) {
            alert('Error al acceder al micrófono/cámara: ' + err.message);
            rejectIncomingCall();
        }
    };

    window.rejectIncomingCall = function() {
        dismissIncomingAlerts();
        if (incomingCaller) {
            sendWebRtcSignal('call_response', {
                target: incomingCaller,
                accepted: false
            });
            incomingCaller = null;
        }
        activeCallPeer = null;
        playCallHangupTone();
    };

    // =========================================================================
    // 5. NEGOCIACIÓN WEBRTC PEER CONNECTION (OFFER / ANSWER / ICE)
    // =========================================================================
    async function initPeerConnection(remoteUser, isInitiator) {
        activeCallPeer = remoteUser;
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
            if (event.track.kind === 'video') {
                remoteMediaState.videoMuted = false;
                if (remoteVideo) {
                    remoteVideo.srcObject = remoteStream;
                    remoteVideo.style.display = 'block';
                }
                if (remoteAvatarBox) remoteAvatarBox.style.display = 'none';
            }

            // Detección nativa de mute/unmute a nivel de pista WebRTC
            event.track.onmute = () => {
                console.log('[WebRTC] Track remoto silenciado:', event.track.kind);
                if (event.track.kind === 'audio') {
                    remoteMediaState.micMuted = true;
                    updateParticipantMediaUI('remote', remoteMediaState);
                } else if (event.track.kind === 'video') {
                    remoteMediaState.videoMuted = true;
                    updateParticipantMediaUI('remote', remoteMediaState);
                }
            };

            event.track.onunmute = () => {
                console.log('[WebRTC] Track remoto reactivado:', event.track.kind);
                if (event.track.kind === 'audio') {
                    remoteMediaState.micMuted = false;
                    updateParticipantMediaUI('remote', remoteMediaState);
                } else if (event.track.kind === 'video') {
                    remoteMediaState.videoMuted = false;
                    updateParticipantMediaUI('remote', remoteMediaState);
                }
            };

            updateParticipantMediaUI('remote', remoteMediaState);
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
                // Sincronizar estado de medios bidireccional inmediatamente
                sendLocalMediaState();
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
                    sdp: offer,
                    mic_muted: localMediaState.micMuted,
                    video_muted: localMediaState.videoMuted,
                    screen_sharing: localMediaState.screenSharing
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
            localMediaState.micMuted = !audioTrack.enabled;

            if (btnMic) {
                btnMic.classList.toggle('muted', localMediaState.micMuted);
                btnMic.textContent = localMediaState.micMuted ? '🔇' : '🎙️';
            }

            if (localMediaState.micMuted) {
                isSpeaking = false;
                setSpeakingHalo('local', false);
                sendWebRtcSignal('voice_speaking', { is_speaking: false });
            }

            updateParticipantMediaUI('local', localMediaState);
            if (window.syncUserPanelMic) {
                window.syncUserPanelMic(localMediaState.micMuted);
            }
            sendLocalMediaState();
        }
    };

    window.toggleCallCam = async function() {
        if (!localStream) return;
        let videoTrack = localStream.getVideoTracks()[0];

        if (videoTrack) {
            // Ya tiene track, alternar enabled
            videoTrack.enabled = !videoTrack.enabled;
            localMediaState.videoMuted = !videoTrack.enabled;

            if (localVideo) localVideo.style.display = videoTrack.enabled ? 'block' : 'none';
            if (localAvatarBox) localAvatarBox.style.display = videoTrack.enabled ? 'none' : 'flex';
            if (btnCam) {
                btnCam.classList.toggle('active', videoTrack.enabled);
                btnCam.classList.toggle('muted', !videoTrack.enabled);
            }
            updateParticipantMediaUI('local', localMediaState);
            sendLocalMediaState();
        } else {
            // Añadir video a llamada en curso
            try {
                const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
                videoTrack = camStream.getVideoTracks()[0];
                localStream.addTrack(videoTrack);
                localMediaState.videoMuted = false;

                if (peerConnection) {
                    peerConnection.addTrack(videoTrack, localStream);
                    // Renegociar
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    sendWebRtcSignal('webrtc_offer', {
                        target: activeCallPeer || window.TELEGRAPH_TARGET_USER || window.DEV_TARGET_USER,
                        sdp: offer,
                        mic_muted: localMediaState.micMuted,
                        video_muted: localMediaState.videoMuted,
                        screen_sharing: localMediaState.screenSharing
                    });
                }
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    localVideo.style.display = 'block';
                }
                if (localAvatarBox) localAvatarBox.style.display = 'none';
                if (btnCam) {
                    btnCam.classList.add('active');
                    btnCam.classList.remove('muted');
                }
                updateParticipantMediaUI('local', localMediaState);
                sendLocalMediaState();
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

            localMediaState.screenSharing = true;
            localMediaState.videoMuted = false;
            updateParticipantMediaUI('local', localMediaState);
            sendLocalMediaState();

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

        localMediaState.screenSharing = false;

        // Restaurar video local
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            localMediaState.videoMuted = videoTrack ? !videoTrack.enabled : true;

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
        } else {
            localMediaState.videoMuted = true;
        }

        updateParticipantMediaUI('local', localMediaState);
        sendLocalMediaState();
    }

    window.endCall = function(notifyRemote = true) {
        if (notifyRemote && isCallActive) {
            sendWebRtcSignal('call_hangup', {
                target: activeCallPeer || window.TELEGRAPH_TARGET_USER || window.DEV_TARGET_USER || ''
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

        activeCallPeer = null;
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

    // Atajos de teclado para llamada entrante (Enter: Aceptar, Esc: Rechazar)
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('incomingCallModal');
        if (modal && modal.style.display === 'flex') {
            if (e.key === 'Enter') {
                e.preventDefault();
                acceptIncomingCall(currentCallType);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                rejectIncomingCall();
            }
        }
    });

    // =========================================================================
    // 8. ENVÍO Y RECEPCIÓN DE MENSAJES WEBRTC POR WEBSOCKET
    // =========================================================================
    function sendWebRtcSignal(type, extra = {}) {
        const sock = window.TELEGRAPH_SOCKET || window.DEV_SOCKET;
        if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({
                type: type,
                ...extra
            }));
        }
    }

    // Despachador de eventos entrantes de WebSockets para WebRTC
    window.handleWebRtcSignal = async function(data) {
        const type = data.type;
        const sender = data.sender;

        // Si el paquete contiene estado de medios del peer, sincronizar inmediatamente
        if (data.mic_muted !== undefined) {
            remoteMediaState.micMuted = Boolean(data.mic_muted);
            remoteMediaState.videoMuted = Boolean(data.video_muted);
            remoteMediaState.screenSharing = Boolean(data.screen_sharing);
            updateParticipantMediaUI('remote', remoteMediaState);
        }

        if (type === 'call_request') {
            window.handleIncomingCallRequest(data);
        } else if (type === 'call_peer_state') {
            console.log('[WebRTC] Estado de medios del participante recibido:', sender, data);
            remoteMediaState.micMuted = Boolean(data.mic_muted);
            remoteMediaState.videoMuted = Boolean(data.video_muted);
            remoteMediaState.screenSharing = Boolean(data.screen_sharing);
            updateParticipantMediaUI('remote', remoteMediaState);
        } else if (type === 'call_response') {
            stopRingingTone();
            if (data.accepted) {
                console.log('[WebRTC] Llamada aceptada por', sender);
                activeCallPeer = sender;
                initPeerConnection(sender, true);
                sendLocalMediaState();
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
                sdp: answer,
                mic_muted: localMediaState.micMuted,
                video_muted: localMediaState.videoMuted,
                screen_sharing: localMediaState.screenSharing
            });
            sendLocalMediaState();
        } else if (type === 'webrtc_answer') {
            if (peerConnection) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            }
            sendLocalMediaState();
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
            dismissIncomingAlerts();
            endCall(false);
        } else if (type === 'voice_speaking') {
            // Si el participante remoto tiene su micrófono silenciado, anular halo verde
            if (remoteMediaState.micMuted) {
                setSpeakingHalo('remote', false);
            } else {
                setSpeakingHalo('remote', Boolean(data.is_speaking));
            }
        }
    };
})();

