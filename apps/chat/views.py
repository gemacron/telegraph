import json
import base64
import os
from datetime import timedelta
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import login, authenticate, logout
from django.contrib.auth.models import User
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse, HttpResponseForbidden
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_POST, require_GET
from django.utils import timezone
from django.db import transaction
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from cryptography.fernet import Fernet
import io
import gzip
from django.core.files.base import ContentFile
from PIL import Image

from apps.chat.models import (
    Workspace, Channel, DirectConversation, Message, 
    EphemeralSecret, Attachment, Sticker, UserProfile
)
from apps.dlp.scanner import DataLossPreventionScanner
from apps.audit.services import AuditService

# Derivación de clave simétrica para secretos efímeros en servidor
def get_encryption_cipher():
    # Llave derivada segura de 32 bytes en base64 url-safe
    raw_key = os.getenv('SECRET_ENCRYPTION_KEY', 'vG7s1Ue8Q1fK9W3sM4vP6xZ8rA2dF5hJ7kL9mN1qR3t=')
    if len(raw_key) < 44:
        raw_key = base64.urlsafe_b64encode(raw_key.ljust(32, 'a').encode()[:32]).decode()
    return Fernet(raw_key.encode())

@login_required
def index_view(request):
    """Vista principal de la plataforma colaborativa estilo Discord."""
    # Asegurar existencia de workspace y canales iniciales si está vacío
    workspace = Workspace.objects.first()
    if not workspace:
        workspace = Workspace.objects.create(
            name="DevCore Principal",
            slug="devcore-principal",
            description="Espacio de trabajo seguro para desarrollo de software"
        )
        workspace.members.add(request.user)
        Channel.objects.create(workspace=workspace, name="general", topic="Discusión general del equipo")
        Channel.objects.create(workspace=workspace, name="codigo-python", topic="Revisión de arquitectura y código Python")
        Channel.objects.create(workspace=workspace, name="seguridad-dlp", topic="Auditorías y alertas de fuga de datos")

    active_channel = workspace.channels.first()
    return redirect('channel_view', channel_id=active_channel.id)

@login_required
def channel_view(request, channel_id):
    """Vista de un canal específico dentro de un workspace."""
    channel = get_object_or_404(Channel, id=channel_id)
    workspace = channel.workspace
    
    # Canales del workspace
    channels = workspace.channels.all()
    
    # Conversaciones directas (DMs) del usuario
    direct_conversations = request.user.direct_conversations.all()
    
    # Mensajes recientes (últimos 50)
    messages = channel.messages.select_related('author').prefetch_related('attachments').order_by('created_at')[:50]
    
    # Secretos efímeros activos en el canal
    active_secrets = channel.ephemeral_secrets.filter(
        is_destroyed=False,
        expires_at__gt=timezone.now()
    ).select_related('author')

    # Miembros del workspace
    members = workspace.members.all()
    if not members.exists():
        workspace.members.add(request.user)
        members = workspace.members.all()

    stickers = Sticker.objects.all()

    context = {
        'workspace': workspace,
        'active_channel': channel,
        'channels': channels,
        'direct_conversations': direct_conversations,
        'messages': messages,
        'active_secrets': active_secrets,
        'members': members,
        'stickers': stickers,
        'room_id': str(channel.id),
        'is_direct': False,
    }
    return render(request, 'chat/discord_app.html', context)

@login_required
def dm_view(request, conversation_id):
    """Vista de mensajes directos 1 a 1 entre programadores."""
    conversation = get_object_or_404(DirectConversation, id=conversation_id, participants=request.user)
    other_user = conversation.get_other_participant(request.user)
    workspace = Workspace.objects.first()
    channels = workspace.channels.all() if workspace else []

    direct_conversations = request.user.direct_conversations.all()
    messages = conversation.messages.select_related('author').order_by('created_at')[:50]
    
    active_secrets = conversation.ephemeral_secrets.filter(
        is_destroyed=False,
        expires_at__gt=timezone.now()
    ).select_related('author')

    context = {
        'workspace': workspace,
        'active_conversation': conversation,
        'other_user': other_user,
        'channels': channels,
        'direct_conversations': direct_conversations,
        'messages': messages,
        'active_secrets': active_secrets,
        'members': workspace.members.all() if workspace else [],
        'room_id': str(conversation.id),
        'is_direct': True,
    }
    return render(request, 'chat/discord_app.html', context)

