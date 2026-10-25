import uuid
from django.db import models, transaction
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.contrib.auth.models import User
from django.utils import timezone
from django.utils.html import escape
from django.core.exceptions import ValidationError
from pygments import highlight
from pygments.lexers import get_lexer_by_name, guess_lexer, TextLexer
from pygments.formatters import HtmlFormatter

class UserProfile(models.Model):
    """
    Perfil de usuario estilo Telegraph:
    Manejo de avatar, display_name, biografía (about me), estado personalizado y color de banner.
    """
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    display_name = models.CharField(max_length=80, blank=True, default="")
    bio = models.TextField(max_length=300, blank=True, default="Desarrollador en Telegraph")
    custom_status = models.CharField(max_length=120, blank=True, default="Programando 💻")
    avatar = models.ImageField(upload_to="avatars/%Y/%m/", null=True, blank=True)
    banner_color = models.CharField(max_length=7, default="#5865f2")
    ROLE_CHOICES = [
        ('admin', 'Administrador General'),
        ('member', 'Miembro Estándar'),
    ]
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default='member')
    two_factor_enabled = models.BooleanField(default=False)
    totp_secret = models.CharField(max_length=64, blank=True, default="")
    backup_codes = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def is_workspace_admin(self):
        """Retorna True si el usuario tiene privilegios de administrador general o superusuario."""
        return self.role == 'admin' or self.user.is_superuser or self.user.is_staff

    def get_display_name(self):
        return self.display_name.strip() if self.display_name else self.user.username

    def get_avatar_url(self):
        if self.avatar and hasattr(self.avatar, 'url'):
            return self.avatar.url
        return None

    def generate_totp_secret(self, force=False):
        """Genera un nuevo secreto base32 para TOTP si no existe."""
        import pyotp
        if not self.totp_secret or force:
            self.totp_secret = pyotp.random_base32()
            self.save(update_fields=['totp_secret'])
        return self.totp_secret

    def get_totp_uri(self):
        """Genera el URI estándar otpauth:// compatible con Google Authenticator."""
        import pyotp
        if not self.totp_secret:
            self.generate_totp_secret()
        totp = pyotp.TOTP(self.totp_secret)
        return totp.provisioning_uri(
            name=self.user.username,
            issuer_name="Telegraph"
        )

    def get_qr_code_base64(self):
        """Genera un código QR en base64 para incrustar directamente en la vista HTML sin llamadas externas."""
        import qrcode
        import io
        import base64
        uri = self.get_totp_uri()
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=8,
            border=2,
        )
        qr.add_data(uri)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buffered = io.BytesIO()
        img.save(buffered, format="PNG")
        return base64.b64encode(buffered.getvalue()).decode()

    def verify_totp(self, token):
        """Verifica un token de 6 dígitos con ventana de tolerancia ±30 segundos."""
        import pyotp
        if not self.totp_secret or not token:
            return False
        clean_token = str(token).strip().replace(" ", "").replace("-", "")
        totp = pyotp.TOTP(self.totp_secret)
        return totp.verify(clean_token, valid_window=1)

    def generate_backup_codes(self, count=8):
        """Genera un listado de códigos de respaldo de un solo uso."""
        import secrets
        codes = []
        for _ in range(count):
            code = f"{secrets.token_hex(4).upper()}-{secrets.token_hex(4).upper()}"
            codes.append(code)
        self.backup_codes = codes
        self.save(update_fields=['backup_codes'])
        return codes

    def verify_and_consume_backup_code(self, code):
        """Valida y consume de forma segura un código de respaldo."""
        if not code or not self.backup_codes:
            return False
        clean_code = str(code).strip().upper()
        if clean_code in self.backup_codes:
            self.backup_codes.remove(clean_code)
            self.save(update_fields=['backup_codes'])
            return True
        return False

    def __str__(self):
        return f"Perfil de {self.user.username}"

@receiver(post_save, sender=User)
def create_or_save_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.create(user=instance)
    else:
        if not hasattr(instance, 'profile'):
            UserProfile.objects.create(user=instance)
        else:
            instance.profile.save()

