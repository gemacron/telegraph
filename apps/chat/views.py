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
from apps.chat.presence import PresenceService
from apps.dlp.scanner import DataLossPreventionScanner
from apps.audit.services import AuditService

# Derivación de clave simétrica para secretos efímeros en servidor
def get_encryption_cipher():
    # Llave derivada segura de 32 bytes en base64 url-safe
    raw_key = os.getenv('SECRET_ENCRYPTION_KEY', 'vG7s1Ue8Q1fK9W3sM4vP6xZ8rA2dF5hJ7kL9mN1qR3t=')
    if len(raw_key) < 44:
        raw_key = base64.urlsafe_b64encode(raw_key.ljust(32, 'a').encode()[:32]).decode()
    return Fernet(raw_key.encode())

def get_accessible_channels(user, workspace):
    """
    Retorna únicamente los canales que el usuario tiene permiso de ver:
    - Superusuarios y Administradores de workspace ven todos los canales.
    - Miembros ven canales generales (is_general=True),
      canales donde son miembros (members=user) o encargados (managers=user).
    Todo lo demás es 100% invisible.
    """
    if not workspace:
        return Channel.objects.none()
    if user.is_superuser or (hasattr(user, 'profile') and user.profile.is_workspace_admin()):
        return workspace.channels.all().order_by('-is_general', 'name')
    from django.db.models import Q
    return workspace.channels.filter(
        Q(is_general=True) |
        Q(members=user) |
        Q(managers=user)
    ).distinct().order_by('-is_general', 'name')

@login_required
def index_view(request):
    """Vista principal de la plataforma colaborativa Telegraph."""
    workspace = Workspace.objects.first()
    if not workspace:
        workspace = Workspace.objects.create(
            name="Telegraph Engineering",
            slug="telegraph-engineering",
            description="Espacio de trabajo seguro para desarrollo de software"
        )
        workspace.members.add(request.user)
        ch_gen = Channel.objects.create(workspace=workspace, name="general", topic="Conversación general del equipo", is_general=True)
        ch_gen.managers.add(request.user)
        ch_gen.members.add(request.user)

    accessible = get_accessible_channels(request.user, workspace)
    first_channel = accessible.first()
    if not first_channel:
        first_channel, _ = Channel.objects.get_or_create(workspace=workspace, name="general", defaults={'is_general': True})
        first_channel.members.add(request.user)

    return redirect('channel_view', channel_id=first_channel.id)

@login_required
def channel_view(request, channel_id):
    """Vista de un canal específico dentro de un workspace."""
    channel = get_object_or_404(Channel, id=channel_id)
    workspace = channel.workspace

    # Comprobar permisos con can_view
    if not channel.can_view(request.user):
        # Redirección transparente y limpia al primer canal accesible (sin error brusco)
        accessible = get_accessible_channels(request.user, workspace)
        first_ch = accessible.first()
        if first_ch and first_ch.id != channel.id:
            return redirect('channel_view', channel_id=first_ch.id)
        return redirect('index')

    channels = get_accessible_channels(request.user, workspace)
    direct_conversations = request.user.direct_conversations.all()
    messages = channel.messages.select_related('author').prefetch_related('attachments').order_by('created_at')[:50]
    
    active_secrets = channel.ephemeral_secrets.filter(
        is_destroyed=False,
        expires_at__gt=timezone.now()
    ).select_related('author')

    # Miembros visibles para este canal y estado de presencia
    online_user_ids = PresenceService.get_online_user_ids()
    online_user_ids.add(request.user.id)

    if channel.is_general:
        members_qs = workspace.members.select_related('profile').all()
    else:
        from django.db.models import Q
        members_qs = User.objects.filter(Q(channel_memberships=channel) | Q(managed_channels=channel)).distinct().select_related('profile')

    user_status_map = {}
    for m in members_qs:
        is_conn = m.id in online_user_ids
        st = PresenceService.get_user_status(m.id, is_connected=is_conn)
        m.effective_status = st
        user_status_map[str(m.id)] = st

    online_members = [m for m in members_qs if m.effective_status != 'offline']
    offline_members = [m for m in members_qs if m.effective_status == 'offline']

    for dm in direct_conversations:
        other_p = dm.get_other_participant(request.user)
        if other_p:
            dm.other_status = PresenceService.get_user_status(other_p.id, is_connected=(other_p.id in online_user_ids))
            user_status_map[str(other_p.id)] = dm.other_status

    stickers = Sticker.objects.all()

    is_channel_manager = channel.can_manage(request.user)
    is_workspace_admin = request.user.profile.is_workspace_admin() if hasattr(request.user, 'profile') else request.user.is_superuser

    context = {
        'workspace': workspace,
        'active_channel': channel,
        'channels': channels,
        'direct_conversations': direct_conversations,
        'messages': messages,
        'active_secrets': active_secrets,
        'members': members_qs,
        'online_members': online_members,
        'offline_members': offline_members,
        'online_user_ids': list(online_user_ids),
        'user_status_map': user_status_map,
        'user_status_json': json.dumps(user_status_map),
        'stickers': stickers,
        'room_id': str(channel.id),
        'is_direct': False,
        'is_channel_manager': is_channel_manager,
        'is_workspace_admin': is_workspace_admin,
    }
    return render(request, 'chat/telegraph_app.html', context)