@login_required
@require_POST
def start_dm_view(request):
    """Inicia o busca un chat directo individual con otro usuario."""
    target_username = request.POST.get('username', '').strip()
    target_user = User.objects.filter(username__iexact=target_username).first()
    
    if not target_user:
        return redirect(request.META.get('HTTP_REFERER', 'index'))

    if target_user == request.user:
        return redirect(request.META.get('HTTP_REFERER', 'index'))

    # Buscar conversación existente entre ambos
    conversation = DirectConversation.objects.filter(participants=request.user).filter(participants=target_user).first()
    if not conversation:
        conversation = DirectConversation.objects.create()
        conversation.participants.add(request.user, target_user)

    return redirect('dm_view', conversation_id=conversation.id)

@login_required
@require_POST
def create_ephemeral_secret_api(request):
    """
    Crea un secreto efímero autodestructible (contraseña, token, secret key).
    El contenido se cifra en memoria y se almacena en PostgreSQL con TTL y burn-on-read.
    """
    try:
        data = json.loads(request.body.decode('utf-8'))
    except Exception:
        return JsonResponse({'error': 'Payload JSON inválido'}, status=400)

    secret_content = data.get('secret_content', '').strip()
    title = data.get('title', 'Credencial / Secreto de Desarrollo').strip()
    ttl_minutes = int(data.get('ttl_minutes', 60))
    burn_on_read = bool(data.get('burn_on_read', True))
    room_id = data.get('room_id')

    if not secret_content:
        return JsonResponse({'error': 'El contenido del secreto no puede estar vacío.'}, status=400)

    # Cifrar payload con Fernet
    cipher = get_encryption_cipher()
    encrypted_bytes = cipher.encrypt(secret_content.encode('utf-8'))
    encrypted_payload = encrypted_bytes.decode('utf-8')

    expires_at = timezone.now() + timedelta(minutes=ttl_minutes)

    channel = Channel.objects.filter(id=room_id).first()
    direct_conv = None if channel else DirectConversation.objects.filter(id=room_id).first()

    secret = EphemeralSecret.objects.create(
        channel=channel,
        direct_conversation=direct_conv,
        author=request.user,
        title=title,
        encrypted_payload=encrypted_payload,
        burn_on_read=burn_on_read,
        expires_at=expires_at
    )

    # Registro forense en PostgreSQL
    AuditService.log(
        event_type='SECRET_CREATED',
        actor=request.user,
        severity='INFO',
        request=request,
        details={
            'secret_id': str(secret.id),
            'title': secret.title,
            'burn_on_read': secret.burn_on_read,
            'ttl_minutes': ttl_minutes,
            'expires_at': secret.expires_at.strftime("%Y-%m-%d %H:%M:%S UTC"),
            'room_id': str(room_id)
        }
    )

    # Notificar a la sala por WebSocket para renderizar la tarjeta autodestructible
    channel_layer = get_channel_layer()
    if channel_layer:
        async_to_sync(channel_layer.group_send)(
            f"chat_{room_id}",
            {
                'type': 'secret_notification',
                'payload': {
                    'secret_id': str(secret.id),
                    'title': secret.title,
                    'author': request.user.username,
                    'burn_on_read': secret.burn_on_read,
                    'expires_at': secret.expires_at.strftime("%H:%M:%S UTC"),
                    'created_at': secret.created_at.strftime("%H:%M")
                }
            }
        )

    return JsonResponse({
        'status': 'success',
        'secret_id': str(secret.id),
        'message': 'Secreto efímero creado y cifrado exitosamente.'
    })

@login_required
@require_POST
def reveal_ephemeral_secret_api(request, secret_id):
    """
    Revela un secreto efímero y ejecuta la autodestrucción atómica (Burn-After-Reading).
    Una vez revelado, se borra irreversiblemente de PostgreSQL.
    """
    secret = EphemeralSecret.objects.filter(id=secret_id).first()
    if not secret or secret.is_destroyed or secret.is_expired():
        return JsonResponse({
            'error': 'Este secreto ya ha sido destruido o expiró permanentemente por políticas de seguridad.'
        }, status=410)

    author_username = secret.author.username
    secret_title = secret.title

    # Acceso atómico y purga
    payload_encrypted, destroyed = secret.access_and_burn()
    if not payload_encrypted:
        return JsonResponse({
            'error': 'El secreto ya no está disponible.'
        }, status=410)

    # Registro de auditoría del acceso y autodestrucción
    AuditService.log(
        event_type='SECRET_REVEALED',
        actor=request.user,
        severity='WARNING' if destroyed else 'INFO',
        request=request,
        details={
            'secret_id': str(secret_id),
            'title': secret_title,
            'author': author_username,
            'purged_from_postgresql': destroyed
        }
    )

    # Descifrado en memoria
    try:
        cipher = get_encryption_cipher()
        decrypted_content = cipher.decrypt(payload_encrypted.encode('utf-8')).decode('utf-8')
    except Exception:
        return JsonResponse({'error': 'Fallo al descifrar el secreto.'}, status=500)

    return JsonResponse({
        'status': 'success',
        'content': decrypted_content,
        'was_destroyed': destroyed,
        'message': 'Secreto revelado. El registro ha sido purgado de PostgreSQL.' if destroyed else 'Secreto revelado.'
    })

