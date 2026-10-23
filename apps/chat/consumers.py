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

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )

    @database_sync_to_async
    def save_chat_message(self, content, is_code, language):
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
            code_language=language or ""
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

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        msg_type = data.get('type', 'message')
        content = data.get('content', '')
        is_code = bool(data.get('is_code', False))
        language = data.get('language', '')

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
        saved_msg = await self.save_chat_message(content, is_code, language)
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