@login_required
def dm_view(request, conversation_id):
    """Vista de mensajes directos 1 a 1 entre programadores."""
    conversation = get_object_or_404(DirectConversation, id=conversation_id, participants=request.user)
    other_user = conversation.get_other_participant(request.user)
    workspace = Workspace.objects.first()
    channels = get_accessible_channels(request.user, workspace)

    direct_conversations = request.user.direct_conversations.all()
    messages = conversation.messages.select_related('author').prefetch_related('attachments').order_by('created_at')[:50]
    
    active_secrets = conversation.ephemeral_secrets.filter(
        is_destroyed=False,
        expires_at__gt=timezone.now()
    ).select_related('author')

    is_workspace_admin = request.user.profile.is_workspace_admin() if hasattr(request.user, 'profile') else request.user.is_superuser

    online_user_ids = PresenceService.get_online_user_ids()
    online_user_ids.add(request.user.id)

    user_status_map = {}
    members_all = workspace.members.select_related('profile').all() if workspace else []
    for m in members_all:
        is_conn = m.id in online_user_ids
        st = PresenceService.get_user_status(m.id, is_connected=is_conn)
        m.effective_status = st
        user_status_map[str(m.id)] = st

    for dm in direct_conversations:
        other_p = dm.get_other_participant(request.user)
        if other_p:
            dm.other_status = PresenceService.get_user_status(other_p.id, is_connected=(other_p.id in online_user_ids))
            user_status_map[str(other_p.id)] = dm.other_status

    other_status = PresenceService.get_user_status(other_user.id, is_connected=(other_user.id in online_user_ids)) if other_user else 'offline'
    other_user_is_online = (other_status != 'offline')

    context = {
        'workspace': workspace,
        'active_conversation': conversation,
        'other_user': other_user,
        'other_status': other_status,
        'other_user_is_online': other_user_is_online,
        'channels': channels,
        'direct_conversations': direct_conversations,
        'messages': messages,
        'active_secrets': active_secrets,
        'members': members_all,
        'online_user_ids': list(online_user_ids),
        'user_status_map': user_status_map,
        'user_status_json': json.dumps(user_status_map),
        'room_id': str(conversation.id),
        'is_direct': True,
        'is_channel_manager': False,
        'is_workspace_admin': is_workspace_admin,
    }
    return render(request, 'chat/telegraph_app.html', context)