@login_required
@require_POST
def upload_attachment_api(request):
    """
    Manejo seguro de subida de imágenes, iconos y stickers.
    Verifica con Pillow los bytes reales para evitar ejecución de scripts maliciosos.
    """
    file_obj = request.FILES.get('file')
    room_id = request.POST.get('room_id')

    if not file_obj:
        return JsonResponse({'error': 'No se proporcionó ningún archivo'}, status=400)

    # Comprobación de seguridad con Pillow
    is_image = False
    try:
        img = Image.open(file_obj)
        img.verify()
        file_obj.seek(0)
        is_image = True
    except Exception:
        return JsonResponse({'error': 'Archivo de imagen inválido o corrupto.'}, status=400)

    channel = Channel.objects.filter(id=room_id).first()
    direct_conv = None if channel else DirectConversation.objects.filter(id=room_id).first()

    msg = Message.objects.create(
        channel=channel,
        direct_conversation=direct_conv,
        author=request.user,
        content=f"Adjunto: {file_obj.name}"
    )

    attachment = Attachment.objects.create(
        message=msg,
        file=file_obj,
        filename=file_obj.name,
        content_type=file_obj.content_type,
        file_size_bytes=file_obj.size,
        is_image=is_image
    )

    # Difusión por WebSocket
    channel_layer = get_channel_layer()
    if channel_layer:
        async_to_sync(channel_layer.group_send)(
            f"chat_{room_id}",
            {
                'type': 'chat_message',
                'payload': {
                    'id': str(msg.id),
                    'content': msg.content,
                    'sender': request.user.username,
                    'is_code': False,
                    'created_at': msg.created_at.strftime("%H:%M"),
                    'attachment_url': attachment.file.url,
                    'is_image': attachment.is_image
                }
            }
        )

    return JsonResponse({'status': 'success', 'url': attachment.file.url})

# Vistas de autenticación local sin dependencias externas
def login_view(request):
    if request.user.is_authenticated:
        return redirect('index')

    error = None
    if request.method == 'POST':
        u = request.POST.get('username')
        p = request.POST.get('password')
        user = authenticate(request, username=u, password=p)
        if user:
            login(request, user)
            AuditService.log(
                event_type='AUTH_LOGIN_SUCCESS',
                actor=user,
                severity='INFO',
                request=request,
                details={'username': user.username}
            )
            return redirect('index')
        else:
            AuditService.log(
                event_type='AUTH_LOGIN_FAILED',
                actor=None,
                severity='WARNING',
                request=request,
                details={'attempted_username': u}
            )
            error = "Credenciales incorrectas."

    return render(request, 'auth/login.html', {'error': error})

def register_view(request):
    if request.user.is_authenticated:
        return redirect('index')

    error = None
    if request.method == 'POST':
        u = request.POST.get('username', '').strip()
        p = request.POST.get('password', '').strip()
        p2 = request.POST.get('password2', '').strip()

        if not u or not p:
            error = "Todos los campos son obligatorios."
        elif p != p2:
            error = "Las contraseñas no coinciden."
        elif len(p) < 8:
            error = "La contraseña debe tener al menos 8 caracteres."
        elif User.objects.filter(username=u).exists():
            error = "El nombre de usuario ya está registrado."
        else:
            user = User.objects.create_user(username=u, password=p)
            login(request, user)
            # Agregar al workspace principal
            ws = Workspace.objects.first()
            if ws:
                ws.members.add(user)
            return redirect('index')

    return render(request, 'auth/register.html', {'error': error})

def logout_view(request):
    logout(request)
    return redirect('login')

