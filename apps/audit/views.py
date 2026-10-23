from django.shortcuts import render
from django.contrib.auth.decorators import login_required, user_passes_test
from django.http import JsonResponse
from apps.audit.models import SecurityAuditLog

def is_staff_or_admin(user):
    return user.is_staff or user.is_superuser

@login_required
def audit_dashboard_view(request):
    """
    Vista del Panel de Auditoría y Cumplimiento de Seguridad (Trazabilidad PostgreSQL).
    """
    recent_logs = SecurityAuditLog.objects.select_related('actor')[:100]
    
    total_logs = SecurityAuditLog.objects.count()
    dlp_blocks = SecurityAuditLog.objects.filter(event_type='DLP_VIOLATION_BLOCKED').count()
    secret_events = SecurityAuditLog.objects.filter(event_type__in=['SECRET_CREATED', 'SECRET_REVEALED']).count()
    auth_fails = SecurityAuditLog.objects.filter(event_type='AUTH_LOGIN_FAILED').count()

    context = {
        'recent_logs': recent_logs,
        'total_logs': total_logs,
        'dlp_blocks': dlp_blocks,
        'secret_events': secret_events,
        'auth_fails': auth_fails,
    }
    return render(request, 'audit/dashboard.html', context)

@login_required
def audit_logs_api(request):
    """API JSON para consultar eventos de auditoría recientes."""
    limit = min(int(request.GET.get('limit', 50)), 200)
    severity = request.GET.get('severity')
    
    queryset = SecurityAuditLog.objects.select_related('actor')
    if severity:
        queryset = queryset.filter(severity=severity.upper())

    logs = queryset[:limit]
    data = [
        {
            'id': str(log.id),
            'timestamp': log.timestamp.strftime('%Y-%m-%d %H:%M:%S UTC'),
            'actor': log.actor.username if log.actor else 'Anónimo / Sistema',
            'event_type': log.get_event_type_display(),
            'event_code': log.event_type,
            'severity': log.severity,
            'ip_address': log.ip_address or 'Desconocida',
            'details': log.details,
        }
        for log in logs
    ]
    return JsonResponse({'status': 'success', 'logs': data})
