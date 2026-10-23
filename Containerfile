# Containerfile oficial para Podman / OCI
FROM docker.io/library/python:3.12-slim

# Evitar escritura de archivos .pyc y habilitar flush inmediato de stdout
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Instalar dependencias mínimas de sistema para compilar psycopg y Pillow
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    libjpeg-dev \
    zlib1g-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements y realizar instalación limpia
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copiar el código del proyecto
COPY . /app/

# Crear directorios para estáticos y media con permisos correctos
RUN mkdir -p /app/staticfiles /app/media && \
    chmod +x /app/entrypoint.sh

# Puerto de escucha del servidor ASGI Daphne
EXPOSE 8000

# Punto de entrada
ENTRYPOINT ["/app/entrypoint.sh"]
