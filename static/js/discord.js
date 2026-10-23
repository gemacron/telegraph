// DevCord - Cliente WebSocket y Control de Seguridad DLP
document.addEventListener('DOMContentLoaded', () => {
    const roomId = window.DEV_ROOM_ID;
    const currentUser = window.DEV_CURRENT_USER;
    const csrfToken = window.DEV_CSRF_TOKEN;

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

        socket.onopen = () => {
            console.log('[DevCord] Conexión WebSocket establecida con la sala:', roomId);
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
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
            console.warn('[DevCord] WebSocket cerrado. Reintentando en 3s...', e.reason);
            setTimeout(connectWebSocket, 3000);
        };

        socket.onerror = (err) => {
            console.error('[DevCord] Error en WebSocket:', err);
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
        if (msg.is_sticker && msg.sticker_image_url) {
            innerContent = `<div class="msg-sticker-wrapper">
                                <img src="${msg.sticker_image_url}" class="msg-sticker-img" alt="${escapeHtml(msg.content)}" title="${escapeHtml(msg.content)}">
                            </div>`;
        } else if (msg.attachment_url) {
            innerContent = `<div class="msg-content">${escapeHtml(msg.content)}</div>
                            <img src="${msg.attachment_url}" class="attachment-preview" alt="Adjunto">`;
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
            innerContent = `<div class="msg-content">${escapeHtml(msg.content)}</div>`;
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
    // Modales de Perfil de Usuario (Estilo Discord)
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

    // Tarjeta emergente de perfil estilo Discord (al hacer clic en cualquier miembro)
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
                document.getElementById('profileCardJoined').textContent = `Miembro de DevCord desde ${data.date_joined}`;

                userProfileCardModal.style.display = 'flex';
            }
        } catch (err) {
            console.error('Error al cargar la tarjeta de perfil:', err);
        }
    };

    // ==========================================
    // Selector y Envío de Stickers (Estilo Discord)
    // ==========================================
    const stickerModal = document.getElementById('stickerPickerModal');

    window.openStickerPicker = function() {
        if (stickerModal) {
            stickerModal.style.display = 'flex';
            loadStickers();
        }
    };

    window.closeStickerPicker = function() {
        if (stickerModal) stickerModal.style.display = 'none';
    };

    window.showStickerTab = function(tabName) {
        const catPane = document.getElementById('stickerTabCatalog');
        const uploadPane = document.getElementById('stickerTabUpload');
        const catBtn = document.getElementById('tabStickerCatBtn');
        const uploadBtn = document.getElementById('tabStickerUploadBtn');

        if (tabName === 'upload') {
            if (catPane) catPane.style.display = 'none';
            if (uploadPane) uploadPane.style.display = 'flex';
            if (catBtn) catBtn.classList.remove('active');
            if (uploadBtn) uploadBtn.classList.add('active');
        } else {
            if (catPane) catPane.style.display = 'flex';
            if (uploadPane) uploadPane.style.display = 'none';
            if (catBtn) catBtn.classList.add('active');
            if (uploadBtn) uploadBtn.classList.remove('active');
        }
    };

    window.sendSticker = function(stickerUrl, stickerName) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
            type: 'sticker',
            is_sticker: true,
            sticker_image_url: stickerUrl,
            content: stickerName || 'Sticker'
        }));
        closeStickerPicker();
    };

    async function loadStickers() {
        const grid = document.getElementById('stickerGridContainer');
        if (!grid) return;
        try {
            const res = await fetch('/api/stickers/');
            if (res.ok) {
                const data = await res.json();
                grid.innerHTML = '';
                if (data.stickers && data.stickers.length > 0) {
                    data.stickers.forEach(s => {
                        const item = document.createElement('div');
                        item.className = 'sticker-picker-item';
                        item.title = `${s.category}: ${s.name}`;
                        item.onclick = () => sendSticker(s.url, s.name);
                        item.innerHTML = `
                            <img src="${s.url}" alt="${s.name}" class="sticker-thumb">
                            <div class="sticker-name-label">${escapeHtml(s.name.replace(/_/g, ' '))}</div>
                        `;
                        grid.appendChild(item);
                    });
                } else {
                    grid.innerHTML = '<div style="color: var(--text-muted); padding: 20px; grid-column: 1/-1; text-align: center;">No hay stickers disponibles.</div>';
                }
            }
        } catch (err) {
            console.error('Error cargando stickers:', err);
        }
    }

    // Subir Sticker Personalizado por el usuario
    window.uploadCustomSticker = async function() {
        const fileInput = document.getElementById('customStickerFileInput');
        const nameInput = document.getElementById('customStickerNameInput');
        const categoryInput = document.getElementById('customStickerCategoryInput');

        if (!fileInput || !fileInput.files[0]) {
            alert('Por favor selecciona una imagen para el sticker.');
            return;
        }

        const formData = new FormData();
        formData.append('sticker_file', fileInput.files[0]);
        formData.append('name', nameInput.value.trim() || 'Custom Sticker');
        formData.append('category', categoryInput.value.trim() || 'Comunidad');

        try {
            const res = await fetch('/api/stickers/upload/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': csrfToken
                },
                body: formData
            });

            const data = await res.json();
            if (res.ok) {
                fileInput.value = '';
                nameInput.value = '';
                // Recargar catálogo de stickers y cambiar a pestaña de stickers
                loadStickers();
                showStickerTab('catalog');
                alert('¡Sticker subido exitosamente a la biblioteca del equipo!');
            } else {
                alert(data.error || 'Error al subir el sticker');
            }
        } catch (err) {
            alert('Error al comunicar con el servidor.');
        }
    };
});