@login_required
@require_POST
def update_profile_view(request):
    """
    Actualiza el perfil del usuario estilo Discord:
    Nombre para mostrar, bio, estado, color de banner y subida de avatar verificada con Pillow.
    """
    user = request.user
    profile, _ = UserProfile.objects.get_or_create(user=user)

    display_name = request.POST.get('display_name', '').strip()
    bio = request.POST.get('bio', '').strip()
    custom_status = request.POST.get('custom_status', '').strip()
    banner_color = request.POST.get('banner_color', '#5865f2').strip()
    avatar_file = request.FILES.get('avatar')

    if display_name:
        profile.display_name = display_name[:80]
    profile.bio = bio[:300]
    profile.custom_status = custom_status[:120]
    if banner_color and banner_color.startswith('#'):
        profile.banner_color = banner_color[:7]

    # Procesamiento y validación segura de Avatar con Pillow
    if avatar_file:
        try:
            img = Image.open(avatar_file)
            img.verify()
            avatar_file.seek(0)
            
            # Reabrir para redimensionar de forma óptima
            img = Image.open(avatar_file)
            img = img.convert('RGB')
            img.thumbnail((256, 256), Image.Resampling.LANCZOS)
            
            output = io.BytesIO()
            img.save(output, format='JPEG', quality=90)
            output.seek(0)
            
            profile.avatar.save(
                f"avatar_{user.id}.jpg",
                ContentFile(output.read()),
                save=False
            )
        except Exception:
            return JsonResponse({'error': 'La imagen de avatar no es válida o está corrupta.'}, status=400)

    profile.save()

    # Cambio opcional de contraseña si se solicita
    new_password = request.POST.get('new_password', '').strip()
    if new_password:
        if len(new_password) < 8:
            return JsonResponse({'error': 'La nueva contraseña debe tener al menos 8 caracteres.'}, status=400)
        user.set_password(new_password)
        user.save()
        login(request, user)  # Mantener sesión activa tras cambio

    if request.headers.get('x-requested-with') == 'XMLHttpRequest' or request.content_type == 'application/json':
        return JsonResponse({
            'status': 'success',
            'display_name': profile.get_display_name(),
            'custom_status': profile.custom_status,
            'bio': profile.bio,
            'banner_color': profile.banner_color,
            'avatar_url': profile.get_avatar_url() or ''
        })

    return redirect(request.META.get('HTTP_REFERER', 'index'))

@login_required
@require_GET
def get_user_profile_api(request, username):
    """
    Retorna la información del perfil para renderizar la Tarjeta de Perfil emergente (Popout Card) estilo Discord.
    """
    target_user = get_object_or_404(User, username=username)
    profile, _ = UserProfile.objects.get_or_create(user=target_user)

    return JsonResponse({
        'username': target_user.username,
        'display_name': profile.get_display_name(),
        'custom_status': profile.custom_status,
        'bio': profile.bio,
        'banner_color': profile.banner_color,
        'avatar_url': profile.get_avatar_url(),
        'date_joined': target_user.date_joined.strftime("%d %b %Y"),
    })

@login_required
@require_GET
def list_stickers_api(request):
    """Retorna la lista de stickers disponibles agrupados por categoría con soporte animado Telegram."""
    stickers = Sticker.objects.all().order_by('category', 'name')
    data = []
    for s in stickers:
        data.append({
            'id': str(s.id),
            'name': s.name,
            'category': s.category,
            'url': s.get_image_url(),
            'is_animated': s.is_animated,
            'animation_type': s.animation_type,
            'lottie_json': s.lottie_json if s.animation_type in ('lottie', 'tgs') else "",
        })
    return JsonResponse({'status': 'success', 'stickers': data})

