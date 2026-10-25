// Telegraph - Motor WebRTC Nativo para Llamadas de Voz, Videollamadas y Screen Share
// Cumple con el estándar W3C/IETF sin dependencias externas ni librerías de terceros.
// Soporta Llamadas 1 a 1 (Direct Messages) y Conferencias Grupales Multi-Peer en Canales.

(function() {
    // Configuración ICE STUN (nativo para resolver direcciones de red públicas y privadas)
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    // Estado WebRTC Multi-Peer
    let peerConnections = {};      // username -> RTCPeerConnection
    let pendingIceCandidates = {}; // username -> Array<candidate>
    let remoteStreams = {};        // username -> MediaStream
    let remoteMediaStates = {};    // username -> { micMuted, videoMuted, screenSharing }

    let localStream = null;
    let screenStream = null;
    let currentCallType = 'audio'; // 'audio' | 'video'
    let isCallActive = false;
    let callTimerInterval = null;
    let callSeconds = 0;
    let incomingCaller = null;
    let activeCallPeer = null;      // Destinatario específico en 1 a 1
    let audioContext = null;
    let ringInterval = null;
    let audioAnalyser = null;
    let isSpeaking = false;

    // Estados de medios locales
    let localMediaState = {
        micMuted: false,
        videoMuted: true,
        screenSharing: false
    };

    // Elementos del DOM
    const callOverlay = document.getElementById('activeCallOverlay');
    const incomingModal = document.getElementById('incomingCallModal');
    const localVideo = document.getElementById('localVideoElement');
    const localAvatarBox = document.getElementById('localAvatarPlaceholder');
    const btnMic = document.getElementById('btnCallMic');
    const btnCam = document.getElementById('btnCallCam');
    const btnScreen = document.getElementById('btnCallScreen');
    const durationTimer = document.getElementById('callDurationTimer');
    const participantsGrid = document.getElementById('callParticipantsGrid');
    const channelCallBanner = document.getElementById('activeChannelCallBanner');

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
    // 2. DETECTOR DE VOZ ACTIVA (HALO VERDE BRILLANTE ESTILO TELEGRAPH)
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
                    sendWebRtcSignal('voice_speaking', {
                        is_speaking: isSpeaking,
                        target: activeCallPeer || ''
                    });
                }
                requestAnimationFrame(checkVolume);
            };
            requestAnimationFrame(checkVolume);
        } catch (e) {
            console.warn('[WebRTC Audio] No se pudo iniciar analizador de voz:', e);
        }
    }

    function setSpeakingHalo(who, speaking) {
        const card = document.getElementById(`participantCard_${who}`);
        if (card) {
            card.classList.toggle('speaking', Boolean(speaking));
        }
    }

    // =========================================================================
    // 3. INICIO Y GESTIÓN DE LLAMADAS (VOZ Y VIDEO)
    // =========================================================================
    window.startCall = async function(type = 'audio') {
        currentCallType = type;
        const isDirect = Boolean(window.TELEGRAPH_IS_DIRECT);
        const targetUser = window.TELEGRAPH_TARGET_USER || window.DEV_TARGET_USER || '';
        activeCallPeer = isDirect ? targetUser : '';

        try {
            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: (type === 'video') ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
                });
            } catch (camErr) {
                console.warn('[WebRTC] Cámara no disponible o denegada, solicitando solo audio:', camErr);
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            localStream = stream;
            setupLocalMedia(localStream, type === 'video');

            showCallOverlay();

            if (isDirect) {
                // LLAMADA 1 A 1
                startRingingTone(false);
                sendWebRtcSignal('call_request', {
                    target: targetUser,
                    call_type: type,
                    mic_muted: localMediaState.micMuted,
                    video_muted: localMediaState.videoMuted,
                    screen_sharing: localMediaState.screenSharing
                });
            } else {
                // LLAMADA GRUPAL / CANAL DE VOZ
                stopRingingTone();
                playCallConnectedTone();
                startCallTimer();
                updateChannelCallBanner(true);

                // Anunciar a la sala del canal que la llamada está activa
                sendWebRtcSignal('channel_call_broadcast', {
                    status: 'active',
                    call_type: type
                });

                // Unirse al grupo de participantes del canal (Mesh)
                sendWebRtcSignal('join_call', {
                    call_type: type,
                    mic_muted: localMediaState.micMuted,
                    video_muted: localMediaState.videoMuted,
                    screen_sharing: localMediaState.screenSharing
                });
            }

            console.log(`[WebRTC] Llamada iniciada (${type}) [${isDirect ? '1a1: ' + targetUser : 'Canal Grupal'}]`);
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
                sendWebRtcSignal('voice_speaking', { is_speaking: false, target: activeCallPeer || '' });
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

        if (state.micMuted) {
            if (micIcon) {
                micIcon.textContent = '🔇 Silenciado';
                micIcon.className = 'call-mic-icon muted';
            }
            if (cardMutedBadge) cardMutedBadge.style.display = 'flex';
            if (participantCard) participantCard.classList.add('muted');
            setSpeakingHalo(who, false);
        } else {
            if (micIcon) {
                micIcon.textContent = '🎙️';
                micIcon.className = 'call-mic-icon active';
            }
            if (cardMutedBadge) cardMutedBadge.style.display = 'none';
            if (participantCard) participantCard.classList.remove('muted');
        }

        if (state.videoMuted) {
            if (cardCamOffBadge) cardCamOffBadge.style.display = (currentCallType === 'video') ? 'flex' : 'none';
            if (videoEl && !state.screenSharing) videoEl.style.display = 'none';
            if (avatarBox && !state.screenSharing) avatarBox.style.display = 'flex';
        } else {
            if (cardCamOffBadge) cardCamOffBadge.style.display = 'none';
            if (videoEl) videoEl.style.display = 'block';
            if (avatarBox) avatarBox.style.display = 'none';
        }

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

        sendWebRtcSignal('call_peer_state', {
            target: activeCallPeer || '',
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
    }

    function updateChannelCallBanner(isActive) {
        if (channelCallBanner) {
            channelCallBanner.style.display = (isActive && !isCallActive) ? 'flex' : 'none';
        }
    }

    // =========================================================================
    // 4. ATENCIÓN DE LLAMADA ENTRANTE (1 A 1 Y CANAL)
    // =========================================================================
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

        if (btnVideo && btnVoice) {
            btnVideo.classList.toggle('btn-call-highlight', isVideo);
            btnVoice.classList.toggle('btn-call-highlight', !isVideo);
        }

        const modal = incomingModal || document.getElementById('incomingCallModal');
        if (modal) modal.style.display = 'flex';

        startRingingTone(true);
    };

    function dismissIncomingAlerts() {
        stopRingingTone();
        const modal = incomingModal || document.getElementById('incomingCallModal');
        if (modal) modal.style.display = 'none';
        const incomingToast = document.getElementById('incomingCallToast');
        if (incomingToast) incomingToast.classList.remove('active');
    }

    window.acceptIncomingCall = async function(type = 'audio') {
        dismissIncomingAlerts();
        try {
            let stream = null;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: (type === 'video' || currentCallType === 'video') ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
                });
            } catch (camErr) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            localStream = stream;
            setupLocalMedia(localStream, (type === 'video' || currentCallType === 'video'));
            showCallOverlay();
            startCallTimer();
            playCallConnectedTone();

            sendWebRtcSignal('call_response', {
                target: incomingCaller,
                accepted: true,
                call_type: currentCallType,
                mic_muted: localMediaState.micMuted,
                video_muted: localMediaState.videoMuted,
                screen_sharing: localMediaState.screenSharing
            });

            // En llamadas 1 a 1, pre-inicializar conexión a la espera del Offer del emisor
            getOrCreatePeerConnection(incomingCaller, false);
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
        playCallHangupTone();
    };

    // =========================================================================
    // 5. GESTIÓN MULTI-PEER WEBRTC (OFFER / ANSWER / ICE QUEUE)
    // =========================================================================
    function getOrCreatePeerConnection(remoteUser, isInitiator) {
        if (peerConnections[remoteUser]) {
            return peerConnections[remoteUser];
        }

        console.log(`[WebRTC] Creando PeerConnection para ${remoteUser} (initiator: ${isInitiator})`);
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[remoteUser] = pc;
        if (!pendingIceCandidates[remoteUser]) pendingIceCandidates[remoteUser] = [];

        // Agregar pistas locales
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        // Manejo de pistas remotas recibidas
        pc.ontrack = (event) => {
            console.log(`[WebRTC] Pista remota recibida de ${remoteUser}:`, event.track.kind);
            const stream = event.streams[0];
            remoteStreams[remoteUser] = stream;

            const cardInfo = getOrCreateParticipantCard(remoteUser);
            if (cardInfo && cardInfo.videoEl) {
                cardInfo.videoEl.srcObject = stream;
                cardInfo.videoEl.play().catch(e => console.warn('Autoplay audio/video note:', e));
            }

            // Sincronizar visibilidad de video/avatar
            if (event.track.kind === 'video') {
                if (!remoteMediaStates[remoteUser]) remoteMediaStates[remoteUser] = { micMuted: false, videoMuted: false, screenSharing: false };
                remoteMediaStates[remoteUser].videoMuted = false;
                updateParticipantMediaUI(remoteUser, remoteMediaStates[remoteUser]);
            }
        };

        // Generación de ICE Candidates locales
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendWebRtcSignal('webrtc_ice_candidate', {
                    target: remoteUser,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`[WebRTC] Estado conexión ${remoteUser}:`, pc.connectionState);
            if (pc.connectionState === 'connected') {
                stopRingingTone();
                playCallConnectedTone();
                startCallTimer();
                sendLocalMediaState();
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                removeParticipantCard(remoteUser);
                delete peerConnections[remoteUser];
                delete remoteStreams[remoteUser];
                // Si ya no quedan peers conectados y estamos en llamada 1 a 1, terminar
                if (window.TELEGRAPH_IS_DIRECT && Object.keys(peerConnections).length === 0) {
                    endCall(false);
                }
            }
        };

        // Si es el iniciador hacia este peer, crear y enviar Offer
        if (isInitiator) {
            pc.createOffer().then(offer => {
                return pc.setLocalDescription(offer);
            }).then(() => {
                sendWebRtcSignal('webrtc_offer', {
                    target: remoteUser,
                    sdp: pc.localDescription,
                    mic_muted: localMediaState.micMuted,
                    video_muted: localMediaState.videoMuted,
                    screen_sharing: localMediaState.screenSharing
                });
            }).catch(err => {
                console.error(`[WebRTC] Error al crear offer para ${remoteUser}:`, err);
            });
        }

        return pc;
    }

    async function flushPendingIceCandidates(user) {
        const pc = peerConnections[user];
        if (pc && pendingIceCandidates[user] && pendingIceCandidates[user].length > 0) {
            console.log(`[WebRTC] Vaciando ${pendingIceCandidates[user].length} candidatos ICE pendientes para ${user}`);
            for (const cand of pendingIceCandidates[user]) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(cand));
                } catch (e) {
                    console.warn(`[WebRTC] Error agregando candidato en cola para ${user}:`, e);
                }
            }
            pendingIceCandidates[user] = [];
        }
    }

    // =========================================================================
    // 6. GESTIÓN DINÁMICA DE TARJETAS EN LA CUADRÍCULA (GRID) DE LLAMADA
    // =========================================================================
    function getOrCreateParticipantCard(username, displayName = '', avatarUrl = '') {
        let card = document.getElementById(`participantCard_${username}`);
        if (!card) {
            // Si existe la tarjeta estática 'remote', asignarla al primer participante
            const defaultRemote = document.getElementById('participantCard_remote');
            if (defaultRemote && defaultRemote.dataset.assignedUser === undefined) {
                card = defaultRemote;
                card.id = `participantCard_${username}`;
                card.dataset.assignedUser = username;
            } else {
                // Crear una nueva tarjeta dinámicamente en el grid para conferencias grupales
                card = document.createElement('div');
                card.className = 'call-participant-card remote';
                card.id = `participantCard_${username}`;
                card.innerHTML = `
                    <video id="${username}VideoElement" autoplay playsinline class="call-video-stream" style="display: none;"></video>
                    <div class="call-avatar-placeholder" id="${username}AvatarPlaceholder">
                        <div class="call-avatar-circle" id="${username}AvatarCircle">
                            ${avatarUrl ? `<img src="${avatarUrl}" alt="Avatar">` : (username.charAt(0).toUpperCase())}
                        </div>
                    </div>
                    <div class="call-card-status-badges" id="${username}CardStatusBadges">
                        <span class="call-card-badge muted" id="${username}CardMutedBadge" style="display: none;">🔇</span>
                        <span class="call-card-badge cam-off" id="${username}CardCamOffBadge" style="display: none;">📷❌</span>
                        <span class="call-card-badge screen" id="${username}CardScreenBadge" style="display: none;">🖥️</span>
                    </div>
                    <div class="call-user-tag">
                        <span id="${username}UserNameTag">${displayName || username}</span>
                        <span class="call-mic-icon" id="${username}MicIcon">🎙️</span>
                        <span class="call-badge-screen-pill" id="${username}ScreenPill" style="display: none;">🖥️ En Vivo</span>
                    </div>
                `;
                if (participantsGrid) participantsGrid.appendChild(card);
            }
        }

        const nameTag = document.getElementById(`${username}UserNameTag`) || document.getElementById('remoteUserNameTag');
        if (nameTag && displayName) nameTag.textContent = displayName;

        return {
            card: card,
            videoEl: document.getElementById(`${username}VideoElement`) || document.getElementById('remoteVideoElement'),
            avatarBox: document.getElementById(`${username}AvatarPlaceholder`) || document.getElementById('remoteAvatarPlaceholder')
        };
    }

    function removeParticipantCard(username) {
        const card = document.getElementById(`participantCard_${username}`);
        if (card) {
            // Si es la tarjeta original estática, resetearla en lugar de destruirla
            if (card.dataset.assignedUser) {
                delete card.dataset.assignedUser;
                card.id = 'participantCard_remote';
                const videoEl = card.querySelector('video');
                if (videoEl) { videoEl.srcObject = null; videoEl.style.display = 'none'; }
                const avatar = card.querySelector('.call-avatar-placeholder');
                if (avatar) avatar.style.display = 'flex';
                const nameTag = card.querySelector('.call-user-tag span');
                if (nameTag) nameTag.textContent = 'Conectando compañeros...';
            } else {
                card.remove();
            }
        }
    }

    // =========================================================================
    // 7. CONTROLES DURANTE LA LLAMADA (MIC, CÁMARA, SCREEN SHARE, HANGUP)
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
                sendWebRtcSignal('voice_speaking', { is_speaking: false, target: activeCallPeer || '' });
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
            try {
                const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
                videoTrack = camStream.getVideoTracks()[0];
                localStream.addTrack(videoTrack);
                localMediaState.videoMuted = false;

                // Reemplazar o añadir track en todas las conexiones peer activas
                Object.values(peerConnections).forEach(pc => {
                    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) {
                        sender.replaceTrack(videoTrack);
                    } else {
                        pc.addTrack(videoTrack, localStream);
                    }
                });

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
            stopScreenShare();
            return;
        }

        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            const screenTrack = screenStream.getVideoTracks()[0];

            Object.values(peerConnections).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(screenTrack);
                } else {
                    pc.addTrack(screenTrack, screenStream);
                }
            });

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
            console.warn('[WebRTC] Compartir pantalla cancelado o no disponible:', e);
        }
    };

    function stopScreenShare() {
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }
        if (btnScreen) btnScreen.classList.remove('active');

        localMediaState.screenSharing = false;

        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            localMediaState.videoMuted = videoTrack ? !videoTrack.enabled : true;

            Object.values(peerConnections).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(videoTrack || null);
            });

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
                target: activeCallPeer || ''
            });
        }

        stopScreenShare();

        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        Object.keys(peerConnections).forEach(user => {
            if (peerConnections[user]) {
                peerConnections[user].close();
            }
            removeParticipantCard(user);
        });

        peerConnections = {};
        pendingIceCandidates = {};
        remoteStreams = {};
        remoteMediaStates = {};
        activeCallPeer = null;

        playCallHangupTone();
        hideCallOverlay();
        updateChannelCallBanner(false);
    };

    // =========================================================================
    // 8. TEMPORIZADOR Y MODOS DE PANTALLA
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
    // 9. ENVÍO Y DESPACHO DE SEÑALIZACIÓN WEBRTC POR WEBSOCKET
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

    window.handleWebRtcSignal = async function(data) {
        const type = data.type;
        const sender = data.sender;
        const currentUsername = window.TELEGRAPH_CURRENT_USER || window.DEV_CURRENT_USER;

        // Ignorar mensajes enviados por nosotros mismos
        if (sender === currentUsername && type !== 'call_hangup') {
            return;
        }

        // 1. Notificación de llamada activa en canal
        if (type === 'channel_call_broadcast') {
            if (!isCallActive) {
                updateChannelCallBanner(data.status === 'active');
            }
            return;
        }

        // 2. Unirse a llamada de canal (Mesh multi-peer)
        if (type === 'join_call') {
            console.log(`[WebRTC] Participante ${sender} se unió a la llamada de canal`);
            if (isCallActive) {
                // Como ya estamos en la llamada, iniciamos la oferta WebRTC hacia el nuevo integrante
                getOrCreatePeerConnection(sender, true);
            }
            return;
        }

        // 3. Solicitud 1 a 1 de llamada entrante
        if (type === 'call_request') {
            window.handleIncomingCallRequest(data);
            return;
        }

        // 4. Respuesta a llamada
        if (type === 'call_response') {
            stopRingingTone();
            if (data.accepted) {
                console.log('[WebRTC] Llamada aceptada por', sender);
                activeCallPeer = sender;
                getOrCreatePeerConnection(sender, true);
                sendLocalMediaState();
            } else {
                if (window.TELEGRAPH_IS_DIRECT) {
                    alert(`Llamada rechazada por ${sender}`);
                    endCall(false);
                }
            }
            return;
        }

        // 5. Oferta WebRTC SDP
        if (type === 'webrtc_offer') {
            console.log(`[WebRTC] Oferta SDP recibida de ${sender}`);
            const pc = getOrCreatePeerConnection(sender, false);
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                await flushPendingIceCandidates(sender);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                sendWebRtcSignal('webrtc_answer', {
                    target: sender,
                    sdp: pc.localDescription,
                    mic_muted: localMediaState.micMuted,
                    video_muted: localMediaState.videoMuted,
                    screen_sharing: localMediaState.screenSharing
                });
                sendLocalMediaState();
            } catch (err) {
                console.error(`[WebRTC] Error al procesar offer de ${sender}:`, err);
            }
            return;
        }

        // 6. Respuesta WebRTC SDP (Answer)
        if (type === 'webrtc_answer') {
            console.log(`[WebRTC] Respuesta SDP recibida de ${sender}`);
            const pc = peerConnections[sender];
            if (pc) {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                    await flushPendingIceCandidates(sender);
                } catch (err) {
                    console.error(`[WebRTC] Error al procesar answer de ${sender}:`, err);
                }
            }
            sendLocalMediaState();
            return;
        }

        // 7. Candidato ICE
        if (type === 'webrtc_ice_candidate') {
            if (data.candidate) {
                const pc = peerConnections[sender];
                if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
                    // Si el remoteDescription no se ha establecido todavía, encolar el candidato
                    if (!pendingIceCandidates[sender]) pendingIceCandidates[sender] = [];
                    pendingIceCandidates[sender].push(data.candidate);
                } else {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } catch (e) {
                        console.warn(`[WebRTC] Error agregando candidato ICE de ${sender}:`, e);
                    }
                }
            }
            return;
        }

        // 8. Estado de medios de participante (Mic/Cam/Screen)
        if (type === 'call_peer_state') {
            remoteMediaStates[sender] = {
                micMuted: Boolean(data.mic_muted),
                videoMuted: Boolean(data.video_muted),
                screenSharing: Boolean(data.screen_sharing)
            };
            updateParticipantMediaUI(sender, remoteMediaStates[sender]);
            return;
        }

        // 9. Halo de voz activa
        if (type === 'voice_speaking') {
            const isMuted = remoteMediaStates[sender] ? remoteMediaStates[sender].micMuted : false;
            setSpeakingHalo(sender, isMuted ? false : Boolean(data.is_speaking));
            return;
        }

        // 10. Desconexión / Colgar llamada
        if (type === 'call_hangup') {
            console.log(`[WebRTC] Participante ${sender} se ha desconectado`);
            dismissIncomingAlerts();
            if (peerConnections[sender]) {
                peerConnections[sender].close();
                delete peerConnections[sender];
            }
            removeParticipantCard(sender);

            // Si es 1 a 1, terminar la llamada
            if (window.TELEGRAPH_IS_DIRECT) {
                endCall(false);
            }
            return;
        }
    };
})();
