import uuid
from django.db import models
from django.contrib.auth.models import User
from django.utils import timezone
from django.core.exceptions import PermissionDenied

class SecurityAuditLog(models.Model):
    """
    Registro inmutable de auditoría de seguridad para PostgreSQL.
    Garantiza trazabilidad forense: no se permite actualización ni eliminación (append-only).
    """
    SEVERITY_LEVELS = [
        ('INFO', 'Informativo'),
        ('WARNING', 'Advertencia de Seguridad'),
        ('CRITICAL', 'Violación Crítica / Amenaza'),
    ]

    EVENT_TYPES = [
        # Eventos DLP (Prevención de fuga de datos)
        ('DLP_VIOLATION_BLOCKED', 'Intento de Fuga de Credenciales Bloqueado'),
        ('DLP_SCAN_PASSED', 'Inspección de Contenido Exitosa'),
        
        # Secretos Efímeros
        ('SECRET_CREATED', 'Creación de Secreto Efímero Cifrado'),
        ('SECRET_REVEALED', 'Acceso y Autodestrucción Atómica de Secreto'),
        ('SECRET_EXPIRED', 'Purga Automática de Secreto por TTL'),

        # Autenticación y Cuentas
        ('AUTH_LOGIN_SUCCESS', 'Inicio de Sesión Exitoso'),
        ('AUTH_LOGIN_FAILED', 'Fallo de Autenticación (Posible Fuerza Bruta)'),
        ('AUTH_LOGOUT', 'Cierre de Sesión'),
        ('PROFILE_UPDATED', 'Modificación de Datos de Usuario / Avatar'),
        ('PASSWORD_CHANGED', 'Cambio de Contraseña'),

        # Transferencia de Archivos
        ('ATTACHMENT_UPLOADED', 'Archivo o Imagen Verificada Subida'),
        ('ATTACHMENT_BLOCKED', 'Archivo Sospechoso / Malicioso Rechazado'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    timestamp = models.DateTimeField(default=timezone.now, db_index=True)
    actor = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_events")
    event_type = models.CharField(max_length=50, choices=EVENT_TYPES, db_index=True)
    severity = models.CharField(max_length=20, choices=SEVERITY_LEVELS, default='INFO', db_index=True)
    
    # Datos de red y cliente
    ip_address = models.GenericIPAddressField(null=True, blank=True, db_index=True)
    user_agent = models.TextField(blank=True, default="")
    
    # Metadata del evento en JSON nativo de PostgreSQL
    details = models.JSONField(default=dict, blank=True, help_text="Información forense estructurada")

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['-timestamp', 'event_type']),
            models.Index(fields=['actor', '-timestamp']),
        ]
        verbose_name = "Registro de Auditoría de Seguridad"
        verbose_name_plural = "Registros de Auditoría de Seguridad"

    def delete(self, *args, **kwargs):
        """Inmutabilidad estricta: los registros de auditoría no pueden eliminarse."""
        raise PermissionDenied("Violación de directiva de auditoría: los registros son inmutables.")

    def save(self, *args, **kwargs):
        """Append-only: solo se permite creación, no modificación posterior."""
        if self.pk and SecurityAuditLog.objects.filter(pk=self.pk).exists():
            raise PermissionDenied("Violación de directiva de auditoría: los registros no pueden ser modificados.")
        super().save(*args, **kwargs)

    def __str__(self):
        actor_name = self.actor.username if self.actor else "Anónimo / Sistema"
        return f"[{self.timestamp.strftime('%Y-%m-%d %H:%M:%S')}] [{self.severity}] {self.event_type} - {actor_name} ({self.ip_address})"
