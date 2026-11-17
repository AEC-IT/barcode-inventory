@echo off
REM Daily backup of the barcode database into a SharePoint-synced folder,
REM so a copy always exists off this PC. Keeps the last 30 backups.
REM Run daily by the "AEC Barcode Backup" scheduled task (see
REM windows\SETUP-WINDOWS.md).
REM
REM Edit these three lines once:
set PG_BIN=C:\Program Files\PostgreSQL\17\bin
set PGPASSWORD=PUT-YOUR-POSTGRES-PASSWORD-HERE
set BACKUP_DIR=%USERPROFILE%\AEC Group\Asset Photos barcode scanner - Documents\Database Backups

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set STAMP=%%i

"%PG_BIN%\pg_dump.exe" -h localhost -U postgres -d eams -Fc -f "%BACKUP_DIR%\eams-%STAMP%.backup"
if errorlevel 1 (
  echo [%date% %time%] BACKUP FAILED >> "%~dp0..\logs\backup.log"
  exit /b 1
)
echo [%date% %time%] Backup saved: eams-%STAMP%.backup >> "%~dp0..\logs\backup.log"

REM Delete backups older than 30 days
forfiles /p "%BACKUP_DIR%" /m eams-*.backup /d -30 /c "cmd /c del @path" 2> nul
exit /b 0
