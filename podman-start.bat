@echo off
echo ==========================================================
echo       Iniciando Telegraph con Podman y PostgreSQL
echo ==========================================================

where podman-compose >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [+] Utilizando podman-compose...
    podman-compose up --build -d
    goto finish
)

where podman >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [+] Utilizando podman compose nativo...
    podman compose up --build -d
    goto finish
)

echo [-] Error: Podman no esta instalado o no se encuentra en el PATH.
exit /b 1

:finish
echo ==========================================================
echo [OK] Contenedores iniciados en segundo plano:
echo     - Aplicacion: http://localhost:8000
echo     - PostgreSQL: localhost:5432
echo     - Redis:      localhost:6379
echo.
echo Credenciales por defecto:
echo     - Admin:     admin     / Admin123456!
echo     - Developer: developer / DevPass123456!
echo ==========================================================
pause
