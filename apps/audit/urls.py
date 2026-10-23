from django.urls import path
from apps.audit import views

urlpatterns = [
    path('audit/', views.audit_dashboard_view, name='audit_dashboard'),
    path('api/audit/logs/', views.audit_logs_api, name='audit_logs_api'),
]
