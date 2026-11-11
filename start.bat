@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   Starting LoseLine local server...
echo.

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%~dp0serve.ps1" -Port 8080
timeout /t 2 /nobreak >nul
start "" "http://localhost:8080/"

echo   Browser should open at http://localhost:8080/
echo   Close this window to stop the server.
echo.
pause
