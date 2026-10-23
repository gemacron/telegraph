from typing import Optional, Dict, Any
from django.contrib.auth.models import User
from apps.audit.models import SecurityAuditLog

class AuditService:
    """
    Servicio centralizado de auditoría y trazabilidad forense.
    Permite registrar eventos desde vistas HTTP, consumers WebSockets y tareas en segundo plano.
    """

    @staticmethod
    def get_client_ip(request) -> str:
        """Obtiene y sanitiza la dirección IP real del cliente."""
        if not request:
            return "127.0.0.1"

        x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
        if x_forwarded_for:
            # Tomar la primera IP de la cadena de proxies
            ip = x_forwarded_for.split(',')[0].strip()
        else:
            ip = request.META.get('REMOTE_ADDR', '127.0.0.1')
        return ip

    @classmethod
    def log(
        cls,
        event_type: str,
        actor: Optional[User] = None,
        severity: str = 'INFO',
        ip_address: Optional[str] = None,
        user_agent: str = "",
        details: Optional[Dict[str, Any]] = None,
        request = None
    ) -> SecurityAuditLog:
        """
        Crea un registro de auditoría inmutable en PostgreSQL.
        """
        if request:
            if not ip_address:
                ip_address = cls.get_client_ip(request)
            if not user_agent:
                user_agent = request.META.get('HTTP_USER_AGENT', '')
            if not actor and hasattr(request, 'user') and request.user.is_authenticated:
                actor = request.user

        return SecurityAuditLog.objects.create(
            event_type=event_type,
            actor=actor,
            severity=severity,
            ip_address=ip_address,
            user_agent=user_agent[:500] if user_agent else "",
            details=details or {}
        )
