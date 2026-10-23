#!/usr/bin/env bash
# Script para iniciar el entorno en Podman
set -e

echo "=========================================================="
echo "      Iniciando DevCord con Podman y PostgreSQL"
echo "=========================================================="

if command -v podman-compose &> /dev/null; then
    echo "[+] Utilizando podman-compose..."
    podman-compose up --build -d
elif command -v podman &> /dev/null; then
    echo "[+] Utilizando podman compose nativo..."
    podman compose up --build -d
else
    echo "[-] Error: Podman no está instalado o no se encuentra en el PATH."
    exit 1
fi

echo "=========================================================="
echo "[✓] Los contenedores se están iniciando en segundo plano:"
echo "    - Web App:   http://localhost:8000"
echo "    - PostgreSQL: localhost:5432"
echo "    - Redis:      localhost:6379"
echo ""
echo "Credenciales creadas por defecto:"
echo "    - Admin:     admin     / Admin123456!"
echo "    - Developer: developer / DevPass123456!"
echo "=========================================================="