@login_required
@require_POST
def create_channel_api(request):
    """
    Creación de canal restringida a Administradores Generales de Workspace.
    Permite definir nombre, tema, encargado principal y miembros iniciales.
    """
    user = request.user
    is_admin = user.is_superuser or (hasattr(user, 'profile') and user.profile.is_workspace_admin())
    if not is_admin:
        return JsonResponse({'status': 'error', 'message': 'Solo los administradores pueden crear canales.'}, status=403)

    workspace = Workspace.objects.first()
    if not workspace:
        return JsonResponse({'status': 'error', 'message': 'No existe un espacio de trabajo activo.'}, status=400)

    try:
        data = json.loads(request.body.decode('utf-8')) if request.body else request.POST
    except Exception:
        data = request.POST

    raw_name = str(data.get('name', '')).strip().lower()
    import re
    clean_name = re.sub(r'[^a-z0-9-_]', '', raw_name.replace(' ', '-'))[:80]
    topic = str(data.get('topic', '')).strip()[:255]
    manager_id = data.get('manager_id')
    raw_is_private = data.get('is_private')
    if isinstance(raw_is_private, str):
        is_private = raw_is_private.lower() in ['true', '1', 'private']
    elif raw_is_private is None:
        is_private = True
    else:
        is_private = bool(raw_is_private)

    member_ids = data.get('member_ids', [])
    if isinstance(member_ids, str):
        member_ids = [m.strip() for m in member_ids.split(',') if m.strip()]

    if not clean_name:
        return JsonResponse({'status': 'error', 'message': 'El nombre del canal no es válido.'}, status=400)

    if Channel.objects.filter(workspace=workspace, name=clean_name).exists():
        return JsonResponse({'status': 'error', 'message': f'Ya existe un canal llamado #{clean_name}.'}, status=400)

    channel = Channel.objects.create(
        workspace=workspace,
        name=clean_name,
        topic=topic,
        created_by=user,
        is_general=False,
        is_private=is_private
    )

    # El creador siempre forma parte del canal
    channel.managers.add(user)
    channel.members.add(user)

    # Asignar encargado seleccionado si se indicó uno específico
    if manager_id:
        mgr = User.objects.filter(id=manager_id).first()
        if mgr:
            channel.managers.add(mgr)
            channel.members.add(mgr)

    # Asignar miembros iniciales
    if is_private:
        if member_ids:
            members_to_add = User.objects.filter(id__in=member_ids)
            channel.members.add(*members_to_add)
    else:
        # En canales públicos, todos los miembros actuales del workspace tienen acceso
        channel.members.add(*workspace.members.all())

    AuditService.log(
        event_type='CHANNEL_CREATED',
        actor=user,
        severity='INFO',
        request=request,
        details={'channel_name': clean_name, 'channel_id': str(channel.id)}
    )

    return JsonResponse({
        'status': 'success',
        'channel_id': str(channel.id),
        'channel_name': channel.name,
        'redirect_url': f'/channels/{channel.id}/'
    })

