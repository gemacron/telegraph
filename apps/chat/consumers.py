import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from apps.dlp.scanner import DataLossPreventionScanner
from apps.chat.models import Message, Channel, DirectConversation
from django.contrib.auth.models import AnonymousUser
from django.utils import timezone

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope.get("user")
        if not self.user or isinstance(self.user, AnonymousUser) or not self.user.is_authenticated:
            await self.close(code=4001)
            return

        self.room_id = self.scope['url_route']['kwargs']['room_id']
        self.room_group_name = f"chat_{self.room_id}"
        self.user_group_name = f"user_{self.user.username}"

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.channel_layer.group_add(
            self.user_group_name,
            self.channel_name
        )
        await self.accept()

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

    @database_sync_to_async
    def save_chat_message(self, content, is_code=False, language="", is_sticker=False, sticker_image_url="", is_animated_sticker=False, sticker_animation_type="", sticker_lottie_json=""):
        """Persiste el mensaje de manera asíncrona en PostgreSQL y renderiza Pygments si aplica."""
        channel = Channel.objects.filter(id=self.room_id).first()
        direct_conv = None if channel else DirectConversation.objects.filter(id=self.room_id).first()

        if not channel and not direct_conv:
            return None

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
            sticker_lottie_json=sticker_lottie_json or ""
        )
        msg.save()
        
        avatar_url = ""
        display_name = self.user.username
        if hasattr(self.user, 'profile'):
            avatar_url = self.user.profile.get_avatar_url() or ""
            display_name = self.user.profile.get_display_name()

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
            "created_at": msg.created_at.strftime("%H:%M")
        }

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

        # Manejo de Señalización WebRTC para Llamadas de Voz, Videollamadas y Compartir Pantalla
        if msg_type.startswith('webrtc_') or msg_type in ['call_request', 'call_response', 'call_hangup', 'voice_speaking', 'join_call']:
            sender_display, sender_avatar = await self.get_user_profile_info()
            target = data.get('target', '')
            payload = {
                'type': msg_type,
                'sender': self.user.username,
                'sender_display': sender_display,
                'sender_avatar': sender_avatar,
                'target': target,
                'call_type': data.get('call_type', 'audio'), # 'audio' o 'video'
                'sdp': data.get('sdp'),
                'candidate': data.get('candidate'),
                'accepted': data.get('accepted'),
                'is_speaking': data.get('is_speaking', False),
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
                sticker_lottie_json=sticker_lottie_json
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
        saved_msg = await self.save_chat_message(content, is_code=is_code, language=language)
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
