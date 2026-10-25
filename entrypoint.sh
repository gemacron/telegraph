#!/bin/sh
set -e

echo "=== Esperando a que PostgreSQL esté disponible ==="
until python -c "
import socket
import sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.connect(('$POSTGRES_HOST', int('$POSTGRES_PORT')))
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
"; do
    echo "PostgreSQL ($POSTGRES_HOST:$POSTGRES_PORT) aún no está listo. Esperando 1 segundo..."
    sleep 1
done

echo "=== PostgreSQL conectado exitosamente ==="

echo "=== Aplicando migraciones de base de datos ==="
python manage.py makemigrations chat dlp --noinput || true
python manage.py migrate --noinput

echo "=== Creando datos iniciales del sistema ==="
python -c "
import os
import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()
from django.contrib.auth.models import User
from apps.chat.models import Workspace, Channel

# Crear superusuario admin si no existe
admin_user = User.objects.filter(username='admin').first()
if not admin_user:
    admin_user = User.objects.create_superuser('admin', 'admin@telegraph.local', 'Admin123456!')
    print('Superusuario creado: admin / Admin123456!')
if hasattr(admin_user, 'profile'):
    admin_user.profile.role = 'admin'
    admin_user.profile.save()

# Crear usuario dev demo si no existe
dev_user = User.objects.filter(username='developer').first()
if not dev_user:
    dev_user = User.objects.create_user('developer', 'dev@telegraph.local', 'DevPass123456!')
    print('Usuario demo creado: developer / DevPass123456!')

# Crear workspace y canales por defecto
ws, _ = Workspace.objects.get_or_create(
    name='Telegraph Engineering',
    slug='telegraph-engineering',
    description='Espacio principal para desarrolladores de software'
)
for u in User.objects.all():
    ws.members.add(u)

ch_gen, _ = Channel.objects.get_or_create(workspace=ws, name='general', defaults={'topic': 'Conversación general y coordinación', 'is_general': True})
ch_gen.is_general = True
ch_gen.save()

Channel.objects.get_or_create(workspace=ws, name='codigo-python', defaults={'topic': 'Snippets de Python, Django y Arquitectura'})
Channel.objects.get_or_create(workspace=ws, name='devops-ci-cd', defaults={'topic': 'Despliegues, Podman y contenedores'})
Channel.objects.get_or_create(workspace=ws, name='seguridad-dlp', defaults={'topic': 'Auditorías de credenciales y secretos efímeros'})

# Asignar a admin como encargado inicial de canales base
for ch in Channel.objects.filter(workspace=ws):
    if admin_user:
        ch.managers.add(admin_user)
        ch.members.add(admin_user)
    if dev_user and ch.is_general:
        ch.members.add(dev_user)

print('Estructura de Workspace y Canales verificada.')
" || true

echo "=== Recolectando archivos estáticos ==="
python manage.py collectstatic --noinput

echo "=== Iniciando servidor ASGI Daphne en http://0.0.0.0:8000 ==="
exec daphne -b 0.0.0.0 -p 8000 config.asgi:application