@login_required
def manage_channel_api(request, channel_id):
    """
    Gestión de miembros y encargados del canal estilo WhatsApp (Agregar, Quitar, Hacer Encargado, Eliminar).
    Solo accesible por los Encargados del canal o Administradores de Workspace.
    """
    channel = get_object_or_404(Channel, id=channel_id)
    if not channel.can_manage(request.user):
        return JsonResponse({'status': 'error', 'message': 'No tienes permisos de administrador en este canal.'}, status=403)

    if request.method == 'GET':
        # Lista de miembros actuales
        members_data = []
        for u in channel.members.select_related('profile').all().order_by('username'):
            members_data.append({
                'id': u.id,
                'username': u.username,
                'display_name': u.profile.get_display_name() if hasattr(u, 'profile') else u.username,
                'avatar_url': u.profile.get_avatar_url() if hasattr(u, 'profile') else None,
                'is_manager': channel.managers.filter(id=u.id).exists(),
                'is_creator': channel.created_by_id == u.id,
            })

        # Lista de usuarios disponibles en el workspace para agregar
        workspace_users = channel.workspace.members.exclude(id__in=channel.members.values_list('id', flat=True)).select_related('profile').order_by('username')
        available_data = []
        for u in workspace_users:
            available_data.append({
                'id': u.id,
                'username': u.username,
                'display_name': u.profile.get_display_name() if hasattr(u, 'profile') else u.username,
                'avatar_url': u.profile.get_avatar_url() if hasattr(u, 'profile') else None,
            })

        return JsonResponse({
            'status': 'success',
            'channel_name': channel.name,
            'topic': channel.topic,
            'is_general': channel.is_general,
            'is_private': channel.is_private,
            'is_creator': channel.created_by_id == request.user.id,
            'members': members_data,
            'available_users': available_data,
        })

    if request.method == 'POST':
        try:
            data = json.loads(request.body.decode('utf-8')) if request.body else request.POST
        except Exception:
            data = request.POST

        action = data.get('action')
        target_user_id = data.get('user_id')

        if action == 'add_member':
            target_user = get_object_or_404(User, id=target_user_id)
            channel.members.add(target_user)
            AuditService.log(
                event_type='CHANNEL_MEMBER_ADDED',
                actor=request.user,
                severity='INFO',
                request=request,
                details={'channel_name': channel.name, 'target_user': target_user.username}
            )
            return JsonResponse({'status': 'success', 'message': f'{target_user.username} añadido al canal.'})

        elif action == 'remove_member':
            target_user = get_object_or_404(User, id=target_user_id)
            if target_user.id == channel.created_by_id and not request.user.is_superuser:
                return JsonResponse({'status': 'error', 'message': 'No se puede remover al creador del canal.'}, status=400)
            channel.members.remove(target_user)
            channel.managers.remove(target_user)
            AuditService.log(
                event_type='CHANNEL_MEMBER_REMOVED',
                actor=request.user,
                severity='INFO',
                request=request,
                details={'channel_name': channel.name, 'target_user': target_user.username}
            )
            return JsonResponse({'status': 'success', 'message': f'{target_user.username} removido del canal.'})

        elif action == 'toggle_manager':
            target_user = get_object_or_404(User, id=target_user_id)
            is_mgr = channel.managers.filter(id=target_user.id).exists()
            if is_mgr:
                channel.managers.remove(target_user)
                msg = f'{target_user.username} ya no es encargado del canal.'
            else:
                channel.managers.add(target_user)
                channel.members.add(target_user)
                msg = f'{target_user.username} ahora es Encargado del canal 👑.'
            AuditService.log(
                event_type='CHANNEL_MANAGER_UPDATED',
                actor=request.user,
                severity='INFO',
                request=request,
                details={'channel_name': channel.name, 'target_user': target_user.username, 'is_manager': not is_mgr}
            )
            return JsonResponse({'status': 'success', 'message': msg, 'is_manager': not is_mgr})

        elif action == 'update_topic':
            new_topic = str(data.get('topic', '')).strip()[:255]
            channel.topic = new_topic
            channel.save(update_fields=['topic'])
            return JsonResponse({'status': 'success', 'message': 'Tema del canal actualizado.'})

        elif action == 'delete_channel':
            if channel.is_general:
                return JsonResponse({'status': 'error', 'message': 'El canal general no puede ser eliminado.'}, status=400)
            is_admin = request.user.is_superuser or (hasattr(request.user, 'profile') and request.user.profile.is_workspace_admin())
            if not is_admin and channel.created_by_id != request.user.id:
                return JsonResponse({'status': 'error', 'message': 'Solo el creador o un Administrador pueden eliminar este canal.'}, status=403)
            ch_name = channel.name
            channel.delete()
            AuditService.log(
                event_type='CHANNEL_DELETED',
                actor=request.user,
                severity='WARNING',
                request=request,
                details={'channel_name': ch_name}
            )
            return JsonResponse({'status': 'success', 'message': f'Canal #{ch_name} eliminado.', 'redirect_url': '/'})

        return JsonResponse({'status': 'error', 'message': 'Acción no reconocida.'}, status=400)

@login_required
@require_GET
def get_workspace_users_api(request):
    """Retorna la lista de todos los usuarios del espacio de trabajo con su nombre y avatar."""
    workspace = Workspace.objects.first()
    if not workspace:
        return JsonResponse({'status': 'success', 'users': []})

    users_data = []
    for u in workspace.members.select_related('profile').all().order_by('username'):
        users_data.append({
            'id': u.id,
            'username': u.username,
            'display_name': u.profile.get_display_name() if hasattr(u, 'profile') else u.username,
            'avatar_url': u.profile.get_avatar_url() if hasattr(u, 'profile') else None,
            'role': u.profile.role if hasattr(u, 'profile') else 'member',
        })
    return JsonResponse({'status': 'success', 'users': users_data})

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