@login_required
@require_POST
def upload_sticker_api(request):
    """
    Soporte multi-formato seguro para stickers de Telegram y comunidad:
    - .tgs (Stickers animados de Telegram basados en Lottie gzip)
    - .json (Animaciones vectoriales Lottie estándar)
    - .webm (Video stickers de Telegram con transparencia)
    - .webp, .png, .gif, .jpg (Stickers estáticos o animados procesados con Pillow)
    """
    file_obj = request.FILES.get('sticker_file')
    name = request.POST.get('name', 'Custom Sticker').strip()
    category = request.POST.get('category', 'Telegram & Equipo').strip()

    if not file_obj:
        return JsonResponse({'error': 'No se proporcionó archivo de sticker.'}, status=400)

    filename_lower = file_obj.name.lower()
    raw_bytes = file_obj.read()
    file_obj.seek(0)

    try:
        # 1. Telegram Animated Sticker (.tgs - gzip compressed Lottie JSON)
        if filename_lower.endswith('.tgs') or (len(raw_bytes) > 2 and raw_bytes[:2] == b'\x1f\x8b'):
            try:
                decompressed = gzip.decompress(raw_bytes).decode('utf-8')
                lottie_dict = json.loads(decompressed)
                # Validar campos básicos de estructura Lottie
                if 'v' in lottie_dict or 'layers' in lottie_dict:
                    sticker = Sticker(
                        name=name[:50],
                        category=category[:50],
                        is_animated=True,
                        animation_type='tgs',
                        lottie_json=decompressed
                    )
                    sticker.image.save(f"tgs_{uuid.uuid4().hex[:8]}.tgs", ContentFile(raw_bytes), save=True)
                    AuditService.log(
                        event_type='ATTACHMENT_UPLOADED',
                        actor=request.user,
                        severity='INFO',
                        request=request,
                        details={'type': 'telegram_tgs_sticker', 'name': sticker.name}
                    )
                    return JsonResponse({
                        'status': 'success',
                        'id': str(sticker.id),
                        'name': sticker.name,
                        'category': sticker.category,
                        'url': sticker.get_image_url(),
                        'is_animated': True,
                        'animation_type': 'tgs',
                        'lottie_json': sticker.lottie_json
                    })
            except Exception as e:
                return JsonResponse({'error': 'El archivo .tgs no es una animación válida de Telegram.'}, status=400)

        # 2. Lottie Vector Sticker (.json)
        if filename_lower.endswith('.json'):
            try:
                json_str = raw_bytes.decode('utf-8')
                lottie_dict = json.loads(json_str)
                if 'v' in lottie_dict or 'layers' in lottie_dict:
                    sticker = Sticker(
                        name=name[:50],
                        category=category[:50],
                        is_animated=True,
                        animation_type='lottie',
                        lottie_json=json_str
                    )
                    sticker.image.save(f"lottie_{uuid.uuid4().hex[:8]}.json", ContentFile(raw_bytes), save=True)
                    return JsonResponse({
                        'status': 'success',
                        'id': str(sticker.id),
                        'name': sticker.name,
                        'category': sticker.category,
                        'url': sticker.get_image_url(),
                        'is_animated': True,
                        'animation_type': 'lottie',
                        'lottie_json': sticker.lottie_json
                    })
            except Exception:
                return JsonResponse({'error': 'El archivo JSON no tiene un formato Lottie válido.'}, status=400)

        # 3. Telegram Video Sticker (.webm)
        if filename_lower.endswith('.webm'):
            if len(raw_bytes) > 10 * 1024 * 1024:
                return JsonResponse({'error': 'El video sticker no debe superar los 10MB.'}, status=400)
            sticker = Sticker(
                name=name[:50],
                category=category[:50],
                is_animated=True,
                animation_type='webm'
            )
            sticker.image.save(f"webm_{uuid.uuid4().hex[:8]}.webm", ContentFile(raw_bytes), save=True)
            return JsonResponse({
                'status': 'success',
                'id': str(sticker.id),
                'name': sticker.name,
                'category': sticker.category,
                'url': sticker.get_image_url(),
                'is_animated': True,
                'animation_type': 'webm',
                'lottie_json': ''
            })

        # 4. Formatos de imagen tradicionales (PNG, WebP, GIF, JPG)
        img = Image.open(file_obj)
        img.verify()
        file_obj.seek(0)
        
        img = Image.open(file_obj)
        is_gif_animated = getattr(img, "is_animated", False)
        
        if is_gif_animated or filename_lower.endswith('.gif'):
            sticker = Sticker(
                name=name[:50], 
                category=category[:50],
                is_animated=True,
                animation_type='gif'
            )
            sticker.image.save(f"anim_{uuid.uuid4().hex[:8]}.gif", ContentFile(raw_bytes), save=True)
        else:
            img = img.convert('RGBA')
            img.thumbnail((256, 256), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format='WEBP', quality=90)
            buf.seek(0)
            sticker = Sticker(
                name=name[:50], 
                category=category[:50],
                is_animated=False,
                animation_type=''
            )
            sticker.image.save(f"custom_{uuid.uuid4().hex[:8]}.webp", ContentFile(buf.read()), save=True)
        
        AuditService.log(
            event_type='ATTACHMENT_UPLOADED',
            actor=request.user,
            severity='INFO',
            request=request,
            details={'type': 'sticker', 'name': sticker.name, 'category': sticker.category}
        )

        return JsonResponse({
            'status': 'success',
            'id': str(sticker.id),
            'name': sticker.name,
            'category': sticker.category,
            'url': sticker.get_image_url(),
            'is_animated': sticker.is_animated,
            'animation_type': sticker.animation_type,
            'lottie_json': sticker.lottie_json
        })
    except Exception as e:
        return JsonResponse({'error': f'Error procesando sticker: {str(e)}'}, status=400)


