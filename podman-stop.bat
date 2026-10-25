@echo off
echo ==========================================================
echo       Deteniendo contenedores de Telegraph
echo ==========================================================

set "PATH=%LOCALAPPDATA%\Programs\Podman;%CD%\.venv\Scripts;%PATH%"

if exist "%CD%\.venv\Scripts\podman-compose.exe" (
    "%CD%\.venv\Scripts\podman-compose.exe" --podman-path "%LOCALAPPDATA%\Programs\Podman\podman.exe" -f compose.yaml down
    goto finish
)

where podman-compose >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    podman-compose down
    goto finish
)

where podman >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    podman compose down
    goto finish
)

:finish
echo ==========================================================
echo [OK] Contenedores detenidos correctamente.
echo ==========================================================
pause
