import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from apps.dlp.scanner import DataLossPreventionScanner
from apps.chat.models import Message, Channel, DirectConversation
from apps.chat.presence import PresenceService
from django.contrib.auth.models import AnonymousUser
from django.utils import timezone

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope.get("user")
        if not self.user or isinstance(self.user, AnonymousUser) or not self.user.is_authenticated:
            await self.close(code=4001)
            return

        self.room_id = self.scope['url_route']['kwargs']['room_id']
        has_access = await self.check_user_access()
        if not has_access:
            await self.close(code=4403)
            return

        self.room_group_name = f"chat_{self.room_id}"
        self.user_group_name = f"user_{self.user.username}"
        self.presence_group_name = "telegraph_presence"

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.channel_layer.group_add(
            self.user_group_name,
            self.channel_name
        )
        await self.channel_layer.group_add(
            self.presence_group_name,
            self.channel_name
        )
        await self.accept()

        # Registrar conexión activa de este socket
        was_offline = await database_sync_to_async(PresenceService.add_connection)(self.user.id, self.channel_name)
        user_status = await database_sync_to_async(PresenceService.get_user_status)(self.user.id, is_connected=True)
        if was_offline:
            display_name, _ = await self.get_user_profile_info()
            await self.channel_layer.group_send(
                self.presence_group_name,
                {
                    'type': 'presence_broadcast',
                    'payload': {
                        'user_id': self.user.id,
                        'username': self.user.username,
                        'display_name': display_name,
                        'status': user_status
                    }
                }
            )

        # Enviar estado actual de presencia al cliente recién conectado con sus estados detallados
        online_ids = await database_sync_to_async(PresenceService.get_online_user_ids)()
        user_statuses = await database_sync_to_async(PresenceService.get_all_user_statuses)(online_ids)
        await self.send(text_data=json.dumps({
            'type': 'presence_init',
            'online_user_ids': list(online_ids),
            'user_statuses': {str(k): v for k, v in user_statuses.items()}
        }))

    @database_sync_to_async
    def check_user_access(self):
        channel = Channel.objects.filter(id=self.room_id).first()
        if channel:
            return channel.can_view(self.user)
        dm = DirectConversation.objects.filter(id=self.room_id).first()
        if dm:
            return dm.participants.filter(id=self.user.id).exists()
        return False

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )
        if hasattr(self, 'user_group_name'):
            await self.channel_layer.group_discard(
                self.user_group_name,
                self.channel_name
            )
        if hasattr(self, 'presence_group_name'):
            await self.channel_layer.group_discard(
                self.presence_group_name,
                self.channel_name
            )

        if hasattr(self, 'user') and self.user and self.user.is_authenticated:
            is_now_offline = await database_sync_to_async(PresenceService.remove_connection)(self.user.id, self.channel_name)
            if is_now_offline:
                await self.channel_layer.group_send(
                    getattr(self, 'presence_group_name', 'telegraph_presence'),
                    {
                        'type': 'presence_broadcast',
                        'payload': {
                            'user_id': self.user.id,
                            'username': self.user.username,
                            'status': 'offline'
                        }
                    }
                )

    @database_sync_to_async
    def save_chat_message(self, content, is_code=False, language="", is_sticker=False, sticker_image_url="", is_animated_sticker=False, sticker_animation_type="", sticker_lottie_json="", reply_to_id=None):
        """Persiste el mensaje de manera asíncrona en PostgreSQL y renderiza Pygments si aplica."""
        channel = Channel.objects.filter(id=self.room_id).first()
        direct_conv = None if channel else DirectConversation.objects.filter(id=self.room_id).first()

        if not channel and not direct_conv:
            return None

        reply_to_msg = None
        if reply_to_id:
            try:
                reply_to_msg = Message.objects.filter(id=reply_to_id).select_related('author', 'author__profile').first()
            except Exception:
                reply_to_msg = None

        msg = Message(
            channel=channel,
            direct_conversation=direct_conv,
            author=self.user,
            content=content,
            is_code_snippet=is_code,
            code_language=language or "",
            is_sticker=is_sticker,
            sticker_image_url=sticker_image_url or "",
            is_animated_sticker=is_animated_sticker,
            sticker_animation_type=sticker_animation_type or "",
            sticker_lottie_json=sticker_lottie_json or "",
            reply_to=reply_to_msg
        )
        msg.save()
        
        avatar_url = ""
        display_name = self.user.username
        if hasattr(self.user, 'profile'):
            avatar_url = self.user.profile.get_avatar_url() or ""
            display_name = self.user.profile.get_display_name()

        reply_to_data = None
        if msg.reply_to:
            r_author_name = msg.reply_to.author.username
            r_display = r_author_name
            if hasattr(msg.reply_to.author, 'profile'):
                r_display = msg.reply_to.author.profile.get_display_name() or r_author_name
            snippet = msg.reply_to.content or ""
            if msg.reply_to.is_sticker:
                snippet = "🎨 Sticker"
            elif msg.reply_to.is_code_snippet:
                snippet = f"💻 Código ({msg.reply_to.code_language or 'snippet'})"
            if len(snippet) > 80:
                snippet = snippet[:80] + "..."
            reply_to_data = {
                "id": str(msg.reply_to.id),
                "author": r_author_name,
                "display_name": r_display,
                "content_snippet": snippet
            }

        return {
            "id": str(msg.id),
            "content": msg.content,
            "sender": self.user.username,
            "display_name": display_name,
            "avatar_url": avatar_url,
            "is_code": msg.is_code_snippet,
            "language": msg.code_language,
            "formatted_code_html": msg.formatted_code_html,
            "is_sticker": msg.is_sticker,
            "sticker_image_url": msg.sticker_image_url,
            "is_animated_sticker": msg.is_animated_sticker,
            "sticker_animation_type": msg.sticker_animation_type,
            "sticker_lottie_json": msg.sticker_lottie_json,
            "reply_to": reply_to_data,
            "reactions": [],
            "created_at": msg.created_at.strftime("%H:%M")
        }

    @database_sync_to_async
    def toggle_reaction_db(self, message_id, emoji):
        from apps.chat.models import MessageReaction
        msg = Message.objects.filter(id=message_id).first()
        if not msg:
            return None
        existing = MessageReaction.objects.filter(message=msg, user=self.user, emoji=emoji).first()
        if existing:
            existing.delete()
            action = "removed"
        else:
            MessageReaction.objects.create(message=msg, user=self.user, emoji=emoji)
            action = "added"
        
        # Devolver resumen de reacciones de este mensaje
        summary = msg.get_grouped_reactions(current_user=self.user)
        return {
            "message_id": str(msg.id),
            "emoji": emoji,
            "action": action,
            "summary": summary
        }

    @database_sync_to_async
    def delete_message_db(self, message_id):
        msg = Message.objects.filter(id=message_id).first()
        if not msg:
            return False
        # Autor o Admin
        is_admin = self.user.is_superuser or self.user.is_staff or (hasattr(self.user, 'profile') and self.user.profile.is_workspace_admin())
        if msg.author_id == self.user.id or is_admin:
            msg.delete()
            return True
        return False

    @database_sync_to_async
    def log_security_audit(self, event_type, severity, details):
        """Registra el evento de forma atómica e inmutable en PostgreSQL."""
        from apps.audit.services import AuditService
        client_ip = self.scope.get('client', ['127.0.0.1'])[0]
        AuditService.log(
            event_type=event_type,
            actor=self.user,
            severity=severity,
            ip_address=client_ip,
            details=details
        )

    @database_sync_to_async
    def get_user_profile_info(self):
        avatar = ""
        display = self.user.username
        try:
            if hasattr(self.user, 'profile'):
                avatar = self.user.profile.get_avatar_url() or ""
                display = self.user.profile.get_display_name() or self.user.username
        except Exception:
            pass
        return display, avatar

    @database_sync_to_async
    def save_user_status_choice(self, status):
        try:
            if hasattr(self.user, 'profile'):
                self.user.profile.status_choice = status
                self.user.profile.save(update_fields=['status_choice'])
        except Exception:
            pass

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        msg_type = data.get('type', 'message')
        content = data.get('content', '')
        is_code = bool(data.get('is_code', False))
        language = data.get('language', '')
        is_sticker = bool(data.get('is_sticker', False))
        sticker_image_url = data.get('sticker_image_url', '')
        is_animated_sticker = bool(data.get('is_animated_sticker', False))
        sticker_animation_type = data.get('sticker_animation_type', '')
        sticker_lottie_json = data.get('sticker_lottie_json', '')

        reply_to_id = data.get('reply_to_id')

        # Manejo de Reacciones a Mensajes (toggle emoji)
        if msg_type == 'toggle_reaction':
            message_id = data.get('message_id')
            emoji = data.get('emoji')
            if message_id and emoji:
                reaction_result = await self.toggle_reaction_db(message_id, emoji)
                if reaction_result:
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'reaction_broadcast',
                            'payload': reaction_result
                        }
                    )
            return

        # Eliminación de Mensaje (autor o admin)
        if msg_type == 'delete_message':
            message_id = data.get('message_id')
            if message_id:
                deleted = await self.delete_message_db(message_id)
                if deleted:
                    await self.channel_layer.group_send(
                        self.room_group_name,
                        {
                            'type': 'message_deleted_broadcast',
                            'payload': {'message_id': message_id}
                        }
                    )
            return

        # Cambio manual o automático de estado de disponibilidad (online, idle, dnd, offline)
        if msg_type == 'set_presence':
            status = data.get('status', 'online')
            if status not in ['online', 'idle', 'dnd', 'offline']:
                status = 'online'
            await database_sync_to_async(PresenceService.set_user_status)(self.user.id, status)
            await self.save_user_status_choice(status)

            display_name, _ = await self.get_user_profile_info()
            await self.channel_layer.group_send(
                self.presence_group_name,
                {
                    'type': 'presence_broadcast',
                    'payload': {
                        'user_id': self.user.id,
                        'username': self.user.username,
                        'display_name': display_name,
                        'status': status
                    }
                }
            )
            return

        # Manejo de Señalización WebRTC para Llamadas de Voz, Videollamadas y Compartir Pantalla
        if msg_type.startswith('webrtc_') or msg_type in ['call_request', 'call_response', 'call_hangup', 'voice_speaking', 'join_call', 'call_peer_state', 'channel_call_broadcast']:
            sender_display, sender_avatar = await self.get_user_profile_info()
            target = data.get('target', '')
            payload = {
                **data,
                'type': msg_type,
                'sender': self.user.username,
                'sender_display': sender_display,
                'sender_avatar': sender_avatar,
                'target': target,
                'call_type': data.get('call_type', 'audio'), # 'audio' o 'video'
                'room_id': self.room_id
            }

            # Si la llamada tiene un destinatario específico (1 a 1), enviarla a su canal personal
            if target and target != self.user.username:
                await self.channel_layer.group_send(
                    f"user_{target}",
                    {
                        'type': 'webrtc_forward',
                        'payload': payload
                    }
                )
            else:
                # Si es llamada grupal o en canal público
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'webrtc_forward',
                        'payload': payload
                    }
                )
            return

        # Si es un sticker directo
        if msg_type == 'sticker' or is_sticker:
            saved_msg = await self.save_chat_message(
                content=content or "Sticker",
                is_sticker=True,
                sticker_image_url=sticker_image_url,
                is_animated_sticker=is_animated_sticker,
                sticker_animation_type=sticker_animation_type,
                sticker_lottie_json=sticker_lottie_json,
                reply_to_id=reply_to_id
            )
            if saved_msg:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'chat_message',
                        'payload': saved_msg
                    }
                )
            return

        # 1. Inspección DLP en tiempo real (anti-fuga de datos)
        dlp_result = DataLossPreventionScanner.scan(content)
        if not dlp_result["is_safe"]:
            # Registrar evento forense en PostgreSQL
            await self.log_security_audit(
                event_type='DLP_VIOLATION_BLOCKED',
                severity='CRITICAL',
                details={
                    'violations': dlp_result["violations"],
                    'room_id': self.room_id,
                    'blocked_characters_count': len(content),
                    'is_code': is_code,
                    'language': language
                }
            )

            await self.send(text_data=json.dumps({
                "type": "dlp_violation",
                "message": "Mensaje bloqueado por DLP: se detectaron credenciales o datos confidenciales no permitidos en texto plano.",
                "rules": dlp_result["violations"],
                "blocked_content": content
            }))
            return

        # 2. Persistencia en base de datos PostgreSQL
        saved_msg = await self.save_chat_message(content, is_code=is_code, language=language, reply_to_id=reply_to_id)
        if not saved_msg:
            return

        # 3. Difusión por WebSockets a los participantes del grupo
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'chat_message',
                'payload': saved_msg
            }
        )

    async def reaction_broadcast(self, event):
        """Difusión de actualización de reacciones a un mensaje."""
        await self.send(text_data=json.dumps({
            'type': 'reaction_update',
            **event['payload']
        }))

    async def message_deleted_broadcast(self, event):
        """Difusión de mensaje eliminado."""
        await self.send(text_data=json.dumps({
            'type': 'message_deleted',
            **event['payload']
        }))

    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'new_message',
            **event['payload']
        }))

    async def secret_notification(self, event):
        """Notificación cuando se envía un secreto efímero autodestructible."""
        await self.send(text_data=json.dumps({
            'type': 'new_secret',
            **event['payload']
        }))

    async def secret_burned_notification(self, event):
        """Notificación cuando un secreto efímero es abierto y purgado."""
        await self.send(text_data=json.dumps({
            'type': 'secret_burned',
            **event['payload']
        }))

    async def webrtc_forward(self, event):
        """Reenvío seguro de paquetes de señalización WebRTC (SDP, ICE, Call states)."""
        payload = event['payload']
        # No rebotar a uno mismo salvo en terminaciones
        if payload.get('sender') == self.user.username and payload.get('type') != 'call_hangup':
            return
        # Si tiene target específico (llamada 1 a 1), enviar solo al destinatario
        target = payload.get('target')
        if target and target != self.user.username:
            return

        await self.send(text_data=json.dumps(payload))

    async def presence_broadcast(self, event):
        """Reenvío de actualizaciones de presencia en tiempo real (online/offline)."""
        await self.send(text_data=json.dumps({
            'type': 'presence_update',
            **event['payload']
        }))
