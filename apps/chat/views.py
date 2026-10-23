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
from PIL import Image

from apps.chat.models import (
    Workspace, Channel, DirectConversation, Message, 
    EphemeralSecret, Attachment, Sticker
)
from apps.dlp.scanner import DataLossPreventionScanner

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
    target_username = request.POST.get('username')
    target_user = get_object_or_404(User, username=target_username)
    
    if target_user == request.user:
        return JsonResponse({'error': 'No puedes iniciar un DM contigo mismo.'}, status=400)

    # Buscar conversación existente
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

    # Acceso atómico y purga
    payload_encrypted, destroyed = secret.access_and_burn()
    if not payload_encrypted:
        return JsonResponse({
            'error': 'El secreto ya no está disponible.'
        }, status=410)

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
            return redirect('index')
        else:
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
