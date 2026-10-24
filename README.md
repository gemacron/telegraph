# 🛡️ Telegraph — Plataforma Colaborativa Segura para Programadores

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python: 3.12](https://img.shields.io/badge/Python-3.12-blue.svg)](https://www.python.org/)
[![Django: 5.1](https://img.shields.io/badge/Django-5.1-green.svg)](https://www.djangoproject.com/)
[![Database: PostgreSQL 16](https://img.shields.io/badge/Database-PostgreSQL%2016-blue.svg)](https://www.postgresql.org/)
[![Containers: Podman](https://img.shields.io/badge/Container-Podman-purple.svg)](https://podman.io/)

**Telegraph** es una plataforma de comunicación y colaboración para equipos de programación de código abierto, con experiencia de usuario fluida y moderna, diseñada desde cero con un enfoque inquebrantable en la **seguridad**, la **prevención de fuga de datos (DLP)**, el **cifrado de secretos efímeros autodestructibles**, **llamadas y videollamadas WebRTC cifradas E2EE** y la **ausencia total de servicios o bibliotecas externas no confiables**.

---

## ✨ Características Principales

### 1. 💬 Experiencia Colaborativa en Tiempo Real
- **Espacios de Trabajo (Workspaces)** y **Canales Temáticos** (`#general`, `#codigo-python`, `#devops`, `#seguridad-dlp`).
- **Mensajes Directos (DMs)** individuales privados entre programadores.
- **Soporte Multimedia Seguro**: Carga de imágenes, avatares, iconos de servidor, stickers locales y GIFs validados a nivel de bytes mediante `Pillow` para neutralizar ataques polyglot o scripts maliciosos.

### 2. 💻 Formateo de Código Nativo para Desarrolladores
- Detección y formateo con bloques de código markdown (\`\`\`python ... \`\`\`).
- Resaltado de sintaxis (Syntax Highlighting) con **Pygments** integrado directamente en el servidor.
- Soporte para **Python, JavaScript, TypeScript, Go, Rust, SQL, Bash/Shell, Dockerfile, YAML, JSON, HTML, CSS**.
- Botón de copiado con un clic y cabecera de lenguaje.

### 3. 🛡️ Motor de Prevención de Fuga de Datos (DLP)
- Inspección determinista en tiempo real antes de que el mensaje sea persistido o emitido por WebSockets.
- Detecta y bloquea automáticamente:
  - 🔑 **Claves Privadas**: SSH, OpenSSH, RSA, EC, PGP (`-----BEGIN ... PRIVATE KEY-----`).
  - ☁️ **Tokens Cloud**: AWS Access Key IDs, GitHub PATs, GitLab, Slack, Discord bots, Stripe.
  - 🗄️ **Cadenas de Conexión**: URIs de bases de datos con contraseñas (`postgres://user:pass@host/db`).
  - 🔒 **Asignaciones de Credenciales**: Expresiones como `password = "..."`, `SECRET_KEY="..."`, `API_KEY="..."`.
  - 🎫 **Tokens JWT** expuestos.
- Notificación preventiva inmediata con opción de convertir el contenido en un **Secreto Efímero Autodestructible**.

### 4. 🔥 Secretos Efímeros Autodestructibles (Burn-After-Reading)
- Envío cifrado de contraseñas, variables `.env`, tokens y claves temporales.
- **Cifrado Simétrico**: Utiliza `cryptography.fernet` con derivación segura.
- **Autodestrucción Atómica en PostgreSQL**:
  - **Burn on Read**: Al ser consultado por primera vez por el destinatario, el registro se elimina física e irreversiblemente de PostgreSQL (`DELETE` atómico con bloqueo transaccional `select_for_update`).
  - **TTL (Time to Live)**: Expiración por tiempo (5 min, 15 min, 1 hora, 24 horas).
  - Temporizador visual de 30 segundos en pantalla antes de limpiar el DOM.

### 5. 🔒 100% Soberano — Sin Dependencias Externas ni CDNs
- No requiere APIs de terceros (sin dependencias de Giphy, Google Fonts o servicios de telemetría que filtren metadatos o IPs).
- Todo el CSS, JavaScript e iconos son servidos localmente.
- Cabeceras de seguridad estrictas: CSP restrictiva, `X-Frame-Options: DENY`, Cookies HttpOnly y SameSite Lax.

---

## 🏗️ Arquitectura Técnica

```
telegraph/
├── apps/
│   ├── chat/                  # Modelos de Workspaces, Canales, DMs, Mensajes y Secretos
│   │   ├── consumers.py       # WebSocket Consumer asíncrono (Channels)
│   │   ├── models.py          # Modelos relacionales PostgreSQL
│   │   ├── routing.py         # Enrutamiento de WebSockets
│   │   ├── urls.py            # Endpoints y vistas
│   │   └── views.py           # Lógica de canales, secretos y archivos
│   └── dlp/                   # Motor DLP (Data Loss Prevention)
│       └── scanner.py         # Escáner regex compilado de credenciales
├── config/
│   ├── asgi.py                # Configuración ASGI (Daphne + Channels)
│   ├── settings.py            # Settings Django (PostgreSQL, Redis, Seguridad)
│   ├── urls.py                # Router principal
│   └── wsgi.py                # WSGI application
├── static/
│   ├── css/
│   │   ├── telegraph.css      # UI temática oscura de Telegraph
│   │   └── pygments.css       # Estilos de resaltado de código
│   └── js/
│       ├── telegraph.js       # Cliente WebSocket, DLP interactivo y secretos
│       └── telegraph_webrtc.js # Llamadas de voz y video E2EE WebRTC
├── templates/
│   ├── auth/                  # Templates de inicio de sesión y registro
│   ├── chat/                  # Template principal de la app Telegraph (telegraph_app.html)
│   └── base.html              # Plantilla base segura
├── Containerfile              # Definición de contenedor OCI para Podman
├── Dockerfile                 # Compatibilidad alternativa
├── compose.yaml               # Orquestación con PostgreSQL 16 y Redis 7
├── podman-compose.yml         # Compatibilidad con podman-compose CLI
├── entrypoint.sh              # Script de arranque y migración automática
├── requirements.txt           # Dependencias auditadas del ecosistema oficial
└── LICENSE                    # Licencia MIT
```

---

## 🚀 Despliegue y Ejecución con Podman

El proyecto está preparado para ejecutarse de forma aislada y reproducible con **Podman**:

### Requisitos Previos
- [Podman](https://podman.io/) (versión 4 o superior)
- `podman-compose` o `podman compose`

### Paso 1: Clonar el repositorio
```bash
git clone https://github.com/tu-organizacion/telegraph.git
cd telegraph
```

### Paso 2: Configurar variables de entorno
Se proporciona un archivo preconfigurado `.env.example`:
```bash
cp .env.example .env
```

### Paso 3: Levantar los contenedores con Podman

#### Opción A: Usando el script automático (Linux / macOS / WSL)
```bash
chmod +x podman-start.sh
./podman-start.sh
```

#### Opción B: Usando el script en Windows (CMD / PowerShell)
```cmd
podman-start.bat
```

#### Opción C: Comando directo de Podman Compose
```bash
podman compose up --build -d
# O si utilizas podman-compose:
podman-compose up --build -d
```

### Paso 4: Acceder a la Plataforma
Abre tu navegador en:
👉 **[http://localhost:8000](http://localhost:8000)**

---

## 👥 Credenciales de Prueba Creadas Automáticamente

El script de inicialización (`entrypoint.sh`) crea automáticamente los siguientes accesos para facilitar las pruebas iniciales:

| Usuario | Contraseña | Rol |
| :--- | :--- | :--- |
| **admin** | `Admin123456!` | Superusuario / Administrador |
| **developer** | `DevPass123456!` | Programador del equipo |

También puedes registrar nuevos usuarios directamente desde la pantalla de login.

---

## 🧪 Pruebas de Seguridad y DLP

Para comprobar el motor de seguridad en acción:

1. **Intenta enviar una clave SSH en un canal público**:
   ```
   -----BEGIN RSA PRIVATE KEY-----
   MIIEowIBAAKCAQEA0Y...
   ```
   *El sistema interceptará el mensaje inmediatamente, cancelará su difusión y mostrará la alerta en rojo.*

2. **Intenta enviar una cadena de conexión con credenciales**:
   ```
   postgres://admin:mi_clave_secreta_123@db.empresa.com:5432/produccion
   ```
   *El DLP bloqueará el mensaje y te sugerirá enviarlo con un clic como Secreto Efímero.*

3. **Crea un Secreto Efímero**:
   - Pulsa en **"🔒 Secreto Seguro"**.
   - Ingresa una contraseña o token sensible.
   - Activa **"Autodestruir al leer"**.
   - Haz clic en Revelar Secreto con otra cuenta: verás cómo se descifra en memoria y se purga físicamente de la base de datos PostgreSQL.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT** — consulta el archivo [LICENSE](LICENSE) para más detalles.