# Vistas de autenticación y doble factor (2FA) TOTP
def login_view(request):
    if request.user.is_authenticated:
        return redirect('index')

    error = None
    if request.method == 'POST':
        u = request.POST.get('username', '').strip()
        p = request.POST.get('password', '').strip()
        user = authenticate(request, username=u, password=p)
        if user:
            profile, _ = UserProfile.objects.get_or_create(user=user)
            if profile.two_factor_enabled:
                # Usuario tiene 2FA habilitado: requerir código TOTP
                request.session['2fa_pending_user_id'] = user.id
                return redirect('login_2fa')

            login(request, user)
            AuditService.log(
                event_type='AUTH_LOGIN_SUCCESS',
                actor=user,
                severity='INFO',
                request=request,
                details={'username': user.username, '2fa_used': False}
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

def login_2fa_view(request):
    if request.user.is_authenticated:
        return redirect('index')

    pending_user_id = request.session.get('2fa_pending_user_id')
    if not pending_user_id:
        return redirect('login')

    user = get_object_or_404(User, id=pending_user_id)
    profile = user.profile
    error = None

    if request.method == 'POST':
        token = request.POST.get('token', '').strip()
        backup_code = request.POST.get('backup_code', '').strip()

        is_valid = False
        method_used = None

        if token:
            if profile.verify_totp(token):
                is_valid = True
                method_used = 'totp'
            else:
                error = "El código de 6 dígitos es incorrecto o ha expirado."
        elif backup_code:
            if profile.verify_and_consume_backup_code(backup_code):
                is_valid = True
                method_used = 'backup_code'
            else:
                error = "El código de respaldo es inválido o ya fue utilizado."
        else:
            error = "Ingresa el código de 6 dígitos o un código de respaldo."

        if is_valid:
            login(request, user)
            request.session.pop('2fa_pending_user_id', None)
            AuditService.log(
                event_type='AUTH_LOGIN_SUCCESS',
                actor=user,
                severity='INFO',
                request=request,
                details={'username': user.username, '2fa_used': True, '2fa_method': method_used}
            )
            return redirect('index')
        else:
            AuditService.log(
                event_type='AUTH_2FA_FAILED',
                actor=user,
                severity='WARNING',
                request=request,
                details={'username': user.username}
            )

    return render(request, 'auth/login_2fa.html', {
        'username': user.username,
        'error': error,
    })

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
            profile, _ = UserProfile.objects.get_or_create(user=user)
            profile.generate_totp_secret(force=True)

            ws = Workspace.objects.first()
            if ws:
                ws.members.add(user)

            request.session['register_pending_user_id'] = user.id
            return redirect('register_2fa')

    return render(request, 'auth/register.html', {'error': error})

def register_2fa_view(request):
    if request.user.is_authenticated:
        return redirect('index')

    pending_user_id = request.session.get('register_pending_user_id')
    if not pending_user_id:
        return redirect('register')

    user = get_object_or_404(User, id=pending_user_id)
    profile = user.profile
    error = None

    if request.method == 'POST':
        token = request.POST.get('token', '').strip()
        if not token:
            error = "Ingresa el código de 6 dígitos mostrado en tu aplicación."
        elif profile.verify_totp(token):
            profile.two_factor_enabled = True
            backup_codes = profile.generate_backup_codes(count=8)
            profile.save()

            login(request, user)
            request.session.pop('register_pending_user_id', None)

            AuditService.log(
                event_type='AUTH_2FA_ENABLED',
                actor=user,
                severity='INFO',
                request=request,
                details={'username': user.username, 'action': 'registered_with_2fa'}
            )
            return render(request, 'auth/register_backup_codes.html', {
                'backup_codes': backup_codes,
                'username': user.username,
                'is_profile_setup': False
            })
        else:
            error = "Código de 6 dígitos inválido. Verifica la hora de tu dispositivo e inténtalo de nuevo."

    return render(request, 'auth/register_2fa.html', {
        'username': user.username,
        'qr_b64': profile.get_qr_code_base64(),
        'totp_secret': profile.totp_secret,
        'totp_uri': profile.get_totp_uri(),
        'error': error,
        'is_profile_setup': False
    })

@login_required
def setup_2fa_view(request):
    profile = request.user.profile
    error = None

    if request.method == 'POST':
        token = request.POST.get('token', '').strip()
        if not token:
            error = "Por favor ingresa el código de 6 dígitos."
        elif profile.verify_totp(token):
            profile.two_factor_enabled = True
            backup_codes = profile.generate_backup_codes(count=8)
            profile.save()

            AuditService.log(
                event_type='AUTH_2FA_ENABLED',
                actor=request.user,
                severity='INFO',
                request=request,
                details={'username': request.user.username}
            )
            return render(request, 'auth/register_backup_codes.html', {
                'backup_codes': backup_codes,
                'username': request.user.username,
                'is_profile_setup': True
            })
        else:
            error = "Código incorrecto. Verifica el token en tu aplicación e intenta nuevamente."

    if not profile.totp_secret:
        profile.generate_totp_secret(force=True)

    return render(request, 'auth/register_2fa.html', {
        'username': request.user.username,
        'qr_b64': profile.get_qr_code_base64(),
        'totp_secret': profile.totp_secret,
        'totp_uri': profile.get_totp_uri(),
        'error': error,
        'is_profile_setup': True
    })

@login_required
@require_POST
def disable_2fa_view(request):
    pwd = request.POST.get('password', '').strip()
    if not request.user.check_password(pwd):
        return JsonResponse({'status': 'error', 'message': 'Contraseña incorrecta.'}, status=400)

    profile = request.user.profile
    profile.two_factor_enabled = False
    profile.totp_secret = ""
    profile.backup_codes = []
    profile.save()

    AuditService.log(
        event_type='AUTH_2FA_DISABLED',
        actor=request.user,
        severity='WARNING',
        request=request,
        details={'username': request.user.username}
    )
    return JsonResponse({'status': 'success', 'message': 'Doble factor desactivado exitosamente.'})

def logout_view(request):
    if request.user.is_authenticated:
        u_id = request.user.id
        u_name = request.user.username
        PresenceService.force_offline(u_id)
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    "telegraph_presence",
                    {
                        'type': 'presence_broadcast',
                        'payload': {
                            'user_id': u_id,
                            'username': u_name,
                            'status': 'offline'
                        }
                    }
                )
        except Exception:
            pass
    logout(request)
    return redirect('login')

