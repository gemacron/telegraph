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
if not User.objects.filter(username='admin').exists():
    User.objects.create_superuser('admin', 'admin@telegraph.local', 'Admin123456!')
    print('Superusuario creado: admin / Admin123456!')

# Crear usuario dev demo si no existe
if not User.objects.filter(username='developer').exists():
    User.objects.create_user('developer', 'dev@telegraph.local', 'DevPass123456!')
    print('Usuario demo creado: developer / DevPass123456!')

# Crear workspace y canales por defecto
ws, _ = Workspace.objects.get_or_create(
    name='Telegraph Engineering',
    slug='telegraph-engineering',
    description='Espacio principal para desarrolladores de software'
)
for u in User.objects.all():
    ws.members.add(u)

Channel.objects.get_or_create(workspace=ws, name='general', topic='Conversación general y coordinación')
Channel.objects.get_or_create(workspace=ws, name='codigo-python', topic='Snippets de Python, Django y Arquitectura')
Channel.objects.get_or_create(workspace=ws, name='devops-ci-cd', topic='Despliegues, Podman y contenedores')
Channel.objects.get_or_create(workspace=ws, name='seguridad-dlp', topic='Auditorías de credenciales y secretos efímeros')
print('Estructura de Workspace y Canales verificada.')
" || true

echo "=== Recolectando archivos estáticos ==="
python manage.py collectstatic --noinput

echo "=== Iniciando servidor ASGI Daphne en http://0.0.0.0:8000 ==="
exec daphne -b 0.0.0.0 -p 8000 config.asgi:application