class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    slug = models.SlugField(unique=True)
    description = models.TextField(blank=True, default="")
    icon = models.ImageField(upload_to="workspaces/icons/", null=True, blank=True)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="owned_workspaces", null=True, blank=True)
    members = models.ManyToManyField(User, related_name="workspaces", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

class Channel(models.Model):
    CHANNEL_TYPES = [
        ('text', 'Texto y Código'),
        ('announcement', 'Anuncios'),
        ('devops', 'DevOps & Logs'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="channels")
    name = models.CharField(max_length=80)
    topic = models.CharField(max_length=255, blank=True, default="")
    channel_type = models.CharField(max_length=20, choices=CHANNEL_TYPES, default='text')
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="created_channels")
    managers = models.ManyToManyField(User, related_name="managed_channels", blank=True)
    members = models.ManyToManyField(User, related_name="channel_memberships", blank=True)
    is_general = models.BooleanField(default=False)
    is_private = models.BooleanField(default=False)
    allowed_members = models.ManyToManyField(User, related_name="private_channels", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('workspace', 'name')

    def can_view(self, user):
        """
        Un usuario puede ver el canal si:
        - Es superusuario o Administrador general del workspace.
        - O el canal es el canal general (#general).
        - O el usuario es un Encargado (manager) del canal.
        - O el usuario es un Miembro asignado (members) del canal.
        """
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser or user.is_staff:
            return True
        if hasattr(user, 'profile') and user.profile.is_workspace_admin():
            return True
        if self.is_general:
            return True
        if self.managers.filter(id=user.id).exists():
            return True
        if self.members.filter(id=user.id).exists():
            return True
        return False

    def can_manage(self, user):
        """
        Un usuario puede administrar (agregar/quitar miembros, cambiar tema) si:
        - Es superusuario o Administrador general del workspace.
        - O es el creador del canal (created_by).
        - O está en la lista de Encargados (managers) del canal (estilo WhatsApp).
        """
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser or user.is_staff:
            return True
        if hasattr(user, 'profile') and user.profile.is_workspace_admin():
            return True
        if self.created_by_id == user.id:
            return True
        if self.managers.filter(id=user.id).exists():
            return True
        return False

    def __str__(self):
        return f"#{self.name} ({self.workspace.name})"

class DirectConversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participants = models.ManyToManyField(User, related_name="direct_conversations")
    created_at = models.DateTimeField(auto_now_add=True)

    def get_other_participant(self, current_user):
        return self.participants.exclude(id=current_user.id).first()

    def __str__(self):
        users = ", ".join([u.username for u in self.participants.all()[:2]])
        return f"DM: {users}"

class Message(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, null=True, blank=True, related_name="messages")
    direct_conversation = models.ForeignKey(DirectConversation, on_delete=models.CASCADE, null=True, blank=True, related_name="messages")
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sent_messages")
    content = models.TextField(help_text="Texto con soporte de código y markdown")
    
    # Manejo de snippets de código para desarrolladores
    is_code_snippet = models.BooleanField(default=False)
    code_language = models.CharField(max_length=30, blank=True, default="")
    formatted_code_html = models.TextField(blank=True, default="")
    
    # Manejo de Stickers y GIFs locales
    is_sticker = models.BooleanField(default=False)
    sticker = models.ForeignKey('Sticker', on_delete=models.SET_NULL, null=True, blank=True, related_name="messages")
    sticker_image_url = models.CharField(max_length=500, blank=True, default="")
    is_animated_sticker = models.BooleanField(default=False)
    sticker_animation_type = models.CharField(max_length=20, blank=True, default="")
    sticker_lottie_json = models.TextField(blank=True, default="")
    
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['created_at']

    def render_syntax_highlighting(self):
        """Genera HTML resaltado usando Pygments nativo y seguro sin llamadas externas."""
        if not self.is_code_snippet and "```" not in self.content:
            return ""

        code_to_highlight = self.content
        lang = self.code_language.lower().strip() if self.code_language else ""

        # Si viene en bloque tipo ```python ... ```
        if "```" in self.content and not self.is_code_snippet:
            parts = self.content.split("```")
            if len(parts) >= 3:
                first_line_end = parts[1].find("\n")
                if first_line_end != -1:
                    detected_lang = parts[1][:first_line_end].strip()
                    if detected_lang:
                        lang = detected_lang
                    code_to_highlight = parts[1][first_line_end + 1:]
                else:
                    code_to_highlight = parts[1]

        try:
            if lang:
                lexer = get_lexer_by_name(lang, stripall=True)
            else:
                lexer = guess_lexer(code_to_highlight)
        except Exception:
            lexer = TextLexer()

        formatter = HtmlFormatter(
            nowrap=False,
            cssclass="highlight-code",
            linespans="line",
            linenos=True
        )
        return highlight(code_to_highlight, lexer, formatter)

    def save(self, *args, **kwargs):
        if self.is_code_snippet or "```" in self.content:
            self.formatted_code_html = self.render_syntax_highlighting()
        super().save(*args, **kwargs)

    def __str__(self):
        dest = self.channel.name if self.channel else "DM"
        return f"[{dest}] {self.author.username}: {self.content[:30]}"

class EphemeralSecret(models.Model):
    """
    Mensaje efímero autodestructible (Burn-After-Reading).
    Permite enviar contraseñas, variables de entorno (.env) o llaves de API
    con borrado físico e irreversible en PostgreSQL tras ser leído o tras expirar.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, null=True, blank=True, related_name="ephemeral_secrets")
    direct_conversation = models.ForeignKey(DirectConversation, on_delete=models.CASCADE, null=True, blank=True, related_name="ephemeral_secrets")
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name="created_secrets")
    title = models.CharField(max_length=120, default="Dato Sensible Confidencial")
    
    # Payload cifrado con criptografía simétrica (Fernet o AES-GCM)
    encrypted_payload = models.TextField(help_text="Payload cifrado en servidor o cliente")
    
    # Políticas de autodestrucción
    burn_on_read = models.BooleanField(default=True, help_text="Destruir inmediatamente al primer acceso")
    max_views = models.PositiveIntegerField(default=1)
    view_count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)
    is_destroyed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def is_expired(self):
        return timezone.now() >= self.expires_at

    @transaction.atomic
    def access_and_burn(self):
        """
        Operación atómica en PostgreSQL:
        Incrementa el contador. Si cumple la condición de quemado o expiración,
        purga el registro de la base de datos de manera irreversible.
        """
        secret_lock = EphemeralSecret.objects.select_for_update().filter(id=self.id).first()
        if not secret_lock or secret_lock.is_destroyed:
            return None, True  # Ya fue destruido

        if secret_lock.is_expired():
            secret_lock.is_destroyed = True
            secret_lock.encrypted_payload = ""
            secret_lock.delete()
            return None, True

        secret_lock.view_count += 1
        payload = secret_lock.encrypted_payload

        # Si es burn_on_read o alcanzó el límite de visualizaciones, se elimina físicamente
        if secret_lock.burn_on_read or secret_lock.view_count >= secret_lock.max_views:
            secret_lock.is_destroyed = True
            secret_lock.encrypted_payload = ""
            secret_lock.delete()
            return payload, True
        else:
            secret_lock.save(update_fields=['view_count'])
            return payload, False

class Sticker(models.Model):
    """Stickers locales y animados estilo Telegram almacenados internamente sin dependencias externas."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=50)
    category = models.CharField(max_length=50, default="Dev")
    image = models.FileField(upload_to="stickers/", blank=True, null=True)
    is_animated = models.BooleanField(default=False)
    animation_type = models.CharField(max_length=20, default="", blank=True)  # 'lottie', 'tgs', 'webm', 'gif'
    lottie_json = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    def get_image_url(self):
        if self.image and hasattr(self.image, 'url'):
            return self.image.url
        return ""

    def __str__(self):
        return f"{self.category}:{self.name}"

class Attachment(models.Model):
    """Archivos adjuntos con validación estricta de seguridad en PostgreSQL."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Message, on_delete=models.CASCADE, null=True, blank=True, related_name="attachments")
    file = models.FileField(upload_to="attachments/%Y/%m/")
    filename = models.CharField(max_length=255, default="")
    content_type = models.CharField(max_length=100)
    file_size_bytes = models.BigIntegerField()
    is_image = models.BooleanField(default=False)
    is_sticker = models.BooleanField(default=False)
    is_local_gif = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def clean(self):
        # Prevención de archivos ejecutables peligrosos (.exe, .sh, .bat, .php, etc.)
        dangerous_extensions = ('.exe', '.sh', '.bat', '.cmd', '.py', '.php', '.phtml', '.js', '.vbs')
        if any(self.file.name.lower().endswith(ext) for ext in dangerous_extensions):
            raise ValidationError("Tipo de archivo no permitido por directiva de seguridad DLP.")