@login_required
@require_POST
def update_profile_view(request):
    """
    Actualiza el perfil del usuario en Telegraph:
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

    status_choice = request.POST.get('status_choice', '').strip()
    if status_choice in ['online', 'idle', 'dnd', 'offline']:
        profile.status_choice = status_choice
        PresenceService.set_user_status(user.id, status_choice)
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    "telegraph_presence",
                    {
                        'type': 'presence_broadcast',
                        'payload': {
                            'user_id': user.id,
                            'username': user.username,
                            'display_name': profile.get_display_name(),
                            'status': status_choice
                        }
                    }
                )
        except Exception:
            pass

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
@require_POST
def set_presence_status_api(request):
    """API rápida para alternar el estado de disponibilidad ('online', 'idle', 'dnd', 'offline')."""
    try:
        data = json.loads(request.body.decode('utf-8'))
    except Exception:
        data = request.POST
    status = data.get('status', 'online')
    if status not in ['online', 'idle', 'dnd', 'offline']:
        status = 'online'
    profile = request.user.profile
    profile.status_choice = status
    profile.save(update_fields=['status_choice'])
    PresenceService.set_user_status(request.user.id, status)

    try:
        channel_layer = get_channel_layer()
        if channel_layer:
            async_to_sync(channel_layer.group_send)(
                "telegraph_presence",
                {
                    'type': 'presence_broadcast',
                    'payload': {
                        'user_id': request.user.id,
                        'username': request.user.username,
                        'display_name': profile.get_display_name(),
                        'status': status
                    }
                }
            )
    except Exception:
        pass
    return JsonResponse({'status': 'success', 'presence_status': status})

@login_required
@require_GET
def get_user_profile_api(request, username):
    """
    Retorna la información del perfil para renderizar la Tarjeta de Perfil emergente (Popout Card) en Telegraph.
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


