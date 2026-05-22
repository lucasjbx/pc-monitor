@echo off
echo Avvio Ciro Monitor...
start "Ciro Monitor" cmd /k "cd /d %~dp0backend && python app.py"
timeout /t 3 /nobreak >nul
start http://localhost:5000
