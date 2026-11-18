@echo off
REM One-click setup of the barcode app on this Windows PC.
REM Needs PostgreSQL 17, Node.js, Git and Tailscale installed first
REM (see SETUP-WINDOWS.md). Right-click this file and choose
REM "Run as administrator". Safe to run again: steps already done are skipped.
setlocal
title AEC Barcode Inventory - setup

REM SharePoint photo storage settings. Leave empty to be asked.
set "MS_TENANT_ID="
set "MS_CLIENT_ID="
set "MS_CLIENT_SECRET="
set "SHAREPOINT_SITE="

set "APP=C:\barcode-inventory"
set "PGBIN=C:\Program Files\PostgreSQL\17\bin"
set "NODEDIR=C:\Program Files\nodejs"
set "TS=C:\Program Files\Tailscale\tailscale.exe"

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Please close this window, right-click setup.bat and choose "Run as administrator".
  goto fail
)

echo.
echo  ===== AEC Barcode Inventory setup =====
echo.

where git >nul 2>&1
if errorlevel 1 ( echo  Git is not installed. Install it from git-scm.com, then run this again. & goto fail )
if not exist "%NODEDIR%\node.exe" ( echo  Node.js is not installed. Install the LTS version from nodejs.org, then run this again. & goto fail )
if not exist "%PGBIN%\psql.exe" ( echo  PostgreSQL 17 is not installed. Install it, then run this again. & goto fail )
if not exist "%TS%" ( echo  Tailscale is not installed. Install it and sign in, then run this again. & goto fail )

echo  [1/7] Downloading the app...
if exist "%APP%\.git" goto pull
git clone https://github.com/AEC-IT/barcode-inventory.git "%APP%"
if errorlevel 1 ( echo  Download failed. If GitHub asked you to sign in, use the AEC-IT account and run this again. & goto fail )
goto cloned
:pull
cd /d "%APP%"
git pull
:cloned
cd /d "%APP%"

echo.
echo  [2/7] Installing app components (1-2 minutes, warnings are normal)...
call "%NODEDIR%\npm.cmd" install --no-audit --no-fund
if errorlevel 1 ( echo  Install failed - check the internet connection and run this again. & goto fail )

echo.
echo  [3/7] Database
:askpw
set "PGPASSWORD="
set /p "PGPASSWORD=  Type the postgres password you set when installing PostgreSQL, then press Enter: "
"%PGBIN%\psql.exe" -U postgres -h localhost -d postgres -tAc "select 1" >nul 2>&1
if errorlevel 1 ( echo  That password didn't work - try again. & goto askpw )
"%PGBIN%\psql.exe" -U postgres -h localhost -d postgres -tAc "select 1 from pg_database where datname='eams'" | findstr "1" >nul
if errorlevel 1 "%PGBIN%\createdb.exe" -U postgres -h localhost eams
echo  Database ready.

echo.
echo  [4/7] Settings file
if exist "%APP%\.env" ( echo  .env already exists - keeping it. & goto envdone )
if "%MS_TENANT_ID%"=="" set /p "MS_TENANT_ID=  Microsoft Tenant ID (from Render, Environment): "
if "%MS_CLIENT_ID%"=="" set /p "MS_CLIENT_ID=  Microsoft Client ID: "
if "%MS_CLIENT_SECRET%"=="" set /p "MS_CLIENT_SECRET=  Microsoft Client Secret: "
if "%SHAREPOINT_SITE%"=="" set /p "SHAREPOINT_SITE=  SharePoint site address: "
for /f %%i in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')"') do set "SESSION_SECRET=%%i"
> "%APP%\.env" echo DATABASE_URL=postgresql://postgres@localhost:5432/eams
>> "%APP%\.env" echo PGPASSWORD=%PGPASSWORD%
>> "%APP%\.env" echo PGSSLMODE=disable
>> "%APP%\.env" echo PORT=3000
>> "%APP%\.env" echo SESSION_SECRET=%SESSION_SECRET%
>> "%APP%\.env" echo MS_TENANT_ID=%MS_TENANT_ID%
>> "%APP%\.env" echo MS_CLIENT_ID=%MS_CLIENT_ID%
>> "%APP%\.env" echo MS_CLIENT_SECRET=%MS_CLIENT_SECRET%
>> "%APP%\.env" echo SHAREPOINT_SITE=%SHAREPOINT_SITE%
echo  Settings saved.
:envdone

echo.
echo  [5/7] Backups
echo  Where should hourly database backups go? Best: a SharePoint folder synced to this PC.
echo  Press Enter to use C:\barcode-backups for now (you can change it later).
set "BACKUP_DIR="
set /p "BACKUP_DIR=  Backup folder: "
if "%BACKUP_DIR%"=="" set "BACKUP_DIR=C:\barcode-backups"
> "%APP%\windows\backup-config.bat" echo set "PGPASSWORD=%PGPASSWORD%"
>> "%APP%\windows\backup-config.bat" echo set "BACKUP_DIR=%BACKUP_DIR%"
>> "%APP%\windows\backup-config.bat" echo set "PG_BIN=%PGBIN%"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo.
echo  [6/7] Auto-start and hourly backups
schtasks /create /f /tn "AEC Barcode Inventory" /tr "%APP%\windows\start-server.bat" /sc onstart /ru SYSTEM /rl HIGHEST >nul
schtasks /create /f /tn "AEC Barcode Backup" /tr "%APP%\windows\backup-database.bat" /sc hourly /st 09:30 /du 08:30 >nul
powercfg /change standby-timeout-ac 0
schtasks /end /tn "AEC Barcode Inventory" >nul 2>&1
schtasks /run /tn "AEC Barcode Inventory" >nul
echo  Starting the app (first start can take a minute)...
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -UseBasicParsing http://localhost:3000/login.html -TimeoutSec 3 | Out-Null; exit 0}catch{Start-Sleep 3}}; exit 1"
if errorlevel 1 ( echo  The app didn't start. Send a screenshot of %APP%\logs\server.log & goto fail )
echo  App is running on this PC: http://localhost:3000

echo.
echo  [7/7] Internet address (Tailscale Funnel)
echo  If a link appears below, open it, approve Funnel, then come back here.
"%TS%" funnel --bg 3000
echo.
"%TS%" funnel status
echo.
echo  ===== Setup finished =====
echo  The https://....ts.net address above is the new scanner link for phones.
echo  First login: superadmin / super123 - change this password straight away.
start "" http://localhost:3000
pause
exit /b 0

:fail
echo.
pause
exit /b 1
