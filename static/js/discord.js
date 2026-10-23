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

    // Renderizar mensaje en la interfaz
    function appendChatMessage(msg) {
        const card = document.createElement('div');
        card.className = 'message-card';

        let innerContent = '';
        if (msg.attachment_url) {
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

        card.innerHTML = `
            <div class="msg-avatar">${msg.sender.charAt(0).toUpperCase()}</div>
            <div class="msg-body">
                <div class="msg-meta">
                    <span class="msg-author">${escapeHtml(msg.sender)}</span>
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
});
