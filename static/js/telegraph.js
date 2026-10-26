// Telegraph - Cliente WebSocket y Control de Seguridad DLP
document.addEventListener('DOMContentLoaded', () => {
    const roomId = window.TELEGRAPH_ROOM_ID || window.DEV_ROOM_ID;
    const currentUser = window.TELEGRAPH_CURRENT_USER || window.DEV_CURRENT_USER;
    const csrfToken = window.TELEGRAPH_CSRF_TOKEN || window.DEV_CSRF_TOKEN;

    const messagesContainer = document.getElementById('messagesContainer');
    const messageInput = document.getElementById('chatInput');
    const dlpAlert = document.getElementById('dlpAlert');
    const dlpMessage = document.getElementById('dlpMessage');
    const dlpRulesList = document.getElementById('dlpRulesList');

    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Protocolo WebSocket seguro
    const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsScheme}://${window.location.host}/ws/chat/${roomId}/`;
    let socket = null;

    function connectWebSocket() {
        socket = new WebSocket(wsUrl);
        window.TELEGRAPH_SOCKET = socket;
        window.DEV_SOCKET = socket;

        socket.onopen = () => {
            console.log('[Telegraph] Conexión WebSocket establecida con la sala:', roomId);
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            // 0. Señales de WebRTC (Llamadas de voz, videollamadas y compartir pantalla)
            if (data.type && (data.type.startsWith('webrtc_') || data.type.startsWith('call_') || data.type === 'voice_speaking')) {
                if (typeof window.handleWebRtcSignal === 'function') {
                    window.handleWebRtcSignal(data);
                }
                return;
            }

            // 1. Manejo de alertas de DLP (Bloqueo de fuga de datos sensibles)
            if (data.type === 'dlp_violation') {
                showDlpAlert(data.message, data.rules, data.blocked_content);
                return;
            }

            // 2. Mensajes entrantes normales o código
            if (data.type === 'new_message') {
                appendChatMessage(data);
                hideDlpAlert();
            }

            // 3. Notificación de nuevo secreto efímero
            if (data.type === 'new_secret') {
                appendSecretCard(data);
                return;
            }

            // 4. Inicialización y actualización de presencia en tiempo real
            if (data.type === 'presence_init') {
                handlePresenceInit(data.online_user_ids || [], data.user_statuses || {});
                return;
            }
            if (data.type === 'presence_update') {
                handlePresenceUpdate(data);
                return;
            }
        };

        socket.onclose = (e) => {
            console.warn('[Telegraph] WebSocket cerrado. Reintentando en 3s...', e.reason);
            setTimeout(connectWebSocket, 3000);
        };

        socket.onerror = (err) => {
            console.error('[Telegraph] Error en WebSocket:', err);
        };
    }

    // Funciones para Gestión de Presencia en Tiempo Real (Online, Idle, DND, Offline)
    function getStatusLabel(status) {
        switch (status) {
            case 'online': return 'En línea';
            case 'idle': return 'Ausente';
            case 'dnd': return 'No molestar';
            case 'offline': default: return 'Desconectado';
        }
    }

    function applyStatusClasses(el, status, prefix) {
        if (!el) return;
        ['online', 'idle', 'dnd', 'offline'].forEach(s => el.classList.remove(prefix ? `${prefix}-${s}` : s));
        el.classList.add(prefix ? `${prefix}-${status}` : status);
    }

    function handlePresenceInit(onlineUserIds, userStatuses) {
        userStatuses = userStatuses || {};
        const idSet = new Set((onlineUserIds || []).map(Number));

        // Actualizar indicadores en la lista de Mensajes Directos (barra izquierda)
        document.querySelectorAll('.dm-status-indicator[data-user-id]').forEach(el => {
            const uid = Number(el.dataset.userId);
            const status = userStatuses[uid] || (idSet.has(uid) ? 'online' : 'offline');
            applyStatusClasses(el, status);

            const subtitle = document.getElementById('dm-subtitle-' + uid);
            if (subtitle) {
                const txt = subtitle.textContent.trim();
                if (['En línea', 'Ausente', 'No molestar', 'Desconectado'].includes(txt)) {
                    subtitle.textContent = getStatusLabel(status);
                }
            }
        });

        // Actualizar miembros en barra derecha
        document.querySelectorAll('.member-item[data-user-id]').forEach(item => {
            const uid = Number(item.dataset.userId);
            const status = userStatuses[uid] || (idSet.has(uid) ? 'online' : 'offline');
            updateMemberItemPresence(item, uid, status);
        });
    }

    function handlePresenceUpdate(data) {
        const uid = Number(data.user_id);
        const status = data.status || 'offline';

        // 1. Barra izquierda: Mensajes directos
        const dmIndicator = document.getElementById('dm-status-' + uid);
        if (dmIndicator) {
            applyStatusClasses(dmIndicator, status);
            const dmSubtitle = document.getElementById('dm-subtitle-' + uid);
            if (dmSubtitle) {
                const txt = dmSubtitle.textContent.trim();
                if (['En línea', 'Ausente', 'No molestar', 'Desconectado'].includes(txt)) {
                    dmSubtitle.textContent = getStatusLabel(status);
                }
            }
        }

        // 2. Columna derecha de DM (Tarjeta de perfil de usuario)
        const profileStatus = document.getElementById('profileDrawerStatus');
        if (profileStatus) {
            const activeUsername = document.querySelector('.profile-drawer-username')?.textContent?.trim();
            if (activeUsername === data.username) {
                applyStatusClasses(profileStatus, status);
                profileStatus.title = getStatusLabel(status);
            }
        }

        // 3. Columna derecha de Canal (Lista de Miembros)
        const memberItem = document.getElementById('member-item-' + uid);
        if (memberItem) {
            updateMemberItemPresence(memberItem, uid, status);
        }

        // 4. Si es el usuario logueado actual
        if (data.username === currentUser) {
            const currentAvatarStatus = document.getElementById('currentUserAvatarStatus');
            if (currentAvatarStatus) {
                applyStatusClasses(currentAvatarStatus, status, 'status');
            }
            document.querySelectorAll('#statusPickerMenu .status-picker-item').forEach(btn => {
                const isMatch = btn.getAttribute('onclick')?.includes(`'${status}'`);
                btn.classList.toggle('active', !!isMatch);
            });
        }
    }

    function updateMemberItemPresence(memberItem, uid, status) {
        const isOnline = status !== 'offline';
        const memberStatus = document.getElementById('member-status-' + uid);
        const onlineList = document.getElementById('onlineMembersList');
        const offlineList = document.getElementById('offlineMembersList');
        const onlineCountEl = document.getElementById('onlineCount');
        const offlineCountEl = document.getElementById('offlineCount');
        const noOnlineMsg = document.getElementById('noOnlineMsg');
        const noOfflineMsg = document.getElementById('noOfflineMsg');

        if (memberStatus) {
            applyStatusClasses(memberStatus, status);
        }

        const avatarImg = memberItem.querySelector('.member-avatar img');
        const customStatusEl = memberItem.querySelector('.member-custom-status');

        if (isOnline) {
            memberItem.classList.remove('member-offline');
            memberItem.classList.add('member-online');
            memberItem.style.opacity = '1';
            if (avatarImg) avatarImg.style.filter = 'none';
            if (customStatusEl && ['En línea', 'Ausente', 'No molestar', 'Desconectado'].includes(customStatusEl.textContent.trim())) {
                customStatusEl.textContent = getStatusLabel(status);
            }
            if (onlineList && !onlineList.contains(memberItem)) {
                onlineList.appendChild(memberItem);
            }
        } else {
            memberItem.classList.remove('member-online');
            memberItem.classList.add('member-offline');
            memberItem.style.opacity = '0.65';
            if (avatarImg) avatarImg.style.filter = 'grayscale(40%)';
            if (customStatusEl && ['En línea', 'Ausente', 'No molestar', 'Desconectado'].includes(customStatusEl.textContent.trim())) {
                customStatusEl.textContent = 'Desconectado';
            }
            if (offlineList && !offlineList.contains(memberItem)) {
                offlineList.appendChild(memberItem);
            }
        }

        if (onlineList && onlineCountEl) {
            const count = onlineList.querySelectorAll('.member-item').length;
            onlineCountEl.textContent = count;
            if (noOnlineMsg) noOnlineMsg.style.display = count === 0 ? 'block' : 'none';
        }
        if (offlineList && offlineCountEl) {
            const count = offlineList.querySelectorAll('.member-item').length;
            offlineCountEl.textContent = count;
            if (noOfflineMsg) noOfflineMsg.style.display = count === 0 ? 'block' : 'none';
        }
    }

    // Funciones globales para el selector flotante de estado
    window.toggleStatusPickerMenu = function(event) {
        if (event) event.stopPropagation();
        const menu = document.getElementById('statusPickerMenu');
        if (menu) {
            menu.classList.toggle('active');
        }
    };

    window.selectUserPresence = function(status) {
        const menu = document.getElementById('statusPickerMenu');
        if (menu) menu.classList.remove('active');

        // Enviar por WebSocket si está abierto
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'set_presence',
                status: status
            }));
        }

        // También persistir via HTTP API
        fetch('/api/presence/status/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken
            },
            body: JSON.stringify({ status: status })
        }).catch(err => console.error('Error al actualizar presencia:', err));

        // Actualizar visualmente de inmediato en avatar personal
        const currentAvatarStatus = document.getElementById('currentUserAvatarStatus');
        if (currentAvatarStatus) {
            applyStatusClasses(currentAvatarStatus, status, 'status');
        }
    };

    // Cerrar menú flotante si se hace clic fuera
    document.addEventListener('click', () => {
        const menu = document.getElementById('statusPickerMenu');
        if (menu && menu.classList.contains('active')) {
            menu.classList.remove('active');
        }
    });

    if (roomId) {
        connectWebSocket();
    }

    // Envío de mensaje con tecla Enter (Shift+Enter para salto de línea)
    if (messageInput) {
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;

        socket.send(JSON.stringify({
            type: 'message',
            content: text,
            is_code: false
        }));

        messageInput.value = '';
        messageInput.style.height = '44px';
    }

    // Mostrar alerta preventiva DLP
    function showDlpAlert(message, rules, blockedContent) {
        dlpAlert.style.display = 'flex';
        dlpMessage.textContent = message;
        dlpRulesList.innerHTML = '';

        if (rules && rules.length > 0) {
            rules.forEach(r => {
                const badge = document.createElement('span');
                badge.className = 'btn-badge-action btn-badge-danger';
                badge.textContent = `🚨 ${r.label || r.rule}`;
                dlpRulesList.appendChild(badge);
            });
        }

        // Pre-cargar en modal de secreto si el usuario desea convertirlo en secreto efímero
        window.pendingSecretContent = blockedContent;
    }

    function hideDlpAlert() {
        if (dlpAlert) dlpAlert.style.display = 'none';
    }

    // Renderizar mensaje en la interfaz con soporte para avatares reales
    function appendChatMessage(msg) {
        const card = document.createElement('div');
        card.className = 'message-card';

        let innerContent = '';
        let pendingLottieId = null;
        let pendingLottieData = null;
        let pendingLottieUrl = null;

        if (msg.is_sticker) {
            const stickerUrl = msg.sticker_image_url || '/media/stickers/lgtm.png';
            if (msg.is_animated_sticker && msg.sticker_animation_type === 'webm') {
                innerContent = `<div class="msg-sticker-wrapper">
                                    <video class="msg-sticker-animated msg-sticker-webm" autoplay loop muted playsinline src="${stickerUrl}" title="${escapeHtml(msg.content)}"></video>
                                </div>`;
            } else {
                innerContent = `<div class="msg-sticker-wrapper">
                                    <img src="${stickerUrl}" class="msg-sticker-img" alt="${escapeHtml(msg.content)}" title="${escapeHtml(msg.content)}">
                                </div>`;
            }
        } else if (msg.attachment_url) {
            const isImg = msg.is_image || /\.(png|jpe?g|gif|webp|svg)$/i.test(msg.attachment_url);
            if (isImg) {
                innerContent = `${msg.content ? `<div class="msg-content">${escapeHtml(msg.content)}</div>` : ''}
                                <img src="${msg.attachment_url}" class="attachment-preview" alt="Adjunto">`;
            } else {
                const fname = msg.filename || msg.attachment_url.split('/').pop();
                innerContent = `
                    <div class="file-attachment-card">
                        <div class="file-card-icon">📄</div>
                        <div class="file-card-details">
                            <a href="${msg.attachment_url}" class="file-card-name" target="_blank">${escapeHtml(fname)}</a>
                            <span class="file-card-size">Archivo adjunto</span>
                        </div>
                        <div class="file-card-actions">
                            <a href="${msg.attachment_url}" target="_blank" class="file-card-btn" title="Ver código">&lt; &gt;</a>
                            <a href="${msg.attachment_url}" download class="file-card-btn" title="Descargar">⬇️</a>
                        </div>
                    </div>`;
            }
        } else if (msg.is_code && msg.formatted_code_html) {
            innerContent = `
                <div class="code-container">
                    <div class="code-header">
                        <span>${msg.language || 'Code'}</span>
                        <button class="btn-copy" onclick="copyCode(this)">Copiar</button>
                    </div>
                    ${msg.formatted_code_html}
                </div>`;
        } else if (msg.formatted_code_html) {
            innerContent = msg.formatted_code_html;
        } else {
            const linked = escapeHtml(msg.content).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
            innerContent = `<div class="msg-content">${linked}</div>`;
        }

        const avatarHtml = msg.avatar_url 
            ? `<img src="${msg.avatar_url}" alt="Avatar" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
            : msg.sender.charAt(0).toUpperCase();

        card.innerHTML = `
            <div class="msg-avatar" onclick="openUserProfileCard('${escapeHtml(msg.sender)}')" style="cursor: pointer;">${avatarHtml}</div>
            <div class="msg-body">
                <div class="msg-meta">
                    <span class="msg-author" onclick="openUserProfileCard('${escapeHtml(msg.sender)}')">${escapeHtml(msg.display_name || msg.sender)}</span>
                    <span class="msg-time">${msg.created_at || 'ahora'}</span>
                </div>
                ${innerContent}
            </div>
        `;

        messagesContainer.appendChild(card);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        if (pendingLottieId) {
            renderLottieItem(pendingLottieId, pendingLottieData, pendingLottieUrl);
        }
    }

    // Renderizar tarjeta de Secreto Efímero Autodestructible
    function appendSecretCard(secret) {
        const card = document.createElement('div');
        card.className = 'message-card';
        card.innerHTML = `
            <div class="msg-avatar">🔒</div>
            <div class="msg-body">
                <div class="msg-meta">
                    <span class="msg-author">${escapeHtml(secret.author)}</span>
                    <span class="msg-time">${secret.created_at || 'ahora'}</span>
                </div>
                <div class="secret-card" id="secretBox_${secret.secret_id}">
                    <div class="secret-header">
                        <span>🛡️ ${escapeHtml(secret.title)}</span>
                    </div>
                    <div class="secret-desc">
                        Este mensaje contiene datos sensibles cifrados.
                        ${secret.burn_on_read ? 'Se destruirá de forma permanente e irreversible tras el primer acceso.' : 'Expirará automáticamente a las ' + secret.expires_at}
                    </div>
                    <button class="btn-reveal-secret" onclick="revealSecret('${secret.secret_id}')">
                        🔓 Revelar Secreto
                    </button>
                </div>
            </div>
        `;
        messagesContainer.appendChild(card);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // API: Revelar y Autodestruir Secreto
    window.revealSecret = async function(secretId) {
        const box = document.getElementById(`secretBox_${secretId}`);
        if (!box) return;

        try {
            const res = await fetch(`/api/secrets/${secretId}/reveal/`, {
                method: 'POST',
                headers: {
                    'X-CSRFToken': csrfToken,
                    'Content-Type': 'application/json'
                }
            });

            const data = await res.json();
            if (res.ok) {
                box.innerHTML = `
                    <div class="secret-header" style="color: #a6e3a1;">
                        <span>🔓 DATO CONFIDENCIAL REVELADO</span>
                    </div>
                    <div class="secret-revealed-box">
                        ${escapeHtml(data.content)}
                    </div>
                    <div class="secret-timer-alert">
                        ⚠️ ${data.message} Este contenido se cerrará automáticamente en <span id="timer_${secretId}">30</span>s.
                    </div>
                `;

                let remaining = 30;
                const timerEl = document.getElementById(`timer_${secretId}`);
                const interval = setInterval(() => {
                    remaining--;
                    if (timerEl) timerEl.textContent = remaining;
                    if (remaining <= 0) {
                        clearInterval(interval);
                        box.innerHTML = `<div class="secret-desc">🗑️ El secreto ha sido purgado y cerrado.</div>`;
                    }
                }, 1000);
            } else {
                box.innerHTML = `<div class="secret-desc" style="color: #ff7b72;">❌ ${data.error}</div>`;
            }
        } catch (err) {
            box.innerHTML = `<div class="secret-desc" style="color: #ff7b72;">❌ Error al conectar con el servidor.</div>`;
        }
    };

    // Funciones de utilidad
    window.copyCode = function(button) {
        const pre = button.closest('.code-container').querySelector('pre');
        if (pre) {
            navigator.clipboard.writeText(pre.innerText).then(() => {
                const originalText = button.textContent;
                button.textContent = '¡Copiado!';
                setTimeout(() => button.textContent = originalText, 2000);
            });
        }
    };

    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Control de Modales
    const secretModal = document.getElementById('secretModal');
    const codeModal = document.getElementById('codeModal');
    const fileInput = document.getElementById('fileUploadInput');

    window.openSecretModal = function() {
        if (window.pendingSecretContent) {
            document.getElementById('secretInputText').value = window.pendingSecretContent;
            window.pendingSecretContent = null;
        }
        secretModal.style.display = 'flex';
    };

    window.closeSecretModal = function() {
        secretModal.style.display = 'none';
    };

    window.openCodeModal = function() {
        codeModal.style.display = 'flex';
    };

    window.closeCodeModal = function() {
        codeModal.style.display = 'none';
    };

    // Envío de Secreto Efímero
    window.submitEphemeralSecret = async function() {
        const content = document.getElementById('secretInputText').value.trim();
        const title = document.getElementById('secretTitle').value.trim();
        const ttl = document.getElementById('secretTtl').value;
        const burnOnRead = document.getElementById('secretBurnOnRead').checked;

        if (!content) return;

        try {
            const res = await fetch('/api/secrets/create/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': csrfToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    room_id: roomId,
                    title: title || 'Dato Sensible Confidencial',
                    secret_content: content,
                    ttl_minutes: parseInt(ttl),
                    burn_on_read: burnOnRead
                })
            });

            const data = await res.json();
            if (res.ok) {
                closeSecretModal();
                hideDlpAlert();
                document.getElementById('secretInputText').value = '';
            } else {
                alert(data.error || 'Error al crear secreto');
            }
        } catch (err) {
            alert('Error al comunicar con el servidor.');
        }
    };

    // Envío de Snippet de Código Formateado
    window.submitCodeSnippet = function() {
        const code = document.getElementById('codeSnippetText').value.trim();
        const lang = document.getElementById('codeLanguageSelect').value;

        if (!code || !socket || socket.readyState !== WebSocket.OPEN) return;

        socket.send(JSON.stringify({
            type: 'message',
            content: code,
            is_code: true,
            language: lang
        }));

        closeCodeModal();
        document.getElementById('codeSnippetText').value = '';
    };

    // Subida de Archivos / Imágenes
    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);
            formData.append('room_id', roomId);

            try {
                const res = await fetch('/api/attachments/upload/', {
                    method: 'POST',
                    headers: {
                        'X-CSRFToken': csrfToken
                    },
                    body: formData
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(data.error || 'Error al subir archivo');
                }
            } catch (err) {
                alert('Fallo en la carga del archivo.');
            }
            fileInput.value = '';
        });
    }

    // ==========================================
    // Modales de Perfil de Usuario (Estilo Telegraph)
    // ==========================================
    const profileModal = document.getElementById('profileSettingsModal');
    const userProfileCardModal = document.getElementById('userProfileCardModal');
    const avatarInput = document.getElementById('avatarFileInput');

    window.openProfileModal = function() {
        if (profileModal) profileModal.style.display = 'flex';
    };

    window.closeProfileModal = function() {
        if (profileModal) profileModal.style.display = 'none';
    };

    window.closeUserProfileCard = function() {
        if (userProfileCardModal) userProfileCardModal.style.display = 'none';
    };

    // Previsualización instantánea de avatar
    if (avatarInput) {
        avatarInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    const previewImg = document.getElementById('avatarPreviewImg');
                    if (previewImg) previewImg.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });
    }

    // Tarjeta emergente de perfil estilo Telegraph (al hacer clic en cualquier miembro)
    window.openUserProfileCard = async function(username) {
        if (!userProfileCardModal) return;
        try {
            const res = await fetch(`/api/users/${encodeURIComponent(username)}/profile/`);
            if (res.ok) {
                const data = await res.json();
                const bannerEl = document.getElementById('profileCardBanner');
                if (bannerEl) bannerEl.style.backgroundColor = data.banner_color || '#5865f2';

                const avatarBox = document.getElementById('profileCardAvatar');
                if (avatarBox) {
                    if (data.avatar_url) {
                        avatarBox.innerHTML = `<img src="${data.avatar_url}" alt="Avatar" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
                    } else {
                        avatarBox.innerHTML = data.username.charAt(0).toUpperCase();
                    }
                }

                document.getElementById('profileCardDisplayName').textContent = data.display_name || data.username;
                document.getElementById('profileCardUsername').textContent = `@${data.username}`;
                document.getElementById('profileCardStatus').textContent = data.custom_status || 'Sin estado';
                document.getElementById('profileCardBio').textContent = data.bio || 'Este usuario aún no ha escrito su biografía.';
                document.getElementById('profileCardJoined').textContent = `Miembro de Telegraph desde ${data.date_joined}`;

                userProfileCardModal.style.display = 'flex';
            }
        } catch (err) {
            console.error('Error al cargar la tarjeta de perfil:', err);
        }
    };

    // ==========================================
    // Panel Popover Flotante Estilo Telegram (Emojis, Stickers, GIFs)
    // ==========================================
    const tgPicker = document.getElementById('telegramPicker');
    const tgToggleBtn = document.getElementById('tgPickerToggleBtn');
    let tgDataLoaded = false;

    window.toggleTelegramPicker = function(e) {
        if (e) e.stopPropagation();
        if (!tgPicker) return;
        const isShown = tgPicker.style.display === 'flex';
        if (isShown) {
            closeTelegramPicker();
        } else {
            openTelegramPicker();
        }
    };

    window.openTelegramPicker = function() {
        if (!tgPicker) return;
        tgPicker.style.display = 'flex';
        if (!tgDataLoaded) {
            initTelegramPickerData();
            tgDataLoaded = true;
        }
    };

    window.closeTelegramPicker = function() {
        if (tgPicker) tgPicker.style.display = 'none';
    };

    // Cerrar el popover al hacer clic fuera
    document.addEventListener('click', (e) => {
        if (!tgPicker || tgPicker.style.display !== 'flex') return;
        const inlineBtn = e.target.closest('.chat-inline-emoji-btn');
        const toggleBtn = e.target.closest('#tgPickerToggleBtn');
        if (!tgPicker.contains(e.target) && !inlineBtn && !toggleBtn) {
            closeTelegramPicker();
        }
    });

    // Cambio de pestañas (Emojis | Stickers | GIF)
    window.switchTgTab = function(tabName) {
        const paneEmojis = document.getElementById('tgPaneEmojis');
        const paneStickers = document.getElementById('tgPaneStickers');
        const paneGifs = document.getElementById('tgPaneGifs');

        const btnEmojis = document.getElementById('tgTabBtnEmojis');
        const btnStickers = document.getElementById('tgTabBtnStickers');
        const btnGifs = document.getElementById('tgTabBtnGifs');

        const dockEmojis = document.getElementById('dockBtnEmojis');
        const dockGifs = document.getElementById('dockBtnGifs');

        [paneEmojis, paneStickers, paneGifs].forEach(p => { if (p) p.style.display = 'none'; });
        [btnEmojis, btnStickers, btnGifs].forEach(b => { if (b) b.classList.remove('active'); });
        if (dockEmojis) dockEmojis.classList.remove('active');
        if (dockGifs) dockGifs.classList.remove('active');

        if (tabName === 'stickers') {
            if (paneStickers) paneStickers.style.display = 'block';
            if (btnStickers) btnStickers.classList.add('active');
            loadTelegramStickers();
        } else if (tabName === 'gifs') {
            if (paneGifs) paneGifs.style.display = 'block';
            if (btnGifs) btnGifs.classList.add('active');
            if (dockGifs) dockGifs.classList.add('active');
            loadTelegramGifs();
        } else {
            if (paneEmojis) paneEmojis.style.display = 'block';
            if (btnEmojis) btnEmojis.classList.add('active');
            if (dockEmojis) dockEmojis.classList.add('active');
        }
    };

    // Insertar emoji en el cursor del input de chat
    window.insertEmoji = function(emojiChar) {
        if (!messageInput) return;
        const start = messageInput.selectionStart || messageInput.value.length;
        const end = messageInput.selectionEnd || messageInput.value.length;
        const text = messageInput.value;
        messageInput.value = text.substring(0, start) + emojiChar + text.substring(end);
        messageInput.selectionStart = messageInput.selectionEnd = start + emojiChar.length;
        messageInput.focus();
    };

    // Enviar sticker al chat de forma instantánea
    window.sendSticker = function(stickerUrl, stickerName, isAnimated, animType) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
            type: 'sticker',
            is_sticker: true,
            sticker_image_url: stickerUrl,
            content: stickerName || 'Sticker',
            is_animated_sticker: !!isAnimated,
            sticker_animation_type: animType || ''
        }));
        closeTelegramPicker();
    };

    // Inicializar datos de emojis, stickers y GIFs
    function initTelegramPickerData() {
        populateEmojis();
        loadTelegramStickers();
    }

    // Poblar colecciones de emojis nativos de alta fidelidad
    function populateEmojis() {
        const faces = [
            '😂', '😘', '❤️', '😍', '😊', '😁', '👍', '😋', '😔', '😃', '😭', '💋', '😉', 
            '😳', '😜', '🙈', '😇', '🥺', '🤪', '😱', '😡', '😏', '😞', '😅', '😚', '🙊', 
            '😴', '😐', '😆', '👌', '😑', '🙁', '😀', '😃', '😄', '😁', '😆', '🥹', '😅', 
            '😂', '🤣', '🥲', '☺️', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', 
            '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', 
            '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', 
            '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱'
        ];

        const tech = [
            '💻', '🖥️', '⌨️', '🖱️', '📱', '💾', '💿', '📡', '🚀', '⚙️', '🛠️', '🔧', '🔨', 
            '🛡️', '🔒', '🔑', '💡', '📊', '📈', '📝', '📌', '☕', '🍕', '🍺', '⚡', '🤖', 
            '🧠', '📦', '🐍', '🦀', '🐳', '🐧', '🌐', '🔍', '🚨', '🎯'
        ];

        const symbols = [
            '❤️', '🤍', '👍', '👎', '🔥', '⭐', '✨', '💥', '💯', '☕', '🎉', '🎊', '🎁',
            '🧡', '💛', '💚', '💙', '💜', '🖤', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', 
            '💖', '💘', '💝', '💢', '💨', '💫', '💬', '💭', '🗯️', '✅', '❌', '⚠️', '🚫'
        ];

        renderEmojiGrid('tgEmojiGridFaces', faces);
        renderEmojiGrid('tgEmojiGridTech', tech);
        renderEmojiGrid('tgEmojiGridSymbols', symbols);
    }

    function renderEmojiGrid(containerId, list) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        list.forEach(emoji => {
            const span = document.createElement('span');
            span.className = 'tg-emoji-item';
            span.textContent = emoji;
            span.title = emoji;
            span.onclick = () => insertEmoji(emoji);
            container.appendChild(span);
        });
    }

    // Cargar y agrupar stickers de la base de datos
    async function loadTelegramStickers() {
        const container = document.getElementById('tgStickersContainer');
        if (!container) return;
        try {
            const res = await fetch('/api/stickers/');
            if (res.ok) {
                const data = await res.json();
                container.innerHTML = '';
                const stickers = data.stickers || [];

                if (stickers.length === 0) {
                    container.innerHTML = '<div style="color: #949ba4; padding: 24px; text-align: center;">No hay stickers disponibles.</div>';
                    return;
                }

                // Agrupar por packs
                const packs = {};
                stickers.forEach(s => {
                    const cat = s.category || 'Varios';
                    if (!packs[cat]) packs[cat] = [];
                    packs[cat].push(s);
                });

                Object.keys(packs).forEach(packName => {
                    const validStickers = packs[packName].filter(s => !s.url.endsWith('.tgs') && !s.url.endsWith('.json'));
                    if (validStickers.length === 0) return;

                    const packHeader = document.createElement('div');
                    packHeader.className = 'tg-stickers-pack-header';
                    packHeader.id = `tgPack_${packName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
                    packHeader.innerHTML = `<span>${escapeHtml(packName)}</span><span style="font-size: 11px; color: #949ba4;">${validStickers.length} stickers</span>`;
                    container.appendChild(packHeader);

                    const grid = document.createElement('div');
                    grid.className = 'tg-stickers-grid';

                    validStickers.forEach(s => {
                        const item = document.createElement('div');
                        item.className = 'tg-sticker-item';
                        item.title = `${s.name} (Clic para enviar)`;
                        item.onclick = () => sendSticker(s.url, s.name, s.is_animated, s.animation_type || 'webp');

                        const badge = s.is_animated ? '<span class="tg-sticker-badge">✨</span>' : '';
                        item.innerHTML = `
                            <img src="${s.url}" alt="${escapeHtml(s.name)}" class="tg-sticker-thumb" loading="lazy" onerror="this.closest('.tg-sticker-item')?.remove()">
                            ${badge}
                        `;
                        grid.appendChild(item);
                    });

                    container.appendChild(grid);
                });
            }
        } catch (err) {
            console.error('Error cargando stickers:', err);
        }
    }

    // Salto rápido a pack desde el dock inferior
    window.jumpToStickerPack = function(packKeyword) {
        switchTgTab('stickers');
        setTimeout(() => {
            const headers = document.querySelectorAll('.tg-stickers-pack-header');
            for (let h of headers) {
                if (h.textContent.toLowerCase().includes(packKeyword.toLowerCase())) {
                    h.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    break;
                }
            }
        }, 100);
    };

    // Envío directo de GIFs estilo Telegram al chat (animados)
    window.sendTelegramGif = function(gifUrl, gifTitle) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
            type: 'sticker',
            is_sticker: true,
            sticker_image_url: gifUrl,
            content: gifTitle || 'GIF',
            is_animated_sticker: true,
            sticker_animation_type: 'gif'
        }));
        closeTelegramPicker();
    };

    // Colección de GIFs en vivo con motor estilo Telegram (Giphy / Tenor)
    let tgGifDebounceTimer = null;
    let tgCurrentGifQuery = '';

    window.searchTgGifsByCategory = function(categoryKeyword) {
        // Actualizar chips visualmente
        const chips = document.querySelectorAll('.tg-gif-chip');
        chips.forEach(chip => {
            const isMatch = (categoryKeyword === '' && chip.textContent.includes('Tendencias')) ||
                            (categoryKeyword !== '' && chip.getAttribute('onclick').includes(`'${categoryKeyword}'`));
            if (isMatch) {
                chip.classList.add('active');
            } else {
                chip.classList.remove('active');
            }
        });

        const searchInput = document.getElementById('tgSearchInput');
        if (searchInput) searchInput.value = categoryKeyword;

        loadTelegramGifs(categoryKeyword);
    };

    async function loadTelegramGifs(query = '') {
        const grid = document.getElementById('tgGifsGrid');
        if (!grid) return;

        tgCurrentGifQuery = query;
        grid.innerHTML = `
            <div class="tg-gif-spinner">
                <span style="font-size: 24px; animation: spin 1s infinite linear;">🔄</span>
                <span>Cargando GIFs de Telegram...</span>
            </div>
        `;

        try {
            const endpoint = query 
                ? `/api/gifs/search/?q=${encodeURIComponent(query)}` 
                : '/api/gifs/trending/';
            
            const res = await fetch(endpoint);
            if (!res.ok) throw new Error('Error al conectar con el servidor de GIFs');
            const data = await res.json();
            const gifs = data.gifs || [];

            // Si la consulta cambió mientras esperábamos la respuesta, descartar
            if (tgCurrentGifQuery !== query) return;

            grid.innerHTML = '';
            if (gifs.length === 0) {
                grid.innerHTML = `
                    <div style="grid-column: span 2; color: #949ba4; padding: 40px 10px; text-align: center;">
                        <span style="font-size: 28px; display: block; margin-bottom: 8px;">🔍</span>
                        No se encontraron GIFs para "${escapeHtml(query)}"
                    </div>
                `;
                return;
            }

            gifs.forEach(g => {
                const item = document.createElement('div');
                item.className = 'tg-gif-item';
                item.title = g.title || 'GIF';
                item.onclick = () => sendTelegramGif(g.url, g.title);
                item.innerHTML = `
                    <img src="${g.preview_url || g.url}" alt="${escapeHtml(g.title)}" class="tg-gif-img" loading="lazy">
                    <div class="tg-gif-label">${escapeHtml(g.title)}</div>
                `;
                grid.appendChild(item);
            });
        } catch (err) {
            console.error('Error cargando GIFs:', err);
            grid.innerHTML = `
                <div style="grid-column: span 2; color: #f23f43; padding: 30px 10px; text-align: center; font-size: 13px;">
                    ⚠️ Error al cargar GIFs. Verifica tu conexión a Internet.
                </div>
            `;
        }
    }

    // Filtrar contenido en el buscador según la pestaña activa
    window.filterTgContent = function(query) {
        const q = (query || '').toLowerCase().trim();
        const activePane = document.querySelector('.tg-pane:not([style*="display: none"])');
        if (!activePane) return;

        if (activePane.id === 'tgPaneEmojis') {
            document.querySelectorAll('.tg-emoji-item').forEach(el => {
                const title = el.getAttribute('title') || '';
                el.style.display = (!q || title.includes(q)) ? 'flex' : 'none';
            });
        } else if (activePane.id === 'tgPaneStickers') {
            document.querySelectorAll('.tg-sticker-item').forEach(el => {
                const title = (el.getAttribute('title') || '').toLowerCase();
                el.style.display = (!q || title.includes(q)) ? 'flex' : 'none';
            });
        } else if (activePane.id === 'tgPaneGifs') {
            if (tgGifDebounceTimer) clearTimeout(tgGifDebounceTimer);
            tgGifDebounceTimer = setTimeout(() => {
                loadTelegramGifs(q);
            }, 350);
        }
    };

    // Modal de Subida de Stickers
    const uploadModal = document.getElementById('customStickerUploadModal');

    window.openUploadModalFromTg = function() {
        closeTelegramPicker();
        if (uploadModal) uploadModal.style.display = 'flex';
    };

    window.closeCustomStickerModal = function() {
        if (uploadModal) uploadModal.style.display = 'none';
    };

    window.uploadCustomSticker = async function() {
        const fileInput = document.getElementById('customStickerFileInput');
        const nameInput = document.getElementById('customStickerNameInput');
        const categoryInput = document.getElementById('customStickerCategoryInput');

        if (!fileInput || !fileInput.files[0]) {
            alert('Por favor selecciona un archivo de sticker (.tgs, .webm, WebP o PNG).');
            return;
        }

        const formData = new FormData();
        formData.append('sticker_file', fileInput.files[0]);
        formData.append('name', (nameInput ? nameInput.value.trim() : '') || 'Sticker');
        formData.append('category', (categoryInput ? categoryInput.value.trim() : '') || 'Comunidad');

        try {
            const res = await fetch('/api/stickers/upload/', {
                method: 'POST',
                headers: { 'X-CSRFToken': csrfToken },
                body: formData
            });

            const data = await res.json();
            if (res.ok) {
                fileInput.value = '';
                if (nameInput) nameInput.value = '';
                closeCustomStickerModal();
                loadTelegramStickers();
                openTelegramPicker();
                switchTgTab('stickers');
            } else {
                alert(data.error || 'Error al subir el sticker');
            }
        } catch (err) {
            alert('Error al comunicar con el servidor.');
        }
    };

    // =========================================================================
    // Manejadores Interactivos Estilo Telegraph / Steam
    // =========================================================================

    const attachMenu = document.getElementById('chatAttachMenu');

    window.toggleAttachMenu = function(e) {
        if (e) e.stopPropagation();
        if (attachMenu) {
            attachMenu.classList.toggle('open');
        }
    };

    window.closeAttachMenu = function() {
        if (attachMenu) {
            attachMenu.classList.remove('open');
        }
    };

    window.openTelegramTab = function(tabName, e) {
        if (e) e.stopPropagation();
        if (typeof openTelegramPicker === 'function') {
            openTelegramPicker();
        }
        if (typeof switchTgTab === 'function') {
            switchTgTab(tabName);
        }
    };

    // Alternar visibilidad de la columna derecha de perfil / miembros
    window.toggleProfileDrawer = function() {
        const appContainer = document.querySelector('.app-container');
        const btnToggle = document.getElementById('btnToggleProfileDrawer');
        if (appContainer) {
            appContainer.classList.toggle('profile-drawer-hidden');
            if (btnToggle) {
                btnToggle.classList.toggle('active', !appContainer.classList.contains('profile-drawer-hidden'));
            }
        }
    };

    // Buscador en tiempo real de mensajes del chat
    window.searchInChat = function(query) {
        const q = (query || '').toLowerCase().trim();
        const msgCards = document.querySelectorAll('#messagesContainer .message-card');
        msgCards.forEach(card => {
            const text = (card.textContent || '').toLowerCase();
            if (!q || text.includes(q)) {
                card.style.display = 'flex';
            } else {
                card.style.display = 'none';
            }
        });
    };

    // Controles de audio de usuario (Mute / Deafen)
    window.toggleMuteAudio = function(btn) {
        if (typeof window.toggleCallMic === 'function' && window.isWebRtcCallActive && window.isWebRtcCallActive()) {
            window.toggleCallMic();
            return;
        }

        btn = btn || document.getElementById('btnUserPanelMic');
        if (!btn) return;
        btn.classList.toggle('active');
        const isMuted = btn.classList.contains('active');
        btn.textContent = isMuted ? '🔇' : '🎙️';
        btn.style.color = isMuted ? 'var(--accent-danger)' : '';
        btn.title = isMuted ? 'Micrófono silenciado' : 'Silenciar micrófono';

        if (typeof window.setLocalMicMuted === 'function') {
            window.setLocalMicMuted(isMuted);
        }
    };

    window.syncUserPanelMic = function(isMuted) {
        const btn = document.getElementById('btnUserPanelMic');
        if (!btn) return;
        btn.classList.toggle('active', isMuted);
        btn.textContent = isMuted ? '🔇' : '🎙️';
        btn.style.color = isMuted ? 'var(--accent-danger)' : '';
        btn.title = isMuted ? 'Micrófono silenciado' : 'Silenciar micrófono';
    };

    window.toggleDeafenAudio = function(btn) {
        btn = btn || document.getElementById('btnUserPanelDeafen');
        if (!btn) return;
        btn.classList.toggle('active');
        const isDeafened = btn.classList.contains('active');
        btn.textContent = isDeafened ? '🔇' : '🎧';
        btn.style.color = isDeafened ? 'var(--accent-danger)' : '';
        btn.title = isDeafened ? 'Audio ensordecido' : 'Ensordecer audio';

        // Si ensordece, también silenciar micrófono local
        if (isDeafened) {
            window.syncUserPanelMic(true);
            if (typeof window.setLocalMicMuted === 'function') {
                window.setLocalMicMuted(true);
            }
        }
    };

    // Auto-expandir altura del input de texto
    if (messageInput) {
        messageInput.addEventListener('input', () => {
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
        });
    }

    // Cerrar menú de adjuntos al hacer clic en cualquier lugar del documento
    document.addEventListener('click', () => {
        closeAttachMenu();
    });

    // ==========================================
    // Gestión de Canales y Grupos Estilo WhatsApp
    // ==========================================
    const createChannelModal = document.getElementById('createChannelModal');
    const manageChannelModal = document.getElementById('manageChannelModal');
    let currentManagingChannelId = null;

    window.openCreateChannelModal = async function() {
        if (!createChannelModal) return;
        createChannelModal.style.display = 'flex';
        const errEl = document.getElementById('createChannelError');
        if (errEl) errEl.style.display = 'none';

        const nameInput = document.getElementById('newChannelName');
        if (nameInput) {
            nameInput.value = '';
            nameInput.focus();
        }
        const topicInput = document.getElementById('newChannelTopic');
        if (topicInput) topicInput.value = '';

        const managerSelect = document.getElementById('newChannelManagerSelect');
        const membersList = document.getElementById('newChannelMembersList');

        try {
            const res = await fetch('/api/workspace/users/');
            if (res.ok) {
                const data = await res.json();
                if (managerSelect) {
                    managerSelect.innerHTML = data.users.map(u => 
                        `<option value="${u.id}" ${u.username === currentUser ? 'selected' : ''}>${u.display_name} (@${u.username})</option>`
                    ).join('');
                }
                if (membersList) {
                    membersList.innerHTML = data.users.map(u => `
                        <label style="display: flex; align-items: center; gap: 8px; padding: 5px 0; cursor: pointer; color: #dbdee1; font-size: 13px;">
                            <input type="checkbox" name="channel_member" value="${u.id}" ${u.username === currentUser ? 'checked disabled' : 'checked'} style="accent-color: #5865f2; width: 16px; height: 16px;">
                            <span>${u.display_name}</span>
                            <span style="color: var(--text-muted); font-size: 11.5px;">@${u.username}</span>
                        </label>
                    `).join('');
                }
            }
        } catch (e) {
            console.error('Error cargando usuarios del workspace:', e);
        }
    };

    window.closeCreateChannelModal = function() {
        if (createChannelModal) createChannelModal.style.display = 'none';
    };

    window.toggleCreateChannelPrivacy = function(mode) {
        const membersGroup = document.getElementById('newChannelMembersGroup');
        const publicNotice = document.getElementById('newChannelPublicNotice');
        if (mode === 'private') {
            if (membersGroup) membersGroup.style.display = 'block';
            if (publicNotice) publicNotice.style.display = 'none';
        } else {
            if (membersGroup) membersGroup.style.display = 'none';
            if (publicNotice) publicNotice.style.display = 'block';
        }
    };

    window.submitCreateChannel = async function() {
        const nameInput = document.getElementById('newChannelName');
        const topicInput = document.getElementById('newChannelTopic');
        const managerSelect = document.getElementById('newChannelManagerSelect');
        const errEl = document.getElementById('createChannelError');
        const btn = document.getElementById('btnSubmitCreateChannel');

        const name = nameInput ? nameInput.value.trim() : '';
        const topic = topicInput ? topicInput.value.trim() : '';
        const managerId = managerSelect ? managerSelect.value : null;
        const privacyRadio = document.querySelector('input[name="newChannelPrivacy"]:checked');
        const isPrivate = privacyRadio ? (privacyRadio.value === 'private') : false;

        const memberCheckboxes = document.querySelectorAll('#newChannelMembersList input[type="checkbox"]:checked');
        const memberIds = Array.from(memberCheckboxes).map(cb => cb.value);

        if (!name) {
            if (errEl) {
                errEl.textContent = 'Ingresa un nombre para el canal.';
                errEl.style.display = 'block';
            }
            return;
        }

        if (btn) btn.disabled = true;

        try {
            const res = await fetch('/api/channels/create/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '',
                },
                body: JSON.stringify({
                    name: name,
                    topic: topic,
                    manager_id: managerId,
                    is_private: isPrivate,
                    member_ids: isPrivate ? memberIds : []
                })
            });

            const data = await res.json();
            if (res.ok && data.status === 'success') {
                window.location.href = data.redirect_url;
            } else {
                if (errEl) {
                    errEl.textContent = data.message || 'Error al crear el canal.';
                    errEl.style.display = 'block';
                }
                if (btn) btn.disabled = false;
            }
        } catch (e) {
            if (errEl) {
                errEl.textContent = 'Error de conexión con el servidor.';
                errEl.style.display = 'block';
            }
            if (btn) btn.disabled = false;
        }
    };

    window.openManageChannelModal = async function(channelId) {
        if (!manageChannelModal) return;
        currentManagingChannelId = channelId;
        manageChannelModal.style.display = 'flex';
        await loadManageChannelData(channelId);
    };

    window.closeManageChannelModal = function() {
        if (manageChannelModal) manageChannelModal.style.display = 'none';
        currentManagingChannelId = null;
    };

    async function loadManageChannelData(channelId) {
        try {
            const res = await fetch(`/api/channels/${channelId}/manage/`);
            if (res.ok) {
                const data = await res.json();
                document.getElementById('manageChannelModalTitle').textContent = `👥 Administrar Grupo: #${data.channel_name}`;
                document.getElementById('manageChannelModalSubtitle').textContent = data.is_general ? 'Canal General (Todos los usuarios)' : 'Canal Privado con Control de Administradores';
                document.getElementById('manageChannelMembersCount').textContent = `Participantes (${data.members.length})`;
                document.getElementById('manageChannelTopicInput').value = data.topic || '';

                const dangerZone = document.getElementById('manageChannelDangerZone');
                if (dangerZone) dangerZone.style.display = data.is_general ? 'none' : 'block';

                const membersList = document.getElementById('manageChannelMembersList');
                if (membersList) {
                    membersList.innerHTML = data.members.map(m => `
                        <div style="display: flex; align-items: center; justify-content: space-between; background: #1e1f22; padding: 8px 12px; border-radius: 6px; border: 1px solid #383a40;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="width: 32px; height: 32px; border-radius: 50%; background: #5865f2; display: flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; font-size: 13px; overflow: hidden;">
                                    ${m.avatar_url ? `<img src="${m.avatar_url}" style="width:100%;height:100%;object-fit:cover;">` : m.username.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <div style="font-size: 13.5px; font-weight: 600; color: #f2f3f5; display: flex; align-items: center; gap: 6px;">
                                        <span>${m.display_name}</span>
                                        ${m.is_manager ? `<span style="background: rgba(240,178,50,0.2); border: 1px solid #f0b232; color: #f0b232; font-size: 10.5px; padding: 1px 5px; border-radius: 3px;">👑 Administrador</span>` : ''}
                                    </div>
                                    <div style="font-size: 11.5px; color: var(--text-muted);">@${m.username}</div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 6px; align-items: center;">
                                ${!data.is_general ? `
                                    <button type="button" class="btn-secondary" style="font-size: 11px; padding: 4px 8px;" onclick="submitChannelToggleManager(${m.id})">
                                        ${m.is_manager ? 'Degradar a Miembro' : '👑 Hacer Administrador'}
                                    </button>
                                    ${!m.is_creator ? `
                                        <button type="button" class="btn-danger" style="font-size: 11px; padding: 4px 8px; background: rgba(242,63,67,0.15); border: 1px solid #f23f43; color: #ff7b72; border-radius: 4px; cursor: pointer;" onclick="submitChannelRemoveMember(${m.id}, '${m.username}')">
                                            ✕ Quitar
                                        </button>
                                    ` : ''}
                                ` : ''}
                            </div>
                        </div>
                    `).join('');
                }

                const userSelect = document.getElementById('manageChannelAddUserSelect');
                if (userSelect) {
                    if (data.available_users.length === 0) {
                        userSelect.innerHTML = `<option value="">Todos los miembros del workspace ya están en el canal</option>`;
                    } else {
                        userSelect.innerHTML = `<option value="">Selecciona un usuario para agregar...</option>` + 
                            data.available_users.map(u => `<option value="${u.id}">${u.display_name} (@${u.username})</option>`).join('');
                    }
                }
            }
        } catch (e) {
            console.error('Error cargando detalles del canal:', e);
        }
    }

    window.submitChannelAddMember = async function() {
        if (!currentManagingChannelId) return;
        const select = document.getElementById('manageChannelAddUserSelect');
        const userId = select ? select.value : null;
        if (!userId) return;

        try {
            const res = await fetch(`/api/channels/${currentManagingChannelId}/manage/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '',
                },
                body: JSON.stringify({ action: 'add_member', user_id: userId })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                await loadManageChannelData(currentManagingChannelId);
            } else {
                alert(data.message || 'Error al agregar miembro.');
            }
        } catch (e) {
            alert('Error de conexión.');
        }
    };

    window.submitChannelRemoveMember = async function(userId, username) {
        if (!currentManagingChannelId) return;
        if (!confirm(`¿Estás seguro de quitar a @${username} de este canal? Ya no podrá ver ni participar en el grupo.`)) return;

        try {
            const res = await fetch(`/api/channels/${currentManagingChannelId}/manage/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '',
                },
                body: JSON.stringify({ action: 'remove_member', user_id: userId })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                await loadManageChannelData(currentManagingChannelId);
            } else {
                alert(data.message || 'Error al quitar miembro.');
            }
        } catch (e) {
            alert('Error de conexión.');
        }
    };

    window.submitChannelToggleManager = async function(userId) {
        if (!currentManagingChannelId) return;
        try {
            const res = await fetch(`/api/channels/${currentManagingChannelId}/manage/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '',
                },
                body: JSON.stringify({ action: 'toggle_manager', user_id: userId })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                await loadManageChannelData(currentManagingChannelId);
            } else {
                alert(data.message || 'Error al cambiar rol.');
            }
        } catch (e) {
            alert('Error de conexión.');
        }
    };

    window.submitChannelUpdateTopic = async function() {
        if (!currentManagingChannelId) return;
        const topicInput = document.getElementById('manageChannelTopicInput');
        const topic = topicInput ? topicInput.value.trim() : '';

        try {
            const res = await fetch(`/api/channels/${currentManagingChannelId}/manage/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '',
                },
                body: JSON.stringify({ action: 'update_topic', topic: topic })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                alert('Tema del canal actualizado.');
            }
        } catch (e) {
            alert('Error de conexión.');
        }
    };

    window.submitChannelDelete = async function() {
        if (!currentManagingChannelId) return;
        if (!confirm('⚠️ ¿Estás COMPLETAMENTE seguro de eliminar este canal? Todos los mensajes y archivos serán eliminados y esta acción NO se puede deshacer.')) return;

        try {
            const res = await fetch(`/api/channels/${currentManagingChannelId}/manage/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken || document.querySelector('[name=csrfmiddlewaretoken]')?.value || '',
                },
                body: JSON.stringify({ action: 'delete_channel' })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                window.location.href = data.redirect_url || '/';
            } else {
                alert(data.message || 'Error al eliminar canal.');
            }
        } catch (e) {
            alert('Error de conexión.');
        }
    };
});


