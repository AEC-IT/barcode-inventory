@echo off
REM Starts the barcode app and restarts it automatically if it ever stops.
REM Run at Windows startup by the "AEC Barcode Inventory" scheduled task
REM (see windows\SETUP-WINDOWS.md). Settings come from the .env file in the
REM app folder.

cd /d "%~dp0.."
if not exist logs mkdir logs

:loop
echo [%date% %time%] Starting barcode app >> logs\server.log
"C:\Program Files\nodejs\node.exe" server.js >> logs\server.log 2>&1
echo [%date% %time%] App stopped - restarting in 5 seconds >> logs\server.log
timeout /t 5 /nobreak > nul
goto loop
