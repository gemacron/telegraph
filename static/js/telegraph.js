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
            if (data.type && (data.type.startsWith('webrtc_') || ['call_request', 'call_response', 'call_hangup', 'voice_speaking'].includes(data.type))) {
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
                    const packHeader = document.createElement('div');
                    packHeader.className = 'tg-stickers-pack-header';
                    packHeader.id = `tgPack_${packName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
                    packHeader.innerHTML = `<span>${escapeHtml(packName)}</span><span style="font-size: 11px; color: #949ba4;">${packs[packName].length} stickers</span>`;
                    container.appendChild(packHeader);

                    const grid = document.createElement('div');
                    grid.className = 'tg-stickers-grid';

                    packs[packName].forEach(s => {
                        const item = document.createElement('div');
                        item.className = 'tg-sticker-item';
                        item.title = `${s.name} (Clic para enviar)`;
                        item.onclick = () => sendSticker(s.url, s.name, s.is_animated, s.animation_type);

                        const badge = s.is_animated ? '<span class="tg-sticker-badge">✨</span>' : '';
                        item.innerHTML = `
                            <img src="${s.url}" alt="${s.name}" class="tg-sticker-thumb">
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

    // Colección de GIFs de desarrollo y humor de equipo
    function loadTelegramGifs() {
        const grid = document.getElementById('tgGifsGrid');
        if (!grid || grid.children.length > 0) return;

        const gifs = [
            { name: 'Coding Hacker', url: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=240&h=160&fit=crop', label: '💻 Coding Fast' },
            { name: 'Server Deployment', url: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=240&h=160&fit=crop', label: '🚀 Deploying' },
            { name: 'Bug Hunting', url: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=240&h=160&fit=crop', label: '🐛 Fix in Progress' },
            { name: 'Coffee Mode', url: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=240&h=160&fit=crop', label: '☕ Need Coffee' }
        ];

        grid.innerHTML = '';
        gifs.forEach(g => {
            const item = document.createElement('div');
            item.className = 'tg-gif-item';
            item.onclick = () => {
                if (!socket || socket.readyState !== WebSocket.OPEN) return;
                socket.send(JSON.stringify({
                    type: 'message',
                    content: `![${g.name}](${g.url})`,
                    is_code: false
                }));
                closeTelegramPicker();
            };
            item.innerHTML = `
                <img src="${g.url}" alt="${g.name}" class="tg-gif-img">
                <div class="tg-gif-label">${g.label}</div>
            `;
            grid.appendChild(item);
        });
    }

    // Filtrar contenido en el buscador
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
        btn.classList.toggle('active');
        if (btn.classList.contains('active')) {
            btn.textContent = '🔇';
            btn.style.color = 'var(--accent-danger)';
            btn.title = 'Micrófono silenciado';
        } else {
            btn.textContent = '🎙️';
            btn.style.color = '';
            btn.title = 'Silenciar micrófono';
        }
    };

    window.toggleDeafenAudio = function(btn) {
        btn.classList.toggle('active');
        if (btn.classList.contains('active')) {
            btn.textContent = '🔇';
            btn.style.color = 'var(--accent-danger)';
            btn.title = 'Audio ensordecido';
        } else {
            btn.textContent = '🎧';
            btn.style.color = '';
            btn.title = 'Ensordecer audio';
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
});


